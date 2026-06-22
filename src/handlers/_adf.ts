/**
 * Shared ADF builders for the orchestrator handler set (0.3.0+).
 *
 * Centralises the document shape used by create_task / create_subtask
 * (description) and complete_task / escalate_task / request_help (comment
 * bodies). The shape is opinionated — heading2 + paragraph + orderedList —
 * because the whole point of the new methods is to lock the orchestrator
 * template into the API surface so agents can't drift from it.
 *
 * No new dependencies: ADF is just nested plain objects, so we hand-build
 * the JSON. Casting to `Record<string, unknown>` at the boundary keeps the
 * handler files clean of `as any`.
 */
import type { AdfDocument, AdfNode } from "../types.js";

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
export function buildTaskDescription(
  requirements: string,
  scope: string,
  acceptanceCriteria: string[],
): AdfDocument {
  const items = acceptanceCriteria.map((c) => ({
    type: "listItem",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: c }],
      },
    ],
  }));
  return {
    version: 1,
    type: "doc",
    content: [
      heading2("任务说明"),
      { type: "paragraph", content: [{ type: "text", text: requirements }] },
      heading2("职责范围"),
      { type: "paragraph", content: [{ type: "text", text: scope }] },
      heading2("验收标准"),
      { type: "orderedList", content: items },
    ],
  };
}

/**
 * Build the completion-comment ADF for complete_task.
 *
 *   ## Verdict: <PASS|FAIL|BLOCKED>
 *   <summary>
 *
 *   ## Evidence
 *   <evidence>           ← omitted when evidence is empty (PASS)
 *
 *   ## Reason
 *   <reason>             ← only when verdict=FAIL; mandatory for FAIL
 *                          but caller must pass non-empty string
 *
 * The caller (complete_task) is responsible for the FAIL invariants —
 * we render whatever the caller passes. The Evidence section is the
 * standard "what was tried / observed" block (used for PASS); the Reason
 * section is the escalation note (used for FAIL).
 */
export function buildCompleteComment(
  verdict: "PASS" | "FAIL" | "BLOCKED",
  summary: string,
  evidence: string,
  reason: string = "",
): AdfDocument {
  const content: AdfNode[] = [
    heading2(`Verdict: ${verdict}`),
    { type: "paragraph", content: [{ type: "text", text: summary }] },
  ];
  if (evidence.length > 0) {
    content.push(heading2("Evidence"));
    content.push({
      type: "paragraph",
      content: [{ type: "text", text: evidence }],
    });
  }
  if (reason.length > 0) {
    content.push(heading2("Reason"));
    content.push({
      type: "paragraph",
      content: [{ type: "text", text: reason }],
    });
  }
  return { version: 1, type: "doc", content };
}

/**
 * Build the escalation-comment ADF for escalate_task.
 *
 *   ## Escalated
 *   <reason>
 */
export function buildEscalateComment(reason: string): AdfDocument {
  return {
    version: 1,
    type: "doc",
    content: [
      heading2("Escalated"),
      { type: "paragraph", content: [{ type: "text", text: reason }] },
    ],
  };
}

/**
 * Build the help-request comment ADF for request_help.
 *
 *   <question>            ← plain paragraph
 *   @displayName          ← ADF mention node (only when mentionAccountId set)
 *
 * The mention node is appended as a separate paragraph so the display name
 * is on its own line — matches the Jira UI rendering convention.
 */
export function buildRequestHelpComment(
  question: string,
  mentionAccountId: string,
  mentionDisplayName: string,
): AdfDocument {
  const content: AdfNode[] = [
    { type: "paragraph", content: [{ type: "text", text: question }] },
  ];
  if (mentionAccountId.length > 0) {
    content.push({
      type: "paragraph",
      content: [
        {
          type: "mention",
          attrs: {
            id: mentionAccountId,
            text: `@${mentionDisplayName}`,
          },
        },
      ],
    });
  }
  return { version: 1, type: "doc", content };
}

function heading2(text: string): AdfNode {
  return {
    type: "heading",
    attrs: { level: 2 },
    content: [{ type: "text", text }],
  };
}
