#!/usr/bin/env node
/**
 * jira-tool — CLI wrapper for the @cereb/jira-openclaw-plugin.
 *
 * Allows the 11 plugin methods to be invoked from any shell / terminal,
 * independently of OpenClaw / OpenCode / Wecom DM. Useful for:
 *
 *   - Debugging from a PC terminal without the full OpenClaw round-trip.
 *   - CI / pipeline scripts that need Jira data.
 *   - Local agent behavior testing (e.g. before re-enabling the plugin).
 *
 * Reuses the same handler / auth stack as the OpenClaw native tools —
 * there is no separate API client. Reads env (ATST_TOKEN / JIRA_CLOUD_ID /
 * JIRA_PROXY) the same way as the OpenClaw entry point, so no new config.
 *
 * Usage:
 *   jira-tool <method> '<args-json>'
 *
 * Examples:
 *   jira-tool search '{"jql":"project = WTO AND status != Done","maxResults":1}'
 *   jira-tool get '{"issueIdOrKey":"WTO-71"}'
 *   jira-tool get '{"issueIdOrKey":"WTO-71","concise":true}'
 *   jira-tool list_comments '{"issueIdOrKey":"WTO-71","maxResults":10}'
 *   jira-tool get_comment '{"issueIdOrKey":"WTO-71","commentId":"10001"}'
 *   jira-tool create_task '{"project":"WTO","summary":"...","requirements":"...","scope":"...","acceptance_criteria":["..."]}'
 *   jira-tool create_subtask '{"project":"WTO","parent":"WTO-100","summary":"...","requirements":"...","scope":"...","acceptance_criteria":["..."],"labels":["code"]}'
 *   jira-tool submit_verdict '{"issueIdOrKey":"WTO-100","verdict":"PASS","summary":"done"}'
 *   jira-tool submit_verdict '{"issueIdOrKey":"WTO-100","verdict":"FAIL","summary":"blocked","reason":"waiting on X"}'
 *   jira-tool abandon_task '{"issueIdOrKey":"WTO-101","reason":"re-planning"}'
 *   jira-tool request_help '{"issueIdOrKey":"WTO-50","question":"need clarification"}'
 *   jira-tool comment '{"issueIdOrKey":"WTO-100","body":{"version":1,"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"..."}]}]}}'
 *   jira-tool transition '{"issueIdOrKey":"WTO-100","targetStatus":"Done"}'
 *
 * Output: JSON to stdout on success; non-zero exit + JSON error on stderr on failure.
 */
import { search } from "./handlers/search.js";
import { get } from "./handlers/get.js";
import { comment } from "./handlers/comment.js";
import { listComments } from "./handlers/list_comments.js";
import { getComment } from "./handlers/get_comment.js";
import { createTask } from "./handlers/create_task.js";
import { createSubtask } from "./handlers/create_subtask.js";
import { submitVerdict } from "./handlers/submit_verdict.js";
import { abandonTask } from "./handlers/abandon_task.js";
import { requestHelp } from "./handlers/request_help.js";
import { transition } from "./handlers/transition.js";
const HANDLERS = {
    search: search,
    get: get,
    list_comments: listComments,
    get_comment: getComment,
    comment: comment,
    create_task: createTask,
    create_subtask: createSubtask,
    submit_verdict: submitVerdict,
    abandon_task: abandonTask,
    request_help: requestHelp,
    transition: transition,
};
function printUsage() {
    console.error([
        `Usage: jira-tool <method> '<args-json>'`,
        ``,
        `Methods (${Object.keys(HANDLERS).length}):`,
        ...Object.keys(HANDLERS).map((m) => `  ${m}`),
        ``,
        `Env (same as OpenClaw plugin):`,
        `  ATST_TOKEN     OAuth 2.0 3LO access token (required)`,
        `  JIRA_CLOUD_ID  Atlassian Cloud ID (required)`,
        `  JIRA_PROXY     HTTP proxy URL (optional, default http://172.29.176.1:7890)`,
        ``,
        `Output: JSON to stdout on success; non-zero exit + JSON error on stderr on failure.`,
    ].join("\n"));
}
async function main() {
    const argv = process.argv.slice(2);
    if (argv.length === 0) {
        printUsage();
        process.exit(1);
    }
    const method = argv[0];
    const argsStr = argv.slice(1).join(" ");
    const handler = HANDLERS[method];
    if (!handler) {
        console.error(JSON.stringify({
            error: `Unknown method "${method}". ${Object.keys(HANDLERS).length} methods: ${Object.keys(HANDLERS).join(", ")}.`,
        }, null, 2));
        process.exit(5);
    }
    let args = {};
    if (argsStr.length > 0) {
        try {
            const parsed = JSON.parse(argsStr);
            if (parsed === null ||
                typeof parsed !== "object" ||
                Array.isArray(parsed)) {
                console.error(`jira-tool: args must be a JSON object (got ${typeof parsed})`);
                process.exit(2);
            }
            args = parsed;
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`jira-tool: failed to parse args JSON: ${msg}`);
            console.error(`  received: ${argsStr.slice(0, 200)}${argsStr.length > 200 ? "..." : ""}`);
            process.exit(2);
        }
    }
    let result;
    try {
        result = await handler(args);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(JSON.stringify({ error: `jira-tool ${method} crashed: ${msg}` }, null, 2));
        process.exit(1);
    }
    console.log(JSON.stringify(result, null, 2));
}
main().catch((e) => {
    console.error(`jira-tool: unhandled error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
