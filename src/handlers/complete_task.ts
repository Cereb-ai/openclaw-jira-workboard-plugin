/**
 * jira.complete_task — close out a task with verdict + transition (0.3.0+).
 *
 * Verdict dispatches to two flows:
 *
 *   PASS / BLOCKED
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
import type { ToolResult } from "../types.js";

type Verdict = "PASS" | "FAIL" | "BLOCKED";
const TARGET_STATUS = "已完成";
const ESCALATED_LABEL = "escalated";

interface AtlassianTransition {
  id: string;
  name: string;
  to?: { name?: string };
}

export async function completeTask(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    return textResult({ error: errorMessage(err) });
  }

  const issueIdOrKey = args.issueIdOrKey;
  if (typeof issueIdOrKey !== "string" || issueIdOrKey.length === 0) {
    return textResult({
      error: "complete_task requires a non-empty `issueIdOrKey` (string).",
    });
  }
  const verdict = args.verdict;
  if (verdict !== "PASS" && verdict !== "FAIL" && verdict !== "BLOCKED") {
    return textResult({
      error: "complete_task requires `verdict` to be one of 'PASS' | 'FAIL' | 'BLOCKED'.",
    });
  }
  const summary = args.summary;
  if (typeof summary !== "string" || summary.trim().length === 0) {
    return textResult({
      error: "complete_task requires `summary` (string, non-empty).",
    });
  }
  const evidence =
    typeof args.evidence === "string" ? args.evidence : "";

  // FAIL invariants: reason is mandatory. Validate BEFORE any side effect
  // so callers get a hard error instead of a partial escalation.
  let reason = "";
  if (verdict === "FAIL") {
    reason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (reason.length === 0) {
      throw new JiraPluginError(
        `complete_task(verdict=FAIL) requires non-empty \`reason\` (string). ` +
          `Reason documents why the task failed; the escalated label + cleared ` +
          `assignee signal "human pickup" to the orchestrator.`,
      );
    }
  }

  // Step 1: post the verdict comment (always).
  const commentAdf = buildCompleteComment(verdict as Verdict, summary, evidence, reason);
  let commentId: string | undefined;
  let commentSelf: string | undefined;
  try {
    const data = (await jiraPost(cfg, `issue/${issueIdOrKey}/comment`, {
      body: commentAdf,
    })) as { id?: string; self?: string };
    commentId = data.id;
    commentSelf = data.self;
  } catch (err) {
    const msg = err instanceof JiraHttpError ? err.message : errorMessage(err);
    return textResult({
      error: `jira.complete_task (step 1: comment) failed: ${msg}. ` +
        "Transition was NOT executed. No side effect on the issue.",
    });
  }

  // FAIL → add label + clear assignee (no transition).
  if (verdict === "FAIL") {
    return await escalateAfterComment(
      cfg,
      issueIdOrKey,
      commentId,
      commentSelf,
    )
  }

  // PASS / BLOCKED → transition to "已完成" (existing behavior).
  return await completeTransition(
    cfg,
    issueIdOrKey,
    commentId,
    commentSelf,
    verdict as Verdict,
  )
}

/**
 * FAIL continuation: add the "escalated" label and clear the assignee.
 * Mirrors escalate_task step 3+4 (post-comment, since step 1 just ran).
 */
