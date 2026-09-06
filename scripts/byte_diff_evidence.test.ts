/**
 * Byte-diff evidence (CP-2710 batch 3, evidence-only, not in main run).
 *
 * Run: `npx vitest run scripts/byte_diff_evidence.test.ts --reporter=verbose`
 * Captures content+details bytes for the 4 tool happy paths and prints
 * a JSON report. Used to populate the PR description "before/after"
 * section.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/http.js", () => ({
  jiraGet: vi.fn(),
  jiraPost: vi.fn(),
  jiraPut: vi.fn(),
  JiraHttpError: class extends Error {
    constructor(public status: number, public statusText: string, public body: string) {
      super(`HTTP ${status} ${statusText}`);
    }
  },
}));

vi.mock("../src/auth.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    loadConfig: () => ({
      atstToken: "test-token",
      cloudId: "test-cloud",
      proxy: "",
      defaultAssigneeAccountId: "",
    }),
  };
});

import { jiraGet, jiraPost, jiraPut } from "../src/http.js";
import { transition } from "../src/handlers/transition.js";
import { submitVerdict } from "../src/handlers/submit_verdict.js";
import { abandonTask } from "../src/handlers/abandon_task.js";
import { requestHelp } from "../src/handlers/request_help.js";

function bytes(s: any) {
  return Buffer.byteLength(typeof s === "string" ? s : JSON.stringify(s), "utf8");
}

describe("byte_diff_evidence (CP-2710 batch 3)", () => {
  it("captures content+details bytes for the 4 tool happy paths", async () => {
    const out: any[] = [];

    // 1. transition
    vi.mocked(jiraGet).mockReset();
    vi.mocked(jiraPost).mockReset();
    vi.mocked(jiraPut).mockReset();
    vi.mocked(jiraGet).mockResolvedValueOnce({
      transitions: [
        { id: "11", name: "Done", to: { name: "已完成", statusCategory: { id: 3, key: "done" } } },
      ],
    });
    vi.mocked(jiraPost).mockResolvedValueOnce({});
    const tr = await transition({ issueIdOrKey: "CP-2690", targetStatus: "done" });
    out.push({
      tool: "transition (CP-2690 done)",
      content_bytes: bytes(JSON.parse(tr.content[0].text as string)),
      details_bytes: bytes(tr.details),
      details_str: tr.details,
      content_keys: Object.keys(JSON.parse(tr.content[0].text as string)),
    });

    // 2. submit_verdict PASS
    vi.mocked(jiraGet).mockReset();
    vi.mocked(jiraPost).mockReset();
    vi.mocked(jiraPut).mockReset();
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" });
    vi.mocked(jiraGet).mockResolvedValueOnce({
      transitions: [
        { id: "11", name: "Done", to: { name: "已完成", statusCategory: { id: 3, key: "done" } } },
      ],
    });
    vi.mocked(jiraPost).mockResolvedValueOnce({});
    const sv = await submitVerdict({ issueIdOrKey: "CP-2690", verdict: "PASS", summary: "all green" });
    out.push({
      tool: "submit_verdict PASS (CP-2690)",
      content_bytes: bytes(JSON.parse(sv.content[0].text as string)),
      details_bytes: bytes(sv.details),
      details_str: sv.details,
      content_keys: Object.keys(JSON.parse(sv.content[0].text as string)),
    });

    // 3. submit_verdict FAIL
    vi.mocked(jiraGet).mockReset();
    vi.mocked(jiraPost).mockReset();
    vi.mocked(jiraPut).mockReset();
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" });
    vi.mocked(jiraPut).mockResolvedValueOnce({});
    vi.mocked(jiraPut).mockResolvedValueOnce({});
    const svF = await submitVerdict({ issueIdOrKey: "CP-2690", verdict: "FAIL", summary: "tests failed", reason: "x" });
    out.push({
      tool: "submit_verdict FAIL (CP-2690)",
      content_bytes: bytes(JSON.parse(svF.content[0].text as string)),
      details_bytes: bytes(svF.details),
      details_str: svF.details,
      content_keys: Object.keys(JSON.parse(svF.content[0].text as string)),
    });

    // 4. abandon_task
    vi.mocked(jiraGet).mockReset();
    vi.mocked(jiraPost).mockReset();
    vi.mocked(jiraPut).mockReset();
    vi.mocked(jiraGet).mockResolvedValueOnce({ fields: { issuetype: { subtask: true, name: "Sub-task" } } });
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" });
    vi.mocked(jiraPut).mockResolvedValueOnce({});
    vi.mocked(jiraGet).mockResolvedValueOnce({ transitions: [{ id: "31", name: "Done", to: { name: "已完成" } }] });
    vi.mocked(jiraPost).mockResolvedValueOnce({});
    vi.mocked(jiraPut).mockResolvedValueOnce({});
    const at = await abandonTask({ issueIdOrKey: "CP-2690", reason: "re-planning" });
    out.push({
      tool: "abandon_task (CP-2690)",
      content_bytes: bytes(JSON.parse(at.content[0].text as string)),
      details_bytes: bytes(at.details),
      details_str: at.details,
      content_keys: Object.keys(JSON.parse(at.content[0].text as string)),
    });

    // 5. request_help
    vi.mocked(jiraGet).mockReset();
    vi.mocked(jiraPost).mockReset();
    vi.mocked(jiraPut).mockReset();
    vi.mocked(jiraGet).mockResolvedValueOnce({ fields: { issuetype: { subtask: false, name: "Task" } } });
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" });
    vi.mocked(jiraPut).mockResolvedValueOnce({});
    const rh = await requestHelp({ issueIdOrKey: "CP-2690", question: "请审核方案" });
    out.push({
      tool: "request_help (CP-2690)",
      content_bytes: bytes(JSON.parse(rh.content[0].text as string)),
      details_bytes: bytes(rh.details),
      details_str: rh.details,
      content_keys: Object.keys(JSON.parse(rh.content[0].text as string)),
    });

    console.log("\n=== CP-2710 batch 3 byte-diff evidence ===");
    console.log(JSON.stringify(out, null, 2));
    console.log("=== end ===\n");
    expect(out).toHaveLength(5);
  });
});
