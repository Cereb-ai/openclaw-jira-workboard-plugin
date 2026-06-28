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
import type { AdfDocument, AdfNode } from "../types.js";

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
export function buildTaskDescription(
  requirements: string,
  scope: string,
  acceptanceCriteria: string,
): AdfDocument {
  const text = `## 任务说明\n${requirements}\n\n## 职责范围\n${scope}\n\n## 验收标准\n${acceptanceCriteria}`;
  return {
    version: 1,
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

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
export function buildCompleteComment(
  verdict: "PASS" | "FAIL",
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
 * Build the FAIL-verdict comment ADF for submit_verdict.
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

// ---- ADF validation (shared across all handlers that send ADF to Atlassian) ----

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

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
export function validateAdfContentNodes(doc: Record<string, unknown>): string | null {
  const stack: unknown[] = [doc];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isRecord(node)) continue;

    // Leaf nodes (no content children) — skip.
    const leafTypes = new Set(["text", "mention", "hardBreak", "rule", "emoji", "inlineCard"]);
    if (typeof node.type === "string" && leafTypes.has(node.type)) continue;

    // Node has neither a recognized type nor content → garbage (e.g. {})
    if (!("content" in node)) {
      const nodeType = typeof node.type === "string" ? node.type : "undefined";
      return `node type="${nodeType}": has no content children. ` +
        `Non-leaf ADF nodes must have a valid type + content:[...] array. ` +
        `Empty nodes ({}) are not valid ADF — likely an LLM serialization error.`;
    }

    // Check: if this node has a `content` property, it must be an Array.
    if ("content" in node) {
      const c = node.content;
      if (!Array.isArray(c)) {
        const nodeType = typeof node.type === "string" ? node.type : "unknown";
        const contentType = c === null ? "null" : typeof c;
        let hint = "";
        if (isRecord(c) && "item" in c) {
          hint = ` (looks like content:{item:{...}} instead of content:[{...}]; remove the "item" wrapper)`;
        }
        return `node type="${nodeType}": content is ${contentType}, must be an Array${hint}`;
      }
      // Push children for recursive check.
      for (const child of c as unknown[]) stack.push(child);
    }
  }
  return null;
}

// ---- ADF → plain-text extraction (used by list_comments / get_comment, 0.4.0+) ----

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
  mentions: Array<{ accountId: string; displayName: string }>;
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
export function adfToPlainText(input: unknown): AdfToTextResult {
  const mentions: Array<{ accountId: string; displayName: string }> = [];
  const seenMentionIds = new Set<string>();

  // Pull out the body if the caller passed a Jira-shaped envelope.
  let doc: unknown = input;
  if (isRecord(input) && isRecord(input.body)) {
    doc = input.body;
  }

  if (!isRecord(doc) || doc.type !== "doc" || doc.version !== 1) {
    return { text: "", mentions };
  }

  const blocks: string[] = [];
  const content = doc.content;
  if (!Array.isArray(content)) {
    return { text: "", mentions };
  }

  for (const node of content) {
    const rendered = renderBlock(node, mentions, seenMentionIds);
    if (rendered.length > 0) {
      blocks.push(rendered);
    }
  }

  // Join blocks with blank line. Trim trailing whitespace for tidiness.
  const text = blocks.join("\n\n").replace(/\s+$/, "");
  return { text, mentions };
}

function renderBlock(
  node: unknown,
  mentions: Array<{ accountId: string; displayName: string }>,
  seenMentionIds: Set<string>,
): string {
  if (!isRecord(node)) return "";
  switch (node.type) {
    case "paragraph":
      return renderInlines(node.content, mentions, seenMentionIds);
    case "heading": {
      const level = isRecord(node.attrs) && typeof node.attrs.level === "number"
        ? node.attrs.level
        : 2;
      const hashes = "#".repeat(Math.min(Math.max(level, 1), 6));
      const inner = renderInlines(node.content, mentions, seenMentionIds);
      return `${hashes} ${inner}`;
    }
    case "codeBlock": {
      const lang = isRecord(node.attrs) && typeof node.attrs.language === "string"
        ? node.attrs.language
        : "";
      const inner = renderInlines(node.content, mentions, seenMentionIds);
      return `\`\`\`${lang}\n${inner}\n\`\`\``;
    }
    case "blockquote":
      return renderChildrenAsBlocks(node.content, mentions, seenMentionIds)
        .split("\n")
        .map((l) => (l.length > 0 ? `> ${l}` : ">"))
        .join("\n");
    case "bulletList":
    case "orderedList":
      return renderList(node.content, node.type === "orderedList", mentions, seenMentionIds);
    case "panel": {
      const inner = renderChildrenAsBlocks(node.content, mentions, seenMentionIds);
      return inner.length > 0 ? inner : "";
    }
    case "rule":
      return "---";
    default:
      // Unknown block — try to render its inline content as a paragraph.
      return renderInlines(node.content, mentions, seenMentionIds);
  }
}

function renderList(
  content: unknown,
  ordered: boolean,
  mentions: Array<{ accountId: string; displayName: string }>,
  seenMentionIds: Set<string>,
): string {
  if (!Array.isArray(content)) return "";
  const lines: string[] = [];
  let i = 1;
  for (const item of content) {
    if (!isRecord(item) || item.type !== "listItem") continue;
    const marker = ordered ? `${i}.` : "-";
    const inner = renderChildrenAsBlocks(item.content, mentions, seenMentionIds);
    // Indent multi-line listItem bodies.
    const indented = inner
      .split("\n")
      .map((l) => (l.length > 0 ? `  ${l}` : ""))
      .join("\n");
    lines.push(`${marker} ${indented.replace(/^  /, "")}`);
    i += 1;
  }
  return lines.join("\n");
}

function renderChildrenAsBlocks(
  content: unknown,
  mentions: Array<{ accountId: string; displayName: string }>,
  seenMentionIds: Set<string>,
): string {
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const child of content) {
    const rendered = renderBlock(child, mentions, seenMentionIds);
    if (rendered.length > 0) out.push(rendered);
  }
  return out.join("\n\n");
}

