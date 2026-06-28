#!/usr/bin/env node
/**
 * SSSS-407 e2e: 7 scenarios covering list_comments (含 since/author filter) /
 * get_comment / jira_get 收敛 (R2 复测).
 *
 * Usage:
 *   cd /home/leoclaw/dev/projects/jira-openclaw-plugin
 *   node scripts/e2e_comment_list.mjs
 *
 * Outputs:
 *   - stdout: per-scenario PASS/FAIL lines + summary
 *   - exit 0 on all PASS, exit 1 on any FAIL
 *
 * Picks TARGET = "SSSS-356" (37 comments at the time of authoring — plenty
 * for filter tests; multiple distinct authors; covers since happy/boundary).
 * For the get_comment error path we use a synthetic non-existent id.
 */
import { execFileSync } from "node:child_process";

const JIRA_TOOL = "/home/leoclaw/dev/projects/jira-openclaw-plugin/dist/cli.js";
const TARGET = process.env.SSSS_E2E_TARGET || "SSSS-356";

function callJira(method, args) {
  // True production path: invoke the jira-tool CLI (same handler/auth stack
  // as the OpenClaw native tools). No mocking — this IS the code path.
  let stdout, stderr;
  try {
    stdout = execFileSync(
      process.execPath,
      [JIRA_TOOL, method, JSON.stringify(args ?? {})],
      {
        env: {
          ...process.env,
          JIRA_CLOUD_ID: process.env.JIRA_CLOUD_ID ?? "a3aec002-a17f-41f4-80b9-bdb3d7a8fae8",
          JIRA_PROXY: process.env.JIRA_PROXY ?? "http://172.29.176.1:7890",
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    stderr = "";
  } catch (e) {
    // jira-tool writes JSON error to stderr and exits non-zero.
    // execFileSync throws; capture stdout/stderr for diagnostic.
    stdout = e.stdout?.toString?.() ?? "";
    stderr = e.stderr?.toString?.() ?? "";
  }

  // The CLI JSON-wraps the result inside `content[0].text` only when invoked
  // through the OpenClaw path. The CLI itself prints the raw result JSON
  // (because it bypasses the OpenClaw dispatcher and calls the handler
  // directly). Handle both shapes.
  const combined = (stdout || stderr || "").trim();
  if (!combined) return { _raw: { stdout, stderr }, ok: false, error: "empty output" };

  let parsed;
  try {
    parsed = JSON.parse(combined);
  } catch (e) {
    return { _raw: { stdout, stderr }, ok: false, error: `non-JSON output: ${combined.slice(0, 200)}` };
  }

  // CLI shape: { ok, method, ... } or { error }
  // OpenClaw shape: { content: [{type:'text', text: '<JSON stringified>'}], details }
  if (parsed && Array.isArray(parsed.content) && parsed.content[0]?.text) {
    try {
      const inner = JSON.parse(parsed.content[0].text);
      return { ...inner, _shape: "openclaw" };
    } catch {
      return { ok: false, error: `unparseable content[0].text: ${parsed.content[0].text.slice(0, 200)}` };
    }
  }
  return { ...parsed, _shape: "cli" };
}

const results = [];
function record(id, label, ok, detail) {
  const tag = ok ? "✅ PASS" : "❌ FAIL";
  console.log(`  ${tag} [${id}] ${label}`);
  if (detail) console.log(`         ${detail}`);
  results.push({ id, label, ok, detail });
}

// ------------------- Scenario 1 -------------------
// happy path — list_comments: pick SSSS-356, expect ≥3 comments and required fields.
console.log("=== Scenario 1: list_comments happy path ===");
{
  const r = callJira("list_comments", { issueIdOrKey: TARGET, maxResults: 10 });
  const okHttp = r.ok === true;
  const hasArr = Array.isArray(r.comments) && r.comments.length >= 3;
  const firstHasFields = hasArr && (() => {
    const c = r.comments[0];
    return typeof c.id !== "undefined"
      && typeof c.author === "object" && c.author !== null
      && typeof c.body === "string"
      && typeof c.created === "string"
      && typeof c.updated === "string";
  })();
  record(
    "S1",
    `list_comments ${TARGET} ok + ≥3 comments + id/author/body/created/updated`,
    okHttp && hasArr && firstHasFields,
    `ok=${okHttp} count=${r.count ?? r.comments?.length} sampleFields=${JSON.stringify(r.comments?.[0] ? Object.keys(r.comments[0]) : null)}`,
  );
  // stash for later scenarios
  results.__listComments = r.comments ?? [];
  results.__firstAuthor = r.comments?.[0]?.author?.accountId ?? null;
  results.__firstCommentId = r.comments?.[0]?.id ?? null;
}

// ------------------- Scenario 2 -------------------
// happy path — get_comment with a known id.
console.log("=== Scenario 2: get_comment happy path ===");
{
  const listComments = results.__listComments;
  const id = listComments?.[0]?.id;
  if (!id) {
    record("S2", "get_comment happy", false, "no comment id available from S1");
  } else {
    const r = callJira("get_comment", { issueIdOrKey: TARGET, commentId: String(id) });
    const okHttp = r.ok === true;
    const idMatch = String(r.comment?.id) === String(id);
    const hasAuthor = !!r.comment?.author;
    const hasBody = typeof r.comment?.body === "string";
    record(
      "S2",
      `get_comment ${TARGET}/${id} ok + id match + author + plain body`,
      okHttp && idMatch && hasAuthor && hasBody,
      `ok=${okHttp} idMatch=${idMatch} bodyChars=${r.comment?.body?.length ?? 0} bodyPreview="${(r.comment?.body ?? "").slice(0, 60).replace(/\n/g, " ")}"`,
    );
  }
}

// ------------------- Scenario 3 -------------------
// error path — get_comment with a non-existent id.
console.log("=== Scenario 3: get_comment 404 (non-existent commentId) ===");
{
  const r = callJira("get_comment", { issueIdOrKey: TARGET, commentId: "99999999" });
  const hasError = typeof r.error === "string";
  const is404 = hasError && (r.error.includes("404") || r.error.toLowerCase().includes("not found"));
  record(
    "S3",
    "get_comment {commentId:'99999999'} → error contains 404",
    hasError && is404,
    `error="${r.error?.slice(0, 200)}"`,
  );
}

// ------------------- Scenario 4 -------------------
// R1 — list_comments since filter happy.
console.log("=== Scenario 4: list_comments since filter happy ===");
{
  const r = callJira("list_comments", {
    issueIdOrKey: TARGET,
    maxResults: 100,
    since: "2026-01-01T00:00:00.000+0800",
  });
  const okHttp = r.ok === true;
  const summarySince = r.summary?.since;
  const comments = Array.isArray(r.comments) ? r.comments : [];
  const sinceMs = Date.parse("2026-01-01T00:00:00.000+0800");
  const allAfterSince = comments.every((c) => {
    const createdMs = Date.parse(c.created);
    return !Number.isNaN(createdMs) && createdMs >= sinceMs;
  });
  record(
    "S4",
    `list_comments since=2026-01-01: all ${comments.length} comments.created >= since`,
    okHttp && comments.length > 0 && allAfterSince && !!summarySince,
    `ok=${okHttp} count=${comments.length} summary.since=${summarySince} allAfterSince=${allAfterSince} sampleCreated=${comments[0]?.created}`,
  );
}

// ------------------- Scenario 5 -------------------
// R1 — list_comments since filter boundary (future date → 0 results).
console.log("=== Scenario 5: list_comments since filter boundary (future date) ===");
{
  const r = callJira("list_comments", {
    issueIdOrKey: TARGET,
    maxResults: 100,
    since: "2099-01-01T00:00:00.000+0800",
  });
  const okHttp = r.ok === true;
  const count = r.count ?? (r.comments?.length ?? -1);
  record(
    "S5",
    "list_comments since=2099-01-01 → count === 0",
    okHttp && count === 0,
    `ok=${okHttp} count=${count} comments=${r.comments?.length ?? "n/a"} summary.since=${r.summary?.since}`,
  );
}

// ------------------- Scenario 6 -------------------
// R1 — list_comments authorAccountId filter.
console.log("=== Scenario 6: list_comments authorAccountId filter ===");
{
  const authorAccountId = results.__firstAuthor;
  if (!authorAccountId) {
    record("S6", "list_comments authorAccountId filter", false, "no author.accountId captured from S1");
  } else {
    const r = callJira("list_comments", {
      issueIdOrKey: TARGET,
      maxResults: 100,
      authorAccountId,
    });
    const okHttp = r.ok === true;
    const comments = Array.isArray(r.comments) ? r.comments : [];
    const allMatch = comments.length > 0 && comments.every((c) => c.author?.accountId === authorAccountId);
    record(
      "S6",
      `list_comments authorAccountId=${authorAccountId.slice(0, 18)}… → all ${comments.length} comments match`,
      okHttp && allMatch,
      `ok=${okHttp} count=${comments.length} summary.authorAccountId=${r.summary?.authorAccountId?.slice(0, 18)}… allMatch=${allMatch}`,
    );
  }
}

// ------------------- Scenario 7 -------------------
// R2 — jira_get 收敛: 不含 comment 数组 + 不含 worklog.worklogs + 含 issuelinks 数组.
console.log("=== Scenario 7: jira_get 收敛 + issuelinks (R2 复测) ===");
{
  const r = callJira("get", { issueIdOrKey: TARGET });
  const okHttp = r.ok === true;
  const hasNoComment = !("comments" in (r.issue?.fields ?? {})) && !("comment" in (r.issue?.fields ?? {}));
  const hasNoWorklog = !("worklog" in (r.issue?.fields ?? {})) && !("worklogs" in (r.issue?.fields ?? {}));
  const hasIssueLinks = Array.isArray(r.issue?.issuelinks);
  const requestFields = r.request?.fields ?? "";
  const fieldsList = requestFields.split(",");
  const noHeavyFieldsInQuery = !fieldsList.includes("comment") && !fieldsList.includes("worklog");
  record(
    "S7",
    "jira_get no `fields` arg → 无 comment/worklog + 含 issuelinks (R2)",
    okHttp && hasNoComment && hasNoWorklog && hasIssueLinks,
    `ok=${okHttp} noComment=${hasNoComment} noWorklog=${hasNoWorklog} issuelinks.len=${r.issue?.issuelinks?.length ?? 0} requestFields="${requestFields}" noHeavyInQuery=${noHeavyFieldsInQuery}`,
  );
}

// ------------------- Summary -------------------
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log("---");
console.log(`PASS ${passed} / FAIL ${failed} / total ${results.length}`);
console.log("Per-scenario:");
for (const r of results) {
  if (typeof r.id === "string" && r.id.startsWith("S")) {
    console.log(`  ${r.ok ? "✅" : "❌"} ${r.id}: ${r.label}`);
  }
}
process.exit(failed > 0 ? 1 : 0);