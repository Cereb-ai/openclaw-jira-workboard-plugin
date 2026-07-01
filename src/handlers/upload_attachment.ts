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
 * conservative cap — Atlassian Cloud's per-attachment limit. Larger files
 * are rejected client-side to avoid burning 100MB+ of bandwidth on a
 * guaranteed-fail request.
 *
 * Returns: { ok, attachments: [{id, filename, size, mimeType, content}, ...] }
 *   on success. The `content` field is the URL to download the attachment
 *   (relative or absolute per server). On failure: { ok: false, error:
 *   { status, message } } with a synthetic status (404 for missing file,
 *   413 for oversize, 500 for misc) so callers can branch on it.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadConfig } from "../auth.js";
import { atlassianApiBase } from "../auth.js";
import { textResult } from "../dispatch.js";
import type { ToolResult } from "../types.js";

/** Atlassian Cloud per-attachment hard cap. */
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

interface AttachmentResponseItem {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  content: string;
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
    return textResult({ ok: false, error: { status: 500, message: errorMessage(err) } });
  }

  const issueIdOrKey = args.issueIdOrKey;
  if (typeof issueIdOrKey !== "string" || issueIdOrKey.length === 0) {
    return textResult({
      ok: false,
      error: {
        status: 400,
        message: "upload_attachment requires a non-empty `issueIdOrKey` (string).",
      },
    });
  }

  const filePath = args.filePath;
  if (typeof filePath !== "string" || filePath.length === 0) {
    return textResult({
      ok: false,
      error: {
        status: 400,
        message: "upload_attachment requires a non-empty `filePath` (string).",
      },
    });
  }

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    return textResult({
      ok: false,
      error: {
        status: 404,
        message: `file not found: ${filePath} (${errorMessage(err)})`,
      },
    });
  }

  if (stat.size > MAX_FILE_SIZE) {
    return textResult({
      ok: false,
      error: {
        status: 413,
        message: `file too large: ${stat.size} bytes (max ${MAX_FILE_SIZE})`,
      },
    });
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
    return textResult({
      ok: false,
      error: {
        status: 500,
        message: `upload network error: ${errorMessage(err)}`,
      },
    });
  }

  const text = await res.text();
  if (!res.ok) {
    return textResult({
      ok: false,
      error: {
        status: res.status,
        message: `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
      },
    });
  }

  let items: AttachmentResponseItem[] = [];
  try {
    const parsed = text ? JSON.parse(text) : [];
    if (Array.isArray(parsed)) {
      items = parsed as AttachmentResponseItem[];
    }
  } catch {
    items = [];
  }

  return textResult({
    ok: true,
    method: "upload_attachment",
    request: { issueIdOrKey, filePath, size: stat.size, filename },
    attachments: items,
    summary: {
      issueIdOrKey,
      filePath,
      filename,
      size: stat.size,
      attachmentCount: items.length,
    },
  });
}
