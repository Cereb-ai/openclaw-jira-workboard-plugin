import { search } from "./handlers/search.js";
import { get } from "./handlers/get.js";
import { comment } from "./handlers/comment.js";
import { createTask } from "./handlers/create_task.js";
import { createSubtask } from "./handlers/create_subtask.js";
import { submitVerdict } from "./handlers/submit_verdict.js";
import { abandonTask } from "./handlers/abandon_task.js";
import { requestHelp } from "./handlers/request_help.js";
import { transition } from "./handlers/transition.js";
export const MVP_METHODS = [
    "search",
    "get",
    "comment",
    "create_task",
    "create_subtask",
    "submit_verdict",
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
        case "abandon_task":
            return abandonTask(normalized.args);
        case "request_help":
            return requestHelp(normalized.args);
        case "transition":
            return transition(normalized.args);
        default:
            return Promise.resolve(textResult({
                error: `Unknown method "${normalized.method}". ` +
                    `${MVP_METHODS.length} methods: ${MVP_METHODS.join(", ")}. ` +
                    "See skills/jira/SKILL.md for per-method guidance.",
            }));
    }
}
function normalizeCall(input) {
    let method = input.method;
    let args = input.args ?? {};
    // {call: "method {...}"} stringified shape
    if (!method && typeof input.call === "string") {
        const trimmed = input.call.trim();
        const spaceIdx = trimmed.search(/\s/);
        if (spaceIdx === -1) {
            method = trimmed;
        }
        else {
            method = trimmed.slice(0, spaceIdx);
            const json = trimmed.slice(spaceIdx + 1).trim();
            try {
                const parsed = JSON.parse(json);
                if (isRecord(parsed))
                    args = parsed;
            }
            catch {
                args = {};
            }
        }
    }
    // Alias shape: {method: "search", jql: "..."} — copy non-meta keys into args.
    if (method && (!input.args || Object.keys(input.args).length === 0)) {
        const reserved = new Set(["method", "args", "call"]);
        const aliasArgs = {};
        for (const [k, v] of Object.entries(input)) {
            if (!reserved.has(k))
                aliasArgs[k] = v;
        }
        if (Object.keys(aliasArgs).length > 0)
            args = aliasArgs;
    }
    if (typeof method !== "string" || method.length === 0)
        return null;
    if (!isJiraMethod(method)) {
        return null;
    }
    return { method: method, args };
}
function isJiraMethod(m) {
    return MVP_METHODS.includes(m);
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
