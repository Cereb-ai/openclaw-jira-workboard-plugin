/**
 * jira.get — read single issue with metadata + plain-text description.
 *
 * Context-saving design (0.4.1+, tightened in CP-2384, CP-2669 G2):
 *
 * Default behavior excludes `comment` and `worklog` from the Atlassian
 * response. These are the two heaviest sub-resources on a long-lived
 * ticket and routinely cost 5-50 KB per call. Agents that want comments
 * should call `jira_list_comments` separately (which renders ADF → plain
 * text and dedupes mentions); agents that want worklog should call a
 * future `jira_list_worklogs` (not yet shipped) or pass `fields: ['*all']`
 * here.
 *
 * CP-2384 (0.5.2+) additionally compacts the issuelinks surface
 * (`{blocks:[{key,statusCategory}], blockedBy:[...]}`), strips the
 * `request.fields` echo from the response envelope, and overall keeps
 * the default payload in the ~10 KB range instead of 45-58 KB.
 *
 * CP-2669 G2: `issue.description` is now rendered via adfToPlainText()
 * (shared helper in src/handlers/_adf.ts) so the LLM context gets a
 * plain-text string instead of the full ADF doc (version/type/content
 * tree — easily 5-30 KB on a long-lived ticket). `null`/missing/empty
 * description renders as `null` (no error). Callers that need the raw
 * ADF can still read `issue.fields.description` after passing
 * `fields: ['description']` (always fetched as part of DEFAULT_FIELDS).
 *
 * CP-2669 G6: `details` on the ToolResult is a <100-char one-line
 * semantic summary (e.g. "成功获取 CP-2667: 标题, N 附件") — NOT the
 * full structured object. `content[0].text` still carries the full
 * JSON for callers that want to parse it.
 *
 * `fields` (optional): whitelisted list of Jira field names to fetch
 * server-side. Empty array or omitted → use the default whitelist below.
 * Pass `['*all']` for full payload, or specific names like
 * `['customfield_10019']` to scope to one field.
 *
 * Why not just "filter client-side"? Because the wire payload from Jira
 * Cloud already costs us tokens even before our formatter runs. Filtering
 * server-side via the `fields` query param is the only real fix.
 *
 * Why not just default to "*navigable"? That set still includes `comment`
 * on most instances — verified empirically against the Cereb Jira Cloud.
 * We need an explicit whitelist to keep the default safe.
 *
 * Default whitelist (everything the formatter surfaces, plus description):
 *   summary, status, issuetype, priority, labels, assignee, reporter,
 *   created, updated, parent, description, issuelinks, attachment
 *
 * Intentionally excluded from default:
 *   comment   → use jira_list_comments
 *   worklog   → not yet exposed as a tool
 *   customfield_* → opt-in per field
 *   workratio, aggregateprogress, timespent, etc. → noise
 */
import { loadConfig } from "../auth.js";
import { jiraGet, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import { adfToPlainText } from "./_adf.js";
import type { ToolResult } from "../types.js";

/** Whitelisted Jira field names that jira_get fetches by default.
 *  Anything not in this list requires explicit `fields` opt-in.
 *
 *  13th field (0.5.0+): `attachment` is included so agents can see
 *  attachment metadata without an extra call. Cap is 5 most-recent
 *  (see ATTACHMENT_CAP); if more exist, the response includes
 *  `moreCount: N` so the agent can call jira_list_attachments for the
 *  full list.
 *
 *  Keep this list in sync with the SSSS-401 plan AC1 contract:
 *    summary, status, issuetype, priority, labels, assignee, reporter,
 *    created, updated, parent, description (rendered plain text), issuelinks, attachment
 *  Adding or removing fields can break SSSS-404 AC2 reverse assertion.
 *
 *  CP-2384 (0.5.2+): the issuelinks FIELD is still fetched (and visible
 *  in `fields.issuelinks` for callers that want the raw shape), but the
 *  top-level `issue.issuelinks` response surface is the compacted
 *  `{blocks, blockedBy}` form — see compactIssueLinks below.
 *
 *  CP-2669 G2: `description` field is fetched server-side (per the
 *  whitelist) so callers that want the raw ADF can read
 *  `fields.description` after the default call. The top-level
 *  `issue.description` is the plain-text rendering (adfToPlainText);
 *  we never expose the raw ADF at the top level anymore. */
const DEFAULT_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "priority",
  "labels",
  "assignee",
  "reporter",
  "created",
  "updated",
  "parent",
  "description",
  "issuelinks",
  "attachment",
] as const;

/** Max attachments returned by jira_get by default. The rest are NOT
 *  truncated silently — instead `moreCount: N` is included so the agent
 *  knows to call jira_list_attachments for the full list. */
const ATTACHMENT_CAP = 5;

/** Strip author.avatarUrls (~600B/att) from the surface to keep
 *  jira_get responses small. The full attachment is still available
 *  via jira_list_attachments. */
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

