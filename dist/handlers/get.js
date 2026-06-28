/**
 * jira.get — read single issue with metadata + ADF description.
 *
 * Context-saving design (0.4.1+):
 *
 * Default behavior excludes `comment` and `worklog` from the Atlassian
 * response. These are the two heaviest sub-resources on a long-lived
 * ticket and routinely cost 5-50 KB per call. Agents that want comments
 * should call `jira_list_comments` separately (which renders ADF → plain
 * text and dedupes mentions); agents that want worklog should call a
 * future `jira_list_worklogs` (not yet shipped) or pass `fields: ['*all']`
 * here.
 *
 * `fields` (optional): whitelisted list of Jira field names to fetch
 * server-side. Empty array or omitted → use the default whitelist below.
 * Pass `['*all']` for full payload, or specific names like
 * `['customfield_10019']` to scope to one field.
 *
 * Why not just "filter client-side"? Because the wire payload from Jira
 * Cloud already costs us tokens even before our formatter runs. Filtering
 * server-side via the `fields` query param is the only real fix.
 *
 * Why not just default to "*navigable"? That set still includes `comment`
 * on most instances — verified empirically against the Cereb Jira Cloud.
 * We need an explicit whitelist to keep the default safe.
 *
 * Default whitelist (everything the formatter surfaces, plus description):
 *   summary, status, issuetype, priority, labels, assignee, reporter,
 *   created, updated, parent, description
 *
 * Intentionally excluded from default:
 *   comment   → use jira_list_comments
 *   worklog   → not yet exposed as a tool
 *   attachment → not yet exposed as a tool
 *   customfield_* → opt-in per field
 *   workratio, aggregateprogress, timespent, etc. → noise
 */
import { loadConfig } from "../auth.js";
import { jiraGet, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
/** Whitelisted Jira field names that jira_get fetches by default.
 *  Anything not in this list requires explicit `fields` opt-in.
 *
 *  Keep this list in sync with the SSSS-401 plan AC1 contract (12 items):
 *    summary, status, issuetype, priority, labels, assignee, reporter,
 *    created, updated, parent, description, issuelinks
 *  Adding a 13th field or removing one breaks SSSS-404 AC2's reverse
 *  assertion. */
const DEFAULT_FIELDS = [
    "summary",
    "status",
    "issuetype",
    "priority",
    "labels",
    "assignee",
    "reporter",
    "created",
    "updated",
    "parent",
    "description",
    "issuelinks",
];
export async function get(args) {
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
            error: "get requires a non-empty `issueIdOrKey` (string) argument.",
        });
    }
    const query = {};
    if (Array.isArray(args.fields)) {
        const fields = args.fields.filter((f) => typeof f === "string");
        if (fields.length > 0) {
            query.fields = fields.join(",");
        }
        else {
            // Empty array = caller wants the default efficient set.
            query.fields = DEFAULT_FIELDS.join(",");
        }
    }
    else {
        // No `fields` arg at all = default efficient set.
        query.fields = DEFAULT_FIELDS.join(",");
    }
    try {
        const data = (await jiraGet(cfg, `issue/${issueIdOrKey}`, query));
        const f = data.fields ?? {};
        const status = typeof f.status === "object" && f.status !== null
            ? f.status.name
            : undefined;
        const issuetype = typeof f.issuetype === "object" && f.issuetype !== null
            ? f.issuetype.name
            : undefined;
        const assignee = typeof f.assignee === "object" && f.assignee !== null
            ? f.assignee
            : undefined;
        const reporter = typeof f.reporter === "object" && f.reporter !== null
            ? f.reporter
            : undefined;
        const priority = typeof f.priority === "object" && f.priority !== null
            ? f.priority.name
            : undefined;
        const parent = typeof f.parent === "object" && f.parent !== null
            ? f.parent
            : undefined;
        return textResult({
            ok: true,
            method: "get",
            request: { issueIdOrKey, fields: query.fields },
            issue: {
                key: data.key,
                id: data.id,
                summary: f.summary,
                status,
                issuetype,
                priority,
                labels: f.labels,
                assignee: assignee?.displayName ?? null,
                reporter: reporter?.displayName ?? null,
                created: f.created,
                updated: f.updated,
                parent: parent
                    ? { key: parent.key, summary: parent.fields?.summary }
                    : null,
                // issuelinks: list of {id, type, inwardIssue|outwardIssue}. Surfaced
                // as-is from the API. Cheap to pass through — it's a small array of
                // {id, type.name, outwardIssue.key, ...} per link.
                issuelinks: f.issuelinks ?? [],
                description: f.description ?? null,
                // Carry through the full fields object so callers can drill into
                // anything we didn't surface. Cheap because the field list is
                // already filtered server-side by the `fields` query param.
                fields: f,
            },
        });
    }
    catch (err) {
        if (err instanceof JiraHttpError) {
            return textResult({ error: `jira.get failed: ${err.message}` });
        }
        return textResult({ error: `jira.get failed: ${errorMessage(err)}` });
    }
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
