/**
 * jira.submit_verdict — close out a task with verdict + transition (0.3.0+).
 *
 * Verdict dispatches to two flows (verdict ∈ {PASS, FAIL}, 0.3.3+ 移除 BLOCKED):
 *
 *   PASS
 *     1. POST  /rest/api/3/issue/{key}/comment  (verdict + summary + evidence)
 *     2. GET+POST /rest/api/3/issue/{key}/transitions  (→ "已完成")
 *
 *   FAIL
 *     1. POST  /rest/api/3/issue/{key}/comment  (verdict=FAIL + summary + reason)
 *     2. PUT   /rest/api/3/issue/{key}  labels: add "escalated"
 *     3. PUT   /rest/api/3/issue/{key}  fields: { assignee: null }
 *
 * Reason is mandatory for FAIL — caller must pass non-empty string. We
 * throw JiraPluginError before any side effect if missing, so the
 * orchestrator gets a clear signal to fix the call rather than retry.
 *
 * Atomic (per step) — same partial-result reporting pattern as before:
 * if step 1 fails, nothing happened. If a later step fails, the prior
 * state is preserved and we surface a partial result with hint.
 *
 * "Atomic" here means "in one method call from the agent's perspective" —
 * not DB-style rollback. We don't fabricate idempotency for re-runs.
 */
import { JiraPluginError, loadConfig } from "../auth.js";
import { jiraGet, jiraPost, jiraPut, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import { buildCompleteComment } from "./_adf.js";
const TARGET_STATUS = "已完成";
const ESCALATED_LABEL = "escalated";
export async function submitVerdict(args) {
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
            error: "submit_verdict requires a non-empty `issueIdOrKey` (string).",
        });
    }
    const verdict = args.verdict;
    if (verdict !== "PASS" && verdict !== "FAIL") {
        return textResult({
            error: "submit_verdict requires `verdict` to be one of 'PASS' | 'FAIL'.",
        });
    }
    const summary = args.summary;
    if (typeof summary !== "string" || summary.trim().length === 0) {
        return textResult({
            error: "submit_verdict requires `summary` (string, non-empty).",
        });
    }
    const evidence = typeof args.evidence === "string" ? args.evidence : "";
    // FAIL invariants: reason is mandatory. Validate BEFORE any side effect
    // so callers get a hard error instead of a partial escalation.
    let reason = "";
    if (verdict === "FAIL") {
        reason = typeof args.reason === "string" ? args.reason.trim() : "";
        if (reason.length === 0) {
            throw new JiraPluginError(`submit_verdict(verdict=FAIL) requires non-empty \`reason\` (string). ` +
                `Reason documents why the task failed; the escalated label + cleared ` +
                `assignee signal "human pickup" to the orchestrator.`);
        }
    }
    // Step 1: post the verdict comment (always).
    const commentAdf = buildCompleteComment(verdict, summary, evidence, reason);
    let commentId;
    let commentSelf;
    try {
        const data = (await jiraPost(cfg, `issue/${issueIdOrKey}/comment`, {
            body: commentAdf,
        }));
        commentId = data.id;
        commentSelf = data.self;
    }
    catch (err) {
        const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
        return textResult({
            error: `jira.submit_verdict (step 1: comment) failed: ${msg}. ` +
                "Transition was NOT executed. No side effect on the issue.",
        });
    }
    // FAIL → add label + clear assignee (no transition).
    if (verdict === "FAIL") {
        return await escalateAfterComment(cfg, issueIdOrKey, commentId, commentSelf);
    }
    // PASS → transition to "已完成" (existing behavior).
    return await completeTransition(cfg, issueIdOrKey, commentId, commentSelf, verdict);
}
/**
 * FAIL continuation: add the "escalated" label and clear the assignee.
 * Mirrors what escalate_task used to do in step 3+4 (label + assignee clear after comment).
 */
