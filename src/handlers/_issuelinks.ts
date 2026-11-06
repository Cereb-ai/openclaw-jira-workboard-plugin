/**
 * Shared issuelinks compaction (CP-2384, extracted in CP-4287).
 *
 * `jira_get` and `jira_search { include: ["issuelinks"] }` MUST expose the
 * exact same shape — this module is the single parser both handlers use
 * (CP-4287 AC4: no second copy of the classification logic).
 */

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
export function compactIssueLinks(raw: unknown): {
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
