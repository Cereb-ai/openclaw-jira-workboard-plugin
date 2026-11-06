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
 * CP-4287 (0.6.0) — opt-in rich fields via `include`:
 *   `include?: Array<"statusCategory"|"assignee"|"updated"|"commentCount"|"issuelinks">`
 *   - Whitelist is strict: an unknown token returns an error envelope BEFORE
 *     any Jira call (never silently dropped).
 *   - Each token is merged into the server-side `fields` query (union with
 *     the default / caller-supplied list — e.g. `commentCount` really fetches
 *     `comment`, so the count comes from the wire, not a local guess).
 *   - Requested keys are appended after `parent`, always in whitelist order
 *     (statusCategory, assignee, updated, commentCount, issuelinks).
 *   - Omitted / empty `include` → the row is byte-identical to v0.5.4
 *     (exactly 8 keys, no extras).
 *   - `issuelinks` reuses `compactIssueLinks` from ./_issuelinks.js — the same
 *     parser jira_get uses (CP-4287 AC4).
 *
 * Out: text-formatted slim envelope + `details` = <100-char one-line summary
 * (e.g. `"JQL 命中 12 票, 本次返回 3 票"`). 响应 content 仍含完整 issues[].
 */
import { loadConfig } from "../auth.js";
import { jiraGet, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import { normalizeInt, normalizeStringArray } from "../normalize.js";
import { compactIssueLinks } from "./_issuelinks.js";
import type { ToolResult } from "../types.js";

const DEFAULT_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "labels",
  "created",
  "parent",
];

/**
 * CP-4287: include tokens, in emission order. The array doubles as the
 * whitelist — anything not listed here is rejected.
 */
const INCLUDE_TOKENS = [
  "statusCategory",
  "assignee",
  "updated",
  "commentCount",
  "issuelinks",
] as const;

type IncludeToken = (typeof INCLUDE_TOKENS)[number];

/**
 * CP-4287: Jira server-side field required to satisfy each include token.
 * `statusCategory` is nested inside `status`; `commentCount` is derived from
 * the `comment` sub-resource (so it must be requested on the wire).
 */
