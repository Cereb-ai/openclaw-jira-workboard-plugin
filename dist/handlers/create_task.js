/**
 * jira.create_task — POST /rest/api/3/issue (orchestrator template, 0.3.0+).
 *
 * Replaces the generic `create` for orchestrator-driven main-task creation.
 * The ADF description template is locked in:
 *
 *   ## 任务说明
 *   <requirements>
 *
 *   ## 职责范围       ← 0.3.3+: scope 是必填
 *   <scope>             (按 label 写 ✅ 负责 / ❌ 不负责)
 *
 *   ## 验收标准
 *   1. <criterion 1>
 *   2. <criterion 2>
 *   ...
 *
 * `scope` is REQUIRED (0.3.3+) — 未传或空串 → 错误。scope 文本模板见
 * ~/.openclaw/skills/task-orchestrator/references/labels.md。
 *
 * assignees default to `defaultAssigneeAccountId` (from cfg or
 * JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID env). Missing → assignee field skipped
 * (issue stays unassigned). labels default to `["plan"]`. issuetype is
 * always "Task" — for subtasks, use create_subtask.
 */
import { loadConfig } from "../auth.js";
import { jiraPost, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import { buildTaskDescription } from "./_adf.js";
const DEFAULT_LABELS = ["plan"];
const DEFAULT_PRIORITY = "Medium";
const DEFAULT_ISSUETYPE = "Task";
export async function createTask(args) {
    let cfg;
    try {
        cfg = loadConfig();
    }
    catch (err) {
        return textResult({ error: errorMessage(err) });
    }
    // project is the only "context" field the caller still has to pass.
    // Template / structure / assignee / labels are all locked below.
    const project = args.project;
    if (typeof project !== "string" || project.trim().length === 0) {
        return textResult({
            error: "create_task requires `project` (string, project key, e.g. 'WTO').",
        });
    }
    const summary = args.summary;
    if (typeof summary !== "string" || summary.trim().length === 0) {
        return textResult({
            error: "create_task requires `summary` (string, non-empty).",
        });
    }
    const requirements = args.requirements;
    if (typeof requirements !== "string" || requirements.length === 0) {
        return textResult({
            error: "create_task requires `requirements` (string, non-empty).",
        });
    }
    const scope = args.scope;
    if (typeof scope !== "string" || scope.trim().length === 0) {
        return textResult({
            error: "create_task requires `scope` (string, non-empty). " +
                "Pass 按 labels.md 标注 ✅ 负责 / ❌ 不负责 的职责文本. " +
                "See ~/.openclaw/skills/task-orchestrator/references/labels.md for label → scope mapping.",
        });
    }
    const acceptanceCriteria = args.acceptance_criteria;
    if (!Array.isArray(acceptanceCriteria) ||
        acceptanceCriteria.length === 0) {
        return textResult({
            error: "create_task requires `acceptance_criteria` (string[], at least one item).",
        });
    }
    const allStrings = acceptanceCriteria.every((c) => typeof c === "string" && c.length > 0);
    if (!allStrings) {
        return textResult({
            error: "create_task `acceptance_criteria` must be an array of non-empty strings.",
        });
    }
    // Optional: priority (default Medium), labels (default ["plan"]).
    const priority = typeof args.priority === "string" && args.priority.trim().length > 0
        ? args.priority
        : DEFAULT_PRIORITY;
    const labels = Array.isArray(args.labels) && args.labels.length > 0
        ? args.labels.filter((l) => typeof l === "string" && l.length > 0)
        : DEFAULT_LABELS;
    const description = buildTaskDescription(requirements, scope, acceptanceCriteria);
    const fields = {
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
    try {
        const data = (await jiraPost(cfg, "issue", { fields }));
        return textResult({
            ok: true,
            method: "create_task",
            request: { fields },
            issue: { id: data.id, key: data.key, self: data.self },
            summary: { key: data.key, id: data.id, url: data.self },
        });
    }
    catch (err) {
        if (err instanceof JiraHttpError) {
            return textResult({ error: `jira.create_task failed: ${err.message}` });
        }
        return textResult({ error: `jira.create_task failed: ${errorMessage(err)}` });
    }
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
