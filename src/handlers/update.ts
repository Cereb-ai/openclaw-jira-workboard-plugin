/**
 * jira.update — PUT /rest/api/3/issue/{issueIdOrKey}.
 *
 * Body shape: { fields: {...} } where fields is a partial issue edit payload.
 * Atlassian returns 204 No Content on success, so we synthesise a success
 * envelope rather than parsing a body.
 *
 * Notable: editmeta validation. If a field is not editable for the issue's
 * current screen scheme, Atlassian 400s with a clear message — we surface
 * the snippet unchanged.
 */
import { loadConfig } from "../auth.js";
import { jiraPut, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import type { ToolResult } from "../types.js";

export async function update(
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
      error: "update requires a non-empty `issueIdOrKey` (string) argument.",
    });
  }

  // Accept either an explicit `fields` object or a flat dict (caller
  // convenience). If flat, wrap into fields: {labels, description, ...}.
  let fields: Record<string, unknown>;
  if (
    typeof args.fields === "object" &&
    args.fields !== null &&
    !Array.isArray(args.fields)
  ) {
    fields = args.fields as Record<string, unknown>;
  } else {
    // Flat form: {issueIdOrKey, labels, description, assignee, ...}
    const flat: Record<string, unknown> = {};
    for (const k of [
      "summary",
      "description",
      "labels",
      "assignee",
      "priority",
      "parent",
    ]) {
      if (k in args) flat[k] = args[k];
    }
    fields = flat;
  }

  if (Object.keys(fields).length === 0) {
    return textResult({
      error:
        "update requires at least one field to change (e.g. `fields: {labels}` or flat `labels: [...]`).",
    });
  }

  try {
    await jiraPut(cfg, `issue/${issueIdOrKey}`, { fields });
    return textResult({
      ok: true,
      method: "update",
      request: { issueIdOrKey, fields },
      summary: {
        key: issueIdOrKey,
        updatedFields: Object.keys(fields),
      },
    });
  } catch (err) {
    if (err instanceof JiraHttpError) {
      return textResult({ error: `jira.update failed: ${err.message}` });
    }
    return textResult({ error: `jira.update failed: ${errorMessage(err)}` });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
