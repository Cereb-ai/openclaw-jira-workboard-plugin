/**
 * jira.create_subtask — POST /rest/api/3/issue (orchestrator template, 0.3.0+).
 *
 * Replaces the generic `create` for orchestrator-driven subtask creation.
 * Same ADF description template as create_task. issuetype is hard-coded to
 * "子任务" (the standard Jira Cloud subtask type name in CN locales — we
 * keep it as a string literal so callers don't drift). parent and project
 * are BOTH required — Atlassian does NOT reliably infer the project from
 * the parent key in our Jira instance, so the caller must supply it (same
 * contract as create_task).
 *
 * labels is REQUIRED here (no default) because subtasks almost always want
 * a distinguishing tag like "subtask:impl" or "subtask:test" — defaults
 * would just paper over the orchestrator's intent. caller supplies it.
 *
 * `scope` is REQUIRED (0.3.3+) — 按 label 写 ✅ 负责 / ❌ 不负责. 渲染成 description
 * 的 `## 职责范围` 节。未传或空串 → 错误。scope 文本模板见
 * ~/.openclaw/skills/task-orchestrator/references/labels.md。
 *
 * Optional `block` parameter (0.3.1+) establishes Blocks links on creation:
 *   block.blocks: string[] — new subtask blocks these tickets
 *   block.blockedBy: string[] — these tickets block the new subtask
 * Both directions are optional and independent. Block failures are reported
 * but do not rollback the created subtask.
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
    return textResult({ error: errorMessage(err) });
  }

  const parent = args.parent;
  if (typeof parent !== "string" || parent.trim().length === 0) {
    return textResult({
      error: "create_subtask requires `parent` (string, parent issue key, e.g. 'WTO-100').",
    });
  }
  const project = args.project;
  if (typeof project !== "string" || project.trim().length === 0) {
    return textResult({
      error:
        "create_subtask requires `project` (string, project key, e.g. 'WTO'). " +
        "Jira does not reliably infer the project from the parent key — " +
        "match what you'd pass to create_task.",
    });
  }
  const summary = args.summary;
  if (typeof summary !== "string" || summary.trim().length === 0) {
    return textResult({
      error: "create_subtask requires `summary` (string, non-empty).",
    });
  }
  const requirements = args.requirements;
  if (typeof requirements !== "string" || requirements.length === 0) {
    return textResult({
      error: "create_subtask requires `requirements` (string, non-empty).",
    });
  }
  const scope = args.scope;
  if (typeof scope !== "string" || scope.trim().length === 0) {
    return textResult({
      error:
        "create_subtask requires `scope` (string, non-empty). " +
        "Pass 按 labels.md 标注 ✅ 负责 / ❌ 不负责 的职责文本. " +
        "See ~/.openclaw/skills/task-orchestrator/references/labels.md for label → scope mapping.",
    });
  }
  const acceptanceCriteria = args.acceptance_criteria;
  if (
    !Array.isArray(acceptanceCriteria) ||
    acceptanceCriteria.length === 0
  ) {
    return textResult({
      error: "create_subtask requires `acceptance_criteria` (string[], at least one item).",
    });
  }
  if (
    !acceptanceCriteria.every(
      (c) => typeof c === "string" && c.length > 0,
    )
  ) {
    return textResult({
      error: "create_subtask `acceptance_criteria` must be an array of non-empty strings.",
    });
  }
  // labels is required (no default) — see file header.
  const labels = args.labels;
  if (!Array.isArray(labels) || labels.length === 0) {
    return textResult({
      error:
        "create_subtask requires `labels` (string[], non-empty). " +
        "Subtasks need a distinguishing tag like ['subtask:impl'] or ['subtask:test'] — there is no default.",
    });
  }
  const cleanLabels = labels.filter(
    (l): l is string => typeof l === "string" && l.length > 0,
  );
  if (cleanLabels.length === 0) {
    return textResult({
      error: "create_subtask `labels` must contain at least one non-empty string.",
    });
  }

  const description = buildTaskDescription(
    requirements,
    scope,
    acceptanceCriteria as string[],
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
      request: { fields },
      issue: { id: data.id, key: data.key, self: data.self },
      parent,
      summary: { key: data.key, id: data.id, url: data.self, parent },
      block: blockPlan.length > 0 ? blockPlan : undefined,
    };
    if (blockErrors.length > 0) {
      result.block_errors = blockErrors;
    }
    return textResult(result);
  } catch (err) {
    if (err instanceof JiraHttpError) {
      return textResult({ error: `jira.create_subtask failed: ${err.message}` });
    }
    return textResult({ error: `jira.create_subtask failed: ${errorMessage(err)}` });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
