/**
 * jira.block — create a "Blocks" issue link between two issues.
 *
 * POST /rest/api/3/issueLink
 *   body: {
 *     type: { name: "Blocks" },
 *     inwardIssue:  { key: blocker  },  // the issue that is doing the blocking
 *     outwardIssue: { key: blocked  },  // the issue that is being blocked
 *   }
 *
 * Natural language: "blocker blocks blocked". From the perspective of the
 * `blocked` issue, `blocker` shows up as a "Blocks" link. The link type
 * name is exactly the Atlassian default ("Blocks") — we don't parameterise
 * it in Phase B.
 *
 * Atlassian returns 201 Created with empty body on success. We synthesise
 * a success envelope from the request.
 *
 * Why a dedicated method instead of a generic `link`? The natural-language
 * framing from the agent is consistently "A blocks B" — exposing the
 * semantic verb as a method name means the dispatcher surface maps 1:1 to
 * intent. Other link types (Relates, Clones, Duplicates) are a Phase C
 * concern; we can add `link` later without breaking this surface.
 */
import { loadConfig } from "../auth.js";
import { jiraPost, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
export async function block(args) {
    let cfg;
    try {
        cfg = loadConfig();
    }
    catch (err) {
        return textResult({ error: errorMessage(err) });
    }
    const blocker = args.blocker;
    if (typeof blocker !== "string" || blocker.trim().length === 0) {
        return textResult({
            error: "block requires a non-empty `blocker` (string, issue key) argument.",
        });
    }
    const blocked = args.blocked;
    if (typeof blocked !== "string" || blocked.trim().length === 0) {
        return textResult({
            error: "block requires a non-empty `blocked` (string, issue key) argument.",
        });
    }
    if (blocker === blocked) {
        return textResult({
            error: `block requires blocker and blocked to be different issues (both were "${blocker}").`,
        });
    }
    try {
        await jiraPost(cfg, "issueLink", {
            type: { name: "Blocks" },
            inwardIssue: { key: blocker },
            outwardIssue: { key: blocked },
        });
        return textResult({
            ok: true,
            method: "block",
            request: { blocker, blocked },
            summary: {
                blocker,
                blocked,
                linkType: "Blocks",
                direction: `${blocker} blocks ${blocked}`,
            },
        });
    }
    catch (err) {
        if (err instanceof JiraHttpError) {
            return textResult({ error: `jira.block failed: ${err.message}` });
        }
        return textResult({ error: `jira.block failed: ${errorMessage(err)}` });
    }
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
