/**
 * jira.add_label — append a single label to an issue.
 *
 * PUT /rest/api/3/issue/{issueIdOrKey}
 *   body: { update: { labels: [{ add: label }] } }
 *
 * Atlassian returns 204 No Content on success. Adding a label that already
 * exists is a no-op (idempotent) — we still report ok:true.
 *
 * Why the `update` envelope rather than `fields.labels`? Two reasons:
 *   1. `fields.labels` is a *replace* semantics — it would clobber other
 *      labels. The `update` array supports append/remove per item.
 *   2. This matches the shape of remove_label and the documented "Edit
 *      issue" → "Modify labels" pattern in Atlassian's REST docs.
 */
import { loadConfig } from "../auth.js";
import { jiraPut, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import type { ToolResult } from "../types.js";

export async function addLabel(
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
      error: "add_label requires a non-empty `issueIdOrKey` (string) argument.",
    });
  }
  const label = args.label;
  if (typeof label !== "string" || label.trim().length === 0) {
    return textResult({
      error: "add_label requires a non-empty `label` (string) argument.",
    });
  }

  try {
    await jiraPut(cfg, `issue/${issueIdOrKey}`, {
      update: { labels: [{ add: label }] },
    });
    return textResult({
      ok: true,
      method: "add_label",
      request: { issueIdOrKey, label },
      summary: {
        key: issueIdOrKey,
        label,
        action: "added",
      },
      ...(LABEL_HINTS[label] ? { hint: LABEL_HINTS[label] } : {}),
    });
  } catch (err) {
    if (err instanceof JiraHttpError) {
      return textResult({ error: `jira.add_label failed: ${err.message}` });
    }
    return textResult({ error: `jira.add_label failed: ${errorMessage(err)}` });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const LABEL_HINTS: Record<string, string> = {
  "wait-approval": "wait-approval 必须配套做：调用 jira comment（带 mentionMap）@mention 责任人，否则对方收不到通知。",
};
