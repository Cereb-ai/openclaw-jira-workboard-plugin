/**
 * jira.comment — POST /rest/api/3/issue/{issueIdOrKey}/comment.
 *
 * Body MUST be an ADF dict (not a plain string). The Atlassian v3 endpoint
 * rejects string bodies — this is a common source of 400s on first contact.
 *
 * If the caller passes a string by accident, we fail-fast with a clear hint
 * pointing at the ADF structure (don't silently stringify, that would
 * produce a different kind of broken ADF that errors less clearly).
 *
 * mentionMap (optional): a `{name: accountId}` dict the caller loaded from
 * their own role-map. When provided, the plugin enforces a strict bijection
 * between ADF mention nodes (type:'mention', attrs.id) and the map's values.
 * This catches the silent-corruption class of bug where caller builds the
 * map from one source and the ADF from another and they drift. If the caller
 * omits mentionMap (or passes `{}`), no mention check is run — the request
 * is forwarded as-is, just like 0.1.0 behavior.
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
    return textResult({ error: errorMessage(err) });
  }

  const issueIdOrKey = args.issueIdOrKey;
  if (typeof issueIdOrKey !== "string" || issueIdOrKey.length === 0) {
    return textResult({
      error: "comment requires a non-empty `issueIdOrKey` (string) argument.",
    });
  }
  const body = args.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return textResult({
      error:
        "comment requires `body` (ADF dict) — NOT a string. " +
        "ADF shape: {version:1, type:'doc', content:[{type:'paragraph', content:[{type:'text', text:'...'}]}]}. " +
        "See skills/jira/SKILL.md 避坑清单 1 for details.",
    });
  }
  const adf = body as Record<string, unknown>;
  if (adf.type !== "doc" || adf.version !== 1) {
    return textResult({
      error:
        "comment `body` must be a valid ADF document (type='doc', version=1). " +
        "Rejecting malformed input rather than silently stringifying. " +
        "See skills/jira/SKILL.md 避坑清单 1.",
    });
  }

  // mentionMap optional bijection check. Fail-fast before any HTTP call.
  if (args.mentionMap !== undefined && args.mentionMap !== null) {
    const mentionErr = validateMentionMap(args.mentionMap, adf);
    if (mentionErr) {
      return textResult({ error: mentionErr });
    }
  }

  try {
    const data = (await jiraPost(cfg, `issue/${issueIdOrKey}/comment`, {
      body: adf,
    })) as { id?: string; self?: string; created?: string };
    return textResult({
      ok: true,
      method: "comment",
      request: { issueIdOrKey, body: adf },
      comment: {
        id: data.id,
        self: data.self,
        created: data.created,
      },
      summary: {
        key: issueIdOrKey,
        commentId: data.id,
        url: data.self,
      },
    });
  } catch (err) {
    if (err instanceof JiraHttpError) {
      return textResult({ error: `jira.comment failed: ${err.message}` });
    }
    return textResult({ error: `jira.comment failed: ${errorMessage(err)}` });
  }
}

/**
 * Validate the optional `mentionMap` argument against the ADF body.
 *
 * Returns an error string if invalid, or `null` if valid (including the
 * empty-map short-circuit). Enforces:
 *   - mentionMap is a plain object (not array, not null)
 *   - every key and every value is a non-empty string
 *   - ADF mention nodes (type:'mention', attrs.id:string) and map values
 *     form a bijection (one-to-one and onto)
 *
 * We do not care about the map KEYS beyond being non-empty strings; the
 * bijection is defined over VALUES (accountIds) on both sides. This means
 * duplicate values in the map are also rejected implicitly (the Set
 * collapses them and the second pass would fail the on-to check).
 */
function validateMentionMap(
  rawMap: unknown,
  adf: Record<string, unknown>,
): string | null {
  if (typeof rawMap !== "object" || rawMap === null || Array.isArray(rawMap)) {
    return (
      "comment `mentionMap` must be a plain object of {name: accountId}, " +
      "not an array or null. Omit the argument entirely to skip the check."
    );
  }
  const mentionMap = rawMap as Record<string, unknown>;

  // Type-validate every entry up front so the bijection message is not
  // polluted by "key must be a string" noise.
  for (const [name, accountId] of Object.entries(mentionMap)) {
    if (typeof name !== "string" || name.length === 0) {
      return (
        "comment `mentionMap` keys must be non-empty strings. " +
        `Got key of type ${typeof name}.`
      );
    }
    if (typeof accountId !== "string" || accountId.length === 0) {
      return (
        `comment \`mentionMap["${name}"]\` must be a non-empty string accountId. ` +
        `Got ${describe(accountId)}.`
      );
    }
  }

  // Empty map → no mention check, fall through to old path.
  if (Object.keys(mentionMap).length === 0) return null;

  const mentionIds = new Set(extractMentionIds(adf));
  const mapValues = new Set(Object.values(mentionMap) as string[]);

  // ADF uses a mention whose accountId is not in the map.
  for (const id of mentionIds) {
    if (!mapValues.has(id)) {
      return (
        `comment: ADF body has mention node with id="${id}" but mentionMap does not contain this accountId. ` +
        `Either add "${id}" to mentionMap (with its display name as key) or remove the mention node from ADF.`
      );
    }
  }

  // Map declares a key/value that ADF does not actually use.
  for (const [name, accountId] of Object.entries(mentionMap)) {
    if (!mentionIds.has(accountId as string)) {
      return (
        `comment: mentionMap has key "${name}" → "${accountId}" but ADF body does not use this accountId. ` +
        `Either add a mention node with id="${accountId}" to ADF body or remove the entry from mentionMap.`
      );
    }
  }

  return null;
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * Walk the ADF tree (depth-first) and collect every `attrs.id` of nodes
 * whose `type === "mention"`. Non-mention nodes and mention nodes missing
 * a string `attrs.id` are skipped silently — the bijection check downstream
 * will surface a missing id as a map-omission, which is the right error
 * for the caller to see.
 */
function extractMentionIds(adf: Record<string, unknown>): string[] {
  const out: string[] = [];
  const stack: unknown[] = [adf];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isRecord(node)) continue;
    if (node.type === "mention") {
      const attrs = node.attrs;
      if (isRecord(attrs) && typeof attrs.id === "string" && attrs.id.length > 0) {
        out.push(attrs.id);
      }
      continue;
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) stack.push(child);
    }
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
