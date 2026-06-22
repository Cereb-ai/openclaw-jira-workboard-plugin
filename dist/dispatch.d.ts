/**
 * Single-tool dispatcher for the Jira plugin (0.3.1 method set).
 *
 * Three invocation shapes (all equivalent):
 *   1. Structured:  { method: "search", args: { jql: "..." } }
 *   2. Stringified: { call: "search {\"jql\":\"...\"}" }
 *   3. Alias:       { method: "search", jql: "..." }
 *
 * Exposed methods (10):
 *   Read-only:   search / get / comment
 *   Atomic actions: create_task / create_subtask / complete_task /
 *                   escalate_task / abandon_task / request_help
 *   Generic:     transition
 *
 * All 6 atomic methods lock in templates, defaults, and multi-step
 * sequences so the orchestrator agent never composes raw Jira calls.
 *
 * escalate_task is a deprecated alias for complete_task({verdict:FAIL,
 * reason, summary}). It still works (back-compat with prior versions)
 * but new callers should use complete_task directly.
 */
import type { ToolResult } from "./types.js";
export declare const MVP_METHODS: readonly ["search", "get", "comment", "create_task", "create_subtask", "complete_task", "escalate_task", "abandon_task", "request_help", "transition"];
export type JiraMethod = (typeof MVP_METHODS)[number];
export interface DispatchInput {
    method?: string;
    args?: Record<string, unknown>;
    call?: string;
}
export declare function dispatch(input: DispatchInput): Promise<ToolResult>;
export declare function textResult(data: unknown): ToolResult;
