/**
 * jira.request_help — orchestrator asks a human for guidance (0.3.0+).
 *
 * Limited to MAIN tasks (issuetype.subtask === false) — for subtasks use
 * submit_verdict({verdict:FAIL, reason}) instead. Flow:
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
 *
 * Return contract (CP-2710 batch 3, v0.5 §6/§7/§8):
 *   success  → {ok, method, comment{id,self}, label:"wait-approval",
 *                mentioned: accountId|null} (summary 块去除; author.accountId
 *                路径通过 mentioned 字段保留, **红线 #28510**)
 *   partial  → 结构 0 改动, 仅 details 摘要化 (CP-2710 红线 #28510: 错误
 *                信息不静默)
 *   error    → {error}; 不变
 *   details  → <100 字符一句话语义摘要; success 例
 *                "CP-2690 主任务已问人: 评论已发 + wait-approval 标签已加"
 *              partial 例 "CP-2690 部分完成: 评论已发但 label 失败, 见 hint"
 */
import { loadConfig } from "../auth.js";
import { jiraGet, jiraPost, jiraPut, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import { buildRequestHelpComment, validateAdfContentNodes } from "./_adf.js";
import type { ToolResult } from "../types.js";

const WAIT_APPROVAL_LABEL = "wait-approval";

export async function requestHelp(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    return textResult(
      { error: errorMessage(err) },
      `jira_request_help 失败: ${errorMessage(err)}`,
    );
  }

  const issueIdOrKey = args.issueIdOrKey;
  if (typeof issueIdOrKey !== "string" || issueIdOrKey.length === 0) {
    return textResult(
      { error: "request_help requires a non-empty `issueIdOrKey` (string)." },
      "jira_request_help 失败: 缺少 issueIdOrKey",
    );
  }
  const question = args.question;
  if (typeof question !== "string" || question.trim().length === 0) {
    return textResult(
      { error: "request_help requires `question` (string, non-empty)." },
      "jira_request_help 失败: 缺少 question",
    );
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
    return textResult(
      {
        error:
          "request_help: when `mention` (accountId) is set, `mentionDisplayName` is also required. " +
          "Atlassian needs both the routable id and the human-readable text for a mention node.",
      },
      "jira_request_help 失败: mention 缺 displayName",
    );
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
    return textResult(
      { error: `jira.request_help (step 1: get issue) failed: ${msg}.` },
      `jira_request_help 失败: HTTP ${msg}`,
    );
  }
  if (!isMainTask) {
    return textResult(
      {
        error:
          `request_help 只能用于主任务。${issueIdOrKey} is a subtask — use submit_verdict({verdict:FAIL, reason}) instead.`,
      },
      `jira_request_help 失败: ${issueIdOrKey} 非主任务`,
    );
  }

  // Step 2: post the question comment (with optional mention).
  const commentAdf = buildRequestHelpComment(
    question,
    mention,
    mentionDisplayName,
  );

  const contentErr = validateAdfContentNodes(commentAdf as unknown as Record<string, unknown>);
  if (contentErr) {
    return textResult(
      { error: `request_help ADF structure error: ${contentErr}. Please report as a plugin bug.` },
      `jira_request_help 失败: ADF 内部错 ${contentErr}`,
    );
  }

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
    return textResult(
      { error: `jira.request_help (step 2: comment) failed: ${msg}. ` +
        "Label was NOT added." },
      `jira_request_help 失败: 评论发布错误 ${msg}`,
    );
  }

  // Step 3: add the `wait-approval` label.
  try {
    await jiraPut(cfg, `issue/${issueIdOrKey}`, {
      update: { labels: [{ add: WAIT_APPROVAL_LABEL }] },
    });
    const mentioned = mention.length > 0 ? mention : null;
    const mentionSuffix = mentioned ? ` + @提及 ${mentionDisplayName}` : "";
    return textResult(
      {
        ok: true,
        method: "request_help",
        comment: { id: commentId, self: commentSelf },
        mentioned,
        label: WAIT_APPROVAL_LABEL,
      },
      `${issueIdOrKey} 主任务已问人: 评论已发 + ${WAIT_APPROVAL_LABEL} 标签已加${mentionSuffix}`,
    );
  } catch (err) {
    const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
    return textResult(
      {
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
      },
      `${issueIdOrKey} 部分完成: 评论已发但 ${WAIT_APPROVAL_LABEL} label 失败, 见 hint`,
    );
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
