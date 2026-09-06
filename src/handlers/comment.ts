/**
 * jira.comment — POST /rest/api/3/issue/{issueIdOrKey}/comment.
 *
 * Agent-facing body is a plain string (NOT ADF). Plugin auto-wraps into
 * ADF before sending to Atlassian v3. Optional `mentionAccountIds` is
 * a string[] of accountIds to @mention.
 *
 * Plain text input rationale (2026-06-29): LLM agents cannot reliably
 * generate valid ADF (nested array serialization errors). 100% of
 * actual comment use cases are plain text. The Atlassian v3 endpoint
 * still requires ADF on the wire — we handle that internally.
 *
 * Multi-line body: use \n in the string — plugin converts to ADF
 * `hardBreak` inline nodes so the rendered comment shows line breaks.
 *
 * @mention: pass `mentionAccountIds: ["accountId1", "accountId2"]` to
 * prefix the comment with @-mentions. Mention nodes still use ADF
 * internally; the agent never sees the ADF.
 *
 * 返回结构 (CP-2693 batch 1, v0.5 提案 RRmzJTZ7Q8 §3 comment 条目):
 *   {ok, method, request{issueIdOrKey, mentions, bodyChars}, comment{id,self,created}}
 *   - `body` 不回显, 仅 `bodyChars` 让 agent 自检长度
 *   - 旧 `summary{key, commentId, url}` 块去除 (key/commentId/url 都与
 *     request.issueIdOrKey / comment.id / comment.self 重复, 落地按草稿池
 *     description 去 summary)
 *   - `details` = <100 字符一句话摘要 (e.g. `已评论 CP-2690: 评论 22475 发布成功`)
 */
import { loadConfig } from "../auth.js";
import { jiraPost, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import type { ToolResult } from "../types.js";

export async function comment(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    return textResult(
      { error: errorMessage(err) },
      `jira_comment 失败: ${errorMessage(err)}`,
    );
  }

  const issueIdOrKey = args.issueIdOrKey;
  if (typeof issueIdOrKey !== "string" || issueIdOrKey.length === 0) {
    return textResult(
      { error: "comment requires a non-empty `issueIdOrKey` (string)." },
      "jira_comment 失败: 缺 issueIdOrKey",
    );
  }

  const body = args.body;
  if (typeof body !== "string") {
    return textResult(
      {
        error:
          "comment `body` must be a plain string. " +
          "Pass text directly, e.g. body: \"✅ CP-423 PASS — K8s 2/2 Running\". " +
          "Plugin auto-wraps into ADF internally. Use \\n for line breaks.",
      },
      "jira_comment 失败: body 非 string",
    );
  }
  if (body.length === 0) {
    return textResult(
      { error: "comment `body` must be a non-empty string." },
      "jira_comment 失败: body 空",
    );
  }

  // Optional mention list — must be an array of strings.
  const mentionAccountIds = readMentionAccountIds(args.mentionAccountIds);

  // Build the ADF body internally. \n → hardBreak, @mention prefix if any.
  const adf = buildCommentAdf(body, mentionAccountIds);

  try {
    const data = (await jiraPost(cfg, `issue/${issueIdOrKey}/comment`, {
      body: adf,
    })) as { id?: string; self?: string; created?: string };
    return textResult(
      {
        ok: true,
        method: "comment",
        // CP-2384 AC2: strip request.body echo (the full body the agent just
        // sent) — comments already echoed back to the writer. Keep only the
        // key-class identifier. mentionAccountIds stays here because it IS
        // key-class info (account IDs, not user content).
        request: {
          issueIdOrKey,
          mentions: mentionAccountIds,
          bodyChars: body.length,
        },
        comment: {
          id: data.id,
          self: data.self,
          created: data.created,
        },
      },
      commentDetailsSummary(issueIdOrKey, data.id),
    );
  } catch (err) {
    if (err instanceof JiraHttpError) {
      return textResult(
        { error: `jira.comment failed: ${err.message}` },
        `jira_comment 失败: HTTP ${err.status} ${err.statusText}`,
      );
    }
    return textResult(
      { error: `jira.comment failed: ${errorMessage(err)}` },
      `jira_comment 失败: ${errorMessage(err)}`,
    );
  }
}

function commentDetailsSummary(issueIdOrKey: string, commentId: string | undefined): string {
  if (commentId) {
    return `已评论 ${issueIdOrKey}: 评论 ${commentId} 发布成功`;
  }
  return `已评论 ${issueIdOrKey}: 发布成功`;
}

/**
 * Normalize the optional mentionAccountIds arg. Returns [] if missing or empty.
 */
function readMentionAccountIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.length > 0) {
      out.push(item);
    }
  }
  return out;
}

/**
 * Convert a plain-text body + optional mentions into an ADF doc.
 *
 *   body="hello\nworld", mentions=["alice_id", "bob_id"]
 *
 *   → { version:1, type:"doc", content:[
 *       { type:"paragraph", content:[
 *         { type:"mention", attrs:{ id:"alice_id" } },
 *         { type:"text", text:" " },
 *         { type:"mention", attrs:{ id:"bob_id" } },
 *         { type:"text", text:" " },
 *         { type:"text", text:"hello" },
 *         { type:"hardBreak" },
 *         { type:"text", text:"world" }
 *       ]}
 *     ]}
 */
function buildCommentAdf(body: string, mentionAccountIds: string[]): Record<string, unknown> {
  // Split on \n into lines, keep the actual \n markers so we can
  // emit hardBreak between them.
  const inline: Array<Record<string, unknown>> = [];
  if (mentionAccountIds.length > 0) {
    for (const id of mentionAccountIds) {
      inline.push({ type: "mention", attrs: { id } });
      inline.push({ type: "text", text: " " });
    }
  }
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) inline.push({ type: "hardBreak" });
    inline.push({ type: "text", text: lines[i] });
  }
  return {
    version: 1,
    type: "doc",
    content: [
      { type: "paragraph", content: inline },
    ],
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
