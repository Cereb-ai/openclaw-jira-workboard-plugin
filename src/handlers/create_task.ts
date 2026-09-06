/**
 * jira.create_task — POST /rest/api/3/issue (orchestrator template, 0.5.0+).
 *
 * 3 plain-text string 字段，plugin 自动加 ## section heading:
 *   requirements → ## 任务说明       (Why + What + ≤ 1-2 句非目标, ≤ 600 字)
 *   scope        → ## 职责范围       (✅ 负责 / ❌ 不负责 bullets)
 *   acceptance_criteria → ## 验收标准 (bullets，每条 AC 含断言+反断言)
 *
 * requirements 末尾用 `📖 参考 Runbook：[title §X](url)` 行挂关联资料
 * （格式见 ~/.openclaw/skills/task-creator/SKILL.md "描述引用格式"）。
 * 严禁 requirements 含: 工作流步骤 / scope 内容 / AC 内容 / 长背景 (>3 句) /
 * 选型理由。详规则见 SKILL.md。
 *
 * `scope` is REQUIRED — 未传或空串 → 错误。scope 文本模板见
 * ~/.openclaw/skills/task-orchestrator/references/labels.md。
 *
 * assignees default to `defaultAssigneeAccountId` (from cfg or
 * JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID env). Missing → assignee field skipped
 * (issue stays unassigned). labels default to `["plan"]`. issuetype is
 * always "Task" — for subtasks, use create_subtask.
 *
 * Optional `block` parameter (0.5.2+) establishes Blocks links on creation,
 * mirroring create_subtask's contract:
 *   block.blocks: string[] — new main task blocks these tickets
 *   block.blockedBy: string[] — these tickets block the new main task
 * Both directions are optional and independent. Block failures are reported
 * but do not rollback the created task.
 *
 * 返回结构 (CP-2693 batch 1, v0.5 提案 RRmzJTZ7Q8 §8 create_task 条目):
 *   {ok, method, request{project, summary, labels}, issue{id, key, self}, block?, block_errors?}
 *   - `request: {fields}` 全量回声去除 (对齐 create_subtask CP-2384 已拍板模式,
 *     fields 含 buildTaskDescription 渲染的 ADF description 1-3KB+, 是 12 工具
 *     单点最大冗余)
 *   - `summary{key, id, url}` 块去除 (issue{key, id, self} 已覆盖)
 *   - `block` / `block_errors` 结果反馈完整保留 (CP-2384 反断言)
 *   - `details` = <100 字符一句话摘要 (e.g. `成功创建主任务 CP-2691: <summary 前截断>`)
 */
