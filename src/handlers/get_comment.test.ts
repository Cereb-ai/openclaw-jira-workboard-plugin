/**
 * get_comment handler tests (SSSS-401).
 *
 * Coverage:
 *   - Happy path: ADF body → plain text + mentions; correct URL path.
 *   - URL encoding: special chars in commentId are encoded.
 *   - Validation: missing issueIdOrKey, missing commentId.
 *   - Upstream HTTP error path.
 *   - ADF body of unexpected shape does not throw.
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

describe("get_comment (SSSS-401)", () => {
  beforeEach(() => {
    vi.mocked(jiraGet).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("AC-401-GC-1: happy path — ADF body to plain text, mentions extracted", async () => {
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
    expect(parsed.summary.bodyChars).toBe("Hello @Carol".length);
    expect(parsed.summary.mentionCount).toBe(1);
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

  it("AC-401-GC-3: rejects missing issueIdOrKey", async () => {
    const result = await getComment({ commentId: "10042" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/issueIdOrKey/);
    expect(jiraGet).not.toHaveBeenCalled();
  });

  it("AC-401-GC-4: rejects missing commentId", async () => {
    const result = await getComment({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/commentId/);
    expect(jiraGet).not.toHaveBeenCalled();
  });

  it("AC-401-GC-5: rejects empty commentId", async () => {
    const result = await getComment({
      issueIdOrKey: "TEST-1",
      commentId: "  ",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/commentId/);
    expect(jiraGet).not.toHaveBeenCalled();
  });

  it("AC-401-GC-6: 404 upstream surfaces as error envelope", async () => {
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
  });

  it("AC-401-GC-7: missing body field renders as empty text", async () => {
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
    expect(parsed.summary.bodyChars).toBe(0);
  });
});
