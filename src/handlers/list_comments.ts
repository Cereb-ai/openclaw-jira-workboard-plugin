/**
 * jira.list_comments — read all comments on a ticket, with ADF → plain text.
 *
 * REST: GET /rest/api/3/issue/{issueIdOrKey}/comment
 *
 * Context-saving design (0.4.0+, CP-2384, CP-2669 G3-G6):
 *   - Default maxResults=10 (CP-2669 G4 — was 20 in 0.5.x, dropped to 10
 *     so the LLM doesn't burn context on a single page when most tickets
 *     have 5-15 comments; use `nextStartAt` from the response to paginate
 *     beyond).
 *   - Comment body is rendered to plain text via adfToPlainText() — the raw
 *     ADF doc is heavy and rarely useful for an LLM context.
 *   - Per-comment body cap (CP-2669 G3): if body.length > 500, the body is
 *     truncated to 500 chars and a tail marker is appended:
 *         "…[正文已截断, 共 N 字符, 全文用 jira_get_comment {id} 获取]"
 *     where N is the original (pre-truncation) body length. The full
 *     body is still fetchable per-comment via jira_get_comment.
 *   - `mentions` field carries the deduped {accountId, displayName} list
 *     pulled from ADF mention nodes. Cheap, and critical for the
 *     "who got pinged on this thread" question.
 *   - `orderBy` defaults to "-created" (newest first), which is what
 *     humans want when scrolling a ticket. Set to "created" to get
 *     oldest-first.
 *   - Response shape (CP-2669 G5): {ok, method, request{issueIdOrKey},
 *     total, returned, comments, [nextStartAt]}. nextStartAt is only
 *     present when more comments remain upstream (i.e. when callers
 *     should paginate). `summary` / `rawCount` / `count` / top-level
 *     `startAt` / `maxResults` are all dropped — the agent already
 *     knows the startAt and maxResults it sent, and total/returned
 *     are the only two numbers the LLM needs to evaluate "did I get
 *     all of them?".
 *   - ToolResult.details (CP-2669 G6): <100-char one-line summary like
 *     "CP-2667 共 25 条评论, 本次返回 10 条 (→10 翻页)". The full
 *     structured object still lives in `content[0].text`.
 *
 * Why a separate tool from jira_get? Two reasons:
 *   1. Comments are usually fetched AFTER the issue metadata. Pulling
 *      them in the same call forces the agent to take the heavy ADF
 *      description + heavy ADF comments together. Splitting lets the
 *      agent pay for each independently.
 *   2. jira_get with `expand=renderedFields` returns comments inline, but
 *      that's the same ADF payload — same cost.
 *
 * Per the SKILL.md §避坑清单 rule, the response only ever contains
 * plain text + mention IDs (never ADF), so the LLM can safely echo it
 * back into a tool call without re-entering the ADF-must-be-dict trap.
 */
