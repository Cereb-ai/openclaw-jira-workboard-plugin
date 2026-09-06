/**
 * jira.upload_attachment — upload a single local file to a Jira issue.
 *
 * REST: POST /rest/api/3/issue/{issueIdOrKey}/attachments
 *   Body: multipart/form-data with a single `file` part.
 *   Required headers (in addition to auth):
 *     - X-Atlassian-Token: no-check   (Jira rejects without it)
 *     - Accept: application/json
 *   `Content-Type: multipart/form-data; boundary=...` is set automatically
 *   by fetch when given a FormData body.
 *
 * Caller passes an absolute filePath; the plugin reads the file from disk
 * and uploads it as-is (filename = basename(filePath)). 100MB is the
 * conservative cap — Atlassian cloud's per-attachment limit. Larger files
 * are rejected client-side to avoid burning 100MB+ of bandwidth on a
 * guaranteed-fail request.
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
 *              status 404/413/500 语义保留; 上游 HTTP 4xx/5xx 透传 res.status)
 *   details → <100 字符一句话语义摘要. success 例
 *              "已上传 screenshot.png (12345 字节) 至 SSSS-454"
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadConfig } from "../auth.js";
import { atlassianApiBase } from "../auth.js";
import { textResult } from "../dispatch.js";
import type { ToolResult } from "../types.js";

/** Atlassian Cloud per-attachment hard cap. */
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

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

  const issueIdOrKey = args.issueIdOrKey;
  if (typeof issueIdOrKey !== "string" || issueIdOrKey.length === 0) {
    return textResult(
      {
        ok: false,
        error: {
          status: 400,
          message: "upload_attachment requires a non-empty `issueIdOrKey` (string).",
        },
      },
      "jira_upload_attachment 失败: 缺少 issueIdOrKey",
    );
  }

  const filePath = args.filePath;
  if (typeof filePath !== "string" || filePath.length === 0) {
    return textResult(
      {
        ok: false,
        error: {
          status: 400,
          message: "upload_attachment requires a non-empty `filePath` (string).",
        },
      },
      "jira_upload_attachment 失败: 缺少 filePath",
    );
  }

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    return textResult(
      {
        ok: false,
        error: {
          status: 404,
          message: `file not found: ${filePath} (${errorMessage(err)})`,
        },
      },
      `jira_upload_attachment 失败: 文件不存在 ${filePath}`,
    );
  }

  if (stat.size > MAX_FILE_SIZE) {
    return textResult(
      {
        ok: false,
        error: {
          status: 413,
          message: `file too large: ${stat.size} bytes (max ${MAX_FILE_SIZE})`,
        },
      },
      `jira_upload_attachment 失败: 文件超 100MB (${stat.size} 字节)`,
    );
  }

  const filename = path.basename(filePath);
  const buffer = await fs.readFile(filePath);

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
    `已上传 ${filename} (${stat.size} 字节) 至 ${issueIdOrKey}`,
  );
}
