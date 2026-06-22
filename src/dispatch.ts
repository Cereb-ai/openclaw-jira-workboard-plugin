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
import { search } from "./handlers/search.js";
import { get } from "./handlers/get.js";
import { comment } from "./handlers/comment.js";
import { createTask } from "./handlers/create_task.js";
import { createSubtask } from "./handlers/create_subtask.js";
import { completeTask } from "./handlers/complete_task.js";
import { escalateTask } from "./handlers/escalate_task.js";
import { abandonTask } from "./handlers/abandon_task.js";
import { requestHelp } from "./handlers/request_help.js";
import { transition } from "./handlers/transition.js";

export const MVP_METHODS = [
  "search",
  "get",
  "comment",
  "create_task",
  "create_subtask",
  "complete_task",
  "escalate_task",
  "abandon_task",
  "request_help",
  "transition",
] as const;

export type JiraMethod = (typeof MVP_METHODS)[number];

export interface DispatchInput {
  method?: string;
  args?: Record<string, unknown>;
  call?: string;
}

export function dispatch(input: DispatchInput): Promise<ToolResult> {
  const normalized = normalizeCall(input);
  if (!normalized) {
    return Promise.resolve(
      textResult({
        error:
          "Invalid call envelope. Provide `{method, args}` or `{call: 'method {json}'}`. " +
          `${MVP_METHODS.length} methods: ${MVP_METHODS.join(", ")}. ` +
          "See skills/jira/SKILL.md for per-method guidance.",
      }),
    );
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
    case "complete_task":
      return completeTask(normalized.args);
    case "escalate_task":
      // Deprecated alias: forwards to complete_task(verdict=FAIL) so the
      // single FAIL path (comment + label + clear assignee) lives in one
      // place. Kept for back-compat with callers still using the old name.
      return completeTask({
        ...normalized.args,
        verdict: "FAIL",
        summary: normalized.args.summary ?? normalized.args.reason,
      });
    case "abandon_task":
      return abandonTask(normalized.args);
    case "request_help":
      return requestHelp(normalized.args);
    case "transition":
      return transition(normalized.args);
    default:
      return Promise.resolve(
        textResult({
          error: `Unknown method "${normalized.method}". ${MVP_METHODS.length} methods: ${MVP_METHODS.join(", ")}.`,
        }),
      );
  }
}

function normalizeCall(
  input: DispatchInput,
): { method: string; args: Record<string, unknown> } | null {
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

function parseCallString(
  raw: string,
): { method: string; args: Record<string, unknown> } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // "method {\"foo\":1}"  — first whitespace separates method from optional json
  const m = trimmed.match(/^(\S+?)(?:\s+(\{[\s\S]*\}))?$/);
  if (!m) return null;
  const [, method, json] = m;
  let args: Record<string, unknown> = {};
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (isRecord(parsed)) args = parsed;
    } catch {
      args = {};
    }
  }
  return { method, args };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function textResult(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text", text }],
    details: data,
  };
}