async function escalateAfterComment(
  cfg: ReturnType<typeof loadConfig>,
  issueIdOrKey: string,
  commentId: string | undefined,
  commentSelf: string | undefined,
): Promise<ToolResult> {
  let labelOk = false
  try {
    await jiraPut(cfg, `issue/${issueIdOrKey}`, {
      update: { labels: [{ add: ESCALATED_LABEL }] },
    })
    labelOk = true
  } catch (err) {
    const msg = err instanceof JiraHttpError ? err.message : errorMessage(err)
    return textResult({
      ok: false,
      method: "complete_task",
      partial: true,
      verdict: "FAIL",
      comment: { id: commentId, self: commentSelf },
      error:
        `jira.complete_task (verdict=FAIL, step 2: add label) failed: ${msg}. ` +
        `Verdict comment was already posted; label was NOT added; assignee NOT cleared. ` +
        `Re-run complete_task with the same args to retry — the comment step is idempotent at ` +
        `the UI level but will post a duplicate ADF comment on Jira.`,
    })
  }

  let assigneeCleared = false
  try {
    await jiraPut(cfg, `issue/${issueIdOrKey}`, {
      fields: { assignee: null },
    })
    assigneeCleared = true
  } catch (err) {
    const msg = err instanceof JiraHttpError ? err.message : errorMessage(err)
    return textResult({
      ok: false,
      method: "complete_task",
      partial: true,
      verdict: "FAIL",
      comment: { id: commentId, self: commentSelf },
      label: ESCALATED_LABEL,
      hint:
        `Verdict comment + "${ESCALATED_LABEL}" label already applied. To finish, run: ` +
        `jira { method: "update", args: { issueIdOrKey: "${issueIdOrKey}", fields: { assignee: null } } }`,
      error:
        `jira.complete_task (verdict=FAIL, step 3: clear assignee) failed: ${msg}. ` +
        `Comment and label already applied; assignee NOT cleared.`,
    })
  }

  return textResult({
    ok: true,
    method: "complete_task",
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
    hint:
      `Task failed and was escalated. The "escalated" label signals "human pickup" ` +
      `to the orchestrator pipeline. Use jira { method: "request_help", ... } if a specific ` +
      `person should look at it.`,
  })
}

/**
 * PASS / BLOCKED continuation: list transitions and move to "已完成".
 * Existing 0.3.0+ behavior — unchanged.
 */
async function completeTransition(
  cfg: ReturnType<typeof loadConfig>,
  issueIdOrKey: string,
  commentId: string | undefined,
  commentSelf: string | undefined,
  verdict: Verdict,
): Promise<ToolResult> {
  let transitions: AtlassianTransition[]
  try {
    const data = (await jiraGet(
      cfg,
      `issue/${issueIdOrKey}/transitions`,
    )) as { transitions?: AtlassianTransition[] }
    transitions = Array.isArray(data?.transitions) ? data.transitions : []
  } catch (err) {
    const msg = err instanceof JiraHttpError ? err.message : errorMessage(err)
    return textResult({
      ok: false,
      method: "complete_task",
      partial: true,
      comment: { id: commentId, self: commentSelf },
      hint:
        `Comment was posted (id=${commentId}) but the transition lookup failed: ${msg}. ` +
        `Re-run the generic \`transition\` method to finish, or retry complete_task ` +
        `if the failure was transient (be aware: this will post a duplicate comment).`,
      error:
        `jira.complete_task (step 2a: list transitions) failed: ${msg}. ` +
        `Comment was already posted.`,
    })
  }

  if (transitions.length === 0) {
    return textResult({
      ok: false,
      method: "complete_task",
      partial: true,
      comment: { id: commentId, self: commentSelf },
      error:
        `No transitions available for ${issueIdOrKey} — issue may be in a terminal state. ` +
        `Comment was already posted.`,
    })
  }

  const target = TARGET_STATUS.toLowerCase()
  const match = transitions.find(
    (t) => (t.to?.name ?? "").toLowerCase() === target,
  )
  if (!match) {
    const available = transitions.map(
      (t) => `${t.name} → ${t.to?.name ?? "?"}`,
    )
    return textResult({
      ok: false,
      method: "complete_task",
      partial: true,
      comment: { id: commentId, self: commentSelf },
      error:
        `targetStatus "${TARGET_STATUS}" not in available transitions for ${issueIdOrKey}: [${available.join(", ")}]. ` +
        `Comment was already posted.`,
      hint: "Available transitions (label → destination): " + available.join("; "),
    })
  }

  try {
    await jiraPost(cfg, `issue/${issueIdOrKey}/transitions`, {
      transition: { id: match.id },
    })
    return textResult({
      ok: true,
      method: "complete_task",
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
    })
  } catch (err) {
    const msg = err instanceof JiraHttpError ? err.message : errorMessage(err)
    return textResult({
      ok: false,
      method: "complete_task",
      partial: true,
      comment: { id: commentId, self: commentSelf },
      hint:
        `Comment was posted (id=${commentId}) but the transition execute failed: ${msg}. ` +
        `Use the generic \`transition\` method to move ${issueIdOrKey} to "${TARGET_STATUS}".`,
      error:
        `jira.complete_task (step 2b: execute transition) failed: ${msg}. ` +
        `Comment was already posted.`,
    })
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
