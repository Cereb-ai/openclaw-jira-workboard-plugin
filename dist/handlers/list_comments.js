/**
 * jira.list_comments — read all comments on a ticket, with ADF → plain text.
 *
 * REST: GET /rest/api/3/issue/{issueIdOrKey}/comment
 *
 * Context-saving design (0.4.0+):
 *   - Default maxResults=50 (Atlassian's default is 50 too).
 *   - Comment body is rendered to plain text via adfToPlainText() — the raw
 *     ADF doc is heavy and rarely useful for an LLM context.
 *   - `mentions` field carries the deduped {accountId, displayName} list
 *     pulled from ADF mention nodes. Cheap, and critical for the
 *     "who got pinged on this thread" question.
 *   - `orderBy` defaults to "-created" (newest first), which is what
 *     humans want when scrolling a ticket. Set to "created" to get
 *     oldest-first.
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
const DEFAULT_MAX_RESULTS = 50;
const ALLOWED_ORDER_BY = new Set(["created", "-created"]);
export async function listComments(args) {
    let cfg;
    try {
        cfg = loadConfig();
    }
    catch (err) {
        return textResult({ error: errorMessage(err) });
    }
    const issueIdOrKey = args.issueIdOrKey;
    if (typeof issueIdOrKey !== "string" || issueIdOrKey.length === 0) {
        return textResult({
            error: "list_comments requires a non-empty `issueIdOrKey` (string) argument.",
        });
    }
    // startAt: optional, default 0. Reject negative / non-integer.
    let startAt = 0;
    if (args.startAt !== undefined && args.startAt !== null) {
        if (typeof args.startAt !== "number" ||
            !Number.isInteger(args.startAt) ||
            args.startAt < 0) {
            return textResult({
                error: "list_comments `startAt` must be a non-negative integer (default 0).",
            });
        }
        startAt = args.startAt;
    }
    // maxResults: optional, default 50. Cap at 100 — beyond that Atlassian
    // returns paginated anyway and the LLM will burn context for no gain.
    let maxResults = DEFAULT_MAX_RESULTS;
    if (args.maxResults !== undefined && args.maxResults !== null) {
        if (typeof args.maxResults !== "number" ||
            !Number.isInteger(args.maxResults) ||
            args.maxResults < 1) {
            return textResult({
                error: "list_comments `maxResults` must be a positive integer (default 50, max 100).",
            });
        }
        if (args.maxResults > 100) {
            return textResult({
                error: "list_comments `maxResults` is capped at 100. Use `startAt` to paginate.",
            });
        }
        maxResults = args.maxResults;
    }
    // orderBy: optional, default "-created". Reject unknown values to keep
    // the URL query param safe (Atlassian returns 400 on garbage, but
    // surfacing the error at the call site is cleaner).
    let orderBy = "-created";
    if (args.orderBy !== undefined && args.orderBy !== null) {
        if (typeof args.orderBy !== "string" || !ALLOWED_ORDER_BY.has(args.orderBy)) {
            return textResult({
                error: "list_comments `orderBy` must be one of: 'created', '-created' (default '-created').",
            });
        }
        orderBy = args.orderBy;
    }
    // since: optional ISO date string. Client-side filter: keep comments
    // whose `created` is >= since. Skipped silently when undefined/empty
    // (AC1: empty filter must not throw). Invalid date strings are caught
    // and returned as a soft error so the agent can correct the call.
    let sinceMs = null;
    if (args.since !== undefined && args.since !== null && args.since !== "") {
        if (typeof args.since !== "string") {
            return textResult({
                error: "list_comments `since` must be an ISO date string (e.g. '2026-06-15' or '2026-06-15T10:00:00.000+0800').",
            });
        }
        const parsed = Date.parse(args.since);
        if (Number.isNaN(parsed)) {
            return textResult({
                error: `list_comments \`since\` is not a valid ISO date: '${args.since}'. ` +
                    `Use e.g. '2026-06-15' or '2026-06-15T10:00:00.000+0800'.`,
            });
        }
        sinceMs = parsed;
    }
    // authorAccountId: optional string. Client-side filter: keep comments
    // whose `author.accountId` matches. Skipped silently when undefined/empty
    // (AC1: empty filter must not throw).
    let authorAccountId = null;
    if (args.authorAccountId !== undefined &&
        args.authorAccountId !== null &&
        args.authorAccountId !== "") {
        if (typeof args.authorAccountId !== "string") {
            return textResult({
                error: "list_comments `authorAccountId` must be a string (e.g. '712020:42e79d90-a6eb-45e7-ac69-f2872f3b89b1').",
            });
        }
        authorAccountId = args.authorAccountId;
    }
    try {
        const data = (await jiraGet(cfg, `issue/${issueIdOrKey}/comment`, {
            startAt,
            maxResults,
            orderBy,
        }));
        const rawComments = Array.isArray(data?.comments) ? data.comments : [];
        const formatted = rawComments.map((c) => formatComment(c));
        // Apply client-side filters. Skip cleanly when the filter is empty.
        const comments = formatted.filter((c) => {
            if (sinceMs !== null) {
                if (typeof c.created !== "string")
                    return false;
                const createdMs = Date.parse(c.created);
                if (Number.isNaN(createdMs))
                    return false;
                if (createdMs < sinceMs)
                    return false;
            }
            if (authorAccountId !== null) {
                if (!c.author || c.author.accountId !== authorAccountId)
                    return false;
            }
            return true;
        });
        return textResult({
            ok: true,
            method: "list_comments",
            request: {
                issueIdOrKey,
                startAt,
                maxResults,
                orderBy,
                since: sinceMs !== null ? new Date(sinceMs).toISOString() : undefined,
                authorAccountId: authorAccountId ?? undefined,
            },
            total: data?.total ?? comments.length,
            startAt: data?.startAt ?? startAt,
            maxResults: data?.maxResults ?? maxResults,
            rawCount: formatted.length,
            count: comments.length,
            comments,
            summary: {
                key: issueIdOrKey,
                total: data?.total ?? comments.length,
                count: comments.length,
                orderBy,
                since: sinceMs !== null ? new Date(sinceMs).toISOString() : undefined,
                authorAccountId: authorAccountId ?? undefined,
            },
        });
    }
    catch (err) {
        if (err instanceof JiraHttpError) {
            return textResult({ error: `jira.list_comments failed: ${err.message}` });
        }
        return textResult({
            error: `jira.list_comments failed: ${errorMessage(err)}`,
        });
    }
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
 *   - body          (plain text + mention list)
 *
 * The `bodyRaw` field is intentionally absent — callers that need the
 * raw ADF should re-fetch via a dedicated endpoint, not piggyback on
 * this read. (We could add it later behind a flag if it turns out
 * downstream tools want it.)
 */
function formatComment(raw) {
    const c = (raw ?? {});
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
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
