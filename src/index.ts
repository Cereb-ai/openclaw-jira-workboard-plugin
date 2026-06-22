/**
 * jira-openclaw-plugin — OpenClaw native plugin entry.
 *
 * Single dispatcher tool `jira` exposes 10 Jira Cloud REST v3 methods
 * (MVP 0.1.0 + Phase B 0.2.0 + Orchestrator 0.3.0):
 *   - generic (5): search / get / comment / transition
 *   - orchestrator (5): create_task / create_subtask / complete_task
 *                       / escalate_task / request_help
 *
 * Replaces the `mcporter call atlassian.*` channel. Reads ATST_TOKEN /
 * JIRA_CLOUD_ID / JIRA_PROXY from env (with optional openclaw.json config
 * override) — see auth.ts for resolution order and fail-fast behavior.
 * Orchestrator 0.3.0+ also reads JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID
 * (optional, used as the implicit assignee for create_task / create_subtask).
 *
 * Invocation shape (mirrors outline-wiki 0.3.1):
 *   - structured: { method: "search", args: { jql: "..." } }
 *   - stringified: { call: "search {\"jql\":\"...\"}" }
 *
 * MVP scope: 10 methods. Not in MVP: property_get/set/del, Confluence,
 * OAuth token refresh.
 */
import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { dispatch, MVP_METHODS, textResult } from "./dispatch.js";
import { setPluginConfig } from "./auth.js";

const PLUGIN_ID = "jira-openclaw-plugin";
const TOOL_NAME = "jira";

const Parameters = Type.Object({
  method: Type.Optional(
    Type.String({
      description:
        "Method name. Generic 5 (0.1.0 + 0.2.0): search, get, comment, transition, block. Orchestrator 5 (0.3.0+): create_task, create_subtask, complete_task, escalate_task, request_help.",
    }),
  ),
  args: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Unknown(),
      { description: "Method-specific arguments as a JSON object." },
    ),
  ),
  call: Type.Optional(
    Type.String({
      description:
        "Alternative single-string invocation, e.g. `search {\"jql\":\"...\"}`.",
    }),
  ),
});

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Jira",
  description:
    "Native Jira Cloud REST v3 integration for OpenClaw. Single dispatcher tool `jira` covers 10 methods: generic 5 (search / get / comment / transition / block from 0.1.0 + 0.2.0) and orchestrator 5 (create_task / create_subtask / complete_task / escalate_task / request_help from 0.3.0+). Reads ATST_TOKEN / JIRA_CLOUD_ID from env (no mcporter dependency). Orchestrator methods also read JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID. See skills/jira/SKILL.md for per-method guidance.",
  register(api) {
    // Capture plugin config from openclaw.json so handlers can resolve tokens
    // without depending on process.env (see auth.ts setPluginConfig / loadConfig).
    setPluginConfig((api as any).pluginConfig ?? null);
    api.registerTool(
      {
        name: TOOL_NAME,
        label: "Jira",
        description:
          "Jira Cloud dispatcher. Invoke as `jira {method, args}` (structured form, e.g. `jira {method:'search', args:{jql:'...'}}`) or `jira {call: 'search {\\\"jql\\\":\\\"...\\\"}'}` (stringified form). 10 methods total. Generic (use when you need flexibility): search, get, comment, transition, block. Orchestrator (use from the task orchestrator agent — templates and defaults are locked in): create_task, create_subtask, complete_task, escalate_task, request_help. All methods read ATST_TOKEN/JIRA_CLOUD_ID/JIRA_PROXY from env (fail-fast on missing); orchestrator methods also read JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID (optional). `comment` body MUST be an ADF dict (not a string). `transition` uses the destination status NAME (e.g. 'In Progress' / 'Done' / '已完成'), not the transition button label. `block {blocker, blocked}` creates a 'Blocks' link: blocker → outward, blocked → inward. `create_task` / `create_subtask` build a fixed ADF description (## 任务说明 / ## 验收标准) and auto-assign to the default assignee. `complete_task` posts a verdict comment then transitions to '已完成'. `escalate_task` is subtask-only (comment + `escalated` label + clear assignee). `request_help` is main-task-only (question comment + `wait-approval` label). See skills/jira/SKILL.md for避坑清单.",
        parameters: Parameters,
        async execute(_id, params) {
          try {
            return await dispatch(params as Record<string, unknown>);
          } catch (err) {
            return textResult({
              error: `jira dispatcher crashed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        },
      },
      { optional: true },
    );
  },
});

/**
 * Re-export MVP method list for any host that wants to introspect the
 * plugin (e.g. openclaw skills check, doc generation).
 */
export { MVP_METHODS };
