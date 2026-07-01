/**
 * jira.list_attachments — list all attachment metadata on a ticket.
 *
 * REST: GET /rest/api/3/issue/{issueIdOrKey}?fields=attachment
 *
 * Why a separate tool from jira_get (which now also includes attachment by
 * default with a 20-item cap)? Because a ticket can have 50+ attachments
 * (e.g. test screenshots, design files). The default cap in jira_get is
 * meant to keep the typical read cheap; if the agent actually needs to
 * enumerate all attachments (e.g. "find the screenshot from last week"),
 * this tool returns the full list with no cap.
 *
 * Returns: array of attachment metadata objects (id, filename, size,
 * mimeType, content URL, thumbnail URL, author, created). NO file content —
 * use jira_get_attachment for the actual bytes.
 */
import { loadConfig } from "../auth.js";
import { jiraGet, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import type { ToolResult } from "../types.js";

interface AttachmentMeta {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  created: string;
  author?: { displayName?: string; accountId?: string };
  content: string;
  thumbnail?: string;
}

export async function listAttachments(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    return textResult({ error: errorMessage(err) });
  }

  const issueIdOrKey = args.issueIdOrKey;
  if (typeof issueIdOrKey !== "string" || issueIdOrKey.length === 0) {
    return textResult({
      error: "list_attachments requires a non-empty `issueIdOrKey` (string).",
    });
  }

  try {
    const data = (await jiraGet(cfg, `issue/${issueIdOrKey}`, {
      fields: "attachment",
    })) as { fields?: { attachment?: AttachmentMeta[] } };
    const atts = data?.fields?.attachment ?? [];
    return textResult({
      ok: true,
      method: "list_attachments",
      request: { issueIdOrKey },
      count: atts.length,
      attachments: atts,
      summary: {
        key: issueIdOrKey,
        attachmentCount: atts.length,
      },
    });
  } catch (err) {
    if (err instanceof JiraHttpError) {
      return textResult({
        error: `jira.list_attachments failed: ${err.message}`,
      });
    }
    return textResult({ error: `jira.list_attachments failed: ${errorMessage(err)}` });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