import { loadConfig } from "../auth.js";
import { jiraGet, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import { adfToPlainText } from "./_adf.js";
import type { ToolResult } from "../types.js";

const DEFAULT_MAX_RESULTS = 10;
const BODY_TRUNCATE_LIMIT = 500;
const ALLOWED_ORDER_BY = new Set(["created", "-created"]);

export async function listComments(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    return textResult(
      { error: errorMessage(err) },
      "jira_list_comments 失败: 配置加载错误",
    );
  }

  const issueIdOrKey = args.issueIdOrKey;
  if (typeof issueIdOrKey !== "string" || issueIdOrKey.length === 0) {
    return textResult(
      {
        error:
          "list_comments requires a non-empty `issueIdOrKey` (string) argument.",
      },
      "jira_list_comments 失败: 缺少 issueIdOrKey",
    );
  }

  // startAt: optional, default 0. Reject negative / non-integer.
  let startAt = 0;
  if (args.startAt !== undefined && args.startAt !== null) {
    if (
      typeof args.startAt !== "number" ||
      !Number.isInteger(args.startAt) ||
      args.startAt < 0
    ) {
      return textResult(
        {
          error:
            "list_comments `startAt` must be a non-negative integer (default 0).",
        },
        "jira_list_comments 失败: startAt 非法",
      );
    }
    startAt = args.startAt;
  }

  // maxResults: optional, default 10 (CP-2669 G4 — was 20 in 0.5.x, dropped
  // to 10 because tickets with > 10 comments are routine and the most-
  // recent 10 cover the LLM use-case; use `nextStartAt` to paginate).
  // Cap at 100 — beyond that Atlassian returns paginated anyway and the LLM
  // will burn context for no gain.
  let maxResults = DEFAULT_MAX_RESULTS;
  if (args.maxResults !== undefined && args.maxResults !== null) {
    if (
      typeof args.maxResults !== "number" ||
      !Number.isInteger(args.maxResults) ||
      args.maxResults < 1
    ) {
      return textResult(
        {
          error:
            "list_comments `maxResults` must be a positive integer (default 10, max 100).",
        },
        "jira_list_comments 失败: maxResults 非法",
      );
    }
    if (args.maxResults > 100) {
      return textResult(
        {
          error:
            "list_comments `maxResults` is capped at 100. Use `startAt` to paginate.",
        },
        "jira_list_comments 失败: maxResults 超 100",
      );
    }
    maxResults = args.maxResults;
  }

  // orderBy: optional, default "-created". Reject unknown values to keep
  // the URL query param safe (Atlassian returns 400 on garbage, but
  // surfacing the error at the call site is cleaner).
  let orderBy = "-created";
  if (args.orderBy !== undefined && args.orderBy !== null) {
    if (typeof args.orderBy !== "string" || !ALLOWED_ORDER_BY.has(args.orderBy)) {
      return textResult(
        {
          error:
            "list_comments `orderBy` must be one of: 'created', '-created' (default '-created').",
        },
        "jira_list_comments 失败: orderBy 非法",
      );
    }
    orderBy = args.orderBy;
  }

  // since: optional ISO date string. Client-side filter: keep comments
  // whose `created` is >= since. Skipped silently when undefined/empty
  // (AC1: empty filter must not throw). Invalid date strings are caught
  // and returned as a soft error so the agent can correct the call.
  let sinceMs: number | null = null;
  if (args.since !== undefined && args.since !== null && args.since !== "") {
    if (typeof args.since !== "string") {
      return textResult(
        {
          error:
            "list_comments `since` must be an ISO date string (e.g. '2026-06-15' or '2026-06-15T10:00:00.000+0800').",
        },
        "jira_list_comments 失败: since 非法",
      );
    }
    const parsed = Date.parse(args.since);
    if (Number.isNaN(parsed)) {
      return textResult(
        {
          error:
            `list_comments \`since\` is not a valid ISO date: '${args.since}'. ` +
            `Use e.g. '2026-06-15' or '2026-06-15T10:00:00.000+0800'.`,
        },
        "jira_list_comments 失败: since 格式错误",
      );
    }
    sinceMs = parsed;
  }

  // authorAccountId: optional string. Client-side filter: keep comments
  // whose `author.accountId` matches. Skipped silently when undefined/empty
  // (AC1: empty filter must not throw).
  let authorAccountId: string | null = null;
  if (
    args.authorAccountId !== undefined &&
    args.authorAccountId !== null &&
    args.authorAccountId !== ""
  ) {
    if (typeof args.authorAccountId !== "string") {
      return textResult(
        {
          error:
            "list_comments `authorAccountId` must be a string (e.g. '712020:42e79d90-a6eb-45e7-ac69-f2872f3b89b1').",
        },
        "jira_list_comments 失败: authorAccountId 非法",
      );
    }
    authorAccountId = args.authorAccountId;
  }

  try {
    const data = (await jiraGet(cfg, `issue/${issueIdOrKey}/comment`, {
      startAt,
      maxResults,
      orderBy,
    })) as {
      comments?: unknown[];
      total?: number;
      startAt?: number;
      maxResults?: number;
    };

    const upstreamCount = Array.isArray(data?.comments) ? data.comments.length : 0;
    const formatted = data?.comments?.map((c) => formatComment(c)) ?? [];

    // Apply client-side filters. Skip cleanly when the filter is empty.
    // Note: since/authorAccountId are no longer echoed in the response
    // (CP-2669 G5 — slim shape); the agent already knows what it sent.
    const comments = formatted.filter((c) => {
      if (sinceMs !== null) {
        if (typeof c.created !== "string") return false;
        const createdMs = Date.parse(c.created);
        if (Number.isNaN(createdMs)) return false;
        if (createdMs < sinceMs) return false;
      }
      if (authorAccountId !== null) {
        if (!c.author || c.author.accountId !== authorAccountId) return false;
      }
      return true;
    });

    // CP-2669 G3: per-comment body cap. Apply AFTER filter so truncated
    // counts reflect what the agent actually sees.
    for (const c of comments) {
      c.body = truncateBody(c.body, c.id);
    }

    const total = data?.total ?? upstreamCount;
    const returned = comments.length;
    const pageStart = data?.startAt ?? startAt;
    // CP-2669 G5: nextStartAt only when more comments remain upstream
    // (i.e. startAt + pageSize < total). Semantically: "last offset
    // we just saw + 1" — the offset for the next page the agent should
    // request. The +1 is implicit in (pageStart + pageSize).
    const pageSize = data?.maxResults ?? maxResults;
    const hasMore = pageStart + pageSize < total;

    const payload: Record<string, unknown> = {
      ok: true,
      method: "list_comments",
      // Echo only key-class identifiers (CP-2384 AC2 + CP-2669 G5 slim).
      request: { issueIdOrKey },
      total,
      returned,
      comments,
    };
    if (hasMore) {
      payload.nextStartAt = pageStart + pageSize;
    }

    // CP-2669 G6: <100-char one-line semantic summary for ToolResult.details.
    // Format: "<key> 共 N 条评论, 本次返回 M 条 (→N 翻页)" — pagination hint
    // only when there's more. When filters narrow returned to 0 we keep
    // the same template but the agent can read `total` from the structured
    // payload.
    const summaryLine = hasMore
      ? `${issueIdOrKey} 共 ${total} 条评论, 本次返回 ${returned} 条 (→${pageStart + pageSize} 翻页)`
      : `${issueIdOrKey} 共 ${total} 条评论, 本次返回 ${returned} 条`;

    return textResult(payload, summaryLine);
  } catch (err) {
    if (err instanceof JiraHttpError) {
      return textResult(
        { error: `jira.list_comments failed: ${err.message}` },
        `jira_list_comments 失败: ${err.message}`,
      );
    }
    return textResult(
      { error: `jira.list_comments failed: ${errorMessage(err)}` },
      `jira_list_comments 失败: ${errorMessage(err)}`,
    );
  }
}

