/**
 * jira.search — JQL search via GET /rest/api/3/search/jql.
 *
 * NOTE: Atlassian deprecated the legacy /rest/api/3/search endpoint (returns
 * HTTP 410 Gone). The new endpoint /rest/api/3/search/jql accepts JQL as a
 * query parameter and returns the same shape. Migration guide:
 *   https://developer.atlassian.com/changelog/#CHANGE-2046
 * The token's OAuth scope is sufficient (verified end-to-end 2026-06-10).
 *
 * Default fields: ["summary","status","issuetype","labels","created","issuelinks","parent"]
 * Default maxResults: 30.
 *
 * Out: a text-formatted table for human/LLM use, plus the raw JSON in `details.issues`
 * so downstream tool calls can re-use the data without re-fetching.
 */
import { loadConfig } from "../auth.js";
import { jiraGet, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
const DEFAULT_FIELDS = [
    "summary",
    "status",
    "issuetype",
    "labels",
    "created",
    "issuelinks",
    "parent",
];
export async function search(args) {
    let cfg;
    try {
        cfg = loadConfig();
    }
    catch (err) {
        return textResult({ error: errorMessage(err) });
    }
    const jql = args.jql;
    if (typeof jql !== "string" || jql.trim().length === 0) {
        return textResult({
            error: "search requires a non-empty `jql` (string) argument.",
        });
    }
    const maxResults = typeof args.maxResults === "number" && Number.isFinite(args.maxResults)
        ? args.maxResults
        : 30;
    const fields = Array.isArray(args.fields)
        ? args.fields.filter((f) => typeof f === "string")
        : DEFAULT_FIELDS;
    try {
        const data = (await jiraGet(cfg, "search/jql", {
            jql,
            maxResults,
            fields: fields.join(","),
        }));
        const issues = Array.isArray(data?.issues) ? data.issues : [];
        return textResult({
            ok: true,
            method: "search",
            request: { jql, maxResults, fields },
            total: data?.total ?? issues.length,
            count: issues.length,
            issues: formatIssues(issues),
        });
    }
    catch (err) {
        if (err instanceof JiraHttpError) {
            return textResult({ error: `jira.search failed: ${err.message}` });
        }
        return textResult({ error: `jira.search failed: ${errorMessage(err)}` });
    }
}
function formatIssues(issues) {
    return issues.map((raw) => {
        const issue = raw;
        const f = issue.fields ?? {};
        const status = typeof f.status === "object" && f.status !== null
            ? f.status.name
            : undefined;
        const issuetype = typeof f.issuetype === "object" && f.issuetype !== null
            ? f.issuetype.name
            : undefined;
        const parent = typeof f.parent === "object" && f.parent !== null
            ? f.parent.key
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
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
