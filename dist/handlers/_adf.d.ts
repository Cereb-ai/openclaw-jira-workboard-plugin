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
 * Build the orchestrator description template (0.3.3+ locked):
 *
 *   ## 任务说明
 *   <requirements>
 *
 *   ## 职责范围
 *   <scope>            ← mandatory since 0.3.3; 按 label 写 ✅ 负责 / ❌ 不负责
 *
 *   ## 验收标准
 *   1. <criterion 1>
 *   2. <criterion 2>
 *   ...
 *
 * `requirements` is a single string (the natural-language ask).
 * `scope` is a single string (按 label 写 ✅ 负责 / ❌ 不负责) — mandatory.
 * `acceptanceCriteria` is a list of strings — one per checklist item.
 *
 * Caller (create_task / create_subtask) is responsible for validating scope
 * is a non-empty string before calling. We render it directly into ADF here.
 */
export declare function buildTaskDescription(requirements: string, scope: string, acceptanceCriteria: string[]): AdfDocument;
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
