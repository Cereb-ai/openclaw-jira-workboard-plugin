/**
 * jira.submit_verdict — close out a task with verdict + transition (0.3.0+).
 *
 * Verdict dispatches to two flows (verdict ∈ {PASS, FAIL}, 0.3.3+ 移除 BLOCKED):
 *
 *   PASS
 *     1. POST  /rest/api/3/issue/{key}/comment  (verdict + summary + evidence)
 *     2. GET+POST /rest/api/3/issue/{key}/transitions  (→ done statusCategory, see _transitions.ts)
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
 * Verdict ↔ summary consistency guard (CP-2805 / CP-2806):
 *   Reject the call BEFORE any Jira write (comment / transition / label /
 *   assignee) when evidence summary contains a CP-1918 FAIL keyword
 *   (whitelisted: literal "FAIL" / "门禁 FAIL" / "前置门禁不达成")
 *   but caller submits verdict="PASS". This is the plugin-layer hard
 *   enforcement that complements the soft tester-skill guard
 *   (agent-skills task-dispatcher/bin/verdict_guard.py) — CP-2799
 *   empirically showed the soft guard was never invoked, so the plugin
 *   layer is the only path that covers all callers.
 *
 * Atomic (per step) — same partial-result reporting pattern as before:
 * if step 1 fails, nothing happened. If a later step fails, the prior
 * state is preserved and we surface a partial result with hint.
 *
 * "Atomic" here means "in one method call from the agent's perspective" —
 * not DB-style rollback. We don't fabricate idempotency for re-runs.
 *
 * Return contract (CP-2710 batch 3, v0.5 §6/§7/§8):
 *   success  → {ok, method, verdict, comment{id,self},
 *                transition{id, name, to, toCategory} (PASS only) /
 *                label, assigneeCleared (FAIL only)}
 *              summary 块去除; FAIL 成功路径 hint 去除 (语义冗余于 label
 *              反馈, 草稿池已定); partial 分支结构 0 改动 (error + hint
 *              完整保留, CP-2710 红线 #28510)
 *   details  → <100 字符一句话语义摘要; success PASS 例
 *                "CP-2690 已 PASS: 评论已发 + 转「已完成」"
 *              success FAIL 例
 *                "CP-2690 已 FAIL: escalated 已标 + assignee 已清"
 *              partial 例
 *                "CP-2690 部分完成: 评论已发但转态失败, 见 hint"
 *              rejection (verdict↔summary 不一致) 例
 *                "CP-2690 拒收: summary 含 FAIL 但 verdict=PASS"
 */
