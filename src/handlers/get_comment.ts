/**
 * jira.get_comment — read a single comment by id, with ADF → plain text.
 *
 * REST: GET /rest/api/3/issue/{issueIdOrKey}/comment/{id}
 *
 * Mirrors the output shape of list_comments (one entry from that array).
 * Both issueIdOrKey AND commentId are required: Atlassian's URL path
 * needs both — you can't fetch a comment by id alone (it isn't globally
 * unique, only unique within an issue).
 *
 * Like list_comments, the response is plain-text only. The raw ADF
 * `body` is intentionally not exposed — see the rationale in
 * list_comments.ts.
 *
 * 返回结构 (CP-2700 batch 2, v0.5 提案 RRmzJTZ7Q8 §2 get_comment 条目):
 *   {ok, method, request{issueIdOrKey, commentId}, comment{id, author{displayName,accountId},
 *   created, updated, body, mentions}}
 *   - `body` **不截断**: 本工具是 list_comments 500 截断的**全文逃生舱**, agent
 *     看到 body > 500 字符截断尾标 → 用 jira_get_comment 单独取, 这里必须返回
 *     完整正文 (按 v0.5 草稿池落地, description 声明 NEVER truncated)
 *   - `body` 永远 plain text — 不暴露 ADF doc (与 list_comments 同)
 *   - 旧 `summary{key, commentId, author, created, bodyChars, mentionCount}` 块去除
 *     (key==request.issueIdOrKey, commentId==comment.id, author==comment.author.displayName,
 *     created==comment.created, bodyChars/mentionCount 为可推导派生计数 → 与
 *     request / comment 字段全部重复, 按白名单建议去 summary)
 *   - `details` = <100 字符一句话语义摘要 (e.g. `成功获取 CP-2690 评论 22475: 张三
 *     2026-09-06, 正文 1280 字`), 复用 CP-2669 G1/G6 模式, 0 dispatch.ts 改动
 *   - `author{displayName, accountId}` 保留 (红线 #28510: author.accountId 不删)
 */
import { loadConfig } from "../auth.js";
import { jiraGet, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import { adfToPlainText } from "./_adf.js";
import type { ToolResult } from "../types.js";

export async function getComment(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    return textResult(
      { error: errorMessage(err) },
      "jira_get_comment 失败: 配置加载错误",
    );
  }

  const issueIdOrKey = args.issueIdOrKey;
  if (typeof issueIdOrKey !== "string" || issueIdOrKey.length === 0) {
    return textResult(
      {
        error:
          "get_comment requires a non-empty `issueIdOrKey` (string) argument.",
      },
      "jira_get_comment 失败: 缺 issueIdOrKey",
    );
  }
  const commentId = args.commentId;
  if (typeof commentId !== "string" || commentId.trim().length === 0) {
    return textResult(
      {
        error:
          "get_comment requires a non-empty `commentId` (string) argument. " +
          "Atlassian comment ids are numeric strings (e.g. '10001'). " +
          "Get them from jira_list_comments first.",
      },
      "jira_get_comment 失败: 缺 commentId",
    );
  }

  try {
    const data = (await jiraGet(
      cfg,
      `issue/${issueIdOrKey}/comment/${encodeURIComponent(commentId)}`,
    )) as {
      id?: string;
      author?: { displayName?: string; accountId?: string };
      created?: string;
      updated?: string;
      body?: unknown;
    };

    const { text, mentions } = adfToPlainText(data?.body);
    const author = data?.author
      ? {
          displayName: data.author.displayName ?? "",
          accountId: data.author.accountId ?? "",
        }
      : null;

    // CP-2700 batch 2: <100-char semantic summary. Format mirrors
    // jira_get / jira_list_comments / jira_comment: key + tool-specific
    // identity + author + date + body size. Truncate summary on tiny
    // lengths; for authorless comments drop the author segment.
    const detailSummary = (() => {
      const cid = data?.id ?? commentId;
      const authorName = author?.displayName || "";
      const createdDate = (data?.created ?? "").slice(0, 10);
      const parts: string[] = [];
      parts.push(`成功获取 ${issueIdOrKey} 评论 ${cid}`);
      const tail: string[] = [];
      if (authorName) tail.push(authorName);
      if (createdDate) tail.push(createdDate);
      tail.push(`正文 ${text.length} 字`);
      return `${parts[0]}: ${tail.join(", ")}`;
    })();

    return textResult(
      {
        ok: true,
        method: "get_comment",
        request: { issueIdOrKey, commentId },
        // CP-2700 batch 2: summary{key, commentId, author, created,
        // bodyChars, mentionCount} block REMOVED — all fields duplicate
        // request / comment surfaces. body is NEVER truncated (escape
        // hatch for list_comments 500-char cap). author{displayName,
        // accountId} preserved (red line #28510).
        comment: {
          id: data?.id,
          author,
          created: data?.created,
          updated: data?.updated,
          body: text,
          mentions,
        },
      },
      detailSummary,
    );
  } catch (err) {
    if (err instanceof JiraHttpError) {
      return textResult(
        { error: `jira.get_comment failed: ${err.message}` },
        `jira_get_comment 失败: HTTP ${err.status} ${err.statusText}`,
      );
    }
    return textResult(
      { error: `jira.get_comment failed: ${errorMessage(err)}` },
      `jira_get_comment 失败: ${errorMessage(err)}`,
    );
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
