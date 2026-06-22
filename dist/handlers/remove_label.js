/**
 * jira.remove_label — drop a single label from an issue.
 *
 * PUT /rest/api/3/issue/{issueIdOrKey}
 *   body: { update: { labels: [{ remove: label }] } }
 *
 * Atlassian returns 204 No Content on success. Removing a label that does
 * not exist is a no-op (idempotent) — we still report ok:true.
 *
 * Note the deliberate symmetry with add_label: same path, same `update`
 * envelope, just `{ remove: label }` in place of `{ add: label }`. We keep
 * the implementations separate (rather than a flag on a single handler)
 * because the agent's intent is explicit and the dispatcher surface is
 * cleaner with two method names.
 */
import { loadConfig } from "../auth.js";
import { jiraPut, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
export async function removeLabel(args) {
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
            error: "remove_label requires a non-empty `issueIdOrKey` (string) argument.",
        });
    }
    const label = args.label;
    if (typeof label !== "string" || label.trim().length === 0) {
        return textResult({
            error: "remove_label requires a non-empty `label` (string) argument.",
        });
    }
    try {
        await jiraPut(cfg, `issue/${issueIdOrKey}`, {
            update: { labels: [{ remove: label }] },
        });
        return textResult({
            ok: true,
            method: "remove_label",
            request: { issueIdOrKey, label },
            summary: {
                key: issueIdOrKey,
                label,
                action: "removed",
            },
        });
    }
    catch (err) {
        if (err instanceof JiraHttpError) {
            return textResult({ error: `jira.remove_label failed: ${err.message}` });
        }
        return textResult({ error: `jira.remove_label failed: ${errorMessage(err)}` });
    }
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
