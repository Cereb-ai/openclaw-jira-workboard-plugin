/**
 * jira.create — POST /rest/api/3/issue.
 *
 * Required: project (key), issuetype (name), summary.
 * Optional: description (ADF dict), assignee, labels, priority, parent.
 *
 * Returns the created issue's key + id + URL.
 */
import { loadConfig } from "../auth.js";
import { jiraPost, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import type { ToolResult } from "../types.js";

export async function create(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    return textResult({ error: errorMessage(err) });
  }

  const project = args.project;
  if (typeof project !== "string" || project.length === 0) {
    return textResult({
      error: "create requires `project` (string, project key e.g. 'WTO').",
    });
  }
  const issuetype = args.issuetype;
  if (typeof issuetype !== "string" || issuetype.length === 0) {
    return textResult({
      error: "create requires `issuetype` (string, e.g. 'Task' / 'Bug' / 'Story').",
    });
  }
  const summary = args.summary;
  if (typeof summary !== "string" || summary.length === 0) {
    return textResult({
      error: "create requires `summary` (string, non-empty).",
    });
  }

  // Build the fields payload. We deliberately use Type.Any-cast — the
  // Atlassian schema is wide and we don't want to over-model it.
  const fields: Record<string, unknown> = {
    project: { key: project },
    issuetype: { name: issuetype },
    summary,
  };
  if (typeof args.description === "object" && args.description !== null) {
    // ADF dict — pass through unchanged. If caller stringified it we can't
    // tell, but Atlassian's 400 will surface clearly.
    fields.description = args.description;
  }
  if (typeof args.labels === "object" && Array.isArray(args.labels)) {
    fields.labels = args.labels.filter((l): l is string => typeof l === "string");
  }
  if (typeof args.priority === "string" && args.priority.length > 0) {
    fields.priority = { name: args.priority };
  }
  if (typeof args.parent === "string" && args.parent.length > 0) {
    // parent can be {key} or {id}; we accept the key form (most common).
    fields.parent = { key: args.parent };
  }
  if (typeof args.assignee === "string" && args.assignee.length > 0) {
    // assignee is accountId (Atlassian Cloud format)
    fields.assignee = { accountId: args.assignee };
  }

  try {
    const data = (await jiraPost(cfg, "issue", { fields })) as {
      id?: string;
      key?: string;
      self?: string;
    };
    return textResult({
      ok: true,
      method: "create",
      request: { fields },
      issue: {
        id: data.id,
        key: data.key,
        self: data.self,
      },
      summary: {
        key: data.key,
        id: data.id,
        url: data.self,
      },
    });
  } catch (err) {
    if (err instanceof JiraHttpError) {
      return textResult({ error: `jira.create failed: ${err.message}` });
    }
    return textResult({ error: `jira.create failed: ${errorMessage(err)}` });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
