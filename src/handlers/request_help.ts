/**
 * jira.request_help — orchestrator asks a human for guidance (0.3.0+).
 *
 * Limited to MAIN tasks (issuetype.subtask === false) — for subtasks use
 * escalate_task instead. Flow:
 *
 *   1. GET /rest/api/3/issue/{key}        → verify it's a main task
 *      (subtask? → fail-fast, "request_help 只能用于主任务")
 *   2. POST /rest/api/3/issue/{key}/comment (question + optional @mention)
 *   3. PUT  /rest/api/3/issue/{key}        add label "wait-approval"
 *
 * We deliberately do NOT clear the assignee here — the orchestrator is
 * still the owner; the human's job is to answer, not to take over. The
 * `wait-approval` label is the human's queue signal.
 *
 * The mention is optional. When supplied we need the display name for the
 * `text` attr (Atlassian requires both id and text on a mention node — the
 * id is the routable accountId, the text is what the UI renders). We do
 * NOT validate the mention against an accountId lookup — the orchestrator
 * is the source of truth, and the mention will simply 400 if the id is
 * bogus (Atlassian tells us clearly in that case).
 */
import { loadConfig } from "../auth.js";
import { jiraGet, jiraPost, jiraPut, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import { buildRequestHelpComment } from "./_adf.js";
import type { ToolResult } from "../types.js";

const WAIT_APPROVAL_LABEL = "wait-approval";

export async function requestHelp(
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
      error: "request_help requires a non-empty `issueIdOrKey` (string).",
    });
  }
  const question = args.question;
  if (typeof question !== "string" || question.trim().length === 0) {
    return textResult({
      error: "request_help requires `question` (string, non-empty).",
    });
  }
  // mention is optional. When present, must be a non-empty string accountId.
  // mentionDisplayName is required alongside it (the @mentioned user shows
  // up by display name in the UI; we can't derive that from accountId).
  const mention =
    typeof args.mention === "string" && args.mention.length > 0
      ? args.mention
      : "";
  const mentionDisplayName =
    typeof args.mentionDisplayName === "string" &&
    args.mentionDisplayName.length > 0
      ? args.mentionDisplayName
      : "";
  if (mention.length > 0 && mentionDisplayName.length === 0) {
    return textResult({
      error:
        "request_help: when `mention` (accountId) is set, `mentionDisplayName` is also required. " +
        "Atlassian needs both the routable id and the human-readable text for a mention node.",
    });
  }

  // Step 1: verify the issue is a main task.
  let isMainTask: boolean;
  try {
    const data = (await jiraGet(cfg, `issue/${issueIdOrKey}`, {
      fields: "issuetype",
    })) as { fields?: { issuetype?: { subtask?: boolean; name?: string } } };
    const it = data?.fields?.issuetype;
    // Main task = subtask is false or missing. We reject explicit subtask.
    isMainTask = it?.subtask === false;
  } catch (err) {
    const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
    return textResult({
      error: `jira.request_help (step 1: get issue) failed: ${msg}.`,
    });
  }
  if (!isMainTask) {
    return textResult({
      error:
        `request_help 只能用于主任务。${issueIdOrKey} is a subtask — use escalate_task instead.`,
    });
  }

  // Step 2: post the question comment (with optional mention).
  const commentAdf = buildRequestHelpComment(
    question,
    mention,
    mentionDisplayName,
  );
  let commentId: string | undefined;
  let commentSelf: string | undefined;
  try {
    const data = (await jiraPost(cfg, `issue/${issueIdOrKey}/comment`, {
      body: commentAdf,
    })) as { id?: string; self?: string };
    commentId = data.id;
    commentSelf = data.self;
  } catch (err) {
    const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
    return textResult({
      error: `jira.request_help (step 2: comment) failed: ${msg}. ` +
        "Label was NOT added.",
    });
  }

  // Step 3: add the `wait-approval` label.
  try {
    await jiraPut(cfg, `issue/${issueIdOrKey}`, {
      update: { labels: [{ add: WAIT_APPROVAL_LABEL }] },
    });
    return textResult({
      ok: true,
      method: "request_help",
      comment: { id: commentId, self: commentSelf },
      mentioned: mention.length > 0 ? mention : null,
      label: WAIT_APPROVAL_LABEL,
      summary: {
        key: issueIdOrKey,
        commentId,
        label: WAIT_APPROVAL_LABEL,
        mentioned: mention.length > 0 ? mention : null,
      },
    });
  } catch (err) {
    const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
    return textResult({
      ok: false,
      method: "request_help",
      partial: true,
      comment: { id: commentId, self: commentSelf },
      hint:
        `Comment was posted (id=${commentId}) but the label add failed: ${msg}. ` +
        `You can finish manually: jira { method: "add_label", args: { issueIdOrKey: "${issueIdOrKey}", label: "${WAIT_APPROVAL_LABEL}" } }`,
      error:
        `jira.request_help (step 3: add label) failed: ${msg}. ` +
        `Comment was already posted; label was NOT added.`,
    });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
