/**
 * jira.list_attachments — list all attachment metadata on a ticket.
 *
 * REST: GET /rest/api/3/issue/{issueIdOrKey}?fields=attachment
 *
 * Why a separate tool from jira_get (which now also includes attachment by
 * default with a 20-item cap)? Because a ticket can have 50+ attachments
 * (e.g. test screenshots, design files). The default cap in jira_get is
 * meant to keep the typical read cheap; if the agent actually needs to
 * enumerate all attachments (e.g. "find the screenshot from last week"),
 * this tool returns the full list with no cap.
 *
 * Returns: array of attachment metadata objects (id, filename, size,
 * mimeType, content URL, thumbnail URL, author, created). NO file content —
 * use jira_get_attachment for the actual bytes.
 *
 * 返回结构 (CP-2700 batch 2, v0.5 提案 RRmzJTZ7Q8 §4 list_attachments 条目):
 *   {ok, method, request{issueIdOrKey}, count, attachments[]}
 *   - 每项 compact 对齐 get.ts compactAttachment (L109 已拍板模式, 本批 0
 *     触碰 get.ts 红线 → 字段集一致复制, 注释注明对齐):
 *       {id, self, filename, size, mimeType, created, content, thumbnail,
 *        author{displayName, accountId}}
 *     (去 author.avatarUrls / active / timeZone / locale / accountType /
 *      emailAddress / self; 每项省 ~600B/att)
 *   - 旧 `summary{key, attachmentCount}` 块去除 (count == attachments.length
 *     == summary.attachmentCount 三重复, 仅留 count)
 *   - `details` = <100 字符一句话语义摘要 (e.g. `CP-2690 共 5 个附件, 总大小
 *     2.3 MB`), 复用 CP-2669 G1/G6 模式, 0 dispatch.ts 改动
 *   - **no-cap 语义不动** = 本工具是 jira_get cap 5 的全量列举逃生舱
 *   - 不含文件内容 (bytes → jira_get_attachment)
 */
import { loadConfig } from "../auth.js";
import { jiraGet, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import type { ToolResult } from "../types.js";

interface AttachmentMeta {
  id: string;
  self?: string;
  filename: string;
  size: number;
  mimeType: string;
  created: string;
  author?: { displayName?: string; accountId?: string };
  content: string;
  thumbnail?: string;
}

/**
 * Compact one attachment — field set mirrors get.ts compactAttachment (L109
 * 已拍板模式). CP-2700 batch 2: NOT imported from get.ts because compactAttachment
 * is not exported (试点 0 触碰红线 = 0 diff to get.ts); field set duplicated
 * inline per task decision. If get.ts compactAttachment changes in a future
 * batch, this copy MUST be re-aligned in lockstep.
 *
 *   {id, self, filename, size, mimeType, created, content, thumbnail,
 *    author{displayName, accountId}}
 *
 * Stripped: author.avatarUrls / active / timeZone / locale / accountType /
 * emailAddress / self — not needed for triage; ~600B/att saved.
 */
function compactAttachment(a: Record<string, unknown>): Record<string, unknown> {
  const author = a.author as { displayName?: string; accountId?: string } | undefined;
  return {
    id: a.id,
    self: a.self,
    filename: a.filename,
    size: a.size,
    mimeType: a.mimeType,
    created: a.created,
    content: a.content,
    thumbnail: a.thumbnail,
    author: author
      ? { displayName: author.displayName, accountId: author.accountId }
      : undefined,
  };
}

export async function listAttachments(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    return textResult(
      { error: errorMessage(err) },
      "jira_list_attachments 失败: 配置加载错误",
    );
  }

  const issueIdOrKey = args.issueIdOrKey;
  if (typeof issueIdOrKey !== "string" || issueIdOrKey.length === 0) {
    return textResult(
      {
        error: "list_attachments requires a non-empty `issueIdOrKey` (string).",
      },
      "jira_list_attachments 失败: 缺 issueIdOrKey",
    );
  }

  try {
    const data = (await jiraGet(cfg, `issue/${issueIdOrKey}`, {
      fields: "attachment",
    })) as { fields?: { attachment?: AttachmentMeta[] } };
    const atts = data?.fields?.attachment ?? [];
    const compacted = atts.map((a) => compactAttachment(a as unknown as Record<string, unknown>));

    // CP-2700 batch 2: <100-char semantic summary. Format mirrors
    // jira_get / jira_get_comment style: key + count + total size. When
    // count=0 emit a short "no attachments" string to stay well below
    // 100 chars. Total size formatted in human-readable units (B / KB /
    // MB) — kept compact.
    const detailSummary = (() => {
      if (compacted.length === 0) {
        return `${issueIdOrKey} 无附件`;
      }
      const totalSize = atts.reduce(
        (sum, a) => sum + (typeof a.size === "number" ? a.size : 0),
        0,
      );
      const sizeStr = formatSize(totalSize);
      return `${issueIdOrKey} 共 ${compacted.length} 个附件, 总大小 ${sizeStr}`;
    })();

    return textResult(
      {
        ok: true,
        method: "list_attachments",
        request: { issueIdOrKey },
        count: compacted.length,
        attachments: compacted,
        // CP-2700 batch 2: summary{key, attachmentCount} block REMOVED.
        // count == attachments.length == summary.attachmentCount was
        // 3-way duplication; only count retained. no-cap semantics
        // unchanged (escape hatch from jira_get's 5-attachment cap).
      },
      detailSummary,
    );
  } catch (err) {
    if (err instanceof JiraHttpError) {
      return textResult(
        {
          error: `jira.list_attachments failed: ${err.message}`,
        },
        `jira_list_attachments 失败: HTTP ${err.status} ${err.statusText}`,
      );
    }
    return textResult(
      {
        error: `jira.list_attachments failed: ${errorMessage(err)}`,
      },
      `jira_list_attachments 失败: ${errorMessage(err)}`,
    );
  }
}

/** Human-readable size string: <1024 → bytes; <1MB → KB; else MB. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
