/**
 * jira.get — read single issue with metadata + ADF description.
 *
 * If `fields` is omitted, Atlassian returns a curated default (not *all*
 * fields), which keeps the response small. We then pick out the most useful
 * keys for the formatted output.
 */
import { loadConfig } from "../auth.js";
import { jiraGet, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
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
        if (fields.length > 0)
            query.fields = fields.join(",");
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
            request: { issueIdOrKey, fields: query.fields ?? null },
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
