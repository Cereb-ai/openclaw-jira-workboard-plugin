import { search } from "./handlers/search.js";
import { get } from "./handlers/get.js";
import { comment } from "./handlers/comment.js";
import { createTask } from "./handlers/create_task.js";
import { createSubtask } from "./handlers/create_subtask.js";
import { submitVerdict } from "./handlers/submit_verdict.js";
import { abandonTask } from "./handlers/abandon_task.js";
import { requestHelp } from "./handlers/request_help.js";
import { transition } from "./handlers/transition.js";
import { loadConfig } from "./auth.js";
import { jiraGet, JiraHttpError } from "./http.js";
export const MVP_METHODS = [
    "search",
    "get",
    "comment",
    "create_task",
    "create_subtask",
    "submit_verdict",
    "escalate_task",
    "abandon_task",
    "request_help",
    "transition",
];
export function dispatch(input) {
    const normalized = normalizeCall(input);
    if (!normalized) {
        return Promise.resolve(textResult({
            error: "Invalid call envelope. Provide `{method, args}` or `{call: 'method {json}'}`. " +
                `${MVP_METHODS.length} methods: ${MVP_METHODS.join(", ")}. ` +
                "See skills/jira/SKILL.md for per-method guidance.",
        }));
    }
    switch (normalized.method) {
        case "search":
            return search(normalized.args);
        case "get":
            return get(normalized.args);
        case "comment":
            return comment(normalized.args);
        case "create_task":
            return createTask(normalized.args);
        case "create_subtask":
            return createSubtask(normalized.args);
        case "submit_verdict":
            return submitVerdict(normalized.args);
        case "escalate_task":
            // Deprecated alias: forwards to submit_verdict(verdict=FAIL) so the
            // single FAIL path (comment + label + clear assignee) lives in one
            // place. Kept for back-compat with callers still using the old name.
            //
            // Backward-compat guard (SSSS-254 S1 fix): the old escalateTask
            // handler checked fields.issuetype.subtask === true and fail-fast
            // when called on a main task. We preserve that contract here so
            // existing callers (e.g., SSSS-208 review tasks that rely on
            // "escalate_task is subtask-only") keep working unchanged.
            return assertSubtaskOnly(normalized.args.issueIdOrKey).then((guard) => {
                if (guard)
                    return guard;
                return submitVerdict({
                    ...normalized.args,
                    verdict: "FAIL",
                    summary: normalized.args.summary ?? normalized.args.reason,
                });
            });
        case "abandon_task":
            return abandonTask(normalized.args);
        case "request_help":
            return requestHelp(normalized.args);
        case "transition":
            return transition(normalized.args);
        default:
            return Promise.resolve(textResult({
                error: `Unknown method "${normalized.method}". ${MVP_METHODS.length} methods: ${MVP_METHODS.join(", ")}.`,
            }));
    }
}
function normalizeCall(input) {
    if (typeof input.method === "string" && input.method.length > 0) {
        return {
            method: input.method,
            args: isRecord(input.args) ? input.args : {},
        };
    }
    if (typeof input.call === "string") {
        return parseCallString(input.call);
    }
    return null;
}
function parseCallString(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return null;
    // "method {\"foo\":1}"  — first whitespace separates method from optional json
    const m = trimmed.match(/^(\S+?)(?:\s+(\{[\s\S]*\}))?$/);
    if (!m)
        return null;
    const [, method, json] = m;
    let args = {};
    if (json) {
        try {
            const parsed = JSON.parse(json);
            if (isRecord(parsed))
                args = parsed;
        }
        catch {
            args = {};
        }
    }
    return { method, args };
}
function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
export function textResult(data) {
    const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    return {
        content: [{ type: "text", text }],
        details: data,
    };
}
/**
 * Subtask-only guard for the deprecated escalate_task alias.
 *
 * The old escalateTask handler (0.3.0+) fail-fast when called on a
 * main task with "use request_help instead". We preserve that contract
 * here so existing callers don't silently escalate non-subtask issues
 * after the SSSS-252 merge.
 *
 * Returns null when the issue is a subtask (proceed with the alias
 * forwarding), or a ToolResult error envelope when it isn't.
 */
async function assertSubtaskOnly(issueIdOrKey) {
    if (typeof issueIdOrKey !== "string" || issueIdOrKey.length === 0) {
        return textResult({
            error: "escalate_task requires a non-empty `issueIdOrKey` (string).",
        });
    }
    try {
        const cfg = loadConfig();
        const data = (await jiraGet(cfg, `issue/${issueIdOrKey}`, {
            fields: "issuetype",
        }));
        const isSubtask = data?.fields?.issuetype?.subtask === true;
        if (!isSubtask) {
            return textResult({
                error: `escalate_task 只能用于子任务。${issueIdOrKey} is a main task — use request_help instead.`,
            });
        }
        return null;
    }
    catch (err) {
        const msg = err instanceof JiraHttpError ? err.message : String(err);
        return textResult({
            error: `escalate_task (subtask guard) failed: ${msg}.`,
        });
    }
}
