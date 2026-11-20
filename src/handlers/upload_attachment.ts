/**
 * jira.upload_attachment — upload a single file to a Jira issue.
 *
 * REST: POST /rest/api/3/issue/{issueIdOrKey}/attachments
 *   Body: multipart/form-data with a single `file` part.
 *   Required headers (in addition to auth):
 *     - X-Atlassian-Token: no-check   (Jira rejects without it)
 *     - Accept: application/json
 *   `Content-Type: multipart/form-data; boundary=...` is set automatically
 *   by fetch when given a FormData body.
 *
 * CP-5107 — THREE mutually exclusive byte sources (cross-sandbox support):
 *
 *   1. `filePath` (original, 0.5.1+) — absolute path readable ON THE GATEWAY
 *      HOST. The plugin stat/readFile()s it locally, filename =
 *      basename(filePath). Unchanged success/error contract.
 *   2. `url` (new) — http/https URL. The plugin downloads the bytes itself
 *      (`fetch` in the gateway process), so the file never has to exist on
 *      the gateway filesystem. Filename = basename of the URL path, unless
 *      an explicit `filename` overrides it. Preferred cross-sandbox entry:
 *      an artifact living in an e2e-runner Job / coder sandbox can be served
 *      over a signed URL (e.g. GCS presigned) and fetched by the gateway.
 *   3. `base64` (new) — base64 payload, optionally prefixed with a
 *      `data:<mime>;base64,` data URL. Requires an EXPLICIT `filename`
 *      (nothing to derive it from) — missing filename → 400, never a
 *      silently generated name. Intended for small files only.
 *
 *   Exactly one source must be supplied:
 *     - 0 sources  → 400 listing filePath / url / base64.
 *     - >1 sources → 400 "accepts exactly one source" (never silently picks).
 *     - url with a non-http(s) scheme → 400.
 *     - sandbox-local path that the gateway cannot read → 404 whose message
 *       says the path must be visible on the gateway host (sandbox-local
 *       paths are not readable) and points at url / base64.
 *   100 MB is the conservative cap for ALL THREE sources (filePath: stat
 *   size; url: actual downloaded bytes; base64: decoded length). Over the
 *   cap → 413 carrying the actual byte count. Atlassian cloud's
 *   per-attachment limit — rejected client-side so we do not burn 100MB+ of
 *   bandwidth on a guaranteed-fail request.
 *
 * Return contract (CP-2715 batch 4, v0.5 §6):
 *   success → {ok, method, request{issueIdOrKey}, count,
 *              attachments[{id, filename, size, mimeType, content}]}.
 *              summary 块去除 (5 字段全部与顶层 / request 重复). request.filePath
 *              / size / filename 回声去除 (filePath 全路径重复, 可上百字符);
 *              最终落盘 / 字节数 / 文件名归顶层 path (本工具不落盘, 直接走
 *              Atlassian) — 此工具不返回顶层 path, 由 caller 通过 request + 自身
 *              状态持有. count == attachments.length 派生自 items.length. attachments
 *              逐项显式 pick 5 字段 (Atlassian 原始项含 author/created/self 等
 *              可能混入, v0.5 §6 草稿池定).
 *   error   → {ok: false, error: {status, message}} (既有契约不动; synthetic
 *              status 400 (bad/missing/ambiguous source) / 404 (gateway cannot
 *              read filePath) / 413 (over 100MB) / 502 (url download failed) /
 *              500 (misc); 上游 HTTP 4xx/5xx 透传 res.status)
 *   details → <100 字符一句话语义摘要. success 例
 *              "已上传 screenshot.png (12345 字节) 至 SSSS-454"
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadConfig } from "../auth.js";
import { atlassianApiBase } from "../auth.js";
import { textResult } from "../dispatch.js";
import { normalizeId } from "../normalize.js";
import type { ToolResult } from "../types.js";

/** Atlassian Cloud per-attachment hard cap — applies to all three sources. */
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

/** Byte sources accepted by this handler (mutually exclusive). */
const SOURCE_KEYS = ["filePath", "url", "base64"] as const;
type SourceKind = (typeof SOURCE_KEYS)[number];

