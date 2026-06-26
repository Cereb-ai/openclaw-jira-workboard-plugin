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
 *   5. POST /rest/api/3/issue/{key}/transitions  → → "已完成"
 *
 * Partial-failure reporting: each later step reports what was already
 * committed so the agent can manually finish what remains.
 */
import { loadConfig } from "../auth.js";
import { jiraGet, jiraPost, jiraPut, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import { validateAdfContentNodes } from "./_adf.js";
const TARGET_STATUS = "已完成";
export async function abandonTask(args) {
    let cfg;
    try {
        cfg = loadConfig();
    }
    catch (err) {
        return textResult({ error: errorMessage(err) });
    }
    const issueIdOrKey = args.issueIdOrKey;
    if (typeof issueIdOrKey !== "string" || issueIdOrKey.length === 0) {
        return textResult({
            error: "abandon_task requires a non-empty `issueIdOrKey` (string).",
        });
    }
    const reason = args.reason;
    if (typeof reason !== "string" || reason.trim().length === 0) {
        return textResult({
            error: "abandon_task requires `reason` (string, non-empty).",
        });
    }
    // Step 1: verify the issue is actually a subtask.
    let isSubtask;
    try {
        const data = (await jiraGet(cfg, `issue/${issueIdOrKey}`, {
            fields: "issuetype",
        }));
        isSubtask = data?.fields?.issuetype?.subtask === true;
    }
    catch (err) {
        const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
        return textResult({
            error: `jira.abandon_task (step 1: get issue) failed: ${msg}.`,
        });
    }
    if (!isSubtask) {
        return textResult({
            error: `abandon_task 只能用于子任务。${issueIdOrKey} is a main task — use submit_verdict instead.`,
        });
    }
    // Step 2: post the abandon comment.
    const abandonComment = {
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
    };
    const contentErr = validateAdfContentNodes(abandonComment);
    if (contentErr) {
        return textResult({
            error: `abandon_task ADF structure error: ${contentErr}. Please report as a plugin bug.`,
        });
    }
    let commentId;
    let commentSelf;
    try {
        const data = (await jiraPost(cfg, `issue/${issueIdOrKey}/comment`, {
            body: abandonComment,
        }));
        commentId = data.id;
        commentSelf = data.self;
    }
    catch (err) {
        const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
        return textResult({
            error: `jira.abandon_task (step 2: comment) failed: ${msg}. ` +
                "No state change yet.",
        });
    }
    // Step 3: clear the assignee.
    let assigneeCleared = false;
    try {
        await jiraPut(cfg, `issue/${issueIdOrKey}`, {
            fields: { assignee: null },
        });
        assigneeCleared = true;
    }
    catch (err) {
        const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
        return textResult({
            ok: false,
            method: "abandon_task",
            partial: true,
            comment: { id: commentId, self: commentSelf },
            hint: `Comment was posted. To finish: manually clear assignee + transition on ${issueIdOrKey}.`,
            error: `jira.abandon_task (step 3: clear assignee) failed: ${msg}. ` +
                `Comment was already posted; assignee NOT cleared.`,
        });
    }
    // Step 4: list transitions.
    let transitions;
    try {
        const data = (await jiraGet(cfg, `issue/${issueIdOrKey}/transitions`));
        transitions = Array.isArray(data?.transitions) ? data.transitions : [];
    }
    catch (err) {
        const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
        return textResult({
            ok: false,
            method: "abandon_task",
            partial: true,
            comment: { id: commentId, self: commentSelf },
            assigneeCleared,
            error: `jira.abandon_task (step 4: list transitions) failed: ${msg}. ` +
                `Comment already posted; assignee ${assigneeCleared ? "cleared" : "NOT cleared"}.`,
        });
    }
    if (transitions.length === 0) {
        return textResult({
            ok: false,
            method: "abandon_task",
            partial: true,
            comment: { id: commentId, self: commentSelf },
            assigneeCleared,
            error: `No transitions available for ${issueIdOrKey} — may be in a terminal state. ` +
                `Comment already posted; assignee ${assigneeCleared ? "cleared" : "NOT cleared"}.`,
        });
    }
    const target = TARGET_STATUS.toLowerCase();
    const match = transitions.find((t) => (t.to?.name ?? "").toLowerCase() === target);
    if (!match) {
        const available = transitions.map((t) => `${t.name} → ${t.to?.name ?? "?"}`);
        return textResult({
            ok: false,
            method: "abandon_task",
            partial: true,
            comment: { id: commentId, self: commentSelf },
            assigneeCleared,
            error: `targetStatus "${TARGET_STATUS}" not in available transitions: [${available.join(", ")}]. ` +
                `Comment already posted; assignee ${assigneeCleared ? "cleared" : "NOT cleared"}.`,
        });
    }
    // Step 5: execute the transition.
    try {
        await jiraPost(cfg, `issue/${issueIdOrKey}/transitions`, {
            transition: { id: match.id },
        });
        return textResult({
            ok: true,
            method: "abandon_task",
            comment: { id: commentId, self: commentSelf },
            assigneeCleared,
            transition: {
                id: match.id,
                name: match.name,
                to: match.to?.name,
            },
            summary: {
                key: issueIdOrKey,
                commentId,
                assigneeCleared: true,
                transitionedTo: match.to?.name,
            },
        });
    }
    catch (err) {
        const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
        return textResult({
            ok: false,
            method: "abandon_task",
            partial: true,
            comment: { id: commentId, self: commentSelf },
            assigneeCleared,
            error: `jira.abandon_task (step 5: execute transition) failed: ${msg}. ` +
                `Comment already posted; assignee ${assigneeCleared ? "cleared" : "NOT cleared"}.`,
        });
    }
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