import { JiraPluginError, loadConfig } from "../auth.js";
import { jiraGet, jiraPost, jiraPut, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import { buildCompleteComment } from "./_adf.js";
import {
  describeAvailableTransitions,
  findTransition,
  type AtlassianTransition,
} from "./_transitions.js";
import type { ToolResult } from "../types.js";

type Verdict = "PASS" | "FAIL";
const ESCALATED_LABEL = "escalated";

// ─── FAIL keyword whitelist (mirror CP-1918 verdict_guard.py L42-46) ─────────
// Empirically, tester / reviewer agents write "FAIL" (literal ASCII) /
// "门禁 FAIL" / "前置门禁不达成" when the intent is FAIL. These are the
// ONLY strings we treat as a mismatch signal against verdict="PASS".
// Fuzzy words ("失败" / "未通过" / lowercase "fail") are intentionally
// NOT on this list to avoid false positives on legitimate PASS runs.
export const FAIL_KEYWORDS: readonly string[] = [
  "FAIL",              // literal ASCII (case-sensitive)
  "门禁 FAIL",          // gate-fail shorthand w/ English FAIL
  "前置门禁不达成",     // full CN phrase (pre-gate unmet)
] as const;

/**
 * Pure helper: return the first FAIL keyword that appears as a substring
 * of `summary`, or `null` if none matches. Case-sensitive (matches the
 * Python `kw in summary` semantics — CP-1918 evidence shows uppercase
 * "FAIL" is the consistent signal; lowercase never appears in
 * auto-generated evidence).
 *
 * Pure: no I/O, no side effects, safe to unit-test directly.
 */
export function findFailKeyword(
  summary: string,
  keywords: readonly string[] = FAIL_KEYWORDS,
): string | null {
  if (typeof summary !== "string") return null;
  for (const kw of keywords) {
    if (kw && summary.includes(kw)) return kw;
  }
  return null;
}

/**
 * Pure helper: verdict ↔ summary consistency check (CP-2805 / CP-2806
 * plugin-layer hard guard, mirrors CP-1918 verdict_guard.py
 * check_verdict_consistency). Returns the matched keyword (a string) when
 * the call should be rejected, or `null` when the call is consistent.
 *
 *   summary 含 FAIL 关键词 + verdict="PASS"  → reject (return keyword)
 *   summary 含 FAIL 关键词 + verdict="FAIL"  → ok    (return null)
 *   summary 无 FAIL 关键词 + verdict="PASS"  → ok    (return null)
 *   summary 无 FAIL 关键词 + verdict="FAIL"  → ok    (return null)
 *
 * The caller is responsible for surfacing `reason` to the agent so it
 * can fix either the verdict or the summary and resubmit.
 */
export function checkVerdictConsistency(
  summary: string,
  verdict: string,
): { matched: string; reason: string } | null {
  const matched = findFailKeyword(summary);
  if (matched && verdict === "PASS") {
    return {
      matched,
      reason:
        `verdict 一致性校验失败: summary 含 "${matched}" 但 verdict="PASS"。` +
        `修正: 意图 FAIL → verdict 改 "FAIL" 并补 reason;` +
        ` 意图 PASS → 修正 summary 去除 "${matched}" 字样。`,
    };
  }
  return null;
}

export async function submitVerdict(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    return textResult(
      { error: errorMessage(err) },
      `jira_submit_verdict 失败: ${errorMessage(err)}`,
    );
  }

  const issueIdOrKey = args.issueIdOrKey;
  if (typeof issueIdOrKey !== "string" || issueIdOrKey.length === 0) {
    return textResult(
      { error: "submit_verdict requires a non-empty `issueIdOrKey` (string)." },
      "jira_submit_verdict 失败: 缺少 issueIdOrKey",
    );
  }
  const verdict = args.verdict;
  if (verdict !== "PASS" && verdict !== "FAIL") {
    return textResult(
      { error: "submit_verdict requires `verdict` to be one of 'PASS' | 'FAIL'." },
      "jira_submit_verdict 失败: verdict 必须为 PASS/FAIL",
    );
  }
  const summary = args.summary;
  if (typeof summary !== "string" || summary.trim().length === 0) {
    return textResult(
      { error: "submit_verdict requires `summary` (string, non-empty)." },
      "jira_submit_verdict 失败: 缺少 summary",
    );
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
        `submit_verdict(verdict=FAIL) requires non-empty \`reason\` (string). ` +
          `Reason documents why the task failed; the escalated label + cleared ` +
          `assignee signal "human pickup" to the orchestrator.`,
      );
    }
  }

  // Verdict ↔ summary consistency guard (CP-2805 / CP-2806). Runs AFTER
  // param validation (issueIdOrKey/verdict/summary) and FAIL-reason
  // validation but BEFORE any Jira write (comment / transition / label
  // / assignee). On reject: zero side effects, textResult error with
  // matched keyword + repair hint, mirroring CP-1918 verdict_guard.py.
  const inconsistency = checkVerdictConsistency(summary, verdict);
  if (inconsistency) {
    return textResult(
      {
        error:
          `jira.submit_verdict rejected: verdict="PASS" but summary contains ` +
          `"${inconsistency.matched}" (CP-1918 FAIL keyword). ${inconsistency.reason}`,
      },
      `${issueIdOrKey} 拒收: summary 含 FAIL 关键词但 verdict=PASS, 见 hint`,
    );
  }

  // Step 1: post the verdict comment (always).
  const commentAdf = buildCompleteComment(verdict as Verdict, summary, evidence, reason);
  // (No ADF validation needed: commentAdf is built by internal plugin code,
  // never from agent-supplied ADF. If shape breaks, it's a plugin bug to fix.)

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
    return textResult(
      {
        error: `jira.submit_verdict (step 1: comment) failed: ${msg}. ` +
          "Transition was NOT executed. No side effect on the issue.",
      },
      `jira_submit_verdict 失败: 评论发布错误 ${msg}`,
    );
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

  // PASS → transition to "已完成" (existing behavior).
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
 * Mirrors what escalate_task used to do in step 3+4 (label + assignee clear after comment).
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
    return textResult(
      {
        ok: false,
        method: "submit_verdict",
        partial: true,
        verdict: "FAIL",
        comment: { id: commentId, self: commentSelf },
        error:
          `jira.submit_verdict (verdict=FAIL, step 2: add label) failed: ${msg}. ` +
          `Verdict comment was already posted; label was NOT added; assignee NOT cleared. ` +
          `Re-run submit_verdict with the same args to retry — the comment step is idempotent at ` +
          `the UI level but will post a duplicate ADF comment on Jira.`,
      },
      `${issueIdOrKey} 部分完成: 评论已发但 escalated label 添加失败, 见 hint`,
    )
  }

  let assigneeCleared = false
  try {
    await jiraPut(cfg, `issue/${issueIdOrKey}`, {
      fields: { assignee: null },
    })
    assigneeCleared = true
  } catch (err) {
    const msg = err instanceof JiraHttpError ? err.message : errorMessage(err)
    return textResult(
      {
        ok: false,
        method: "submit_verdict",
        partial: true,
        verdict: "FAIL",
        comment: { id: commentId, self: commentSelf },
        label: ESCALATED_LABEL,
        hint:
          `Verdict comment + "${ESCALATED_LABEL}" label already applied. To finish, run: ` +
          `jira { method: "update", args: { issueIdOrKey: "${issueIdOrKey}", fields: { assignee: null } } }`,
        error:
          `jira.submit_verdict (verdict=FAIL, step 3: clear assignee) failed: ${msg}. ` +
          `Comment and label already applied; assignee NOT cleared.`,
      },
      `${issueIdOrKey} 部分完成: 评论 + label 已应用但清 assignee 失败, 见 hint`,
    )
  }

  return textResult(
    {
      ok: true,
      method: "submit_verdict",
      verdict: "FAIL",
      comment: { id: commentId, self: commentSelf },
      label: ESCALATED_LABEL,
      assigneeCleared: true,
    },
    `${issueIdOrKey} 已 FAIL: escalated 已标 + assignee 已清`,
  )
}

