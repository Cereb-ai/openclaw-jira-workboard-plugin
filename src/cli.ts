#!/usr/bin/env node
/**
 * jira-tool — CLI wrapper for the @cereb/jira-openclaw-plugin.
 *
 * Allows the 9 plugin methods to be invoked from any shell / terminal,
 * independently of OpenClaw / OpenCode / Wecom DM. Useful for:
 *
 *   - Debugging from a PC terminal without the full OpenClaw round-trip.
 *   - CI / pipeline scripts that need Jira data.
 *   - Local agent behavior testing (e.g. before re-enabling the plugin).
 *
 * Reuses the same handler / dispatch stack as the OpenClaw native tool —
 * there is no separate API client. Reads env (ATST_TOKEN / JIRA_CLOUD_ID /
 * JIRA_PROXY) the same way as the OpenClaw entry point, so no new config.
 *
 * Usage:
 *   jira-tool <method> '<args-json>'
 *
 * Examples:
 *   jira-tool search '{"jql":"project = WTO AND status != Done","maxResults":1}'
 *   jira-tool get '{"issueIdOrKey":"WTO-71"}'
 *   jira-tool add_label '{"issueIdOrKey":"WTO-71","label":"smoke-verify"}'
 *   jira-tool remove_label '{"issueIdOrKey":"WTO-71","label":"smoke-verify"}'
 *   jira-tool block '{"blocker":"WTO-71","blocked":"WTO-72"}'
 *
 * Output: JSON pretty-printed to stdout on success.
 *         JSON error envelope to stderr + non-zero exit on failure.
 */
import { dispatch, MVP_METHODS } from "./dispatch.js";

function printUsage(): void {
  console.error(
    [
      `Usage: jira-tool <method> '<args-json>'`,
      ``,
      `MVP methods (${MVP_METHODS.length}):`,
      ...MVP_METHODS.map((m) => `  ${m}`),
      ``,
      `Examples:`,
      `  jira-tool search '{"jql":"project = WTO AND status != Done","maxResults":1}'`,
      `  jira-tool get '{"issueIdOrKey":"WTO-71"}'`,
      `  jira-tool add_label '{"issueIdOrKey":"WTO-71","label":"smoke-verify"}'`,
      `  jira-tool remove_label '{"issueIdOrKey":"WTO-71","label":"smoke-verify"}'`,
      `  jira-tool block '{"blocker":"WTO-71","blocked":"WTO-72"}'`,
      ``,
      `Env (same as OpenClaw plugin):`,
      `  ATST_TOKEN     OAuth 2.0 3LO access token (required)`,
      `  JIRA_CLOUD_ID  Atlassian Cloud ID (required)`,
      `  JIRA_PROXY     HTTP proxy URL (optional, default http://172.29.176.1:7890)`,
      ``,
      `Output: JSON to stdout on success; non-zero exit + JSON error on stderr on failure.`,
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    printUsage();
    process.exit(1);
  }
  const method = argv[0];
  const argsStr = argv.slice(1).join(" ");
  let args: Record<string, unknown> = {};
  if (argsStr.length > 0) {
    try {
      const parsed = JSON.parse(argsStr);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        console.error(`jira-tool: args must be a JSON object (got ${typeof parsed})`);
        process.exit(2);
      }
      args = parsed as Record<string, unknown>;
    } catch (e) {
      console.error(`jira-tool: failed to parse args JSON: ${(e as Error).message}`);
      console.error(`  received: ${argsStr.slice(0, 200)}${argsStr.length > 200 ? "..." : ""}`);
      process.exit(2);
    }
  }

  let result;
  try {
    result = await dispatch({ method, args });
  } catch (e) {
    console.error(`jira-tool: dispatch failed: ${(e as Error).message}`);
    process.exit(3);
  }

  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") {
    console.error("jira-tool: unexpected dispatch return shape (no .content[0].text)");
    process.exit(4);
  }
  // Always print to stdout (success AND error), so callers can pipe jq.
  console.log(text);
  // Exit non-zero if the result was an error envelope (handler returns
  // textResult({error: "..."}) on failure, so the JSON has an "error" key).
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.error === "string") {
      process.exit(5);
    }
  } catch {
    // text is not JSON — not an error envelope
  }
}

main().catch((e) => {
  console.error(`jira-tool: fatal: ${(e as Error).message}`);
  process.exit(99);
});