async function escalateAfterComment(cfg, issueIdOrKey, commentId, commentSelf) {
    let labelOk = false;
    try {
        await jiraPut(cfg, `issue/${issueIdOrKey}`, {
            update: { labels: [{ add: ESCALATED_LABEL }] },
        });
        labelOk = true;
    }
    catch (err) {
        const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
        return textResult({
            ok: false,
            method: "submit_verdict",
            partial: true,
            verdict: "FAIL",
            comment: { id: commentId, self: commentSelf },
            error: `jira.submit_verdict (verdict=FAIL, step 2: add label) failed: ${msg}. ` +
                `Verdict comment was already posted; label was NOT added; assignee NOT cleared. ` +
                `Re-run submit_verdict with the same args to retry — the comment step is idempotent at ` +
                `the UI level but will post a duplicate ADF comment on Jira.`,
        });
    }
    let assigneeCleared = false;
    try {
        await jiraPut(cfg, `issue/${issueIdOrKey}`, {
            fields: { assignee: null },
        });
        assigneeCleared = true;
    }
    catch (err) {
        const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
        return textResult({
            ok: false,
            method: "submit_verdict",
            partial: true,
            verdict: "FAIL",
            comment: { id: commentId, self: commentSelf },
            label: ESCALATED_LABEL,
            hint: `Verdict comment + "${ESCALATED_LABEL}" label already applied. To finish, run: ` +
                `jira { method: "update", args: { issueIdOrKey: "${issueIdOrKey}", fields: { assignee: null } } }`,
            error: `jira.submit_verdict (verdict=FAIL, step 3: clear assignee) failed: ${msg}. ` +
                `Comment and label already applied; assignee NOT cleared.`,
        });
    }
    return textResult({
        ok: true,
        method: "submit_verdict",
        verdict: "FAIL",
        comment: { id: commentId, self: commentSelf },
        label: ESCALATED_LABEL,
        assigneeCleared: true,
        summary: {
            key: issueIdOrKey,
            verdict: "FAIL",
            commentId,
            label: ESCALATED_LABEL,
            assigneeCleared: true,
        },
        hint: `Task failed and was escalated. The "escalated" label signals "human pickup" ` +
            `to the orchestrator pipeline. Use jira { method: "request_help", ... } if a specific ` +
            `person should look at it.`,
    });
}
/**
 * PASS continuation: list transitions and move to "已完成".
 * Existing 0.3.0+ behavior — unchanged.
 */
async function completeTransition(cfg, issueIdOrKey, commentId, commentSelf, verdict) {
    let transitions;
    try {
        const data = (await jiraGet(cfg, `issue/${issueIdOrKey}/transitions`));
        transitions = Array.isArray(data?.transitions) ? data.transitions : [];
    }
    catch (err) {
        const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
        return textResult({
            ok: false,
            method: "submit_verdict",
            partial: true,
            comment: { id: commentId, self: commentSelf },
            hint: `Comment was posted (id=${commentId}) but the transition lookup failed: ${msg}. ` +
                `Re-run the generic \`transition\` method to finish, or retry submit_verdict ` +
                `if the failure was transient (be aware: this will post a duplicate comment).`,
            error: `jira.submit_verdict (step 2a: list transitions) failed: ${msg}. ` +
                `Comment was already posted.`,
        });
    }
    if (transitions.length === 0) {
        return textResult({
            ok: false,
            method: "submit_verdict",
            partial: true,
            comment: { id: commentId, self: commentSelf },
            error: `No transitions available for ${issueIdOrKey} — issue may be in a terminal state. ` +
                `Comment was already posted.`,
        });
    }
    const target = TARGET_STATUS.toLowerCase();
    const match = transitions.find((t) => (t.to?.name ?? "").toLowerCase() === target);
    if (!match) {
        const available = transitions.map((t) => `${t.name} → ${t.to?.name ?? "?"}`);
        return textResult({
            ok: false,
            method: "submit_verdict",
            partial: true,
            comment: { id: commentId, self: commentSelf },
            error: `targetStatus "${TARGET_STATUS}" not in available transitions for ${issueIdOrKey}: [${available.join(", ")}]. ` +
                `Comment was already posted.`,
            hint: "Available transitions (label → destination): " + available.join("; "),
        });
    }
    try {
        await jiraPost(cfg, `issue/${issueIdOrKey}/transitions`, {
            transition: { id: match.id },
        });
        return textResult({
            ok: true,
            method: "submit_verdict",
            comment: { id: commentId, self: commentSelf },
            transition: {
                id: match.id,
                name: match.name,
                to: match.to?.name,
            },
            summary: {
                key: issueIdOrKey,
                verdict,
                commentId,
                transitionedTo: match.to?.name,
            },
        });
    }
    catch (err) {
        const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
        return textResult({
            ok: false,
            method: "submit_verdict",
            partial: true,
            comment: { id: commentId, self: commentSelf },
            hint: `Comment was posted (id=${commentId}) but the transition execute failed: ${msg}. ` +
                `Use the generic \`transition\` method to move ${issueIdOrKey} to "${TARGET_STATUS}".`,
            error: `jira.submit_verdict (step 2b: execute transition) failed: ${msg}. ` +
                `Comment was already posted.`,
        });
    }
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
