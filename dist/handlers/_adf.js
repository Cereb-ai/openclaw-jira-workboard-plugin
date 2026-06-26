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
export function buildTaskDescription(requirements, scope, acceptanceCriteria) {
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