import { loadConfig } from "../auth.js";
import { jiraPost, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import { buildTaskDescription } from "./_adf.js";
import { block } from "./block.js";
import type { ToolResult } from "../types.js";

const DEFAULT_LABELS = ["plan"];
const DEFAULT_PRIORITY = "Medium";
const DEFAULT_ISSUETYPE = "Task";

export async function createTask(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    return textResult(
      { error: errorMessage(err) },
      `jira_create_task 失败: ${errorMessage(err)}`,
    );
  }

  // project is the only "context" field the caller still has to pass.
  // Template / structure / assignee / labels are all locked below.
  const project = args.project;
  if (typeof project !== "string" || project.trim().length === 0) {
    return textResult(
      { error: "create_task requires `project` (string, project key, e.g. 'WTO')." },
      "jira_create_task 失败: 缺 project",
    );
  }
  const summary = args.summary;
  if (typeof summary !== "string" || summary.trim().length === 0) {
    return textResult(
      { error: "create_task requires `summary` (string, non-empty)." },
      "jira_create_task 失败: 缺 summary",
    );
  }
  const requirements = args.requirements;
  if (typeof requirements !== "string" || requirements.trim().length === 0) {
    return textResult(
      {
        error:
          "create_task requires `requirements` (plain text string, non-empty). " +
          "3 fields (requirements / scope / acceptance_criteria) are all plain " +
          "text strings — NOT ADF dict, NOT arrays. See skills/jira/SKILL.md.",
      },
      "jira_create_task 失败: 缺 requirements",
    );
  }
  // requirements 字段粒度 sanity check — 防 caller 把整 ticket doc 塞进 requirements
  if (requirements.length > 600) {
    return textResult(
      {
        error: `requirements 字段长度 ${requirements.length} > 600。` +
          `它是"任务说明"section,不是整个 ticket doc。` +
          `长背景 / 选型理由 → wiki;scope/AC → 对应字段。` +
          `Runbook 引用 → 📖 参考 Runbook：[title §X](url) 格式（详见 task-creator SKILL.md）。`,
      },
      "jira_create_task 失败: requirements > 600 字符",
    );
  }
  if (/\*\*断言\*\*|AC\d+:|✅ 负责|❌ 不负责/.test(requirements)) {
    return textResult(
      {
        error: `requirements 字段含疑似 AC 或 Scope 内容（"**断言**" / "AC1:" / "✅ 负责"）。` +
          `这些应该分别放 acceptance_criteria / scope 字段,不是任务说明。`,
      },
      "jira_create_task 失败: requirements 字段混入 AC/Scope",
    );
  }
  const scope = args.scope;
  if (typeof scope !== "string" || scope.trim().length === 0) {
    return textResult(
      {
        error:
          "create_task requires `scope` (string, non-empty). " +
          "Pass 按 labels.md 标注 ✅ 负责 / ❌ 不负责 的职责文本. " +
          "See ~/.openclaw/skills/task-orchestrator/references/labels.md for label → scope mapping.",
      },
      "jira_create_task 失败: 缺 scope",
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
          "create_task requires `acceptance_criteria` (plain text string, non-empty). " +
          "NOT a string[]. Use \\n to separate multiple ACs, e.g. 'AC1: ...\\nAC2: ...'. " +
          "See skills/jira/SKILL.md.",
      },
      "jira_create_task 失败: 缺 acceptance_criteria",
    );
  }

  // Optional: priority (default Medium). labels always includes "plan"
  // (tool contract: "plan label is auto-added"), then any extra labels.
  const priority =
    typeof args.priority === "string" && args.priority.trim().length > 0
      ? args.priority
      : DEFAULT_PRIORITY;
  const extraLabels =
    Array.isArray(args.labels) && args.labels.length > 0
      ? (args.labels as unknown[]).filter(
          (l): l is string => typeof l === "string" && l.length > 0,
        )
      : [];
  const labels = ["plan", ...extraLabels];

  const description = buildTaskDescription(
    requirements,
    scope,
    acceptanceCriteria,
  );

  const fields: Record<string, unknown> = {
    project: { key: project },
    issuetype: { name: DEFAULT_ISSUETYPE },
    summary,
    description,
    priority: { name: priority },
    labels,
  };
  if (cfg.defaultAssigneeAccountId.length > 0) {
    fields.assignee = { accountId: cfg.defaultAssigneeAccountId };
  }

  // --- optional block relationships (0.5.2+) ---
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

    // establish block relationships (mirror create_subtask.ts:155-182)
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
      method: "create_task",
      // CP-2384 AC2 + CP-2693 batch 1: strip `request: {fields}` echo (12 工具
      // 单点最大冗余 — 含 buildTaskDescription 生成的 ADF description 1-3KB+,
      // 完全就是 agent 自己的输入 bounce back). 与 create_subtask 同构 (a89b512
      // L186-190), 只留 key 类 project/summary/labels.
      request: { project, summary, labels },
      issue: { id: data.id, key: data.key, self: data.self },
      block: blockPlan.length > 0 ? blockPlan : undefined,
    };
    if (blockErrors.length > 0) {
      result.block_errors = blockErrors;
    }
    return textResult(result, createTaskDetailsSummary(data.key, summary));
  } catch (err) {
    if (err instanceof JiraHttpError) {
      return textResult(
        { error: `jira.create_task failed: ${err.message}` },
        `jira_create_task 失败: HTTP ${err.status} ${err.statusText}`,
      );
    }
    return textResult(
      { error: `jira.create_task failed: ${errorMessage(err)}` },
      `jira_create_task 失败: ${errorMessage(err)}`,
    );
  }
}

function createTaskDetailsSummary(newKey: string | undefined, summary: string): string {
  // summary 太长 → 截断 + 尾部标记. 整条 < 100 字符.
  const keyPrefix = newKey ? `成功创建主任务 ${newKey}: ` : "成功创建主任务: ";
  const headroom = 99 - keyPrefix.length;
  if (headroom <= 0) return keyPrefix.trimEnd();
  const head = summary.length <= headroom
    ? summary
    : summary.slice(0, Math.max(0, headroom - 1)) + "…";
  return keyPrefix + head;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
