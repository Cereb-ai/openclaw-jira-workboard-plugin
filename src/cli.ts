#!/usr/bin/env node
/**
 * jira-tool — CLI wrapper for the @cereb/jira-openclaw-plugin.
 *
 * Allows all 14 plugin methods to be invoked from any shell / terminal,
 * independently of OpenClaw / OpenCode / Wecom DM. Useful for:
 *
 *   - Debugging from a PC terminal without the full OpenClaw round-trip.
 *   - CI / pipeline scripts that need Jira data.
 *   - Local agent behavior testing (e.g. before re-enabling the plugin).
 *
 * Reuses the same handler / auth stack as the OpenClaw native tools —
 * there is no separate API client. Reads env (JIRA_ATST_TOKEN / ATST_TOKEN /
 * JIRA_CLOUD_ID / JIRA_PROXY) the same way as the OpenClaw entry point, so
 * a single env block works for both MCP and CLI paths — see auth.ts
 * (CP-2955 env-first resolution).
 *
 * Method names are 100% aligned with the OpenClaw MCP tools: both the
 * MCP names (jira_search / jira_get / ...) and the short names
 * (search / get / ...) are accepted.
 *
 * Usage:
 *   jira-tool <method> '<args-json>'
 *
 * Examples:
 *   jira-tool jira_search '{"jql":"project = WTO AND status != Done","maxResults":1}'
 *   jira-tool jira_get '{"issueIdOrKey":"WTO-71"}'
 *   jira-tool jira_list_comments '{"issueIdOrKey":"WTO-71","maxResults":10}'
 *   jira-tool jira_get_comment '{"issueIdOrKey":"WTO-71","commentId":"10001"}'
 *   jira-tool jira_comment '{"issueIdOrKey":"WTO-100","body":"plain text"}'
 *   jira-tool jira_list_attachments '{"issueIdOrKey":"WTO-100"}'
 *   jira-tool jira_get_attachment '{"attachmentId":"10001"}'
 *   jira-tool jira_upload_attachment '{"issueIdOrKey":"WTO-100","filePath":"/tmp/x.png"}'
 *   jira-tool jira_create_task '{"project":"WTO","summary":"...","requirements":"...","scope":"...","acceptance_criteria":["..."]}'
 *   jira-tool jira_create_subtask '{"project":"WTO","parent":"WTO-100","summary":"...","requirements":"...","scope":"...","acceptance_criteria":["..."],"labels":["code"]}'
 *   jira-tool jira_submit_verdict '{"issueIdOrKey":"WTO-100","verdict":"PASS","summary":"done"}'
 *   jira-tool jira_submit_verdict '{"issueIdOrKey":"WTO-100","verdict":"FAIL","summary":"blocked","reason":"waiting on X"}'
 *   jira-tool jira_abandon_task '{"issueIdOrKey":"WTO-101","reason":"re-planning"}'
 *   jira-tool jira_request_help '{"issueIdOrKey":"WTO-50","question":"need clarification"}'
 *   jira-tool jira_transition '{"issueIdOrKey":"WTO-100","targetStatus":"Done"}'
 *
 * Output: JSON to stdout on success; non-zero exit + JSON error on stderr on failure.
 */
import { search } from "./handlers/search.js";
import { get } from "./handlers/get.js";
import { comment } from "./handlers/comment.js";
import { listComments } from "./handlers/list_comments.js";
import { getComment } from "./handlers/get_comment.js";
import { listAttachments } from "./handlers/list_attachments.js";
import { getAttachment } from "./handlers/get_attachment.js";
import { uploadAttachment } from "./handlers/upload_attachment.js";
import { createTask } from "./handlers/create_task.js";
import { createSubtask } from "./handlers/create_subtask.js";
import { submitVerdict } from "./handlers/submit_verdict.js";
import { abandonTask } from "./handlers/abandon_task.js";
import { requestHelp } from "./handlers/request_help.js";
import { transition } from "./handlers/transition.js";
import type { ToolResult } from "./types.js";

const HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {
  search: search,
  get: get,
  list_comments: listComments,
  get_comment: getComment,
  comment: comment,
  list_attachments: listAttachments,
  get_attachment: getAttachment,
  upload_attachment: uploadAttachment,
  create_task: createTask,
  create_subtask: createSubtask,
  submit_verdict: submitVerdict,
  abandon_task: abandonTask,
  request_help: requestHelp,
  transition: transition,
};

// 100% parity with the OpenClaw native MCP tool names (jira_*).
const MCP_ALIASES: Record<string, string> = {
  jira_search: "search",
  jira_get: "get",
  jira_list_comments: "list_comments",
  jira_get_comment: "get_comment",
  jira_comment: "comment",
  jira_list_attachments: "list_attachments",
  jira_get_attachment: "get_attachment",
  jira_upload_attachment: "upload_attachment",
  jira_create_task: "create_task",
  jira_create_subtask: "create_subtask",
  jira_submit_verdict: "submit_verdict",
  jira_abandon_task: "abandon_task",
  jira_request_help: "request_help",
  jira_transition: "transition",
};

function printUsage(): void {
  console.error(
    [
      `Usage: jira-tool <method> '<args-json>'`,
      ``,
      `Methods (${Object.keys(HANDLERS).length}):`,
      ...Object.keys(HANDLERS).map((m) => `  ${m}`),
      ``,
      `Env (same as OpenClaw plugin — CP-2955 env-first):`,
      `  JIRA_ATST_TOKEN OAuth 2.0 3LO access token (required, preferred name)`,
      `  ATST_TOKEN      OAuth 2.0 3LO access token (required, legacy alias)`,
      `  JIRA_CLOUD_ID   Atlassian Cloud ID (required)`,
      `  JIRA_PROXY      HTTP proxy URL (optional, default = direct connection)`,
      ``,
      `Output: JSON to stdout on success; non-zero exit + JSON error on stderr on failure.`,
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    printUsage();
    process.exit(1);
  }
  const methodArg = argv[0];
  if (methodArg === "--help" || methodArg === "-h") {
    printUsage();
    process.exit(0);
  }
  const method = MCP_ALIASES[methodArg] ?? methodArg;
  const argsStr = argv.slice(1).join(" ");
  if (argsStr === "--help" || argsStr === "-h") {
    printUsage();
    process.exit(0);
  }
  const handler = HANDLERS[method];
  if (!handler) {
    console.error(
      JSON.stringify(
        {
          error: `Unknown method "${method}". ${Object.keys(HANDLERS).length} methods: ${Object.keys(HANDLERS).join(", ")}.`,
        },
        null,
        2,
      ),
    );
    process.exit(5);
  }
  let args: Record<string, unknown> = {};
  if (argsStr.length > 0) {
    try {
      const parsed = JSON.parse(argsStr);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        console.error(
          `jira-tool: args must be a JSON object (got ${typeof parsed})`,
        );
        process.exit(2);
      }
      args = parsed as Record<string, unknown>;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`jira-tool: failed to parse args JSON: ${msg}`);
      console.error(`  received: ${argsStr.slice(0, 200)}${argsStr.length > 200 ? "..." : ""}`);
      process.exit(2);
    }
  }
  let result: ToolResult;
  try {
    result = await handler(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      JSON.stringify({ error: `jira-tool ${method} crashed: ${msg}` }, null, 2),
    );
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(
    `jira-tool: unhandled error: ${e instanceof Error ? e.message : String(e)}`,
  );
  process.exit(1);
});
