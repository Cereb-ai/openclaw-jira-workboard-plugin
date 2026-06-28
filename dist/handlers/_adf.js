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
export function buildTaskDescription(requirements, scope, acceptanceCriteria) {
    const content = [];
    // ## 任务说明
    content.push(heading2("任务说明"));
    content.push(...textToParagraphs(requirements));
    // ## 职责范围
    content.push(heading2("职责范围"));
    content.push(...textToParagraphs(scope));
    // ## 验收标准
    content.push(heading2("验收标准"));
    content.push(textToOrderedList(acceptanceCriteria));
    return { version: 1, type: "doc", content };
}
/**
 * Convert a plain-text section to one or more ADF paragraph nodes.
 * - Blank lines (`\n\n+`) split into separate paragraphs.
 * - Single newlines become ADF `hardBreak` inline nodes so every Jira
 *   viewer renders them as line breaks (instead of literal `\n`).
 * - Empty / whitespace-only input produces one empty paragraph (matches
 *   the prior behavior of always emitting a paragraph after each heading).
 */
function textToParagraphs(text) {
    const normalized = text.replace(/\r\n/g, "\n").trim();
    if (normalized.length === 0) {
        return [{ type: "paragraph", content: [{ type: "text", text: "" }] }];
    }
    return normalized
        .split(/\n\n+/)
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk.length > 0)
        .map((chunk) => ({ type: "paragraph", content: lineToInlines(chunk) }));
}
/**
 * Convert a single "paragraph chunk" into inline ADF nodes. Single `\n`
 * become `hardBreak`; everything else becomes a `text` node.
 */
function lineToInlines(chunk) {
    const lines = chunk.split("\n");
    const nodes = [];
    for (let i = 0; i < lines.length; i++) {
        if (i > 0)
            nodes.push({ type: "hardBreak" });
        nodes.push({ type: "text", text: lines[i] });
    }
    return nodes;
}
/**
 * Convert acceptance criteria into an orderedList. Each non-empty line
 * becomes one listItem. Empty / whitespace-only input produces a 1-item
 * list with an empty paragraph (so the heading isn't orphaned).
 */
function textToOrderedList(text) {
    const normalized = text.replace(/\r\n/g, "\n").trim();
    if (normalized.length === 0) {
        return {
            type: "orderedList",
            content: [
                {
                    type: "listItem",
                    content: [
                        { type: "paragraph", content: [{ type: "text", text: "" }] },
                    ],
                },
            ],
        };
    }
    const items = normalized
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    return {
        type: "orderedList",
        content: items.map((item) => ({
            type: "listItem",
            content: [
                { type: "paragraph", content: [{ type: "text", text: item }] },
            ],
        })),
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
export function buildCompleteComment(verdict, summary, evidence, reason = "") {
    const content = [
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
export function buildEscalateComment(reason) {
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
export function buildRequestHelpComment(question, mentionAccountId, mentionDisplayName) {
    const content = [
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
function heading2(text) {
    return {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text }],
    };
}
// ---- ADF validation (shared across all handlers that send ADF to Atlassian) ----
function isRecord(v) {
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
export function validateAdfContentNodes(doc) {
    const stack = [doc];
    while (stack.length > 0) {
        const node = stack.pop();
        if (!isRecord(node))
            continue;
        // Leaf nodes (no content children) — skip.
        const leafTypes = new Set(["text", "mention", "hardBreak", "rule", "emoji", "inlineCard"]);
        if (typeof node.type === "string" && leafTypes.has(node.type))
            continue;
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
            for (const child of c)
                stack.push(child);
        }
    }
    return null;
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
export function adfToPlainText(input) {
    const mentions = [];
    const seenMentionIds = new Set();
    // Pull out the body if the caller passed a Jira-shaped envelope.
    let doc = input;
    if (isRecord(input) && isRecord(input.body)) {
        doc = input.body;
    }
    if (!isRecord(doc) || doc.type !== "doc" || doc.version !== 1) {
        return { text: "", mentions };
    }
    const blocks = [];
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
function renderBlock(node, mentions, seenMentionIds) {
    if (!isRecord(node))
        return "";
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
function renderList(content, ordered, mentions, seenMentionIds) {
    if (!Array.isArray(content))
        return "";
    const lines = [];
    let i = 1;
    for (const item of content) {
        if (!isRecord(item) || item.type !== "listItem")
            continue;
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
function renderChildrenAsBlocks(content, mentions, seenMentionIds) {
    if (!Array.isArray(content))
        return "";
    const out = [];
    for (const child of content) {
        const rendered = renderBlock(child, mentions, seenMentionIds);
        if (rendered.length > 0)
            out.push(rendered);
    }
    return out.join("\n\n");
}
function renderInlines(content, mentions, seenMentionIds) {
    if (!Array.isArray(content))
        return "";
    const parts = [];
    for (const node of content) {
        const piece = renderInline(node, mentions, seenMentionIds);
        if (piece.length > 0)
            parts.push(piece);
    }
    return parts.join("");
}
function renderInline(node, mentions, seenMentionIds) {
    if (!isRecord(node))
        return "";
    switch (node.type) {
        case "text":
            return typeof node.text === "string" ? node.text : "";
        case "hardBreak":
            return "\n";
        case "mention": {
            const attrs = node.attrs;
            if (!isRecord(attrs))
                return "@unknown";
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
            if (isRecord(attrs) && typeof attrs.text === "string")
                return attrs.text;
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
