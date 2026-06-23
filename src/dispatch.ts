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
    case "submit_verdict":
      return submitVerdict(normalized.args);
    case "abandon_task":
      return abandonTask(normalized.args);
    case "request_help":
      return requestHelp(normalized.args);
    case "transition":
      return transition(normalized.args);
    default:
      return Promise.resolve(
        textResult({
          error:
            `Unknown method "${normalized.method}". ` +
            `${MVP_METHODS.length} methods: ${MVP_METHODS.join(", ")}. ` +
            "See skills/jira/SKILL.md for per-method guidance.",
        }),
      );
  }
}

interface NormalizedCall {
  method: JiraMethod;
  args: Record<string, unknown>;
}

function normalizeCall(input: DispatchInput): NormalizedCall | null {
  let method: string | undefined = input.method;
  let args: Record<string, unknown> = input.args ?? {};

  // {call: "method {...}"} stringified shape
  if (!method && typeof input.call === "string") {
    const trimmed = input.call.trim();
    const spaceIdx = trimmed.search(/\s/);
    if (spaceIdx === -1) {
      method = trimmed;
    } else {
      method = trimmed.slice(0, spaceIdx);
      const json = trimmed.slice(spaceIdx + 1).trim();
      try {
        const parsed = JSON.parse(json);
        if (isRecord(parsed)) args = parsed;
      } catch {
        args = {};
      }
    }
  }

  // Alias shape: {method: "search", jql: "..."} — copy non-meta keys into args.
  if (method && (!input.args || Object.keys(input.args).length === 0)) {
    const reserved = new Set(["method", "args", "call"]);
    const aliasArgs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      if (!reserved.has(k)) aliasArgs[k] = v;
    }
    if (Object.keys(aliasArgs).length > 0) args = aliasArgs;
  }

  if (typeof method !== "string" || method.length === 0) return null;
  if (!isJiraMethod(method)) {
    return null;
  }
  return { method: method as JiraMethod, args };
}

function isJiraMethod(m: string): m is JiraMethod {
  return (MVP_METHODS as readonly string[]).includes(m);
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