type FormattedComment = {
  id: string | undefined;
  author: { displayName: string; accountId: string } | null;
  created: string | undefined;
  updated: string | undefined;
  body: string;
  mentions: Array<{ accountId: string; displayName: string }>;
};

/**
 * CP-2669 G3: truncate a comment body to BODY_TRUNCATE_LIMIT chars and
 * append a tail marker that tells the agent where to fetch the full
 * body. The marker carries the ORIGINAL (pre-truncation) character
 * count N so the agent can judge "this is way longer than the snippet"
 * and the jira_get_comment {id} pointer for one-shot follow-up.
 *
 *   <first 500 chars>…[正文已截断, 共 N 字符, 全文用 jira_get_comment {id} 获取]
 *
 * Below the limit the body is returned untouched.
 */
function truncateBody(body: string, id: string | undefined): string {
  if (body.length <= BODY_TRUNCATE_LIMIT) return body;
  const idFragment = id ? ` ${id}` : "";
  return `${body.slice(0, BODY_TRUNCATE_LIMIT)}…[正文已截断, 共 ${body.length} 字符, 全文用 jira_get_comment${idFragment} 获取]`;
}

/**
 * Format a single Atlassian comment into the minimal LLM-friendly shape.
 *
 * Skips raw ADF — that's the whole point. Carries:
 *   - id            (for jira_get_comment follow-up)
 *   - author        (displayName + accountId; accountId is needed for
 *                    matching against a future mentionMap AND for the
 *                    list_comments `authorAccountId` client-side filter)
 *   - created/updated
 *   - body          (plain text + mention list; CP-2669 G3 truncates
 *                    bodies longer than 500 chars to keep a single
 *                    comment from blowing out the LLM context budget)
 *
 * The `bodyRaw` field is intentionally absent — callers that need the
 * raw ADF should re-fetch via a dedicated endpoint, not piggyback on
 * this read. (We could add it later behind a flag if it turns out
 * downstream tools want it.)
 */
function formatComment(raw: unknown): FormattedComment {
  const c = (raw ?? {}) as {
    id?: string;
    author?: { displayName?: string; accountId?: string };
    created?: string;
    updated?: string;
    body?: unknown;
  };
  const { text, mentions } = adfToPlainText(c.body);
  const author = c.author
    ? {
        displayName: c.author.displayName ?? "",
        accountId: c.author.accountId ?? "",
      }
    : null;
  return {
    id: c.id,
    author,
    created: c.created,
    updated: c.updated,
    body: text,
    mentions,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
