/**
 * jira.block — create a "Blocks" issue link between two issues.
 *
 * POST /rest/api/3/issueLink
 *   body: {
 *     type: { name: "Blocks" },
 *     inwardIssue:  { key: blocker  },  // the issue that is doing the blocking
 *     outwardIssue: { key: blocked  },  // the issue that is being blocked
 *   }
 *
 * Natural language: "blocker blocks blocked". From the perspective of the
 * `blocked` issue, `blocker` shows up as a "Blocks" link. The link type
 * name is exactly the Atlassian default ("Blocks") — we don't parameterise
 * it in Phase B.
 *
 * Atlassian returns 201 Created with empty body on success. We synthesise
 * a success envelope from the request.
 *
 * Why a dedicated method instead of a generic `link`? The natural-language
 * framing from the agent is consistently "A blocks B" — exposing the
 * semantic verb as a method name means the dispatcher surface maps 1:1 to
 * intent. Other link types (Relates, Clones, Duplicates) are a Phase C
 * concern; we can add `link` later without breaking this surface.
 */
import { loadConfig } from "../auth.js";
import { jiraPost, JiraHttpError } from "../http.js";
import { textResult } from "../dispatch.js";
import { normalizeId } from "../normalize.js";
import type { ToolResult } from "../types.js";

export async function block(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    return textResult({ error: errorMessage(err) });
  }

  // CP-3751: blocker / blocked accept string | number → normalized to string.
  const blockerNorm = normalizeId(args.blocker, "blocker");
  if (!blockerNorm.ok) {
    return textResult({ error: blockerNorm.error });
  }
  const blocker = blockerNorm.value;

  const blockedNorm = normalizeId(args.blocked, "blocked");
  if (!blockedNorm.ok) {
    return textResult({ error: blockedNorm.error });
  }
  const blocked = blockedNorm.value;

  if (blocker === blocked) {
    return textResult({
      error: `block requires blocker and blocked to be different issues (both were "${blocker}").`,
    });
  }

  try {
    await jiraPost(cfg, "issueLink", {
      type: { name: "Blocks" },
      inwardIssue: { key: blocker },
      outwardIssue: { key: blocked },
    });
    return textResult({
      ok: true,
      method: "block",
      request: { blocker, blocked },
      summary: {
        blocker,
        blocked,
        linkType: "Blocks",
        direction: `${blocker} blocks ${blocked}`,
      },
    });
  } catch (err) {
    if (err instanceof JiraHttpError) {
      return textResult({ error: `jira.block failed: ${err.message}` });
    }
    return textResult({ error: `jira.block failed: ${errorMessage(err)}` });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
