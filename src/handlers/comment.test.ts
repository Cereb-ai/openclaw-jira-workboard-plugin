/**
 * comment handler tests — CP-2384 AC2 (request echo strip body), AC4 (return
 * field contract: comment.id/self/created), CP-2693 batch 1 (details summary
 * + summary block removal).
 *
 * Coverage:
 *   - Happy path: posting a comment returns comment.id/self/created; old
 *     `summary{key,commentId,url}` block REMOVED (CP-2693 batch 1, v0.5 草稿池
 *     落地去 summary). request.body is NOT echoed.
 *   - Validation: missing issueIdOrKey, missing body, empty body, body
 *     not-a-string.
 *   - mentionAccountIds are stripped down to account IDs (no @displayName
 *     needed); kept under `request.mentions`.
 *   - bodyChars carries the original length so the agent can sanity-check
 *     truncation locally.
 *   - details: <100-char one-line summary string (NOT the full structured
 *     object). 401 / network errors also surface slim details.
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

import { jiraPost } from "../http.js";
import { comment } from "../handlers/comment.js";

describe("comment (CP-2384)", () => {
  beforeEach(() => {
    vi.mocked(jiraPost).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("AC-2384-C-1: happy path — comment.id/self/created preserved (CP-2384 AC4) + summary block REMOVED (CP-2693 batch 1)", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({
      id: "10001",
      self: "https://example.atlassian.net/rest/api/3/issue/TEST-1/comment/10001",
      created: "2026-06-15T10:00:00.000+0800",
    });

    const result = await comment({
      issueIdOrKey: "TEST-1",
      body: "✅ CP-2384 implementation kicked off",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(true);
    expect(parsed.method).toBe("comment");
    // comment.* fields ARE the result feedback — preserved.
    expect(parsed.comment).toEqual({
      id: "10001",
      self: "https://example.atlassian.net/rest/api/3/issue/TEST-1/comment/10001",
      created: "2026-06-15T10:00:00.000+0800",
    });
    // CP-2693 batch 1: summary block REMOVED (key/commentId/url all duplicated
    // request.issueIdOrKey / comment.id / comment.self — v0.5 草稿池落地).
    expect(parsed).not.toHaveProperty("summary");
    // CP-2693 batch 1: details is a <100-char one-line summary string.
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/TEST-1/);
    expect(details).toMatch(/10001/);
    expect(details).toMatch(/已评论/);
  });

  it("AC-2384-C-2: request body is NOT echoed (CP-2384 AC2 echo strip)", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({
      id: "10002",
      self: "url",
      created: "2026-06-15T10:00:00.000+0800",
    });

    const longBody = "x".repeat(200);
    const result = await comment({
      issueIdOrKey: "TEST-1",
      body: longBody,
    });
    const parsed = JSON.parse(result.content[0].text as string);

    // The original body must NOT appear anywhere in the response surface.
    expect(JSON.stringify(parsed)).not.toContain(longBody);
    // bodyChars tells the agent how big the body was, but not the contents.
    expect(parsed.request.bodyChars).toBe(200);
    expect(parsed.request.body).toBeUndefined();
  });

  it("AC-2384-C-3: mentionAccountIds are kept under request.mentions (key-class info)", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({
      id: "10003",
      self: "url",
      created: "2026-06-15T10:00:00.000+0800",
    });

    const result = await comment({
      issueIdOrKey: "TEST-1",
      body: "ping",
      mentionAccountIds: ["acc-1", "acc-2"],
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.request.mentions).toEqual(["acc-1", "acc-2"]);
    expect(parsed.request.body).toBeUndefined();
  });

  it("AC-2384-C-4: upstream POST receives ADF doc (internal contract unchanged)", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({
      id: "10004",
      self: "url",
      created: "2026-06-15T10:00:00.000+0800",
    });

    await comment({
      issueIdOrKey: "TEST-1",
      body: "hello\nworld",
      mentionAccountIds: ["acc-1"],
    });

    expect(jiraPost).toHaveBeenCalledTimes(1);
    const [cfg, path, body] = vi.mocked(jiraPost).mock.calls[0];
    expect(cfg).toBeDefined();
    expect(path).toBe("issue/TEST-1/comment");
    // Plain text "hello\nworld" + mention prefix becomes an ADF doc internally.
    const adf = (body as { body: unknown }).body as {
      type: string;
      content: Array<{ type: string; content: Array<{ type: string; text?: string; attrs?: Record<string, unknown> }> }>;
    };
    expect(adf.type).toBe("doc");
    const inline = adf.content[0].content;
    // Mention prefix is the first inline; the comment.ts implementation
    // serializes it as `{type:"mention", attrs:{id}}` (mentionMap is the
    // responsibility of the calling layer in v0.5.1+).
    expect(inline.some((n) => n.type === "mention" && n.attrs?.id === "acc-1")).toBe(true);
    // \\n → hardBreak is the user-visible multi-line handling.
    expect(inline.some((n) => n.type === "hardBreak")).toBe(true);
  });

  it("AC-2384-C-5: rejects missing issueIdOrKey", async () => {
    const result = await comment({ body: "x" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/issueIdOrKey/);
    expect(jiraPost).not.toHaveBeenCalled();
    // CP-2693 batch 1: error paths also surface slim details.
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
  });

  it("AC-2384-C-6: rejects missing body", async () => {
    const result = await comment({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/body.*plain string/);
    expect(jiraPost).not.toHaveBeenCalled();
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
  });

  it("AC-2384-C-7: rejects empty body", async () => {
    const result = await comment({ issueIdOrKey: "TEST-1", body: "" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/body.*non-empty/);
    expect(jiraPost).not.toHaveBeenCalled();
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
  });

  it("AC-2384-C-8: 401 upstream surfaces as error envelope with status + body preserved", async () => {
    const { JiraHttpError } = await import("../http.js");
    vi.mocked(jiraPost).mockRejectedValueOnce(
      new JiraHttpError(401, "Unauthorized", "bad token"),
    );
    const result = await comment({ issueIdOrKey: "TEST-1", body: "x" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/jira\.comment failed/);
    expect(parsed.error).toMatch(/HTTP 401/);
    // CP-2693 batch 1: error paths also have slim details.
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
  });
});
