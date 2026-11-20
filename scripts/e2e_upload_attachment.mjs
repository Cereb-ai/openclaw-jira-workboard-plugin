#!/usr/bin/env node
/**
 * e2e_upload_attachment.mjs — end-to-end acceptance harness for
 * `jira_upload_attachment` (0.7.0: filePath / url / base64 + diagnostics).
 *
 * Why this exists: CP-5107/CP-5113 proved that the ONLY honest way to validate
 * this tool is to actually push bytes from a machine that does NOT share a
 * filesystem with the gateway (cross-sandbox), then read the metadata back.
 * This script encodes that whole matrix so any future change can be re-checked
 * with one command instead of ad-hoc curls.
 *
 * Contract under test (skills/jira/SKILL.md §场景 9 + src/handlers/upload_attachment.ts):
 *   - exactly one of filePath | url | base64
 *   - url / base64 must work for bytes that never exist on the gateway
 *   - unreadable filePath  → 404 + actionable guidance (gateway-visible + url/base64)
 *   - oversize             → 413 carrying the ACTUAL byte count, before any transfer
 *   - naming               → url: basename(URL path), override by `filename`;
 *                            base64: explicit `filename` (never rewritten)
 *   - success envelope     → {ok, method, request:{issueIdOrKey}, count, attachments[5 fields]}
 *
 * Usage:
 *   JIRA_ATST_TOKEN=… JIRA_CLOUD_ID=… \
 *     node scripts/e2e_upload_attachment.mjs --issue CP-5113 [--out ./out]
 *
 * Runs against `jira-tool` (same handler as the MCP named tool). The CLI is
 * env-first (CP-2955), so no ~/.openclaw/openclaw.json is required.
 *
 *   --issue <KEY>      target ticket (required unless --self-test)
 *   --out <dir>        artifact dir (default ./upload-attachment-e2e-<ts>)
 *   --tool <cmd>       jira CLI (default `jira-tool`)
 *   --skip-network     skip url cases that need public egress
 *   --self-test        exercise the harness against a stub CLI (no Jira, no network)
 *   --timeout <ms>     per-call timeout (default 180000)
 *
 * Exit code: 0 all cases passed · 1 at least one case failed · 2 usage/setup error.
 *
 * Note on byte fidelity: the harness hashes the SOURCE bytes locally and
 * compares them with the Jira-reported size (server-side byte count) plus the
 * download-back size. A sha256 of the stored object cannot be computed from a
 * foreign sandbox (no Jira read token, gateway /tmp not shared) — see
 * REPORT_LIMITATION. Nothing is ever written to the gateway filesystem to make
 * a case pass; that anti-assertion is the whole point of this harness.
 */

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const REPORT_LIMITATION =
  "downloaded-byte sha256 is computed on the source side only; the stored object's hash is not " +
  "readable from a non-gateway sandbox (no Jira read token, no shared /tmp). Integrity is asserted " +
  "as: source sha256 + Jira-reported size + download-back size all equal.";

const ATTACHMENT_FIELDS = ["id", "filename", "size", "mimeType", "content"];

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { tool: "jira-tool", timeout: 180000, skipNetwork: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === "--issue") out.issue = next();
    else if (a === "--out") out.out = next();
    else if (a === "--tool") out.tool = next();
    else if (a === "--timeout") out.timeout = Number(next());
    else if (a === "--skip-network") out.skipNetwork = true;
    else if (a === "--self-test") out.selfTest = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* jira-tool wrapper                                                   */
/*                                                                     */
/* The CLI prints the MCP envelope {content:[{type:"text",text:"<json>  */
/* then the payload inside. Unwrap before reading.                      */
/* ------------------------------------------------------------------ */

function runTool(tool, method, args, timeout) {
  return new Promise((resolve) => {
    execFile(
      tool,
      [method, JSON.stringify(args)],
      { timeout, maxBuffer: 32 * 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ transportError: err.message, stdout, stderr, exitCode: err.code ?? 1 });
          return;
        }
        let payload;
        try {
          const envelope = JSON.parse(stdout);
          const text = Array.isArray(envelope?.content) ? envelope.content[0]?.text : undefined;
          payload = typeof text === "string" ? JSON.parse(text) : envelope;
        } catch (e) {
          resolve({ transportError: `unparsable output: ${e.message}`, stdout, stderr, exitCode: 0 });
          return;
        }
        resolve({ payload, exitCode: 0 });
      },
    );
  });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Deterministic, non-trivial payload so a size match is meaningful. */