/**
 * PASS continuation: list transitions and move to "已完成".
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
    return textResult(
      {
        ok: false,
        method: "submit_verdict",
        partial: true,
        verdict: "PASS",
        comment: { id: commentId, self: commentSelf },
        hint:
          `Comment was posted (id=${commentId}) but the transition lookup failed: ${msg}. ` +
          `Re-run the generic \`transition\` method to finish, or retry submit_verdict ` +
          `if the failure was transient (be aware: this will post a duplicate comment).`,
        error:
          `jira.submit_verdict (step 2a: list transitions) failed: ${msg}. ` +
          `Comment was already posted.`,
      },
      `${issueIdOrKey} 部分完成: 评论已发但查 transition 失败, 见 hint`,
    )
  }

  if (transitions.length === 0) {
    return textResult(
      {
        ok: false,
        method: "submit_verdict",
        partial: true,
        verdict: "PASS",
        comment: { id: commentId, self: commentSelf },
        error:
          `No transitions available for ${issueIdOrKey} — issue may be in a terminal state. ` +
          `Comment was already posted.`,
      },
      `${issueIdOrKey} 部分完成: 评论已发但无可用 transition`,
    )
  }

  const { match, matchedBy } = findTransition(transitions, "done");
  if (!match) {
    const available = describeAvailableTransitions(transitions);
    return textResult(
      {
        ok: false,
        method: "submit_verdict",
        partial: true,
        verdict: "PASS",
        comment: { id: commentId, self: commentSelf },
        error:
          `No "done" category transition for ${issueIdOrKey}: [${available}]. ` +
          `Comment was already posted.`,
        hint: "Available transitions (name [category]): " + available,
      },
      `${issueIdOrKey} 部分完成: 评论已发但无 done category transition, 见 hint`,
    );
  }

  try {
    await jiraPost(cfg, `issue/${issueIdOrKey}/transitions`, {
      transition: { id: match.id },
    })
    const toName = match.to?.name ?? "";
    const toCategory = match.to?.statusCategory?.key ?? "";
    return textResult(
      {
        ok: true,
        method: "submit_verdict",
        verdict: "PASS",
        comment: { id: commentId, self: commentSelf },
        transition: {
          id: match.id,
          name: match.name,
          to: toName,
          toCategory,
          matchedBy,
        },
      },
      `${issueIdOrKey} 已 PASS: 评论已发 + 转「${toName}」`,
    )
  } catch (err) {
    const msg = err instanceof JiraHttpError ? err.message : errorMessage(err)
    return textResult(
      {
        ok: false,
        method: "submit_verdict",
        partial: true,
        verdict: "PASS",
        comment: { id: commentId, self: commentSelf },
        hint:
          `Comment was posted (id=${commentId}) but the transition execute failed: ${msg}. ` +
          `Use \`jira_transition\` to move ${issueIdOrKey} to the appropriate done status.`,
        error:
          `jira.submit_verdict (step 2b: execute transition) failed: ${msg}. ` +
          `Comment was already posted.`,
      },
      `${issueIdOrKey} 部分完成: 评论已发但转态失败, 见 hint`,
    )
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
