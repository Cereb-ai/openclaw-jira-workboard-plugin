/**
 * jira.search — JQL search via GET /rest/api/3/search/jql.
 *
 * NOTE: Atlassian deprecated the legacy /rest/api/3/search endpoint (returns
 * HTTP 410 Gone). The new endpoint /rest/api/3/search/jql accepts JQL as a
 * query parameter and returns the same shape. Migration guide:
 *   https://developer.atlassian.com/changelog/#CHANGE-2046
 * The token's OAuth scope is sufficient (verified end-to-end 2026-06-10).
 *
 * Default fields (CP-2384 0.5.2+, issuelinks dropped — search callers usually
 * only need summary/status/issuetype/labels/created/parent for triage; if
 * they want issuelinks, fetch per-ticket via jira_get):
 *   ["summary","status","issuetype","labels","created","parent"]
 * Default maxResults: 30.
 *
 * `fields` 参数语义 (CP-2693 batch 1, v0.5 提案 RRmzJTZ7Q8 §1 search 条目):
 *   - fields 仅作为**服务端拉取收窄**使用 (降 wire token), 返回字段集固定为
 *     `formatIssues` 输出的 8 字段 (key/id/summary/status/issuetype/labels/
 *     created/parent).
 *   - 显式传白名单外字段 (如 `["description"]` / `["customfield_*"]`) **不会**
 *     扩展返回 — 格式器只接受 8 字段. 这是已知简化: 需要 description 或
 *     customfield_* 等白名单外字段时, 走 `jira_get { fields: [...] }` 单票
 *     逃生舱 (jira_get 的 fields 参数与 jira_search 不同, 那里是真实逃生舱).
 *
 * Out: text-formatted slim envelope + `details` = <100-char one-line summary
 * (e.g. `"JQL 命中 12 票, 本次返回 3 票"`). 响应 content 仍含完整 issues[].
 */
import { loadConfig } from "../auth.js";
import { jiraGet, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import type { ToolResult } from "../types.js";

const DEFAULT_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "labels",
  "created",
  "parent",
];

export async function search(args: Record<string, unknown>): Promise<ToolResult> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    return textResult({ error: errorMessage(err) }, `jira_search 失败: ${errorMessage(err)}`);
  }

  const jql = args.jql;
  if (typeof jql !== "string" || jql.trim().length === 0) {
    return textResult(
      { error: "search requires a non-empty `jql` (string) argument." },
      "jira_search 失败: 缺 jql",
    );
  }
  const maxResults =
    typeof args.maxResults === "number" && Number.isFinite(args.maxResults)
      ? args.maxResults
      : 30;
  const fields = Array.isArray(args.fields)
    ? (args.fields as unknown[]).filter((f): f is string => typeof f === "string")
    : DEFAULT_FIELDS;

  try {
    const data = (await jiraGet(cfg, "search/jql", {
      jql,
      maxResults,
      fields: fields.join(","),
    })) as { issues?: unknown[]; total?: number; startAt?: number };

    const issues = Array.isArray(data?.issues) ? data.issues : [];
    const total = data?.total ?? issues.length;
    return textResult(
      {
        ok: true,
        method: "search",
        // CP-2384 AC2: echo only key-class JQL — agents don't need the
        // echoed fields list / maxResults back (they just sent them).
        request: { jql },
        total,
        count: issues.length,
        issues: formatIssues(issues),
      },
      searchDetailsSummary(total, issues.length),
    );
  } catch (err) {
    if (err instanceof JiraHttpError) {
      return textResult(
        { error: `jira.search failed: ${err.message}` },
        `jira_search 失败: HTTP ${err.status} ${err.statusText}`,
      );
    }
    return textResult(
      { error: `jira.search failed: ${errorMessage(err)}` },
      `jira_search 失败: ${errorMessage(err)}`,
    );
  }
}

function searchDetailsSummary(total: number, returned: number): string {
  // total = JQL 命中总数 (server-side). returned = 本次返回条数 (无客户端 filter).
  // 无客户端 filter 时 total === returned, 此处仍按"命中 X, 返回 Y"格式输出, 让
  // agent 一眼判断是否需要收窄 JQL.
  return `JQL 命中 ${total} 票, 本次返回 ${returned} 票`;
}

function formatIssues(issues: unknown[]): unknown[] {
  return issues.map((raw) => {
    const issue = raw as {
      key?: string;
      id?: string;
      fields?: Record<string, unknown>;
    };
    const f = issue.fields ?? {};
    const status =
      typeof f.status === "object" && f.status !== null
        ? (f.status as { name?: string }).name
        : undefined;
    const issuetype =
      typeof f.issuetype === "object" && f.issuetype !== null
        ? (f.issuetype as { name?: string }).name
        : undefined;
    const parent =
      typeof f.parent === "object" && f.parent !== null
        ? (f.parent as { key?: string }).key
        : undefined;
    return {
      key: issue.key,
      id: issue.id,
      summary: f.summary,
      status,
      issuetype,
      labels: f.labels,
      created: f.created,
      parent,
    };
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