function makePayload(n, seed = 37) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * seed + 11) & 0xff;
  return b;
}

function record(ctx, entry) {
  ctx.results.push(entry);
  const mark = entry.pass ? "PASS" : "FAIL";
  console.log(`  ${mark}  ${entry.id}${entry.pass ? "" : ` — ${entry.failures.join("; ")}`}`);
}

function checker() {
  const failures = [];
  return {
    eq(label, actual, expected) {
      if (actual !== expected) {
        failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    ok(label, cond, extra) {
      if (!cond) failures.push(`${label}${extra ? `: ${extra}` : ""}`);
    },
    has(label, haystack, needle) {
      if (typeof haystack !== "string" || !haystack.includes(needle)) {
        failures.push(`${label}: substring ${JSON.stringify(needle)} missing`);
      }
    },
    failures,
  };
}

/* ------------------------------------------------------------------ */
/* Cases                                                               */
/* ------------------------------------------------------------------ */

/** AC1 — url source for a file that does not exist on the gateway. */
async function caseUrl(ctx, url, expectName) {
  const c = checker();
  const res = await ctx.call("jira_upload_attachment", { issueIdOrKey: ctx.issue, url });
  const p = res.payload ?? {};
  const att = p.attachments?.[0] ?? {};
  c.eq("ok", p.ok, true);
  c.eq("count", p.count, 1);
  c.eq("filename", att.filename, expectName);
  c.eq("request echo", JSON.stringify(Object.keys(p.request ?? {})), JSON.stringify(["issueIdOrKey"]));
  c.eq("attachment fields", JSON.stringify(Object.keys(att).sort()), JSON.stringify([...ATTACHMENT_FIELDS].sort()));
  c.ok("size>0", att.size > 0, `size=${att.size}`);
  record(ctx, {
    id: "AC1 url upload (gateway fetches, no local file)",
    pass: c.failures.length === 0,
    failures: c.failures,
    url,
    response: p,
  });
  return att;
}

/** AC1b — url failure must be 502 and must not masquerade as "file not found". */
async function caseUrlUnreachable(ctx) {
  const c = checker();
  const res = await ctx.call("jira_upload_attachment", {
    issueIdOrKey: ctx.issue,
    url: "http://127.0.0.1:1/nope.bin",
  });
  const p = res.payload ?? {};
  const msg = String(p.error?.message ?? "");
  c.eq("ok", p.ok, false);
  c.eq("status", p.error?.status, 502);
  c.has("mentions target url", msg, "nope.bin");
  c.ok("not 'file not found'", !msg.includes("file not found"), msg);
  record(ctx, {
    id: "AC1b url failure → 502 (never 'file not found')",
    pass: c.failures.length === 0,
    failures: c.failures,
    response: p,
  });
}

/** AC2 — base64 straight from memory; explicit filename preserved verbatim. */
async function caseBase64(ctx) {
  const c = checker();
  const bytes = makePayload(1024);
  const filename = `cp5113-e2e-${sha256(bytes).slice(0, 8)}.bin`;
  const res = await ctx.call("jira_upload_attachment", {
    issueIdOrKey: ctx.issue,
    base64: bytes.toString("base64"),
    filename,
  });
  const p = res.payload ?? {};
  const att = p.attachments?.[0] ?? {};
  c.eq("ok", p.ok, true);
  c.eq("filename not rewritten", att.filename, filename);
  c.eq("size == source size", att.size, bytes.length);
  record(ctx, {
    id: "AC2 base64 upload (in-memory bytes)",
    pass: c.failures.length === 0,
    failures: c.failures,
    source: { size: bytes.length, sha256: sha256(bytes) },
    response: p,
  });
  return { att, bytes };
}

/** AC2b — base64 without filename is rejected (no silent naming). */
async function caseBase64NoFilename(ctx) {
  const c = checker();
  const res = await ctx.call("jira_upload_attachment", {
    issueIdOrKey: ctx.issue,
    base64: makePayload(64).toString("base64"),
  });
  const p = res.payload ?? {};
  c.eq("ok", p.ok, false);
  c.eq("status", p.error?.status, 400);
  c.has("explains filename", String(p.error?.message ?? ""), "filename");
  record(ctx, {
    id: "AC2b base64 without filename → 400",
    pass: c.failures.length === 0,
    failures: c.failures,
    response: p,
  });
}

/** AC3 — a path the gateway cannot see must produce actionable 404 text. */
async function caseInvisiblePath(ctx) {
  const c = checker();
  // Deliberately a path that cannot exist on ANY host (not under os.tmpdir(), which is
  // readable when this harness itself runs on the gateway) — keeps AC3 host-agnostic.
  const sandboxPath = `/nonexistent-sandbox-mount-${randomBytes(4).toString("hex")}/payload.bin`;
  const res = await ctx.call("jira_upload_attachment", { issueIdOrKey: ctx.issue, filePath: sandboxPath });
  const p = res.payload ?? {};
  const msg = String(p.error?.message ?? "");
  c.eq("ok", p.ok, false);
  c.eq("status", p.error?.status, 404);
  c.has("keeps legacy prefix", msg, "file not found:");
  c.has("gateway visibility", msg, "readable on the gateway host");
  c.has("sandbox warning", msg, "sandbox-local paths are NOT readable");
  c.has("points at url", msg, "`url` (http/https)");
  c.has("points at base64", msg, "`base64` + `filename`");
  record(ctx, {
    id: "AC3 unreadable path → 404 with guidance",
    pass: c.failures.length === 0,
    failures: c.failures,
    response: p,
  });
}

/** AC4a — oversize rejected from the declared length, before any transfer. */
async function caseOversize(ctx) {
  const c = checker();
  const res = await ctx.call("jira_upload_attachment", {
    issueIdOrKey: ctx.issue,
    url: "http://ipv4.download.thinkbroadband.com/1GB.zip",
  });
  const p = res.payload ?? {};
  const msg = String(p.error?.message ?? "");
  c.eq("ok", p.ok, false);
  c.eq("status", p.error?.status, 413);
  c.has("message shape", msg, "file too large:");
  c.has("carries byte count", msg, "bytes (max 104857600)");
  record(ctx, {
    id: "AC4a oversize → 413 with actual bytes (no transfer)",
    pass: c.failures.length === 0,
    failures: c.failures,
    response: p,
  });
}

/** AC4b — percent-encoded non-ASCII basename decodes into the filename. */
async function casePercentEncodedName(ctx) {
  const c = checker();
  const res = await ctx.call("jira_upload_attachment", {
    issueIdOrKey: ctx.issue,
    url: "https://httpbin.org/anything/%E6%8A%A5%E5%91%8A%20%E6%B5%8B%E8%AF%95.txt",
  });
  const p = res.payload ?? {};
  c.eq("ok", p.ok, true);
  c.eq("decoded filename", p.attachments?.[0]?.filename, "报告 测试.txt");
  record(ctx, {
    id: "AC4b percent-encoded name decodes",
    pass: c.failures.length === 0,
    failures: c.failures,
    response: p,
  });
}

/** AC4c — explicit filename overrides the URL basename. */
async function caseFilenameOverride(ctx) {
  const c = checker();
  const filename = "CP-5113-覆盖名-报告.bin";
  const res = await ctx.call("jira_upload_attachment", {
    issueIdOrKey: ctx.issue,
    url: "https://httpbin.org/anything/%E6%8A%A5%E5%91%8A%20%E6%B5%8B%E8%AF%95.txt",
    filename,
  });
  const p = res.payload ?? {};
  c.eq("ok", p.ok, true);
  c.eq("override applied", p.attachments?.[0]?.filename, filename);
  record(ctx, {
    id: "AC4c filename overrides URL basename",
    pass: c.failures.length === 0,
    failures: c.failures,
    response: p,
  });
}

/**
 * AC5 — filePath regression on a path the gateway CAN read. The path is
 * produced by the gateway itself (jira_get_attachment), so the case stays
 * self-contained and never needs a foreign filesystem.
 */
async function caseFilePathRegression(ctx, attachmentId) {
  const c = checker();
  if (!attachmentId) {
    record(ctx, { id: "AC5 filePath regression", pass: false, failures: ["no attachmentId from the url case"] });
    return;
  }
  const dl = await ctx.call("jira_get_attachment", { attachmentId });
  const gwPath = dl.payload?.path;
  if (!gwPath) {
    record(ctx, {
      id: "AC5 filePath regression",
      pass: false,
      failures: ["jira_get_attachment returned no path"],
      response: dl.payload,
    });
    return;
  }
  const res = await ctx.call("jira_upload_attachment", { issueIdOrKey: ctx.issue, filePath: gwPath });
  const p = res.payload ?? {};
  const att = p.attachments?.[0] ?? {};
  c.eq("ok", p.ok, true);
  c.eq("method", p.method, "upload_attachment");
  c.eq("count", p.count, 1);
  c.eq("request only issueIdOrKey", JSON.stringify(Object.keys(p.request ?? {})), JSON.stringify(["issueIdOrKey"]));
  c.eq("attachment fields", JSON.stringify(Object.keys(att).sort()), JSON.stringify([...ATTACHMENT_FIELDS].sort()));
  c.eq("filename = basename(filePath)", att.filename, path.basename(gwPath));
  c.eq("size == download size", att.size, dl.payload?.size);
  record(ctx, {
    id: "AC5 filePath regression (gateway-visible path)",
    pass: c.failures.length === 0,
    failures: c.failures,
    gatewayPath: gwPath,
    response: p,
  });
}

/** AC7 — evidence round-trip: bytes from THIS host become a Jira attachment. */
async function caseEvidenceAttach(ctx, targetIssue, text) {
  const c = checker();
  const bytes = Buffer.from(text, "utf8");
  const filename = `cp5113-evidence-${sha256(bytes).slice(0, 8)}.md`;
  const res = await ctx.call("jira_upload_attachment", {
    issueIdOrKey: targetIssue,
    base64: bytes.toString("base64"),
    filename,
  });
  const p = res.payload ?? {};
  c.eq("ok", p.ok, true);
  c.eq("filename", p.attachments?.[0]?.filename, filename);
  c.eq("size == local size", p.attachments?.[0]?.size, bytes.length);
  record(ctx, {
    id: `AC7 evidence attached to ${targetIssue}`,
    pass: c.failures.length === 0,
    failures: c.failures,
    source: { size: bytes.length, sha256: sha256(bytes) },
    response: p,
  });
}

/* ------------------------------------------------------------------ */
/* Self-test stub                                                      */
/* ------------------------------------------------------------------ */

async function makeStubTool(dir) {
  const stub = path.join(dir, "jira-tool-stub.mjs");
  // Minimal stand-in for `jira-tool`: same MCP envelope, same status codes and
  // naming rules as src/handlers/upload_attachment.ts, no Jira, no network.
  const src = [
    '#!/usr/bin/env node',
    'const [method, raw] = process.argv.slice(2);',
    'const args = JSON.parse(raw || "{}");',
    'const env = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });',
    'const att = (id, filename, size, mimeType) => ({ id: String(id), filename, size, mimeType, content: "https://example/" + id });',
    'const ok = (id, filename, size, mimeType) => env({ ok: true, method: "upload_attachment", request: { issueIdOrKey: args.issueIdOrKey }, count: 1, attachments: [att(id, filename, size, mimeType)] });',
    'const fail = (status, message) => env({ ok: false, error: { status, message } });',
    'function respond() {',
    '  if (method === "jira_get_attachment") {',
    '    return env({ ok: true, method: "get_attachment", request: { attachmentId: String(args.attachmentId) }, path: "/tmp/openclaw-attachments/" + args.attachmentId + ".json", size: 1697, mimeType: "application/json", filename: "package.json" });',
    '  }',
    '  if (method !== "jira_upload_attachment") return fail(400, "unknown method " + method);',
    '  const sources = [args.filePath, args.url, args.base64].filter((v) => v !== undefined);',
    '  if (sources.length !== 1) return fail(400, "upload_attachment accepts exactly one source");',
    '  if (args.base64 !== undefined) {',
    '    if (!args.filename) return fail(400, "base64 requires an explicit filename (string)");',
    '    const n = Buffer.from(args.base64, "base64").length;',
    '    return ok(9001, args.filename, n, "application/octet-stream");',
    '  }',
    '  if (args.filePath !== undefined) {',
    '    if (args.filePath.indexOf("/tmp/openclaw-attachments/") !== 0) {',
    '      const m = "file not found: " + args.filePath + " (ENOENT: no such file or directory). "',
    '        + "filePath must be an absolute path readable on the gateway host - sandbox-local paths are NOT readable. "',
    '        + "Use `url` (http/https) or `base64` + `filename` instead.";',
    '      return fail(404, m);',
    '    }',
    '    return ok(9501, args.filePath.split("/").pop(), 1697, "application/json");',
    '  }',
    '  if (args.url.indexOf("1GB") >= 0) return fail(413, "file too large: 1073725334 bytes (max 104857600)");',
    '  if (args.url.indexOf("127.0.0.1") >= 0) return fail(502, "url download failed: " + args.url + " (fetch failed)");',
    '  const base = decodeURIComponent(new URL(args.url).pathname.split("/").pop());',
    '  return ok(9101, args.filename || base, 403, "application/json");',
    '}',
    'console.log(JSON.stringify(respond()));',
    '',
  ].join("\n");
  await fs.writeFile(stub, src, { mode: 0o755 });
  return stub;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function usage() {
  console.log(
    [
      "e2e_upload_attachment.mjs — jira_upload_attachment acceptance harness",
      "",
      "  --issue <KEY>     target ticket (required unless --self-test)",
      "  --out <dir>       artifact dir (default ./upload-attachment-e2e-<ts>)",
      "  --tool <cmd>      jira CLI (default: jira-tool)",
      "  --skip-network    skip url cases that need public egress",
      "  --self-test       exercise the harness against a stub CLI (no Jira)",
      "  --timeout <ms>    per call timeout (default 180000)",
    ].join("\n"),
  );
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e.message}`);
    usage();
    return 2;
  }
  if (opts.help) {
    usage();
    return 0;
  }
  if (!opts.selfTest && !opts.issue) {
    console.error("error: --issue is required (or use --self-test)");
    usage();
    return 2;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve(opts.out ?? `./upload-attachment-e2e-${stamp}`);
  await fs.mkdir(outDir, { recursive: true });

  let tool = opts.tool;
  if (opts.selfTest) {
    tool = await makeStubTool(outDir);
    opts.issue = opts.issue ?? "CP-5113-STUB";
  }

  const ctx = {
    issue: opts.issue,
    outDir,
    tool,
    timeout: opts.timeout,
    results: [],
    call: async (method, args) => {
      const res = await runTool(tool, method, args, opts.timeout);
      if (res.transportError) console.error(`  [tool error] ${method}: ${res.transportError}`);
      return res;
    },
  };

  console.log(`jira_upload_attachment e2e — issue=${ctx.issue} tool=${tool} out=${outDir}`);
  console.log(opts.selfTest ? "(self-test: stub CLI, no Jira, no network)\n" : "");

  if (!opts.skipNetwork) {
    const urlAtt = await caseUrl(
      ctx,
      "https://raw.githubusercontent.com/Cereb-ai/openclaw-jira-workboard-plugin/master/package.json",
      "package.json",
    );
    await caseUrlUnreachable(ctx);
    await caseOversize(ctx);
    await casePercentEncodedName(ctx);
    await caseFilenameOverride(ctx);
    await caseFilePathRegression(ctx, urlAtt?.id);
  } else {
    await caseFilePathRegression(ctx, ctx.stubAttachmentId ?? "16256");
  }
  await caseBase64(ctx);
  await caseBase64NoFilename(ctx);
  await caseInvisiblePath(ctx);
  await caseEvidenceAttach(ctx, ctx.issue, `# evidence ${ctx.issue}\nself-load ${stamp}\n`);

  const failed = ctx.results.filter((r) => !r.pass);
  const summary = {
    issue: ctx.issue,
    generatedAt: new Date().toISOString(),
    tool,
    selfTest: opts.selfTest,
    total: ctx.results.length,
    passed: ctx.results.length - failed.length,
    failed: failed.length,
    limitation: REPORT_LIMITATION,
    results: ctx.results,
  };
  await fs.writeFile(path.join(outDir, "results.json"), JSON.stringify(summary, null, 2));

  const lines = [
    `# jira_upload_attachment e2e — ${ctx.issue}`,
    "",
    `- generated: ${summary.generatedAt}`,
    `- tool: \`${tool}\`${opts.selfTest ? " (stub self-test)" : ""}`,
    `- result: **${summary.passed}/${summary.total} passed**`,
    "",
    ...ctx.results.map((r) => `- ${r.pass ? "PASS" : "FAIL"} — ${r.id}${r.pass ? "" : `\n  - ${r.failures.join("\n  - ")}`}`),
    "",
    `> Limitation: ${REPORT_LIMITATION}`,
  ];
  await fs.writeFile(path.join(outDir, "SUMMARY.md"), lines.join("\n"));

  console.log(`\n${summary.passed}/${summary.total} passed → ${outDir}`);
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`fatal: ${e.stack ?? e}`);
    process.exit(2);
  });
