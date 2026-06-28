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
 */
import { loadConfig } from "../auth.js";
import { jiraGet, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import { adfToPlainText } from "./_adf.js";
export async function getComment(args) {
    let cfg;
    try {
        cfg = loadConfig();
    }
    catch (err) {
        return textResult({ error: errorMessage(err) });
    }
    const issueIdOrKey = args.issueIdOrKey;
    if (typeof issueIdOrKey !== "string" || issueIdOrKey.length === 0) {
        return textResult({
            error: "get_comment requires a non-empty `issueIdOrKey` (string) argument.",
        });
    }
    const commentId = args.commentId;
    if (typeof commentId !== "string" || commentId.trim().length === 0) {
        return textResult({
            error: "get_comment requires a non-empty `commentId` (string) argument. " +
                "Atlassian comment ids are numeric strings (e.g. '10001'). " +
                "Get them from jira_list_comments first.",
        });
    }
    try {
        const data = (await jiraGet(cfg, `issue/${issueIdOrKey}/comment/${encodeURIComponent(commentId)}`));
        const { text, mentions } = adfToPlainText(data?.body);
        const author = data?.author
            ? {
                displayName: data.author.displayName ?? "",
                accountId: data.author.accountId ?? "",
            }
            : null;
        return textResult({
            ok: true,
            method: "get_comment",
            request: { issueIdOrKey, commentId },
            comment: {
                id: data?.id,
                author,
                created: data?.created,
                updated: data?.updated,
                body: text,
                mentions,
            },
            summary: {
                key: issueIdOrKey,
                commentId: data?.id ?? commentId,
                author: author?.displayName ?? null,
                created: data?.created,
                bodyChars: text.length,
                mentionCount: mentions.length,
            },
        });
    }
    catch (err) {
        if (err instanceof JiraHttpError) {
            return textResult({ error: `jira.get_comment failed: ${err.message}` });
        }
        return textResult({
            error: `jira.get_comment failed: ${errorMessage(err)}`,
        });
    }
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