/** Atlassian attachment item (with possible extra fields like author/created/self). */
interface AttachmentResponseItem {
  id?: unknown;
  filename?: unknown;
  size?: unknown;
  mimeType?: unknown;
  content?: unknown;
  [k: string]: unknown;
}

/** Compact 5-field shape returned to the caller. */
interface CompactAttachment {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  content: string;
}

/**
 * Pick the 5 whitelisted fields from a raw Atlassian attachment item.
 * Falls back to "" / 0 for any missing field rather than spreading unknown
 * fields — prevents author/created/self/thumbnail/etc. from leaking through.
 */
function pickCompact(item: AttachmentResponseItem): CompactAttachment {
  return {
    id: typeof item.id === "string" ? item.id : String(item.id ?? ""),
    filename:
      typeof item.filename === "string" ? item.filename : String(item.filename ?? ""),
    size: typeof item.size === "number" ? item.size : Number(item.size ?? 0),
    mimeType:
      typeof item.mimeType === "string" ? item.mimeType : String(item.mimeType ?? ""),
    content:
      typeof item.content === "string" ? item.content : String(item.content ?? ""),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Uniform structured error envelope ({ok:false, error:{status,message}}). */
function errorResult(status: number, message: string, details: string): ToolResult {
  // details contract: <100-char one-line summary (long sandbox paths would
  // otherwise blow past it). The full path always stays in `error.message`.
  const summary = details.length > 99 ? `${details.slice(0, 98)}…` : details;
  return textResult({ ok: false, error: { status, message } }, summary);
}

/** Keep the target URL short enough for an actionable, bounded error message. */
function truncateUrl(u: string, n = 120): string {
  return u.length > n ? `${u.slice(0, n)}…` : u;
}

/** Strip an optional `data:<mime>;base64,` prefix; plain base64 passes through. */
function stripDataUrlPrefix(raw: string): string {
  const m = /^data:[^,]*;base64,/i.exec(raw);
  return m ? raw.slice(m[0].length) : raw;
}

/**
 * Exact decoded byte length of a base64 string WITHOUT decoding it — lets the
 * handler reject an oversize payload before allocating the buffer.
 */
function base64DecodedLength(b64: string): number {
  const clean = b64.replace(/\s+/g, "");
  if (clean.length === 0) return 0;
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - pad;
}

/** Filename derived from a URL path, falling back to "download". */
function filenameFromUrl(u: URL): string {
  let base = "";
  try {
    base = path.posix.basename(decodeURIComponent(u.pathname));
  } catch {
    base = path.posix.basename(u.pathname);
  }
  return base && base !== "." && base !== "/" ? base : "download";
}

/** Raised by `downloadFromUrl` — carries the synthetic status to return. */
class DownloadError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DownloadError";
    this.status = status;
  }
}

interface DownloadedBytes {
  buffer: Buffer<ArrayBuffer>;
  size: number;
}

/**
 * Fetch a http/https URL in the gateway process and return the bytes.
 *
 * The body is streamed so an oversized response is aborted as soon as it
 * crosses MAX_FILE_SIZE (no 100MB+ allocation on a guaranteed-fail upload).
 * Any failure carries status 502 + the target URL (truncated) and the
 * upstream status code / underlying reason — never "file not found".
 */
async function downloadFromUrl(urlStr: string): Promise<DownloadedBytes> {
  let res: Response;
  try {
    res = await fetch(urlStr, { method: "GET", redirect: "follow" });
  } catch (err) {
    throw new DownloadError(
      `url download failed: ${truncateUrl(urlStr)} (${errorMessage(err)})`,
      502,
    );
  }

  if (!res.ok) {
    throw new DownloadError(
      `url download failed: ${truncateUrl(urlStr)} → HTTP ${res.status} ${res.statusText}`,
      502,
    );
  }

  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_FILE_SIZE) {
    throw new DownloadError(
      `file too large: ${declared} bytes (max ${MAX_FILE_SIZE})`,
      413,
    );
  }

  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FILE_SIZE) {
      throw new DownloadError(
        `file too large: ${buf.length} bytes (max ${MAX_FILE_SIZE})`,
        413,
      );
    }
    return { buffer: buf, size: buf.length };
  }

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_FILE_SIZE) {
        await reader.cancel().catch(() => undefined);
        throw new DownloadError(
          `file too large: ${total} bytes (max ${MAX_FILE_SIZE})`,
          413,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    if (err instanceof DownloadError) throw err;
    throw new DownloadError(
      `url download failed: ${truncateUrl(urlStr)} (${errorMessage(err)})`,
      502,
    );
  }

  return { buffer: Buffer.concat(chunks), size: total };
}

