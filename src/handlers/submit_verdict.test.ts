import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Hoist-friendly mocks: declare factories inline (vi.mock is hoisted
// to top of file before any module-level consts).
vi.mock("../http.js", () => ({
  jiraGet: vi.fn(),
  jiraPost: vi.fn(),
  jiraPut: vi.fn(),
  JiraHttpError: class extends Error {
    constructor(public status: number, public statusText: string, public body: string) {
      super(`HTTP ${status} ${statusText}`);
    }
  },
}));

vi.mock("../auth.js", async (importOriginal) => {
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

import { jiraGet, jiraPost, jiraPut } from "../http.js";
import { submitVerdict } from "../handlers/submit_verdict.js";
import { JiraPluginError } from "../auth.js";

describe("submit_verdict FAIL escalation (SSSS-252)", () => {
  beforeEach(() => {
    vi.mocked(jiraGet).mockReset();
    vi.mocked(jiraPost).mockReset();
    vi.mocked(jiraPut).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("AC-252-1: verdict=FAIL with reason → comment + label + clear assignee", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" }); // comment
    vi.mocked(jiraPut).mockResolvedValueOnce({}); // add label
    vi.mocked(jiraPut).mockResolvedValueOnce({}); // clear assignee

    const result = await submitVerdict({
      issueIdOrKey: "TEST-1",
      verdict: "FAIL",
      summary: "tests failed",
      reason: "vitest timeout in integration",
    });

    expect(jiraPost).toHaveBeenCalledTimes(1);
    expect(jiraPut).toHaveBeenCalledTimes(2);
    // First PUT: label
    expect(vi.mocked(jiraPut).mock.calls[0][2]).toEqual({
      update: { labels: [{ add: "escalated" }] },
    });
    // Second PUT: clear assignee
    expect(vi.mocked(jiraPut).mock.calls[1][2]).toEqual({
      fields: { assignee: null },
    });
    const body = result.content[0].text as string;
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(true);
    expect(parsed.verdict).toBe("FAIL");
    expect(parsed.label).toBe("escalated");
    expect(parsed.assigneeCleared).toBe(true);
    // CP-2710 batch 3: summary 块去除, verdict 已统一在顶层
    expect(parsed).not.toHaveProperty("summary");
    expect(parsed.verdict).toBe("FAIL");
    // details <100 字符一句话语义摘要
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/TEST-1 已 FAIL/);
  });

  it("AC-252-2: verdict=FAIL with empty reason → throws JiraPluginError (no side effect)", async () => {
    await expect(
      submitVerdict({
        issueIdOrKey: "TEST-1",
        verdict: "FAIL",
        summary: "tests failed",
        reason: "",
      }),
    ).rejects.toThrow(JiraPluginError);

    await expect(
      submitVerdict({
        issueIdOrKey: "TEST-1",
        verdict: "FAIL",
        summary: "tests failed",
      }),
    ).rejects.toThrow(JiraPluginError);

    // No HTTP calls made before throw
    expect(jiraPost).not.toHaveBeenCalled();
    expect(jiraPut).not.toHaveBeenCalled();
  });

  it("AC-252-3: verdict=FAIL, label PUT fails → partial result with hint", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" }); // comment OK
    vi.mocked(jiraPut).mockRejectedValueOnce(new Error("label 500")); // label fails

    const result = await submitVerdict({
      issueIdOrKey: "TEST-1",
      verdict: "FAIL",
      summary: "tests failed",
      reason: "vitest timeout",
    });

    const body = result.content[0].text as string;
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.partial).toBe(true);
    expect(parsed.verdict).toBe("FAIL");
    expect(parsed.comment.id).toBe("c1");
    // The hint about retrying is embedded in the error message
    // (no separate hint field for FAIL partial — single error string).
    expect(parsed.error).toMatch(/retry/i);
    // CP-2710 batch 3: partial 结构 0 改动, 仅 details 摘要化
    expect(parsed).not.toHaveProperty("summary");
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/TEST-1 部分完成/);
  });

  it("AC-252-4: verdict=PASS still transitions (no FAIL handling kicks in)", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" }); // comment
    vi.mocked(jiraGet).mockResolvedValueOnce({
      transitions: [
        { id: "11", name: "Done", to: { name: "已完成", statusCategory: { id: 3, key: "done" } } },
      ],
    });
    vi.mocked(jiraPost).mockResolvedValueOnce({}); // transition execute

    const result = await submitVerdict({
      issueIdOrKey: "TEST-1",
      verdict: "PASS",
      summary: "all green",
      evidence: "vitest 110/110",
    });

    const body = result.content[0].text as string;
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(true);
    // CP-2710 batch 3: 顶层 verdict="PASS" 补齐, summary 块去除
    expect(parsed.verdict).toBe("PASS");
    expect(parsed.transition.to).toBe("已完成");
    expect(parsed.transition.toCategory).toBe("done");
    expect(parsed).not.toHaveProperty("summary");
    // details <100 字符一句话语义摘要
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/TEST-1 已 PASS/);
    // No label add PUT for PASS
    expect(jiraPut).not.toHaveBeenCalled();
  });

  it("AC-252-5: verdict=BLOCKED rejected (removed in 0.4.0)", async () => {
    const result = await submitVerdict({
      issueIdOrKey: "TEST-1",
      verdict: "BLOCKED",
      summary: "should be rejected",
    });
    const parsed = JSON.parse((result.content[0].text as string));
    expect(parsed.error).toMatch(/verdict.*one of/);
    expect(jiraPost).not.toHaveBeenCalled();
  });

  it("CP-2710-3: validation error path (missing verdict) carries slim details", async () => {
    const result = await submitVerdict({
      issueIdOrKey: "TEST-1",
      summary: "no verdict",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/verdict.*one of/);
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/jira_submit_verdict 失败/);
  });

  it("CP-2710-4: PASS partial (comment OK, transition execute fails) keeps partial structure + details summary", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" }); // comment
    vi.mocked(jiraGet).mockResolvedValueOnce({
      transitions: [
        { id: "11", name: "Done", to: { name: "已完成", statusCategory: { id: 3, key: "done" } } },
      ],
    });
    vi.mocked(jiraPost).mockRejectedValueOnce(new Error("transition 500")); // execute fails

    const result = await submitVerdict({
      issueIdOrKey: "TEST-1",
      verdict: "PASS",
      summary: "all green",
    });

    const body = result.content[0].text as string;
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.partial).toBe(true);
    // CP-2710 batch 3: PASS 分支 partial 也要带 verdict 字段
    expect(parsed.verdict).toBe("PASS");
    expect(parsed.comment.id).toBe("c1");
    expect(parsed).not.toHaveProperty("summary");
    // hint 文案完整保留 (CP-2710 红线 #28510)
    expect(parsed.hint).toMatch(/transition/);
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/TEST-1 部分完成/);
  });

  it("CP-2710-5: FAIL success no longer carries hint (CP-2710 草稿池: 语义冗余于 label 反馈)", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" }); // comment
    vi.mocked(jiraPut).mockResolvedValueOnce({}); // add label
    vi.mocked(jiraPut).mockResolvedValueOnce({}); // clear assignee

    const result = await submitVerdict({
      issueIdOrKey: "TEST-1",
      verdict: "FAIL",
      summary: "tests failed",
      reason: "vitest timeout",
    });

    const body = result.content[0].text as string;
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(true);
    expect(parsed.verdict).toBe("FAIL");
    expect(parsed.label).toBe("escalated");
    expect(parsed.assigneeCleared).toBe(true);
    // FAIL 成功路径不再有 hint (CP-2710 草稿池: 与 label 反馈语义冗余)
    expect(parsed).not.toHaveProperty("hint");
  });
});
