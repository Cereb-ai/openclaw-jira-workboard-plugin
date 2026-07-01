/**
 * jira.transition — state machine flow.
 *
 * Two REST round-trips per call:
 *   1. GET  /rest/api/3/issue/{key}/transitions  → list of {id, name, to: {name, statusCategory}}
 *   2. POST /rest/api/3/issue/{key}/transitions  body: {transition: {id}}
 *
 * Project-agnostic: targetStatus accepts LOGICAL names ("done" / "in_progress" /
 * "review" / "blocked" / "reopen" / "todo") that map to Jira's statusCategory
 * (platform-level standard). Falls back to exact name match for non-standard
 * project statuses. See `_transitions.ts` for the full mapping table.
 *
 * Examples:
 *   jira_transition { issueIdOrKey:"SSSS-1", targetStatus:"in_progress" }  // → 任意"进行中"
 *   jira_transition { issueIdOrKey:"CP-1",   targetStatus:"done" }          // → CP 的 complete
 *   jira_transition { issueIdOrKey:"CP-1",   targetStatus:"review" }       // → 审查/Review/In Review
 *   jira_transition { issueIdOrKey:"CP-1",   targetStatus:"In Review" }   // → exact-name fallback
 */
import { loadConfig } from "../auth.js";
import { jiraGet, jiraPost, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import {
  describeAvailableTransitions,
  findTransition,
  type AtlassianTransition,
} from "./_transitions.js";
import type { ToolResult } from "../types.js";

export async function transition(
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
      error: "transition requires a non-empty `issueIdOrKey` (string).",
    });
  }
  const targetStatus = args.targetStatus;
  if (typeof targetStatus !== "string" || targetStatus.trim().length === 0) {
    return textResult({
      error:
        "transition requires `targetStatus` (string). Use logical names: " +
        "'todo' / 'in_progress' / 'done' / 'review' / 'blocked' / 'reopen' / 'cancelled'. " +
        "Or pass the project's exact status name as last-resort fallback.",
    });
  }

  // Step 1: GET transitions
  let transitions: AtlassianTransition[];
  try {
    const data = (await jiraGet(
      cfg,
      `issue/${issueIdOrKey}/transitions`,
    )) as { transitions?: AtlassianTransition[] };
    transitions = Array.isArray(data?.transitions) ? data.transitions : [];
  } catch (err) {
    if (err instanceof JiraHttpError) {
      return textResult({
        error: `jira.transition (step 1: list) failed: ${err.message}`,
      });
    }
    return textResult({
      error: `jira.transition (step 1: list) failed: ${errorMessage(err)}`,
    });
  }

  if (transitions.length === 0) {
    return textResult({
      error:
        `No transitions available for ${issueIdOrKey} — ` +
        `the issue may be in a terminal state (done) or the workflow has no outgoing edges from the current status.`,
    });
  }

  // Resolve via 3-tier matcher (logical / business-pattern / exact-name).
  const { match, matchedBy } = findTransition(transitions, targetStatus);
  if (!match) {
    const available = describeAvailableTransitions(transitions);
    return textResult({
      error:
        `targetStatus "${targetStatus}" did not match any available transition for ${issueIdOrKey}: [${available}]. ` +
        "Use a logical name (done / in_progress / review / blocked / reopen / cancelled / todo) " +
        "or the project's exact status name.",
      hint: "Available transitions (name [category]): " + available,
    });
  }

  // Step 2: POST execute
  try {
    await jiraPost(cfg, `issue/${issueIdOrKey}/transitions`, {
      transition: { id: match.id },
    });
    return textResult({
      ok: true,
      method: "transition",
      request: { issueIdOrKey, targetStatus, resolvedBy: matchedBy },
      transition: {
        id: match.id,
        name: match.name,
        to: match.to?.name,
        category: match.to?.statusCategory?.key,
      },
      summary: {
        key: issueIdOrKey,
        to: match.to?.name,
        toCategory: match.to?.statusCategory?.key,
        matchedBy,
      },
    });
  } catch (err) {
    if (err instanceof JiraHttpError) {
      return textResult({
        error: `jira.transition (step 2: execute) failed: ${err.message}`,
      });
    }
    return textResult({
      error: `jira.transition (step 2: execute) failed: ${errorMessage(err)}`,
    });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}