export async function uploadAttachment(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    return textResult(
      { ok: false, error: { status: 500, message: errorMessage(err) } },
      `jira_upload_attachment 失败: ${errorMessage(err)}`,
    );
  }

  // CP-3751: issueIdOrKey accepts string | number → normalized to string.
  const issueIdOrKeyNorm = normalizeId(args.issueIdOrKey, "issueIdOrKey");
  if (!issueIdOrKeyNorm.ok) {
    return textResult(
      {
        ok: false,
        error: {
          status: 400,
          message: issueIdOrKeyNorm.error,
        },
      },
      "jira_upload_attachment 失败: 缺少 issueIdOrKey",
    );
  }
  const issueIdOrKey = issueIdOrKeyNorm.value;

  // CP-5107 AC3 — exactly one byte source.
  const provided = SOURCE_KEYS.filter(
    (key) => args[key] !== undefined && args[key] !== null,
  );
  if (provided.length === 0) {
    return errorResult(
      400,
      "upload_attachment requires exactly one source: `filePath` (absolute path readable on the gateway host) | `url` (http/https) | `base64` (with an explicit `filename`).",
      "jira_upload_attachment 失败: 缺少来源 (filePath / url / base64)",
    );
  }
  if (provided.length > 1) {
    return errorResult(
      400,
      `upload_attachment accepts exactly one source: \`filePath\` | \`url\` | \`base64\` (got: ${provided.join(", ")}).`,
      `jira_upload_attachment 失败: 来源互斥 (${provided.join(" + ")})`,
    );
  }
  const source: SourceKind = provided[0];

  let buffer: Buffer<ArrayBuffer>;
  let size: number;
  let filename: string;

  if (source === "filePath") {
    const filePath = args.filePath;
    if (!isNonEmptyString(filePath)) {
      return errorResult(
        400,
        "upload_attachment requires a non-empty `filePath` (string).",
        "jira_upload_attachment 失败: 缺少 filePath",
      );
    }

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (err) {
      // CP-5107 AC5 — actionable diagnosis: the path must be gateway-visible,
      // a sandbox-local path is unreadable, and there are two cross-sandbox
      // entry points. Prefix kept verbatim for 0.6.0 consumers that match on
      // "file not found".
      return errorResult(
        404,
        `file not found: ${filePath} (${errorMessage(err)}). filePath must be an absolute path readable on the gateway host — sandbox-local paths are NOT readable (路径必须在 gateway 主机可见; 沙箱内本地路径不可读). Use \`url\` (http/https) or \`base64\` + \`filename\` instead.`,
        `jira_upload_attachment 失败: 文件不存在 ${filePath}`,
      );
    }

    if (stat.size > MAX_FILE_SIZE) {
      return errorResult(
        413,
        `file too large: ${stat.size} bytes (max ${MAX_FILE_SIZE})`,
        `jira_upload_attachment 失败: 文件超 100MB (${stat.size} 字节)`,
      );
    }

    filename = path.basename(filePath);
    buffer = await fs.readFile(filePath);
    size = stat.size;
  } else if (source === "url") {
    const rawUrl = args.url;
    if (!isNonEmptyString(rawUrl)) {
      return errorResult(
        400,
        "upload_attachment requires a non-empty `url` (string).",
        "jira_upload_attachment 失败: 缺少 url",
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch (err) {
      return errorResult(
        400,
        `invalid url: ${truncateUrl(rawUrl)} (${errorMessage(err)})`,
        "jira_upload_attachment 失败: url 无效",
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return errorResult(
        400,
        `unsupported url scheme: ${parsed.protocol} (only http/https are allowed)`,
        `jira_upload_attachment 失败: 不支持的 url scheme ${parsed.protocol}`,
      );
    }

    let downloaded: DownloadedBytes;
    try {
      downloaded = await downloadFromUrl(rawUrl);
    } catch (err) {
      if (err instanceof DownloadError) {
        const details =
          err.status === 413
            ? "jira_upload_attachment 失败: 文件超 100MB"
            : "jira_upload_attachment 失败: url 下载失败";
        return errorResult(err.status, err.message, details);
      }
      return errorResult(
        502,
        `url download failed: ${truncateUrl(rawUrl)} (${errorMessage(err)})`,
        "jira_upload_attachment 失败: url 下载失败",
      );
    }

    buffer = downloaded.buffer;
    size = downloaded.size;
    filename = isNonEmptyString(args.filename)
      ? args.filename
      : filenameFromUrl(parsed);
  } else {
    const rawBase64 = args.base64;
    if (!isNonEmptyString(rawBase64)) {
      return errorResult(
        400,
        "upload_attachment requires a non-empty `base64` (string).",
        "jira_upload_attachment 失败: 缺少 base64",
      );
    }
    if (!isNonEmptyString(args.filename)) {
      return errorResult(
        400,
        "`base64` requires an explicit `filename` (string) — there is nothing to derive a name from.",
        "jira_upload_attachment 失败: base64 缺少 filename",
      );
    }

    const b64 = stripDataUrlPrefix(rawBase64).replace(/\s+/g, "");
    if (b64.length === 0) {
      return errorResult(
        400,
        "base64 payload is empty after stripping the data: URL prefix.",
        "jira_upload_attachment 失败: base64 内容为空",
      );
    }

    // Reject before allocating: exact decoded length, no Buffer yet.
    const declared = base64DecodedLength(b64);
    if (declared > MAX_FILE_SIZE) {
      return errorResult(
        413,
        `file too large: ${declared} bytes (max ${MAX_FILE_SIZE})`,
        `jira_upload_attachment 失败: 文件超 100MB (${declared} 字节)`,
      );
    }

    buffer = Buffer.from(b64, "base64");
    size = buffer.length;
    if (size > MAX_FILE_SIZE) {
      return errorResult(
        413,
        `file too large: ${size} bytes (max ${MAX_FILE_SIZE})`,
        `jira_upload_attachment 失败: 文件超 100MB (${size} 字节)`,
      );
    }
    filename = args.filename;
  }

  const form = new FormData();
  form.append("file", new Blob([buffer]), filename);

  const url = `${atlassianApiBase(cfg.cloudId)}/issue/${encodeURIComponent(issueIdOrKey)}/attachments`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.atstToken}`,
        "X-Atlassian-Token": "no-check",
        Accept: "application/json",
      },
      body: form,
    });
  } catch (err) {
    return textResult(
      {
        ok: false,
        error: {
          status: 500,
          message: `upload network error: ${errorMessage(err)}`,
        },
      },
      `jira_upload_attachment 失败: ${errorMessage(err)}`,
    );
  }

  const text = await res.text();
  if (!res.ok) {
    return textResult(
      {
        ok: false,
        error: {
          status: res.status,
          message: `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
        },
      },
      `jira_upload_attachment 失败: HTTP ${res.status} ${res.statusText}`,
    );
  }

  let items: CompactAttachment[] = [];
  try {
    const parsed = text ? JSON.parse(text) : [];
    if (Array.isArray(parsed)) {
      items = (parsed as AttachmentResponseItem[]).map(pickCompact);
    }
  } catch {
    items = [];
  }

  return textResult(
    {
      ok: true,
      method: "upload_attachment",
      request: { issueIdOrKey },
      count: items.length,
      attachments: items,
    },
    `已上传 ${filename} (${size} 字节) 至 ${issueIdOrKey}`,
  );
}
