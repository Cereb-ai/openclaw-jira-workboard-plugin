/**
 * Single-tool dispatcher for the Jira plugin (0.3.4 method set).
 *
 * Three invocation shapes (all equivalent):
 *   1. Structured:  { method: "search", args: { jql: "..." } }
 *   2. Stringified: { call: "search {\"jql\":\"...\"}" }
 *   3. Alias:       { method: "search", jql: "..." }
 *
 * Exposed methods (9):
 *   Read-only:   search / get / comment
 *   Atomic actions: create_task / create_subtask / submit_verdict /
 *                   abandon_task / request_help
 *   Generic:     transition
 *
 * All 5 atomic methods lock in templates, defaults, and multi-step
 * sequences so the orchestrator agent never composes raw Jira calls.
 *
 * verdict dispatches both PASS and FAIL in submit_verdict; there is no
 * separate escalate_task. Main task can still pause via request_help
 * (wait-approval label) without going through an escalation path.
 */
import type { ToolResult } from "./types.js";
export declare const MVP_METHODS: readonly ["search", "get", "comment", "create_task", "create_subtask", "submit_verdict", "abandon_task", "request_help", "transition"];
export type JiraMethod = (typeof MVP_METHODS)[number];
export interface DispatchInput {
    method?: string;
    args?: Record<string, unknown>;
    call?: string;
}
export declare function dispatch(input: DispatchInput): Promise<ToolResult>;
export declare function textResult(data: unknown): ToolResult;
