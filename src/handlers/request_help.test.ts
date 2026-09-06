/**
 * request_help handler tests (CP-2710 batch 3 — new file).
 *
 * Coverage:
 *   - Happy path: comment + wait-approval label; summary block REMOVED;
 *     mentioned: accountId|null (红线 #28510: accountId 不删); details
 *     <100-char one-line summary.
 *   - Mention path: optional accountId + displayName → mentioned set to
 *     accountId; details reflects the @mention.
 *   - Validation: missing issueIdOrKey, missing question; mention without
 *     displayName → error.
 *   - Main-task-only: subtask issue → fail-fast with slim details.
 *   - Partial: comment OK, label add fails → partial structure intact
 *     (CP-2710 红线 #28510: 结构 0 改动, 仅 details 摘要化).
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
import { requestHelp } from "../handlers/request_help.js";

describe("request_help (CP-2710 batch 3)", () => {
  beforeEach(() => {
    vi.mocked(jiraGet).mockReset();
    vi.mocked(jiraPost).mockReset();
    vi.mocked(jiraPut).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("AC-2710-RH-1: happy path — no mention, summary block REMOVED, label/method/comment present", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      fields: { issuetype: { subtask: false, name: "Task" } },
    });
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" });
    vi.mocked(jiraPut).mockResolvedValueOnce({});

    const result = await requestHelp({
      issueIdOrKey: "CP-2690",
      question: "How should I configure X?",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(true);
    expect(parsed.method).toBe("request_help");
    expect(parsed.comment).toEqual({ id: "c1", self: "http://x/c1" });
    expect(parsed.label).toBe("wait-approval");
    // CP-2710: 无 mention 时, mentioned=null (而非 undefined)
    expect(parsed.mentioned).toBeNull();
    // CP-2710: summary 块去除
    expect(parsed).not.toHaveProperty("summary");
    // 验证旧 summary 内的字段不在顶层 (key / commentId / label 全部回声)
    expect(parsed).not.toHaveProperty("key");
    // CP-2710 batch 3: 顶层 label 字段保留 (CP-2700 batch 2 之前的契约如此, 等价
    // label 反馈给 agent; 与「label 回声」区别是它是结果反馈而非请求回声)
    // details <100 字符一句话
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/CP-2690 主任务已问人/);
    expect(details).toMatch(/wait-approval/);
  });

  it("AC-2710-RH-2: happy path — with mention, mentioned=accountId, details shows @mention", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      fields: { issuetype: { subtask: false, name: "Task" } },
    });
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" });
    vi.mocked(jiraPut).mockResolvedValueOnce({});

    const result = await requestHelp({
      issueIdOrKey: "CP-2690",
      question: "请审核方案",
      mention: "acc-42",
      mentionDisplayName: "张三",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(true);
    // CP-2710: mentioned 保留 accountId (红线 #28510)
    expect(parsed.mentioned).toBe("acc-42");
    expect(parsed).not.toHaveProperty("summary");
    // details 显示 mention displayName
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/CP-2690 主任务已问人/);
    expect(details).toMatch(/张三/);
  });

  it("AC-2710-RH-3: validation — missing issueIdOrKey; error + slim details", async () => {
    const result = await requestHelp({ question: "x" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/issueIdOrKey/);
    expect(jiraGet).not.toHaveBeenCalled();
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
  });

  it("AC-2710-RH-4: validation — missing question; error + slim details", async () => {
    const result = await requestHelp({ issueIdOrKey: "CP-2690" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/question/);
    expect(jiraGet).not.toHaveBeenCalled();
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
  });

  it("AC-2710-RH-5: validation — mention without displayName; error + slim details", async () => {
    const result = await requestHelp({
      issueIdOrKey: "CP-2690",
      question: "x",
      mention: "acc-42",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/mentionDisplayName/);
    expect(jiraGet).not.toHaveBeenCalled();
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/缺 displayName/);
  });

  it("AC-2710-RH-6: subtask → fail-fast + slim details", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      fields: { issuetype: { subtask: true, name: "Sub-task" } },
    });
    const result = await requestHelp({
      issueIdOrKey: "CP-2690",
      question: "x",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/只能用于主任务/);
    expect(jiraPost).not.toHaveBeenCalled();
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/非主任务/);
  });

  it("AC-2710-RH-7: partial (comment OK, label add fails) — structure preserved, details slim", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      fields: { issuetype: { subtask: false, name: "Task" } },
    });
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" });
    vi.mocked(jiraPut).mockRejectedValueOnce(new Error("label 500"));

    const result = await requestHelp({
      issueIdOrKey: "CP-2690",
      question: "x",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    // CP-2710 红线 #28510: partial 结构 0 改动
    expect(parsed.ok).toBe(false);
    expect(parsed.method).toBe("request_help");
    expect(parsed.partial).toBe(true);
    expect(parsed.comment).toEqual({ id: "c1", self: "http://x/c1" });
    expect(parsed.hint).toBeDefined();
    expect(parsed.hint).toMatch(/add_label/);
    // CP-2710: summary 不再被引入 partial
    expect(parsed).not.toHaveProperty("summary");
    // details 反映 label 失败
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/CP-2690 部分完成/);
    expect(details).toMatch(/label 失败/);
  });

  it("AC-2710-RH-8: HTTP error on step 1 (get issue) — error + slim details", async () => {
    const { JiraHttpError } = await import("../http.js");
    vi.mocked(jiraGet).mockRejectedValueOnce(
      new JiraHttpError(404, "Not Found", "issue gone"),
    );
    const result = await requestHelp({
      issueIdOrKey: "CP-2690",
      question: "x",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/step 1/);
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
  });

  it("AC-2710-RH-9: HTTP error on step 2 (comment) — error + slim details", async () => {
    const { JiraHttpError } = await import("../http.js");
    vi.mocked(jiraGet).mockResolvedValueOnce({
      fields: { issuetype: { subtask: false, name: "Task" } },
    });
    vi.mocked(jiraPost).mockRejectedValueOnce(
      new JiraHttpError(500, "Server Error", "kaboom"),
    );
    const result = await requestHelp({
      issueIdOrKey: "CP-2690",
      question: "x",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/step 2/);
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
  });
});
