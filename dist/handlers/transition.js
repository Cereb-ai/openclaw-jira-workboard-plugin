/**
 * jira.transition — state machine flow.
 *
 * Two REST round-trips per call:
 *   1. GET  /rest/api/3/issue/{key}/transitions  → list of {id, name, to: {name}}
 *   2. POST /rest/api/3/issue/{key}/transitions  body: {transition: {id}}
 *
 * The caller supplies the destination status NAME (e.g. "In Progress" / "Done"
 * / "REVIEW"). We match by case-insensitive exact match on the transition's
 * `to.name` field. If not found, fail-fast with a list of available
 * transitions (so the agent can pick a valid one).
 *
 * Why name→id lookup server-side? The transition id is project-specific and
 * can change if an admin edits the workflow. The status name is the stable
 * user-facing handle.
 */
import { loadConfig } from "../auth.js";
import { jiraGet, jiraPost, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
export async function transition(args) {
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
            error: "transition requires a non-empty `issueIdOrKey` (string) argument.",
        });
    }
    const targetStatus = args.targetStatus;
    if (typeof targetStatus !== "string" || targetStatus.trim().length === 0) {
        return textResult({
            error: "transition requires `targetStatus` (string, e.g. 'In Progress' / 'Done' / 'REVIEW').",
        });
    }
    // Step 1: GET transitions
    let transitions;
    try {
        const data = (await jiraGet(cfg, `issue/${issueIdOrKey}/transitions`));
        transitions = Array.isArray(data?.transitions) ? data.transitions : [];
    }
    catch (err) {
        if (err instanceof JiraHttpError) {
            return textResult({
                error: `jira.transition (step 1: list) failed: ${err.message}`,
            });
        }
        return textResult({
            error: `jira.transition (step 1: list) failed: ${errorMessage(err)}`,
        });
    }
    if (transitions.length === 0) {
        return textResult({
            error: `No transitions available for ${issueIdOrKey} — ` +
                `the issue may be in a terminal state (Done/Closed) or the workflow has no outgoing edges from the current status.`,
        });
    }
    // Match by case-insensitive exact match on the destination name.
    const target = targetStatus.trim().toLowerCase();
    const match = transitions.find((t) => (t.to?.name ?? "").toLowerCase() === target);
    if (!match) {
        const available = transitions.map((t) => `${t.name} → ${t.to?.name ?? "?"}`);
        return textResult({
            error: `targetStatus "${targetStatus}" not in available transitions for ${issueIdOrKey}: [${available.join(", ")}]. ` +
                "Note: targetStatus is the destination status name, not the transition button label. " +
                "Run jira.get on the issue first to see the current status, then re-check the workflow.",
            hint: "Available transitions (label → destination): " + available.join("; "),
        });
    }
    // Step 2: POST execute
    try {
        await jiraPost(cfg, `issue/${issueIdOrKey}/transitions`, {
            transition: { id: match.id },
        });
        return textResult({
            ok: true,
            method: "transition",
            request: { issueIdOrKey, targetStatus },
            transition: {
                id: match.id,
                name: match.name,
                to: match.to?.name,
            },
            summary: {
                key: issueIdOrKey,
                from: "see jira.get current status",
                to: match.to?.name,
            },
        });
    }
    catch (err) {
        if (err instanceof JiraHttpError) {
            return textResult({
                error: `jira.transition (step 2: execute) failed: ${err.message}`,
            });
        }
        return textResult({
            error: `jira.transition (step 2: execute) failed: ${errorMessage(err)}`,
        });
    }
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