/**
 * Compact the issuelinks array (CP-2384 AC1; CP-2391 hardening) — split
 * into two flat lists keyed by relationship direction so the agent
 * doesn't have to walk inwardIssue/outwardIssue unions.
 *
 *   blocks:     tickets THIS issue blocks (type has outward=blocks, target
 *               is in outwardIssue).
 *   blockedBy:  tickets blocking THIS issue (type has inward=is blocked by,
 *               target is in inwardIssue).
 *
 * Per-link shape: `{key, statusCategory}` where statusCategory is the
 * linked ticket's status.statusCategory.name (a platform-level taxonomy
 * whose display name follows the instance locale — see SKILL.md note).
 * Single link always ≤50 chars of payload.
 *
 * Link types we don't recognize as either blocks / blockedBy (rare
 * "Duplicate", "Relates", "Clones" etc.) are dropped silently — the agent
 * never needed them and they add noise. CP-2391 FIX: classification now
 * guards on `link.type.name === "Blocks"` (Jira Cloud defaults this link
 * type's display name to "Blocks" / "Block" depending on locale; we match
 * case-insensitively on either `name` or the inward/outward direction
 * strings to be robust to locale variants). For non-Blocks types we
 * skip the link entirely so it cannot leak into either blocks or
 * blockedBy — previously a Jira bug where Relates / Duplicate populated
 * both inwardIssue and outwardIssue would cause the same link to show up
 * twice, once in each list. Callers that want the raw shape can still
 * use `jira_get { fields: ['*all'] }` and read `fields.issuelinks`.
 */
function compactIssueLinks(raw: unknown): {
  blocks: Array<{ key: string; statusCategory: string }>;
  blockedBy: Array<{ key: string; statusCategory: string }>;
} {
  const out = {
    blocks: [] as Array<{ key: string; statusCategory: string }>,
    blockedBy: [] as Array<{ key: string; statusCategory: string }>,
  };
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    const link = item as {
      type?: { name?: string; inward?: string; outward?: string };
      inwardIssue?: { key?: string; fields?: { status?: { statusCategory?: { name?: string } } } };
      outwardIssue?: { key?: string; fields?: { status?: { statusCategory?: { name?: string } } } };
    };
    // CP-2391: classification guard — only "Blocks" link type counts.
    // Jira Cloud occasionally populates BOTH inwardIssue and outwardIssue
    // on bidirectional types like Relates/Duplicate; without this guard
    // the same non-blocks link would land in both blocks AND blockedBy.
    // Match on the canonical type.name (case-insensitive — Jira locales
    // vary the capitalization e.g. "Blocks" vs "Block") and fall back to
    // the direction strings ("blocks" / "is blocked by") for instances
    // where name is localized away.
    const typeName = (link.type?.name ?? "").toLowerCase();
    const inwardDir = (link.type?.inward ?? "").toLowerCase();
    const outwardDir = (link.type?.outward ?? "").toLowerCase();
    const isBlocks =
      typeName === "blocks" ||
      typeName === "block" ||
      outwardDir === "blocks" ||
      inwardDir === "is blocked by";
    if (!isBlocks) continue;
    // outwardIssue present → this issue blocks that one
    if (link.outwardIssue?.key) {
      out.blocks.push({
        key: String(link.outwardIssue.key),
        statusCategory: String(
          link.outwardIssue.fields?.status?.statusCategory?.name ?? "",
        ),
      });
    }
    // inwardIssue present → that one blocks this issue
    if (link.inwardIssue?.key) {
      out.blockedBy.push({
        key: String(link.inwardIssue.key),
        statusCategory: String(
          link.inwardIssue.fields?.status?.statusCategory?.name ?? "",
        ),
      });
    }
  }
  return out;
}

