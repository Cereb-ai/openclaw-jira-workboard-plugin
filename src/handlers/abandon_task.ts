/**
 * jira.abandon_task — discard a subtask during re-planning (0.3.1+).
 *
 * Called by the plan agent when the main task is re-planned and existing
 * subtasks are no longer needed.  Semantic difference from submit_verdict:
 * "abandon" = 放弃/废弃 (the work was NOT done); "complete" = 完成 (done).
 *
 * Steps:
 *   1. GET /rest/api/3/issue/{key}  → check fields.issuetype.subtask
 *      - false / not present → fail-fast (abandon_task is subtask-only)
 *      - true                → continue
 *   2. POST /rest/api/3/issue/{key}/comment  (abandon reason)
 *   3. PUT  /rest/api/3/issue/{key}          fields: { assignee: null }
 *   4. GET  /rest/api/3/issue/{key}/transitions  → find "已完成"
 *      POST /rest/api/3/issue/{key}/transitions  → → "已完成"
 *   5. PUT  /rest/api/3/issue/{key}          update: { labels: [{ remove: "escalated" }] }
 *
 * Partial-failure reporting: each later step reports what was already
 * committed so the agent can manually finish what remains.
 *
 * Return contract (CP-2710 batch 3, v0.5 §6/§7/§8):
 *   success  → {ok, method, comment{id,self}, assigneeCleared, labelsRemoved,
 *                labelsRemoveError, transition{id, name, to}} (summary 块
 *                去除; labels 回声去除, 保留布尔 + 错误字符串)
 *   partial  → 结构 0 改动, 仅 details 摘要化 (CP-2710 红线 #28510)
 *   error    → {error}; 不变
 *   details  → <100 字符一句话语义摘要; success 例
 *                "CP-2690 子任务已废弃: 评论 + 清 assignee + 转「已完成」+ 清 escalated"
 *              partial 例 "CP-2690 部分废弃: 评论已发但转态失败, 见 hint"
 */
