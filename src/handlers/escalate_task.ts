/**
 * jira.escalate_task — bubble a subtask up to a human (orchestrator, 0.3.0+).
 *
 * Steps:
 *   1. GET /rest/api/3/issue/{key}  → check fields.issuetype.subtask
 *      - false / not present → fail-fast (escalate_task is subtask-only)
 *      - true                → continue
 *   2. POST /rest/api/3/issue/{key}/comment  (reason + escalation header)
 *   3. PUT  /rest/api/3/issue/{key}          update: { labels: [{ add: "escalated" }] }
 *   4. PUT  /rest/api/3/issue/{key}          fields: { assignee: null }
 *      (clears the default assignee so a human can pick it up)
 *
 * The order is deliberate: comment first (so the reason is timestamped
 * before any state change), then label, then assignee clear. Each step
 * reports partial progress if a later step fails.
 */
import { loadConfig } from "../auth.js";
import { jiraGet, jiraPost, jiraPut, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import { buildEscalateComment } from "./_adf.js";
import type { ToolResult } from "../types.js";

const ESCALATED_LABEL = "escalated";

export async function escalateTask(
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
      error: "escalate_task requires a non-empty `issueIdOrKey` (string).",
    });
  }
  const reason = args.reason;
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return textResult({
      error: "escalate_task requires `reason` (string, non-empty).",
    });
  }

  // Step 1: verify the issue is actually a subtask.
  let isSubtask: boolean;
  try {
    const data = (await jiraGet(cfg, `issue/${issueIdOrKey}`, {
      fields: "issuetype",
    })) as { fields?: { issuetype?: { subtask?: boolean; name?: string } } };
    const it = data?.fields?.issuetype;
    isSubtask = it?.subtask === true;
  } catch (err) {
    const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
    return textResult({
      error: `jira.escalate_task (step 1: get issue) failed: ${msg}.`,
    });
  }
  if (!isSubtask) {
    return textResult({
      error:
        `escalate_task 只能用于子任务。${issueIdOrKey} is a main task — use request_help instead.`,
    });
  }

  // Step 2: post the escalation comment.
  let commentId: string | undefined;
  let commentSelf: string | undefined;
  try {
    const data = (await jiraPost(cfg, `issue/${issueIdOrKey}/comment`, {
      body: buildEscalateComment(reason),
    })) as { id?: string; self?: string };
    commentId = data.id;
    commentSelf = data.self;
  } catch (err) {
    const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
    return textResult({
      error: `jira.escalate_task (step 2: comment) failed: ${msg}. ` +
        "No state change yet — comment was NOT posted, label was NOT added, assignee NOT cleared.",
    });
  }

  // Step 3: add the `escalated` label.
  let labelOk = false;
  try {
    await jiraPut(cfg, `issue/${issueIdOrKey}`, {
      update: { labels: [{ add: ESCALATED_LABEL }] },
    });
    labelOk = true;
  } catch (err) {
    const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
    return textResult({
      ok: false,
      method: "escalate_task",
      partial: true,
      comment: { id: commentId, self: commentSelf },
      error:
        `jira.escalate_task (step 3: add label) failed: ${msg}. ` +
        `Comment was already posted; label was NOT added; assignee NOT cleared.`,
    });
  }

  // Step 4: clear the assignee.
  let assigneeCleared = false;
  try {
    await jiraPut(cfg, `issue/${issueIdOrKey}`, {
      fields: { assignee: null },
    });
    assigneeCleared = true;
  } catch (err) {
    const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
    return textResult({
      ok: false,
      method: "escalate_task",
      partial: true,
      comment: { id: commentId, self: commentSelf },
      label: ESCALATED_LABEL,
      hint:
        `Comment and label already applied. To finish, run: ` +
        `jira { method: "update", args: { issueIdOrKey: "${issueIdOrKey}", fields: { assignee: null } } }`,
      error:
        `jira.escalate_task (step 4: clear assignee) failed: ${msg}. ` +
        `Comment and label already applied; assignee NOT cleared.`,
    });
  }

  return textResult({
    ok: true,
    method: "escalate_task",
    comment: { id: commentId, self: commentSelf },
    label: ESCALATED_LABEL,
    assigneeCleared,
    summary: {
      key: issueIdOrKey,
      commentId,
      label: ESCALATED_LABEL,
      assigneeCleared: true,
    },
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
