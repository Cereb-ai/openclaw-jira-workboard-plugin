/**
 * get_comment handler tests (SSSS-401, CP-2700 batch 2).
 *
 * Coverage:
 *   - Happy path: ADF body → plain text + mentions; correct URL path.
 *   - URL encoding: special chars in commentId are encoded.
 *   - Validation: missing issueIdOrKey, missing commentId.
 *   - Upstream HTTP error path.
 *   - ADF body of unexpected shape does not throw.
 *   - CP-2700 batch 2: summary block REMOVED; details = <100-char one-line
 *     string summary; body NEVER truncated (full-text escape hatch from
 *     jira_list_comments 500-char cap).
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

import { jiraGet } from "../http.js";
import { getComment } from "../handlers/get_comment.js";

const SAMPLE_BODY = {
  version: 1,
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Hello " },
        { type: "mention", attrs: { id: "acc-9", text: "@Carol" } },
      ],
    },
  ],
};

describe("get_comment (SSSS-401 + CP-2700 batch 2)", () => {
  beforeEach(() => {
    vi.mocked(jiraGet).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("AC-401-GC-1: happy path — ADF body to plain text, mentions extracted; summary block REMOVED (CP-2700 batch 2)", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      id: "10042",
      author: { displayName: "Dave", accountId: "acc-3" },
      created: "2026-06-20T08:30:00.000+0800",
      updated: "2026-06-20T08:30:00.000+0800",
      body: SAMPLE_BODY,
    });

    const result = await getComment({
      issueIdOrKey: "TEST-1",
      commentId: "10042",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(true);
    expect(parsed.method).toBe("get_comment");
    expect(parsed.comment.id).toBe("10042");
    expect(parsed.comment.author).toEqual({
      displayName: "Dave",
      accountId: "acc-3",
    });
    expect(parsed.comment.body).toBe("Hello @Carol");
    expect(parsed.comment.mentions).toEqual([
      { accountId: "acc-9", displayName: "Carol" },
    ]);
    // CP-2700 batch 2: summary block REMOVED — all 6 fields (key, commentId,
    // author, created, bodyChars, mentionCount) duplicated request /
    // comment surfaces.
    expect(parsed).not.toHaveProperty("summary");
  });

  it("AC-401-GC-1b (CP-2700 batch 2): details is <100-char one-line semantic summary string", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      id: "10042",
      author: { displayName: "Dave", accountId: "acc-3" },
      created: "2026-06-20T08:30:00.000+0800",
      updated: "2026-06-20T08:30:00.000+0800",
      body: SAMPLE_BODY,
    });

    const result = await getComment({
      issueIdOrKey: "TEST-1",
      commentId: "10042",
    });
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    // Format: 成功获取 <key> 评论 <id>: <author> <date>, 正文 <N> 字
    expect(details).toMatch(/成功获取 TEST-1 评论 10042/);
    expect(details).toMatch(/Dave/);
    expect(details).toMatch(/正文 \d+ 字/);
  });

  it("AC-401-GC-1c (CP-2700 batch 2): body NEVER truncated, even for huge bodies (escape hatch)", async () => {
    const huge = "x".repeat(5000);
    vi.mocked(jiraGet).mockResolvedValueOnce({
      id: "10042",
      author: { displayName: "Dave", accountId: "acc-3" },
      created: "2026-06-20T08:30:00.000+0800",
      updated: "2026-06-20T08:30:00.000+0800",
      body: {
        version: 1,
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: huge }] },
        ],
      },
    });

    const result = await getComment({
      issueIdOrKey: "TEST-1",
      commentId: "10042",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    // The full 5000 chars must come back. No tail marker.
    expect(parsed.comment.body).toBe(huge);
    expect(parsed.comment.body).not.toMatch(/正文已截断/);
    // details carries the size hint as a number, not as a truncated string.
    expect(parsed.comment.body.length).toBe(5000);
    expect((result.details as string)).toMatch(/正文 5000 字/);
  });

  it("AC-401-GC-2: URL is issue/{key}/comment/{id} with encoding", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      id: "100/42",
      body: SAMPLE_BODY,
    });

    await getComment({
      issueIdOrKey: "TEST-1",
      commentId: "100/42",
    });

    expect(jiraGet).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(jiraGet).mock.calls[0];
    expect(callArgs[1]).toBe("issue/TEST-1/comment/100%2F42");
  });

  it("AC-401-GC-3: rejects missing issueIdOrKey; error path also has slim details (CP-2700 batch 2)", async () => {
    const result = await getComment({ commentId: "10042" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/issueIdOrKey/);
    expect(jiraGet).not.toHaveBeenCalled();
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
    expect((result.details as string)).toMatch(/jira_get_comment 失败/);
  });

  it("AC-401-GC-4: rejects missing commentId; error path also has slim details (CP-2700 batch 2)", async () => {
    const result = await getComment({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/commentId/);
    expect(jiraGet).not.toHaveBeenCalled();
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
  });

  it("AC-401-GC-5: rejects empty commentId; error path also has slim details (CP-2700 batch 2)", async () => {
    const result = await getComment({
      issueIdOrKey: "TEST-1",
      commentId: "  ",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/commentId/);
    expect(jiraGet).not.toHaveBeenCalled();
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
  });

  it("AC-401-GC-6: 404 upstream surfaces as error envelope with slim details (CP-2700 batch 2)", async () => {
    const { JiraHttpError } = await import("../http.js");
    vi.mocked(jiraGet).mockRejectedValueOnce(
      new JiraHttpError(404, "Not Found", "issue not found"),
    );

    const result = await getComment({
      issueIdOrKey: "TEST-1",
      commentId: "10042",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/HTTP 404/);
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/jira_get_comment 失败/);
  });

  it("AC-401-GC-7: missing body field renders as empty text; summary absent (CP-2700 batch 2)", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      id: "10042",
      author: { displayName: "Dave", accountId: "acc-3" },
      created: "2026-06-20T08:30:00.000+0800",
    });

    const result = await getComment({
      issueIdOrKey: "TEST-1",
      commentId: "10042",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.comment.body).toBe("");
    expect(parsed.comment.mentions).toEqual([]);
    expect(parsed).not.toHaveProperty("summary");
  });

  it("AC-401-GC-8 (CP-2700 batch 2): details does NOT echo content payload (no details=content duplication)", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      id: "10042",
      author: { displayName: "Dave", accountId: "acc-3" },
      created: "2026-06-20T08:30:00.000+0800",
      updated: "2026-06-20T08:30:00.000+0800",
      body: SAMPLE_BODY,
    });

    const result = await getComment({
      issueIdOrKey: "TEST-1",
      commentId: "10042",
    });
    // CP-2700 batch 2 reverse assertion: details must be a slim string, NOT
    // a duplication of the full content payload (was the 批 1 batch fix
    // for search/comment/create_task/create_subtask).
    expect(typeof result.details).toBe("string");
    expect(result.details).not.toEqual(JSON.parse(result.content[0].text as string));
  });
});
