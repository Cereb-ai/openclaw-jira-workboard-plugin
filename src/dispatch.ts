/**
 * jira-openclaw-plugin — textResult helper (0.6.0+, CP-2669 G1).
 *
 * Two-arg signature: `textResult(content, details?)`.
 *   - `content`  the only payload that lands in `content[0].text` (LLM
 *                context). Either a plain string or a structured object
 *                that gets JSON-stringified for display.
 *   - `details`  optional one-sentence semantic summary (<100 chars)
 *                surfaced under `details` for downstream machine readers.
 *                When omitted it defaults to `content` so the 12
 *                non-pilot tools keep their previous behavior and only
 *                the two CP-2669 pilot tools (jira_get, jira_list_comments)
 *                explicitly pass a slim summary string here.
 *
 * Why split: in 0.5.x the default was `details: data` — `details` carried
 * the FULL structured object while `content` carried the same object
 * pretty-printed, doubling the wire payload. CP-2669 G1 keeps the
 * dual-shape backward compatibility but flips the default: omitting
 * `details` still mirrors `content` (legacy), but the pilot tools pass
 * a <100-char string so the duplication disappears for them.
 */
import type { ToolResult } from "./types.js";

export function textResult(content: unknown, details?: unknown): ToolResult {
  const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  return {
    content: [{ type: "text", text }],
    details: details === undefined ? content : details,
  };
}