const INCLUDE_JIRA_FIELDS: Record<IncludeToken, string> = {
  statusCategory: "status",
  assignee: "assignee",
  updated: "updated",
  commentCount: "comment",
  issuelinks: "issuelinks",
};

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

  // CP-4287: validate `include` BEFORE any Jira round-trip so an unknown
  // token can never cost an HTTP call (AC1).
  const includeNorm = normalizeInclude(args.include);
  if (!includeNorm.ok) {
    return textResult(
      { error: includeNorm.error },
      "jira_search 失败: include 非法",
    );
  }
  const include = includeNorm.value;

  // CP-3751: maxResults accepts number | numeric string. An invalid value
  // falls back to the default 30 (previous behavior) rather than erroring.
  let maxResults = 30;
  if (args.maxResults !== undefined && args.maxResults !== null) {
    const norm = normalizeInt(args.maxResults, "maxResults", { min: 1 });
    if (norm.ok) maxResults = norm.value;
  }

  // CP-3751: `fields` members accept string | number → normalized to
  // string[]. Previously numeric members were silently DROPPED by the
  // `.filter((f) => typeof f === "string")` — `fields: [10019]` produced a
  // request with an empty field list.
  let fields: string[] = DEFAULT_FIELDS;
  if (args.fields !== undefined && args.fields !== null) {
    const norm = normalizeStringArray(args.fields, "fields");
    if (norm.ok) {
      fields = norm.value;
    }
  }

  // CP-4287: union the server-side field list with whatever the include
  // tokens need. Order: caller/default fields first, then the missing
  // include-backed fields in whitelist order (stable, de-duplicated).
  let requestedFields = fields;
  if (include.size > 0) {
    const merged = new Set(fields);
    for (const token of INCLUDE_TOKENS) {
      if (include.has(token)) merged.add(INCLUDE_JIRA_FIELDS[token]);
    }
    requestedFields = [...merged];
  }

  try {
    const data = (await jiraGet(cfg, "search/jql", {
      jql,
      maxResults,
      fields: requestedFields.join(","),
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
        issues: formatIssues(issues, include),
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

/**
 * CP-4287: parse + strictly validate `include`.
 *
 * - omitted / null → empty set (default v0.5.4 behaviour)
 * - non-array / non-string members → error (via normalizeStringArray)
 * - any token outside the whitelist → error (never silently ignored)
 * - duplicates collapse into a set; empty array is a valid no-op
 */
function normalizeInclude(
  raw: unknown,
): { ok: true; value: Set<IncludeToken> } | { ok: false; error: string } {
  const out = new Set<IncludeToken>();
  if (raw === undefined || raw === null) return { ok: true, value: out };

  const norm = normalizeStringArray(raw, "include");
  if (!norm.ok) return { ok: false, error: norm.error };

  const unknown = norm.value.filter(
    (token) => !(INCLUDE_TOKENS as readonly string[]).includes(token),
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      error:
        `include accepts only ${INCLUDE_TOKENS.join(" / ")}. ` +
        `Unknown token(s): ${unknown.join(", ")}.`,
    };
  }
  for (const token of norm.value) out.add(token as IncludeToken);
  return { ok: true, value: out };
}

function searchDetailsSummary(total: number, returned: number): string {
  // total = JQL 命中总数 (server-side). returned = 本次返回条数 (无客户端 filter).
  // 无客户端 filter 时 total === returned, 此处仍按"命中 X, 返回 Y"格式输出, 让
  // agent 一眼判断是否需要收窄 JQL.
  return `JQL 命中 ${total} 票, 本次返回 ${returned} 票`;
}

function formatIssues(issues: unknown[], include: ReadonlySet<IncludeToken>): unknown[] {
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
    const row: Record<string, unknown> = {
      key: issue.key,
      id: issue.id,
      summary: f.summary,
      status,
      issuetype,
      labels: f.labels,
      created: f.created,
      parent,
    };
    // CP-4287: append only the requested keys, in whitelist order. With an
    // empty include set this loop is a no-op → the row above stays exactly
    // the v0.5.4 8-field object.
    for (const token of INCLUDE_TOKENS) {
      if (!include.has(token)) continue;
      switch (token) {
        case "statusCategory":
          row.statusCategory = statusCategoryKey(f.status);
          break;
        case "assignee":
          row.assignee = assigneeSummary(f.assignee);
          break;
        case "updated":
          row.updated = f.updated;
          break;
        case "commentCount":
          row.commentCount = countComments(f.comment);
          break;
        case "issuelinks":
          row.issuelinks = compactIssueLinks(f.issuelinks);
          break;
      }
    }
    return row;
  });
}

/** CP-4287: `fields.status.statusCategory.key`, `""` when absent. */
function statusCategoryKey(rawStatus: unknown): string {
  if (typeof rawStatus !== "object" || rawStatus === null) return "";
  const statusCategory = (rawStatus as { statusCategory?: unknown }).statusCategory;
  if (typeof statusCategory !== "object" || statusCategory === null) return "";
  const key = (statusCategory as { key?: unknown }).key;
  return typeof key === "string" ? key : "";
}

/** CP-4287: `{displayName, accountId}` or `null` when unassigned. */
function assigneeSummary(
  raw: unknown,
): { displayName?: string; accountId?: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const assignee = raw as { displayName?: string; accountId?: string };
  return {
    displayName: assignee.displayName,
    accountId: assignee.accountId,
  };
}

/** CP-4287: `comment.total ?? comments.length ?? 0`. */
function countComments(raw: unknown): number {
  if (typeof raw !== "object" || raw === null) return 0;
  const comment = raw as { total?: unknown; comments?: unknown };
  if (typeof comment.total === "number") return comment.total;
  if (Array.isArray(comment.comments)) return comment.comments.length;
  return 0;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