export async function get(args: Record<string, unknown>): Promise<ToolResult> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    return textResult(
      { error: errorMessage(err) },
      "jira_get 失败: 配置加载错误",
    );
  }

  const issueIdOrKey = args.issueIdOrKey;
  if (typeof issueIdOrKey !== "string" || issueIdOrKey.length === 0) {
    return textResult(
      {
        error: "get requires a non-empty `issueIdOrKey` (string) argument.",
      },
      "jira_get 失败: 缺少 issueIdOrKey",
    );
  }

  const query: Record<string, string> = {};
  if (Array.isArray(args.fields)) {
    const fields = (args.fields as unknown[]).filter(
      (f): f is string => typeof f === "string",
    );
    if (fields.length > 0) {
      query.fields = fields.join(",");
    } else {
      // Empty array = caller wants the default efficient set.
      query.fields = DEFAULT_FIELDS.join(",");
    }
  } else {
    // No `fields` arg at all = default efficient set.
    query.fields = DEFAULT_FIELDS.join(",");
  }

  try {
    const data = (await jiraGet(cfg, `issue/${issueIdOrKey}`, query)) as {
      key?: string;
      id?: string;
      fields?: Record<string, unknown>;
    };
    const f = data.fields ?? {};

    // Compact issuelinks (CP-2384 AC1): drop the raw inwardIssue/outwardIssue
    // nested objects (which carry the full fields summary + Atlassian self
    // URLs) and split into 2 flat lists. statusCategory is taken from the
    // linked ticket's status.statusCategory.name. Each link stays under ~50
    // chars. Used to be the 3rd-heaviest field on long-lived tickets.
    const compactIssuelinks = compactIssueLinks(f.issuelinks);
    const status =
      typeof f.status === "object" && f.status !== null
        ? (f.status as { name?: string }).name
        : undefined;
    const issuetype =
      typeof f.issuetype === "object" && f.issuetype !== null
        ? (f.issuetype as { name?: string }).name
        : undefined;
    const assignee =
      typeof f.assignee === "object" && f.assignee !== null
        ? (f.assignee as { displayName?: string; accountId?: string })
        : undefined;
    const reporter =
      typeof f.reporter === "object" && f.reporter !== null
        ? (f.reporter as { displayName?: string; accountId?: string })
        : undefined;
    const priority =
      typeof f.priority === "object" && f.priority !== null
        ? (f.priority as { name?: string }).name
        : undefined;
    const parent =
      typeof f.parent === "object" && f.parent !== null
        ? (f.parent as { key?: string; fields?: { summary?: string } })
        : undefined;

    // Compact the attachment list: cap at 5 most-recent + strip avatarUrls.
    // The raw `attachment` field is still available under `fields.attachment`
    // for callers that need the full list. (CP-2384 didn't touch attachments;
    // CP-2676 G7 tightened the cap from 20 → 5 to keep default payloads tiny.)
    const rawAtt = Array.isArray(f.attachment) ? (f.attachment as Record<string, unknown>[]) : [];
    const sortedAtt = [...rawAtt].sort((a, b) =>
      String(b.created ?? "").localeCompare(String(a.created ?? "")),
    );
    const truncated = sortedAtt.length > ATTACHMENT_CAP;
    const visibleAtt = truncated
      ? sortedAtt.slice(0, ATTACHMENT_CAP).map(compactAttachment)
      : sortedAtt.map(compactAttachment);

    // CP-2669 G2: render description ADF → plain text. The raw ADF stays
    // available under `fields.description` for callers that want it; the
    // top-level surface is now a plain string (empty string for null/empty
    // ADF, null for the rare "field absent" case to preserve the previous
    // "no description" sentinel). We do NOT extract mention nodes from
    // description — only the comment body uses mention collection
    // (see jira_list_comments); description is single-author.
    const descriptionText = (() => {
      if (f.description == null) return null;
      const { text } = adfToPlainText(f.description);
      return text;
    })();

    // CP-2669 G6: build the <100-char semantic summary that goes into
    // ToolResult.details. Format: "成功获取 <key>: <summary>, N 附件"
    // (attachment count omitted when zero to stay under 100 chars on
    // long summary strings). We keep the line readable for both Chinese
    // and English agents; the contract is the shape, not the locale.
    const detailSummary = (() => {
      const key = data.key ?? issueIdOrKey;
      const attCount = rawAtt.length;
      const summary = typeof f.summary === "string" ? f.summary : "";
      const base = `成功获取 ${key}: ${summary}`;
      return attCount > 0 ? `${base}, ${attCount} 附件` : base;
    })();

    return textResult(
      {
        ok: true,
        method: "get",
        // Echo only key-class identifiers — strip the full `fields` list
        // (echo of the query string) which is redundant with the upstream
        // call and bloats the response. CP-2384 AC2.
        request: { issueIdOrKey },
        issue: {
          key: data.key,
          id: data.id,
          summary: f.summary,
          status,
          issuetype,
          priority,
          labels: f.labels,
          assignee: assignee?.displayName ?? null,
          reporter: reporter?.displayName ?? null,
          created: f.created,
          updated: f.updated,
          parent: parent
            ? { key: parent.key, summary: parent.fields?.summary }
            : null,
          // CP-2384 AC1: simplified issuelinks — flat {blocks, blockedBy}
          // lists with just {key, statusCategory} per link (no raw
          // inwardIssue/outwardIssue nested objects).
          issuelinks: compactIssuelinks,
          // CP-2669 G2: plain text (adfToPlainText), NOT ADF doc.
          description: descriptionText,
          // 5 most-recent attachments (sorted by created desc, avatarUrls
          // stripped). `attachmentCount` is the total; `moreCount` is set when
          // we hit the cap — agent should call jira_list_attachments for the
          // full list. Use `jira_get { fields: ['attachment'] }` to bypass
          // the cap and see the raw array.
          attachments: visibleAtt,
          attachmentCount: rawAtt.length,
          ...(truncated ? { moreCount: rawAtt.length - ATTACHMENT_CAP } : {}),
          // Carry through the full fields object so callers can drill into
          // anything we didn't surface. Cheap because the field list is
          // already filtered server-side by the `fields` query param.
          fields: f,
        },
      },
      detailSummary,
    );
  } catch (err) {
    if (err instanceof JiraHttpError) {
      return textResult(
        { error: `jira.get failed: ${err.message}` },
        `jira_get 失败: ${err.message}`,
      );
    }
    return textResult(
      { error: `jira.get failed: ${errorMessage(err)}` },
      `jira_get 失败: ${errorMessage(err)}`,
    );
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
