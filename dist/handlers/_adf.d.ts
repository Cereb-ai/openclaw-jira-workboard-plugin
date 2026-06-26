/**
 * Shared ADF builders for the orchestrator handler set (0.3.0+).
 *
 * Centralises the document shape used by create_task / create_subtask
 * (description) and submit_verdict / request_help (comment
 * bodies). The shape is opinionated — heading2 + paragraph + orderedList —
 * because the whole point of the new methods is to lock the orchestrator
 * template into the API surface so agents can't drift from it.
 *
 * No new dependencies: ADF is just nested plain objects, so we hand-build
 * the JSON. Casting to `Record<string, unknown>` at the boundary keeps the
 * handler files clean of `as any`.
 */
import type { AdfDocument } from "../types.js";
/**
 * Build the orchestrator description template (0.5.0+ simplified):
 *
 *   ## 任务说明
 *   <requirements>
 *
 *   ## 职责范围
 *   <scope>            ← 按 label 写 ✅ 负责 / ❌ 不负责
 *
 *   ## 验收标准
 *   <acceptanceCriteria>
 *
 * All three inputs are plain-text strings — caller passes them verbatim
 * (with `\n` for line breaks). No parsing, no listItem wrapping, no ADF
 * structure for the agent to maintain. Earlier versions accepted ADF docs
 * or `string[]` for these fields; SSSS-388 showed that schema inconsistency
 * caused LLM serialization drift (AC array → 1 smashed paragraph). We now
 * lock all three to plain strings.
 *
 * Caller (create_task / create_subtask) is responsible for validating that
 * each input is a non-empty string before calling.
 */
export declare function buildTaskDescription(requirements: string, scope: string, acceptanceCriteria: string): AdfDocument;
/**
 * Build the completion-comment ADF for submit_verdict.
 *
 *   ## Verdict: <PASS|FAIL>
 *   <summary>
 *
 *   ## Evidence
 *   <evidence>           ← omitted when evidence is empty (PASS)
 *
 *   ## Reason
 *   <reason>             ← only when verdict=FAIL; mandatory for FAIL
 *                          but caller must pass non-empty string
 *
 * The caller (submit_verdict) is responsible for the FAIL invariants —
 * we render whatever the caller passes. The Evidence section is the
 * standard "what was tried / observed" block (used for PASS); the Reason
 * section is the escalation note (used for FAIL).
 */
export declare function buildCompleteComment(verdict: "PASS" | "FAIL", summary: string, evidence: string, reason?: string): AdfDocument;
/**
 * Build the FAIL-verdict comment ADF for submit_verdict.
 *
 *   ## Escalated
 *   <reason>
 */
export declare function buildEscalateComment(reason: string): AdfDocument;
/**
 * Build the help-request comment ADF for request_help.
 *
 *   <question>            ← plain paragraph
 *   @displayName          ← ADF mention node (only when mentionAccountId set)
 *
 * The mention node is appended as a separate paragraph so the display name
 * is on its own line — matches the Jira UI rendering convention.
 */
export declare function buildRequestHelpComment(question: string, mentionAccountId: string, mentionDisplayName: string): AdfDocument;
declare function isRecord(v: unknown): v is Record<string, unknown>;
export { isRecord };
/**
 * Deep-validate ADF content nodes: any node with a `content` property must
 * have it as an Array, not an Object. Catches two common LLM-generated patterns:
 *
 * 1. paragraph.content = {item:{type:"text",...}} instead of [{type:"text",...}]
 * 2. Empty objects {} in nested structures (bulletList/orderedList wrappers)
 *
 * Both pass Jira's client-side checks but Atlassian rejects with opaque
 * 400 INVALID_INPUT.
 *
 * Returns an error message string on the first violation, or null if valid.
 */
export declare function validateAdfContentNodes(doc: Record<string, unknown>): string | null;