function renderInlines(
  content: unknown,
  mentions: Array<{ accountId: string; displayName: string }>,
  seenMentionIds: Set<string>,
): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const node of content) {
    const piece = renderInline(node, mentions, seenMentionIds);
    if (piece.length > 0) parts.push(piece);
  }
  return parts.join("");
}

function renderInline(
  node: unknown,
  mentions: Array<{ accountId: string; displayName: string }>,
  seenMentionIds: Set<string>,
): string {
  if (!isRecord(node)) return "";
  switch (node.type) {
    case "text":
      return typeof node.text === "string" ? node.text : "";
    case "hardBreak":
      return "\n";
    case "mention": {
      const attrs = node.attrs;
      if (!isRecord(attrs)) return "@unknown";
      const id = typeof attrs.id === "string" ? attrs.id : "";
      // Atlassian stores display name in `text` (e.g. "@Alice"). Strip the
      // leading @ for the mention list — we add it back when re-rendering.
      const rawText = typeof attrs.text === "string" ? attrs.text : id;
      const displayName = rawText.replace(/^@/, "");
      if (id.length > 0 && !seenMentionIds.has(id)) {
        seenMentionIds.add(id);
        mentions.push({ accountId: id, displayName });
      }
      return `@${displayName}`;
    }
    case "emoji": {
      const attrs = node.attrs;
      if (isRecord(attrs) && typeof attrs.text === "string") return attrs.text;
      if (isRecord(attrs) && typeof attrs.shortName === "string") {
        return attrs.shortName;
      }
      return "";
    }
    case "inlineCard":
    case "link": {
      // Render as plain text fallback — link URL alone is rarely useful in
      // an LLM context. If we have a child text node, use that; otherwise
      // we drop the marker (better than "[link](url)" clutter).
      if (Array.isArray(node.content)) {
        return node.content
          .map((c) => renderInline(c, mentions, seenMentionIds))
          .join("");
      }
      return "";
    }
    default:
      // Unknown inline — try recurse.
      if (Array.isArray(node.content)) {
        return node.content
          .map((c) => renderInline(c, mentions, seenMentionIds))
          .join("");
      }
      return "";
  }
}