import { loadConfig } from "../auth.js";
import { jiraGet, jiraPost, jiraPut, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import { validateAdfContentNodes } from "./_adf.js";
import type { ToolResult } from "../types.js";

const TARGET_STATUS = "已完成";
const DEFAULT_LABELS_TO_REMOVE = ["escalated"];

interface AtlassianTransition {
  id: string;
  name: string;
  to?: { name?: string };
}

export async function abandonTask(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    return textResult(
      { error: errorMessage(err) },
      `jira_abandon_task 失败: ${errorMessage(err)}`,
    );
  }

  const issueIdOrKey = args.issueIdOrKey;
  if (typeof issueIdOrKey !== "string" || issueIdOrKey.length === 0) {
    return textResult(
      { error: "abandon_task requires a non-empty `issueIdOrKey` (string)." },
      "jira_abandon_task 失败: 缺少 issueIdOrKey",
    );
  }
  const reason = args.reason;
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return textResult(
      { error: "abandon_task requires `reason` (string, non-empty)." },
      "jira_abandon_task 失败: 缺少 reason",
    );
  }
  const labelsArg = args.labels;
  let labelsToRemove: string[] = DEFAULT_LABELS_TO_REMOVE;
  if (labelsArg !== undefined) {
    if (
      !Array.isArray(labelsArg) ||
      !labelsArg.every(
        (label) => typeof label === "string" && label.trim().length > 0,
      )
    ) {
      return textResult(
        { error: "abandon_task `labels` must be an array of non-empty strings when provided." },
        "jira_abandon_task 失败: labels 形态错",
      );
    }
    labelsToRemove = labelsArg as string[];
  }

  // Step 1: verify the issue is actually a subtask.
  let isSubtask: boolean;
  try {
    const data = (await jiraGet(cfg, `issue/${issueIdOrKey}`, {
      fields: "issuetype",
    })) as { fields?: { issuetype?: { subtask?: boolean } } };
    isSubtask = data?.fields?.issuetype?.subtask === true;
  } catch (err) {
    const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
    return textResult(
      { error: `jira.abandon_task (step 1: get issue) failed: ${msg}.` },
      `jira_abandon_task 失败: HTTP ${msg}`,
    );
  }
  if (!isSubtask) {
    return textResult(
      {
        error:
          `abandon_task 只能用于子任务。${issueIdOrKey} is a main task — use submit_verdict instead.`,
      },
      `jira_abandon_task 失败: ${issueIdOrKey} 非子任务`,
    );
  }

  // Step 2: post the abandon comment.
  const abandonComment: Record<string, unknown> = {
    version: 1,
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "🚫 此子任务已废弃 — ",
          },
        ],
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: reason,
          },
        ],
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "（主任务重新规划，本子任务不再需要）",
          },
        ],
      },
    ],
  } as { version: number; type: string; content: Array<{ type: string; content: Array<{ type: string; text: string }> }> };

  const contentErr = validateAdfContentNodes(abandonComment);
  if (contentErr) {
    return textResult(
      { error: `abandon_task ADF structure error: ${contentErr}. Please report as a plugin bug.` },
      `jira_abandon_task 失败: ADF 内部错 ${contentErr}`,
    );
  }

  let commentId: string | undefined;
  let commentSelf: string | undefined;
  try {
    const data = (await jiraPost(cfg, `issue/${issueIdOrKey}/comment`, {
      body: abandonComment,
    })) as { id?: string; self?: string };
    commentId = data.id;
    commentSelf = data.self;
  } catch (err) {
    const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
    return textResult(
      { error: `jira.abandon_task (step 2: comment) failed: ${msg}. ` +
        "No state change yet." },
      `jira_abandon_task 失败: 评论发布错误 ${msg}`,
    );
  }

  // Step 3: clear the assignee.
  let assigneeCleared = false;
  try {
    await jiraPut(cfg, `issue/${issueIdOrKey}`, {
      fields: { assignee: null },
    });
    assigneeCleared = true;
  } catch (err) {
    const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
    return textResult(
      {
        ok: false,
        method: "abandon_task",
        partial: true,
        comment: { id: commentId, self: commentSelf },
        hint:
          `Comment was posted. To finish: manually clear assignee + transition on ${issueIdOrKey}.`,
        error:
          `jira.abandon_task (step 3: clear assignee) failed: ${msg}. ` +
          `Comment was already posted; assignee NOT cleared.`,
      },
      `${issueIdOrKey} 部分废弃: 评论已发但清 assignee 失败, 见 hint`,
    );
  }

  // Step 4: list transitions.
  let transitions: AtlassianTransition[];
  try {
    const data = (await jiraGet(
      cfg,
      `issue/${issueIdOrKey}/transitions`,
    )) as { transitions?: AtlassianTransition[] };
    transitions = Array.isArray(data?.transitions) ? data.transitions : [];
  } catch (err) {
    const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
    return textResult(
      {
        ok: false,
        method: "abandon_task",
        partial: true,
        comment: { id: commentId, self: commentSelf },
        assigneeCleared,
        error:
          `jira.abandon_task (step 4: list transitions) failed: ${msg}. ` +
          `Comment already posted; assignee ${assigneeCleared ? "cleared" : "NOT cleared"}.`,
      },
      `${issueIdOrKey} 部分废弃: 评论已发但查 transition 失败`,
    );
  }

  if (transitions.length === 0) {
    return textResult(
      {
        ok: false,
        method: "abandon_task",
        partial: true,
        comment: { id: commentId, self: commentSelf },
        assigneeCleared,
        error:
          `No transitions available for ${issueIdOrKey} — may be in a terminal state. ` +
          `Comment already posted; assignee ${assigneeCleared ? "cleared" : "NOT cleared"}.`,
      },
      `${issueIdOrKey} 部分废弃: 评论已发但无可用 transition`,
    );
  }

  const target = TARGET_STATUS.toLowerCase();
  const match = transitions.find(
    (t) => (t.to?.name ?? "").toLowerCase() === target,
  );
  if (!match) {
    const available = transitions.map(
      (t) => `${t.name} → ${t.to?.name ?? "?"}`,
    );
    return textResult(
      {
        ok: false,
        method: "abandon_task",
        partial: true,
        comment: { id: commentId, self: commentSelf },
        assigneeCleared,
        error:
          `targetStatus "${TARGET_STATUS}" not in available transitions: [${available.join(", ")}]. ` +
          `Comment already posted; assignee ${assigneeCleared ? "cleared" : "NOT cleared"}.`,
      },
      `${issueIdOrKey} 部分废弃: 评论已发但无「${TARGET_STATUS}」transition`,
    );
  }

  // Step 4: execute the transition.
  try {
    await jiraPost(cfg, `issue/${issueIdOrKey}/transitions`, {
      transition: { id: match.id },
    });
  } catch (err) {
    const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
    return textResult(
      {
        ok: false,
        method: "abandon_task",
        partial: true,
        comment: { id: commentId, self: commentSelf },
        assigneeCleared,
        error:
          `jira.abandon_task (step 4: execute transition) failed: ${msg}. ` +
          `Comment already posted; assignee ${assigneeCleared ? "cleared" : "NOT cleared"}.`,
      },
      `${issueIdOrKey} 部分废弃: 评论已发但转态失败`,
    );
  }

  let labelsRemoved = true;
  let labelsRemoveError: string | undefined;
  if (labelsToRemove.length > 0) {
    try {
      // Per AGENTS.md T9 + SSSS-765 incident 2026-07-20 02:18 — escalated label must be cleared on abandon to prevent dispatch loop label accumulation
      await jiraPut(cfg, `issue/${issueIdOrKey}`, {
        update: {
          labels: labelsToRemove.map((label) => ({ remove: label })),
        },
      });
    } catch (err) {
      labelsRemoved = false;
      labelsRemoveError = err instanceof JiraHttpError
        ? err.message
        : errorMessage(err);
    }
  }

  return textResult(
    {
      ok: true,
      method: "abandon_task",
      comment: { id: commentId, self: commentSelf },
      assigneeCleared,
      labelsRemoved,
      labelsRemoveError,
      transition: {
        id: match.id,
        name: match.name,
        to: match.to?.name,
      },
    },
    `${issueIdOrKey} 子任务已废弃: 评论 + 清 assignee + 转「${match.to?.name ?? ""}」+ 清 ${labelsToRemove.join(",")}${labelsRemoved ? "" : " (部分 label 清除失败)"}`,
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
