/**
 * jira.get_attachment — download an attachment's binary content to disk.
 *
 * REST flow:
 *   1. GET /rest/api/3/attachment/content/{id}  → HTTP 303 redirect
 *   2. Follow Location header to api.media.atlassian.com  → actual binary
 *
 * We MUST follow the redirect manually because:
 *   - Node global fetch won't follow cross-origin redirects without `redirect: "follow"`,
 *     but the standard fetch does follow them. We use redirect: "follow" for safety.
 *   - The actual binary endpoint (api.media.atlassian.com) is on a different host
 *     than the Atlassian Cloud API. The proxy in http.ts is hostname-scoped to
 *     `api.atlassian.com`, so the redirect target goes through the global pool
 *     (no proxy) — fine for direct connections.
 *
 * Save path:
 *   - `saveToPath` (caller-supplied): file is written there. Caller is responsible
 *     for ensuring the directory exists.
 *   - Default (no path): written to `/tmp/openclaw-attachments/{id}.{ext}` where
 *     `ext` is derived from mimeType. We DO NOT save under the OpenClaw system
 *     dir (`~/.openclaw/...`) — attachments are caller-temp, not plugin state.
 *
 * Returns: { path, size, mimeType, filename } on success. NO file content in
 * the response — caller reads from disk (smaller context, works for big files).
 *
 * Why not return base64? A 50 MB image as base64 is ~67 MB of JSON in the LLM
 * context. Path-based handoff is the only sane option for arbitrary binaries.
 */
import { loadConfig } from "../auth.js";
import { jiraGet, JiraHttpError, buildUrl, authHeaders } from "../http.js";
import { textResult } from "../dispatch.js";
import type { ToolResult } from "../types.js";

const DEFAULT_ATTACHMENT_DIR = "/tmp/openclaw-attachments";

interface AttachmentMeta {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  content: string;
}

/** Map common mimeType → file extension. Falls back to "" (no ext). */
function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "application/pdf": "pdf",
    "text/plain": "txt",
    "text/markdown": "md",
    "text/csv": "csv",
    "application/json": "json",
    "application/zip": "zip",
    "application/octet-stream": "bin",
  };
  return map[mime] ?? "";
}

export async function getAttachment(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    return textResult({ error: errorMessage(err) });
  }

  const attachmentId = args.attachmentId;
  if (typeof attachmentId !== "string" || attachmentId.length === 0) {
    return textResult({
      error: "get_attachment requires a non-empty `attachmentId` (string).",
    });
  }

  // Optional saveToPath — caller-controlled destination.
  const saveToPath = args.saveToPath;
  if (saveToPath !== undefined && typeof saveToPath !== "string") {
    return textResult({
      error: "`saveToPath` must be a string (full file path).",
    });
  }

  // Fetch metadata first to learn mimeType + filename for path derivation.
  // Single round-trip since the metadata is required anyway.
  let meta: AttachmentMeta;
  try {
    const data = (await jiraGet(cfg, `attachment/${attachmentId}`)) as AttachmentMeta;
    meta = data;
  } catch (err) {
    if (err instanceof JiraHttpError) {
      return textResult({
        error: `jira.get_attachment (metadata) failed: ${err.message}`,
      });
    }
    return textResult({
      error: `jira.get_attachment (metadata) failed: ${errorMessage(err)}`,
    });
  }

  // Resolve destination path.
  const destPath =
    saveToPath ?? `${DEFAULT_ATTACHMENT_DIR}/${meta.id}.${extFromMime(meta.mimeType)}`;

  // Ensure parent dir exists (only for the default path — caller-supplied
  // paths are assumed to be already valid).
  if (saveToPath === undefined) {
    try {
      const fs = await import("node:fs/promises");
      await fs.mkdir(DEFAULT_ATTACHMENT_DIR, { recursive: true });
    } catch (err) {
      return textResult({
        error: `failed to create ${DEFAULT_ATTACHMENT_DIR}: ${errorMessage(err)}`,
      });
    }
  }

  // Download via content endpoint with auto-redirect follow.
  const contentUrl = `attachment/content/${attachmentId}`;
  try {
    // Use jiraGet to handle auth + proxy, then handle redirect manually.
    // jiraGet returns the parsed response body, which for a binary is
    // an ArrayBuffer → we re-implement the binary fetch here.
    const resp = await rawFetchContent(cfg, contentUrl);
    if (!resp.ok) {
      return textResult({
        error: `jira.get_attachment download failed: HTTP ${resp.status}`,
      });
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    const fs = await import("node:fs/promises");
    await fs.writeFile(destPath, buffer);

    return textResult({
      ok: true,
      method: "get_attachment",
      request: { attachmentId, saveToPath },
      path: destPath,
      size: buffer.length,
      mimeType: meta.mimeType,
      filename: meta.filename,
      summary: {
        attachmentId,
        path: destPath,
        size: buffer.length,
        mimeType: meta.mimeType,
        filename: meta.filename,
      },
    });
  } catch (err) {
    return textResult({
      error: `jira.get_attachment download failed: ${errorMessage(err)}`,
    });
  }
}

/**
 * Low-level fetch for binary content (no JSON parsing). Follows redirects
 * (the content endpoint returns 303 → api.media.atlassian.com). Does NOT
 * go through the proxy hostname guard — the redirect target is a different
 * host that we trust explicitly.
 */
async function rawFetchContent(
  cfg: ReturnType<typeof loadConfig>,
  path: string,
): Promise<Response> {
  const url = buildUrl(cfg, path);
  const res = await fetch(url, {
    method: "GET",
    headers: authHeaders(cfg),
    redirect: "follow",
  });
  return res;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
