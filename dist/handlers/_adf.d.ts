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
 * All three inputs are plain-text strings — caller passes them verbatim.
 * No ADF for the caller to maintain. Earlier versions accepted ADF docs
 * or `string[]` for these fields; SSSS-388 showed that schema inconsistency
 * caused LLM serialization drift (AC array → 1 smashed paragraph). We now
 * lock all three to plain strings.
 *
 * Newline handling inside each field (0.5.1+):
 *   - `\n\n` (blank line) inside `requirements` / `scope` → split into
 *     separate paragraph nodes (so Jira renders consistent paragraph
 *     breaks regardless of viewer).
 *   - `\n` (single newline) inside `requirements` / `scope` → render as
 *     ADF `hardBreak` so it's an explicit line break (instead of relying
 *     on `\n` inside a text node, which some Jira renderers show as
 *     literal `\n`).
 *   - `acceptanceCriteria` is split on every `\n` and emitted as an
 *     orderedList (one listItem per AC line). Single line with no `\n`
 *     still becomes a 1-item orderedList.
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
/**
 * Result of converting an ADF doc to plain text + a mention list.
 *
 *   text:     human-readable string (block-level nodes separated by "\n\n";
 *             inline nodes concatenated). For LLM consumption.
 *   mentions: deduped list of `{accountId, displayName}` for every ADF
 *             mention node. Preserves first-seen order.
 *
 * We deliberately do NOT preserve marks (bold/code/link) — context-savings
 * is the entire point of these tools. The raw ADF body is still available
 * via jira_comment (or by re-running jira_get and asking for `comment`).
 */
export interface AdfToTextResult {
    text: string;
    mentions: Array<{
        accountId: string;
        displayName: string;
    }>;
}
/**
 * Convert an ADF document to plain text and a mention list.
 *
 * Accepts a parsed ADF dict, an ADF body wrapped inside a Jira response
 * (e.g. `comment.body`), or `null`/missing — in which case returns
 * `{ text: "", mentions: [] }`. Anything that fails the safety check
 * (`type !== "doc"` or `version !== 1`) is treated as empty to avoid
 * throwing inside a list-comments path; callers can still re-fetch
 * raw ADF via a separate tool.
 *
 * Block separators: a top-level `paragraph` / `heading` ends with `"\n\n"`,
 * a `bulletList` / `orderedList` / `blockquote` ends with `"\n\n"`. A
 * `codeBlock` is rendered as a fenced block:
 *
 *   ```<language>
 *   <code>
 *   ```
 *
 * The intent is to be useful for an LLM, not to be a lossless round-trip
 * — there's no need to recover marks / lists / links. (We render `- ` for
 * each listItem so the structure is at least visible.)
 */
export declare function adfToPlainText(input: unknown): AdfToTextResult;
