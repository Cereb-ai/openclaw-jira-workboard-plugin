/**
 * abandon_task handler tests (CP-2710 batch 3 — new file).
 *
 * Coverage:
 *   - Happy path: comment + clear assignee + transition + remove labels;
 *     summary block REMOVED; labels echo (key list) REMOVED but boolean +
 *     error string preserved; details <100-char one-line summary.
 *   - Validation: missing issueIdOrKey, missing reason, bad labels shape.
 *   - Subtask-only: non-subtask issue → fail-fast with slim details.
 *   - Partial: comment OK, assignee clear fails → partial structure intact
 *     (CP-2710 红线 #28510: 结构 0 改动, 仅 details 摘要化).
 *   - HTTP upstream error paths: error envelope + slim details.
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

import { jiraGet, jiraPost, jiraPut } from "../http.js";
import { abandonTask } from "../handlers/abandon_task.js";

describe("abandon_task (CP-2710 batch 3)", () => {
  beforeEach(() => {
    vi.mocked(jiraGet).mockReset();
    vi.mocked(jiraPost).mockReset();
    vi.mocked(jiraPut).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("AC-2710-AT-1: happy path — summary block REMOVED, labels echo trimmed, details slim", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      fields: { issuetype: { subtask: true, name: "Sub-task" } },
    });
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" }); // comment
    vi.mocked(jiraPut).mockResolvedValueOnce({}); // clear assignee
    vi.mocked(jiraGet).mockResolvedValueOnce({
      transitions: [{ id: "31", name: "Done", to: { name: "已完成" } }],
    });
    vi.mocked(jiraPost).mockResolvedValueOnce({}); // transition execute
    vi.mocked(jiraPut).mockResolvedValueOnce({}); // remove escalated label

    const result = await abandonTask({
      issueIdOrKey: "CP-2690",
      reason: "re-planning",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(true);
    expect(parsed.method).toBe("abandon_task");
    expect(parsed.comment).toEqual({ id: "c1", self: "http://x/c1" });
    expect(parsed.assigneeCleared).toBe(true);
    expect(parsed.labelsRemoved).toBe(true);
    expect(parsed.labelsRemoveError).toBeUndefined();
    expect(parsed.transition).toEqual({
      id: "31",
      name: "Done",
      to: "已完成",
    });
    // CP-2710: summary 块去除
    expect(parsed).not.toHaveProperty("summary");
    // 验证 labels 回声去除 (旧 summary 内的 labels 数组)
    expect(parsed).not.toHaveProperty("labels");
    // 验证顶层 key 回声去除
    expect(parsed).not.toHaveProperty("key");
    expect(parsed).not.toHaveProperty("commentId");
    // details <100 字符一句话
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/CP-2690 子任务已废弃/);
    expect(details).toMatch(/已完成/);
  });

  it("AC-2710-AT-2: validation — missing issueIdOrKey; error + slim details", async () => {
    const result = await abandonTask({ reason: "x" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/issueIdOrKey/);
    expect(jiraGet).not.toHaveBeenCalled();
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
  });

  it("AC-2710-AT-3: validation — missing reason; error + slim details", async () => {
    const result = await abandonTask({ issueIdOrKey: "CP-2690" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/reason/);
    expect(jiraGet).not.toHaveBeenCalled();
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
  });

  it("AC-2710-AT-4: validation — bad labels shape; error + slim details", async () => {
    const result = await abandonTask({
      issueIdOrKey: "CP-2690",
      reason: "x",
      labels: ["ok", 42],
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/labels/);
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
  });

  it("AC-2710-AT-5: non-subtask → fail-fast + slim details", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      fields: { issuetype: { subtask: false, name: "Task" } },
    });
    const result = await abandonTask({
      issueIdOrKey: "CP-2690",
      reason: "x",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/只能用于子任务/);
    expect(jiraPost).not.toHaveBeenCalled();
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/非子任务/);
  });

  it("AC-2710-AT-6: partial (comment OK, clear assignee fails) — structure preserved, details slim", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      fields: { issuetype: { subtask: true, name: "Sub-task" } },
    });
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" });
    vi.mocked(jiraPut).mockRejectedValueOnce(new Error("assignee 500"));

    const result = await abandonTask({
      issueIdOrKey: "CP-2690",
      reason: "x",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    // CP-2710 红线 #28510: partial 结构 0 改动
    expect(parsed.ok).toBe(false);
    expect(parsed.method).toBe("abandon_task");
    expect(parsed.partial).toBe(true);
    expect(parsed.comment).toEqual({ id: "c1", self: "http://x/c1" });
    expect(parsed.hint).toBeDefined();
    // hint 文案完整保留
    expect(parsed.hint).toMatch(/manually clear/);
    // CP-2710 batch 3: summary 不再被引入 partial
    expect(parsed).not.toHaveProperty("summary");
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/CP-2690 部分废弃/);
  });

  it("AC-2710-AT-7: partial (comment OK, assignee OK, no transitions) — structure preserved", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      fields: { issuetype: { subtask: true, name: "Sub-task" } },
    });
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" });
    vi.mocked(jiraPut).mockResolvedValueOnce({}); // clear assignee OK
    vi.mocked(jiraGet).mockResolvedValueOnce({ transitions: [] });

    const result = await abandonTask({
      issueIdOrKey: "CP-2690",
      reason: "x",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.partial).toBe(true);
    expect(parsed.assigneeCleared).toBe(true);
    expect(parsed).not.toHaveProperty("summary");
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
    expect((result.details as string)).toMatch(/无可用 transition/);
  });

  it("AC-2710-AT-8: partial (transition execute fails) — structure preserved", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      fields: { issuetype: { subtask: true, name: "Sub-task" } },
    });
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" });
    vi.mocked(jiraPut).mockResolvedValueOnce({}); // clear assignee OK
    vi.mocked(jiraGet).mockResolvedValueOnce({
      transitions: [{ id: "31", name: "Done", to: { name: "已完成" } }],
    });
    vi.mocked(jiraPost).mockRejectedValueOnce(new Error("transition 500"));

    const result = await abandonTask({
      issueIdOrKey: "CP-2690",
      reason: "x",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.partial).toBe(true);
    expect(parsed.assigneeCleared).toBe(true);
    expect(parsed).not.toHaveProperty("summary");
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
    expect((result.details as string)).toMatch(/转态失败/);
  });

  it("AC-2710-AT-9: labels remove fails — labelsRemoved=false, labelsRemoveError set, but rest OK", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      fields: { issuetype: { subtask: true, name: "Sub-task" } },
    });
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" });
    vi.mocked(jiraPut).mockResolvedValueOnce({}); // clear assignee OK
    vi.mocked(jiraGet).mockResolvedValueOnce({
      transitions: [{ id: "31", name: "Done", to: { name: "已完成" } }],
    });
    vi.mocked(jiraPost).mockResolvedValueOnce({}); // transition OK
    vi.mocked(jiraPut).mockRejectedValueOnce(new Error("label 500")); // remove label fails

    const result = await abandonTask({
      issueIdOrKey: "CP-2690",
      reason: "x",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.assigneeCleared).toBe(true);
    expect(parsed.labelsRemoved).toBe(false);
    expect(parsed.labelsRemoveError).toMatch(/label 500/);
    expect(parsed).not.toHaveProperty("summary");
    // details 反映 label 部分失败
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/部分 label 清除失败/);
  });

  it("AC-2710-AT-10: HTTP error on step 1 (get issue) — error + slim details", async () => {
    const { JiraHttpError } = await import("../http.js");
    vi.mocked(jiraGet).mockRejectedValueOnce(
      new JiraHttpError(404, "Not Found", "issue gone"),
    );
    const result = await abandonTask({
      issueIdOrKey: "CP-2690",
      reason: "x",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/step 1/);
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
  });
});
