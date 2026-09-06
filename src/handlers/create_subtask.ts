/**
 * jira.create_subtask — POST /rest/api/3/issue (orchestrator template, 0.5.0+).
 *
 * Same 3 plain-text string fields as create_task. issuetype is hard-coded
 * to "子任务" (the standard Jira Cloud subtask type name in CN locales — we
 * keep it as a string literal so callers don't drift). parent and project
 * are BOTH required — Atlassian does NOT reliably infer the project from
 * the parent key in our Jira instance, so the caller must supply it (same
 * contract as create_task).
 *
 * labels is REQUIRED here (no default) because subtasks almost always want
 * a distinguishing tag like "subtask:impl" or "subtask:test" — defaults
 * would just paper over the orchestrator's intent. caller supplies it.
 *
 * `scope` is REQUIRED — 按 label 写 ✅ 负责 / ❌ 不负责. 渲染成 description
 * 的 `## 职责范围` 节。未传或空串 → 错误。scope 文本模板见
 * ~/.openclaw/skills/task-orchestrator/references/labels.md。
 *
 * Optional `block` parameter (0.3.1+) establishes Blocks links on creation:
 *   block.blocks: string[] — new subtask blocks these tickets
 *   block.blockedBy: string[] — these tickets block the new subtask
 * Both directions are optional and independent. Block failures are reported
 * but do not rollback the created subtask.
 *
 * 返回结构 (CP-2693 batch 1, v0.5 提案 RRmzJTZ7Q8 §9 create_subtask 条目):
 *   {ok, method, request{parent, summary, labels}, issue{id, key, self}, block?, block_errors?}
 *   - `request.fields` 全量回声去除 (CP-2384 已拍板, 不重做)
 *   - `summary{key, id, url, parent}` 块去除 + 顶层 `parent` 去除 (与
 *     request.parent 重复, 留 request.parent 为锚) — 与 create_task 同构
 *   - `block` / `block_errors` 结果反馈完整保留 (CP-2384 反断言)
 *   - `details` = <100 字符一句话摘要 (e.g. `成功创建子任务 CP-2695 (父 CP-2690): <summary 前截断>`)
 */
