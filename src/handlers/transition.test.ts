/**
 * transition handler tests (CP-2710 batch 3 — new file).
 *
 * Coverage:
 *   - Happy path: matchedBy merges into transition block; summary block
 *     REMOVED; request.targetStatus / request.resolvedBy echoes REMOVED.
 *   - Validation: missing issueIdOrKey, missing targetStatus; error path
 *     carries slim details.
 *   - No-match error path: error + hint "Available transitions" preserved
 *     (CP-2710 红线 #28510: 错误信息不静默); details slim.
 *   - HTTP upstream error path: error envelope + slim details.
 *   - Empty transitions list: error + slim details.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import { jiraGet, jiraPost } from "../http.js";
import { transition } from "../handlers/transition.js";

describe("transition (CP-2710 batch 3)", () => {
  beforeEach(() => {
    vi.mocked(jiraGet).mockReset();
    vi.mocked(jiraPost).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("AC-2710-TR-1: happy path — matchedBy merged into transition, summary block REMOVED, request echoes trimmed", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      transitions: [
        {
          id: "11",
          name: "Done",
          to: { name: "已完成", statusCategory: { id: 3, key: "done" } },
        },
      ],
    });
    vi.mocked(jiraPost).mockResolvedValueOnce({});

    const result = await transition({
      issueIdOrKey: "CP-2690",
      targetStatus: "done",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(true);
    expect(parsed.method).toBe("transition");
    // CP-2710: request 只保留 issueIdOrKey 锚; targetStatus / resolvedBy 去除
    expect(parsed.request).toEqual({ issueIdOrKey: "CP-2690" });
    expect(parsed.request).not.toHaveProperty("targetStatus");
    expect(parsed.request).not.toHaveProperty("resolvedBy");
    // CP-2710: transition 块含 matchedBy (合并)
    expect(parsed.transition).toEqual({
      id: "11",
      name: "Done",
      to: "已完成",
      category: "done",
      matchedBy: "category",
    });
    // CP-2710: summary 块去除
    expect(parsed).not.toHaveProperty("summary");
    // details <100 字符
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/CP-2690 已转至「已完成」/);
  });

  it("AC-2710-TR-2: validation — missing issueIdOrKey; error + slim details", async () => {
    const result = await transition({ targetStatus: "done" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/issueIdOrKey/);
    expect(jiraGet).not.toHaveBeenCalled();
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/jira_transition 失败/);
  });

  it("AC-2710-TR-3: validation — missing targetStatus; error + slim details", async () => {
    const result = await transition({ issueIdOrKey: "CP-2690" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/targetStatus/);
    expect(jiraGet).not.toHaveBeenCalled();
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
  });

  it("AC-2710-TR-4: empty transitions list → error + slim details", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ transitions: [] });
    const result = await transition({
      issueIdOrKey: "CP-2690",
      targetStatus: "done",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/No transitions available/);
    expect(jiraPost).not.toHaveBeenCalled();
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/CP-2690 无可用 transition/);
  });

  it("AC-2710-TR-5: no match → error + hint「Available transitions」完整保留 + slim details", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      transitions: [
        {
          id: "21",
          name: "Reopen",
          to: { name: "待办", statusCategory: { id: 1, key: "new" } },
        },
      ],
    });
    const result = await transition({
      issueIdOrKey: "CP-2690",
      targetStatus: "done",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/did not match/);
    // CP-2710 红线 #28510: hint 「Available transitions」 完整保留
    expect(parsed.hint).toMatch(/Available transitions/);
    expect(parsed.hint).toMatch(/待办/);
    expect(jiraPost).not.toHaveBeenCalled();
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/无 done 匹配/);
  });

  it("AC-2710-TR-6: HTTP 500 on step 1 → error + slim details", async () => {
    const { JiraHttpError } = await import("../http.js");
    vi.mocked(jiraGet).mockRejectedValueOnce(
      new JiraHttpError(500, "Server Error", "kaboom"),
    );
    const result = await transition({
      issueIdOrKey: "CP-2690",
      targetStatus: "done",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/step 1/);
    expect(jiraPost).not.toHaveBeenCalled();
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/HTTP 500/);
  });

  it("AC-2710-TR-7: HTTP 500 on step 2 (execute) → error + slim details", async () => {
    const { JiraHttpError } = await import("../http.js");
    vi.mocked(jiraGet).mockResolvedValueOnce({
      transitions: [
        {
          id: "11",
          name: "Done",
          to: { name: "已完成", statusCategory: { id: 3, key: "done" } },
        },
      ],
    });
    vi.mocked(jiraPost).mockRejectedValueOnce(
      new JiraHttpError(500, "Server Error", "kaboom"),
    );
    const result = await transition({
      issueIdOrKey: "CP-2690",
      targetStatus: "done",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/step 2/);
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/HTTP 500/);
  });

  it("AC-2710-TR-8: matchedBy=exact-name fallback → details reflects matcher", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      transitions: [
        {
          id: "11",
          name: "In Review",
          to: { name: "In Review", statusCategory: { id: 2, key: "indeterminate" } },
        },
      ],
    });
    vi.mocked(jiraPost).mockResolvedValueOnce({});
    const result = await transition({
      issueIdOrKey: "CP-2690",
      targetStatus: "In Review",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.transition.matchedBy).toBe("exact-name");
    expect((result.details as string)).toMatch(/exact-name/);
  });
});
