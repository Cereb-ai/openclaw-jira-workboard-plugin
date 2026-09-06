/**
 * Shared types for the Jira plugin.
 *
 * Kept in a single file so handlers/auth/dispatch don't have to chase imports
 * across multiple type-only modules. The shape is intentionally narrow: the
 * plugin only uses ~6 entry points, and over-modelling the Atlassian schema
 * (hundreds of fields) would be YAGNI.
 */

export interface JiraConfig {
  atstToken: string;
  cloudId: string;
  proxy: string;
  /**
   * Optional accountId used as the default assignee for orchestrator-driven
   * create_task / create_subtask. Resolved from
   * `cfg.defaultAssigneeAccountId` or `JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID` env.
   * Missing → orchestrator methods skip the assignee field (issue stays
   * unassigned until someone picks it up).
   */
  defaultAssigneeAccountId: string;
}

/** Loose envelope returned by Atlassian REST v3 (search/get/create/transition). */
export interface JiraApiResponse {
  [key: string]: unknown;
}

/** Tool call result envelope (mirrors outline-wiki textResult shape).
 *
 * CP-2669 G1 update: `details` is now an OPTIONAL <100-char one-line
 * semantic summary. The two pilot tools (jira_get / jira_list_comments)
 * always set it to a short string; the other 12 tools still pass a
 * single-arg textResult() which defaults `details` to `content` (their
 * structured object). The `unknown` type stays so we don't break the
 * other 12 tools' fixtures — the new semantic is "details is short or
 * matches content", not a strict string-only contract.
 */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  details: unknown;
}

/** ADF (Atlassian Document Format) document — top-level shape. */
export interface AdfDocument {
  version: 1;
  type: "doc";
  content: AdfNode[];
}

export interface AdfNode {
  type: string;
  [key: string]: unknown;
}