import { loadConfig } from "../auth.js";
import { jiraPost, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import { buildTaskDescription } from "./_adf.js";
import { block } from "./block.js";
import type { ToolResult } from "../types.js";

const SUBTASK_TYPE_NAME = "子任务";

export async function createSubtask(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    return textResult(
      { error: errorMessage(err) },
      `jira_create_subtask 失败: ${errorMessage(err)}`,
    );
  }

  const parent = args.parent;
  if (typeof parent !== "string" || parent.trim().length === 0) {
    return textResult(
      {
        error:
          "create_subtask requires `parent` (string, parent issue key, e.g. 'WTO-100').",
      },
      "jira_create_subtask 失败: 缺 parent",
    );
  }
  const project = args.project;
  if (typeof project !== "string" || project.trim().length === 0) {
    return textResult(
      {
        error:
          "create_subtask requires `project` (string, project key, e.g. 'WTO'). " +
          "Jira does not reliably infer the project from the parent key — " +
          "match what you'd pass to create_task.",
      },
      "jira_create_subtask 失败: 缺 project",
    );
  }
  const summary = args.summary;
  if (typeof summary !== "string" || summary.trim().length === 0) {
    return textResult(
      { error: "create_subtask requires `summary` (string, non-empty)." },
      "jira_create_subtask 失败: 缺 summary",
    );
  }
  const requirements = args.requirements;
  if (typeof requirements !== "string" || requirements.trim().length === 0) {
    return textResult(
      {
        error:
          "create_subtask requires `requirements` (plain text string, non-empty). " +
          "3 fields (requirements / scope / acceptance_criteria) are all plain " +
          "text strings — NOT ADF dict, NOT arrays. See skills/jira/SKILL.md.",
      },
      "jira_create_subtask 失败: 缺 requirements",
    );
  }
  const scope = args.scope;
  if (typeof scope !== "string" || scope.trim().length === 0) {
    return textResult(
      {
        error:
          "create_subtask requires `scope` (string, non-empty). " +
          "Pass 按 labels.md 标注 ✅ 负责 / ❌ 不负责 的职责文本. " +
          "See ~/.openclaw/skills/task-orchestrator/references/labels.md for label → scope mapping.",
      },
      "jira_create_subtask 失败: 缺 scope",
    );
  }
  const acceptanceCriteria = args.acceptance_criteria;
  if (
    typeof acceptanceCriteria !== "string" ||
    acceptanceCriteria.trim().length === 0
  ) {
    return textResult(
      {
        error:
          "create_subtask requires `acceptance_criteria` (plain text string, non-empty). " +
          "NOT a string[]. Use \\n to separate multiple ACs. See skills/jira/SKILL.md.",
      },
      "jira_create_subtask 失败: 缺 acceptance_criteria",
    );
  }
  // labels is required (no default) — see file header.
  const labels = args.labels;
  if (!Array.isArray(labels) || labels.length === 0) {
    return textResult(
      {
        error:
          "create_subtask requires `labels` (string[], non-empty). " +
          "Subtasks need a distinguishing tag like ['subtask:impl'] or ['subtask:test'] — there is no default.",
      },
      "jira_create_subtask 失败: 缺 labels",
    );
  }
  const cleanLabels = labels.filter(
    (l): l is string => typeof l === "string" && l.length > 0,
  );
  if (cleanLabels.length === 0) {
    return textResult(
      { error: "create_subtask `labels` must contain at least one non-empty string." },
      "jira_create_subtask 失败: labels 全为空",
    );
  }

  const description = buildTaskDescription(
    requirements,
    scope,
    acceptanceCriteria,
  );

  // project is required (caller-supplied). parent key is validated above
  // but Jira still wants both fields set explicitly.
  const fields: Record<string, unknown> = {
    project: { key: project },
    parent: { key: parent },
    issuetype: { name: SUBTASK_TYPE_NAME },
    summary,
    description,
    labels: cleanLabels,
  };
  if (cfg.defaultAssigneeAccountId.length > 0) {
    fields.assignee = { accountId: cfg.defaultAssigneeAccountId };
  }

  // --- optional block relationships (0.3.1+) ---
  let blockErrors: string[] = [];
  let blockPlan: Array<{ direction: string; keys: string[] }> = [];
  const blockParam = args.block as Record<string, unknown> | undefined;
  if (blockParam && typeof blockParam === "object") {
    const blocks = blockParam.blocks;
    const blockedBy = blockParam.blockedBy;
    if (Array.isArray(blocks) && blocks.length > 0) {
      blockPlan.push({ direction: "blocks", keys: blocks as string[] });
    }
    if (Array.isArray(blockedBy) && blockedBy.length > 0) {
      blockPlan.push({ direction: "blockedBy", keys: blockedBy as string[] });
    }
  }

  try {
    const data = (await jiraPost(cfg, "issue", { fields })) as {
      id?: string;
      key?: string;
      self?: string;
    };
    const newKey = data.key;

    // establish block relationships
    if (newKey && blockParam && typeof blockParam === "object") {
      const blocks = blockParam.blocks;
      const blockedBy = blockParam.blockedBy;

      if (Array.isArray(blocks)) {
        for (const target of blocks) {
          if (typeof target === "string" && target.trim().length > 0) {
            const r = await block({ blocker: newKey, blocked: target });
            const d = r.details as Record<string, unknown> | undefined;
            if (d && !d.ok) {
              blockErrors.push(`blocks ${target}: ${d.error ?? JSON.stringify(d)}`);
            }
          }
        }
      }
      if (Array.isArray(blockedBy)) {
        for (const target of blockedBy) {
          if (typeof target === "string" && target.trim().length > 0) {
            const r = await block({ blocker: target, blocked: newKey });
            const d = r.details as Record<string, unknown> | undefined;
            if (d && !d.ok) {
              blockErrors.push(`blockedBy ${target}: ${d.error ?? JSON.stringify(d)}`);
            }
          }
        }
      }
    }

    const result: Record<string, unknown> = {
      ok: true,
      method: "create_subtask",
      // CP-2384 AC2: strip the `request.fields` echo — it carried the full
      // ADF description (requirements / scope / acceptance_criteria rendered
      // by buildTaskDescription), which is just the agent's own input
      // bounced back. Keep the key-class identifiers only.
      request: { parent, summary, labels: cleanLabels },
      // CP-2693 batch 1: drop `summary{key,id,url,parent}` + 顶层 `parent`
      // (与 request.parent 重复). 与 create_task 同构收敛.
      issue: { id: data.id, key: data.key, self: data.self },
      block: blockPlan.length > 0 ? blockPlan : undefined,
    };
    if (blockErrors.length > 0) {
      result.block_errors = blockErrors;
    }
    return textResult(
      result,
      createSubtaskDetailsSummary(data.key, parent, summary),
    );
  } catch (err) {
    if (err instanceof JiraHttpError) {
      return textResult(
        { error: `jira.create_subtask failed: ${err.message}` },
        `jira_create_subtask 失败: HTTP ${err.status} ${err.statusText}`,
      );
    }
    return textResult(
      { error: `jira.create_subtask failed: ${errorMessage(err)}` },
      `jira_create_subtask 失败: ${errorMessage(err)}`,
    );
  }
}

function createSubtaskDetailsSummary(
  newKey: string | undefined,
  parent: string,
  summary: string,
): string {
  // 形如: "成功创建子任务 CP-2695 (父 CP-2690): <summary 前截断>"
  const keyPart = newKey ?? "?";
  const head = `成功创建子任务 ${keyPart} (父 ${parent}): `;
  const headroom = 99 - head.length;
  if (headroom <= 0) return head.trimEnd();
  const tail = summary.length <= headroom
    ? summary
    : summary.slice(0, Math.max(0, headroom - 1)) + "…";
  return head + tail;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}