/**
 * list_comments handler tests (SSSS-401).
 *
 * Coverage:
 *   - Happy path: ADF body → plain text + mentions; correct URL query.
 *   - Validation: missing issueIdOrKey, bad startAt/maxResults/orderBy.
 *   - Empty comments array.
 *   - Auth/config failure path (returns error envelope, not throws).
 *   - Upstream HTTP failure path.
 *   - ADF body of unexpected shape (non-doc) does not throw — returns "".
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
import { listComments } from "../handlers/list_comments.js";
import { adfToPlainText } from "../handlers/_adf.js";

const SAMPLE_ADF = {
  version: 1,
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Looks good to me. " },
        {
          type: "mention",
          attrs: { id: "acc-1", text: "@Alice" },
        },
        { type: "text", text: " please review." },
      ],
    },
  ],
};

describe("list_comments (SSSS-401)", () => {
  beforeEach(() => {
    vi.mocked(jiraGet).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("AC-401-LC-1: happy path — ADF body is converted to plain text + mentions", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      total: 1,
      startAt: 0,
      maxResults: 50,
      comments: [
        {
          id: "10001",
          author: { displayName: "Bob", accountId: "acc-2" },
          created: "2026-06-15T10:00:00.000+0800",
          updated: "2026-06-15T10:00:00.000+0800",
          body: SAMPLE_ADF,
        },
      ],
    });

    const result = await listComments({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(true);
    expect(parsed.method).toBe("list_comments");
    expect(parsed.count).toBe(1);
    // CP-2384 AC3: `total` lives under `summary` now (no top-level dup).
    expect(parsed.summary.total).toBe(1);
    expect(parsed.comments).toHaveLength(1);

    const c = parsed.comments[0];
    expect(c.id).toBe("10001");
    expect(c.author).toEqual({ displayName: "Bob", accountId: "acc-2" });
    expect(c.body).toBe("Looks good to me. @Alice please review.");
    expect(c.mentions).toEqual([
      { accountId: "acc-1", displayName: "Alice" },
    ]);
  });

  it("AC-401-LC-2: URL query uses startAt / maxResults / orderBy defaults", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ comments: [] });

    await listComments({ issueIdOrKey: "TEST-1" });

    expect(jiraGet).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(jiraGet).mock.calls[0];
    expect(callArgs[1]).toBe("issue/TEST-1/comment");
    // CP-2384 AC3: default maxResults dropped 50 → 20.
    expect(callArgs[2]).toEqual({
      startAt: 0,
      maxResults: 20,
      orderBy: "-created",
    });
  });

  it("AC-401-LC-3: respects custom startAt / maxResults / orderBy", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ comments: [] });

    await listComments({
      issueIdOrKey: "TEST-1",
      startAt: 20,
      maxResults: 10,
      orderBy: "created",
    });

    const callArgs = vi.mocked(jiraGet).mock.calls[0];
    expect(callArgs[2]).toEqual({
      startAt: 20,
      maxResults: 10,
      orderBy: "created",
    });
  });

  it("AC-401-LC-4: rejects negative startAt", async () => {
    const result = await listComments({
      issueIdOrKey: "TEST-1",
      startAt: -1,
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/startAt.*non-negative integer/);
    expect(jiraGet).not.toHaveBeenCalled();
  });

  it("AC-401-LC-5: rejects non-integer maxResults", async () => {
    const result = await listComments({
      issueIdOrKey: "TEST-1",
      maxResults: 2.5,
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/maxResults.*positive integer/);
    expect(jiraGet).not.toHaveBeenCalled();
  });

  it("AC-401-LC-6: rejects maxResults > 100 (forces pagination)", async () => {
    const result = await listComments({
      issueIdOrKey: "TEST-1",
      maxResults: 500,
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/capped at 100/);
    expect(jiraGet).not.toHaveBeenCalled();
  });

  it("AC-401-LC-7: rejects unknown orderBy (URL injection guard)", async () => {
    const result = await listComments({
      issueIdOrKey: "TEST-1",
      orderBy: "id DESC",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/orderBy.*one of/);
    expect(jiraGet).not.toHaveBeenCalled();
  });

  it("AC-401-LC-8: rejects missing issueIdOrKey", async () => {
    const result = await listComments({});
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/issueIdOrKey/);
    expect(jiraGet).not.toHaveBeenCalled();
  });

  it("AC-401-LC-9: empty comments list", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      total: 0,
      startAt: 0,
      maxResults: 50,
      comments: [],
    });

    const result = await listComments({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(0);
    expect(parsed.comments).toEqual([]);
  });

  it("AC-401-LC-10: missing body field renders as empty text", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      comments: [
        {
          id: "10001",
          author: { displayName: "Bob", accountId: "acc-2" },
          created: "2026-06-15T10:00:00.000+0800",
        },
      ],
    });

    const result = await listComments({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.comments[0].body).toBe("");
    expect(parsed.comments[0].mentions).toEqual([]);
  });

  it("AC-401-LC-11: HTTP error surfaces in the result envelope (no throw)", async () => {
    vi.mocked(jiraGet).mockRejectedValueOnce(new Error("network down"));

    const result = await listComments({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/jira\.list_comments failed.*network down/);
  });

  // ---- SSSS-404 R1/R4: client-side filter (since + authorAccountId) ----

  it("AC-404-LC-12: 401 unauthorized surfaces as error envelope (no throw)", async () => {
    const { JiraHttpError } = await import("../http.js");
    vi.mocked(jiraGet).mockRejectedValueOnce(
      new JiraHttpError(401, "Unauthorized", "invalid token"),
    );

    const result = await listComments({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/HTTP 401/);
    expect(parsed.error).toMatch(/Unauthorized/);
  });

  it("AC-404-LC-13: since filter keeps only comments with created>=since (client-side)", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      total: 3,
      startAt: 0,
      maxResults: 50,
      comments: [
        {
          id: "1",
          author: { displayName: "Alice", accountId: "acc-1" },
          created: "2026-06-10T10:00:00.000+0800",
          body: SAMPLE_ADF,
        },
        {
          id: "2",
          author: { displayName: "Bob", accountId: "acc-2" },
          created: "2026-06-15T10:00:00.000+0800",
          body: SAMPLE_ADF,
        },
        {
          id: "3",
          author: { displayName: "Carol", accountId: "acc-3" },
          created: "2026-06-20T10:00:00.000+0800",
          body: SAMPLE_ADF,
        },
      ],
    });

    const result = await listComments({
      issueIdOrKey: "TEST-1",
      since: "2026-06-15",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(true);
    expect(parsed.summary.total).toBe(3);
    expect(parsed.rawCount).toBe(3);
    expect(parsed.count).toBe(2);
    expect(parsed.comments.map((c: { id: string }) => c.id)).toEqual(["2", "3"]);
    // CP-2384 AC2/AC3: `since` moved from request echo → summary.
    expect(parsed.summary.since).toBe("2026-06-15T00:00:00.000Z");
  });

  it("AC-404-LC-14: since filter boundary — empty raw comments / since in the future", async () => {
    // (a) empty raw comments
    vi.mocked(jiraGet).mockResolvedValueOnce({
      total: 0,
      comments: [],
    });
    let result = await listComments({
      issueIdOrKey: "TEST-1",
      since: "2026-06-15",
    });
    let parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(0);
    expect(parsed.rawCount).toBe(0);
    expect(parsed.comments).toEqual([]);

    // (b) since in the future → all comments filtered out
    vi.mocked(jiraGet).mockResolvedValueOnce({
      total: 2,
      comments: [
        {
          id: "1",
          author: { displayName: "Alice", accountId: "acc-1" },
          created: "2026-06-10T10:00:00.000+0800",
          body: SAMPLE_ADF,
        },
        {
          id: "2",
          author: { displayName: "Bob", accountId: "acc-2" },
          created: "2026-06-15T10:00:00.000+0800",
          body: SAMPLE_ADF,
        },
      ],
    });

    result = await listComments({
      issueIdOrKey: "TEST-1",
      since: "2099-01-01",
    });
    parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.rawCount).toBe(2);
    expect(parsed.count).toBe(0);
    expect(parsed.comments).toEqual([]);
  });

  it("AC-404-LC-15: authorAccountId filter matches / does not match", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      total: 3,
      comments: [
        {
          id: "1",
          author: { displayName: "Alice", accountId: "acc-1" },
          created: "2026-06-10T10:00:00.000+0800",
          body: SAMPLE_ADF,
        },
        {
          id: "2",
          author: { displayName: "Bob", accountId: "acc-2" },
          created: "2026-06-15T10:00:00.000+0800",
          body: SAMPLE_ADF,
        },
        {
          id: "3",
          author: { displayName: "Alice", accountId: "acc-1" },
          created: "2026-06-20T10:00:00.000+0800",
          body: SAMPLE_ADF,
        },
      ],
    });

    // (a) match — returns Alice's two comments
    let result = await listComments({
      issueIdOrKey: "TEST-1",
      authorAccountId: "acc-1",
    });
    let parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.count).toBe(2);
    expect(parsed.comments.map((c: { id: string }) => c.id)).toEqual(["1", "3"]);
    expect(
      parsed.comments.every(
        (c: { author: { accountId: string } }) => c.author.accountId === "acc-1",
      ),
    ).toBe(true);

    // (b) no match — empty result
    vi.mocked(jiraGet).mockResolvedValueOnce({
      total: 1,
      comments: [
        {
          id: "99",
          author: { displayName: "Stranger", accountId: "acc-99" },
          created: "2026-06-20T10:00:00.000+0800",
          body: SAMPLE_ADF,
        },
      ],
    });

    result = await listComments({
      issueIdOrKey: "TEST-1",
      authorAccountId: "acc-1",
    });
    parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.count).toBe(0);
    expect(parsed.rawCount).toBe(1);
    expect(parsed.comments).toEqual([]);
  });

  it("AC-404-LC-16: empty since / authorAccountId skip filter (no throw)", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      comments: [
        {
          id: "1",
          author: { displayName: "Alice", accountId: "acc-1" },
          created: "2026-06-10T10:00:00.000+0800",
          body: SAMPLE_ADF,
        },
      ],
    });

    // Empty string and null and undefined all → no filter applied
    const result = await listComments({
      issueIdOrKey: "TEST-1",
      since: "",
      authorAccountId: "",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(1);
    // CP-2384 AC3: request echo stripped to {issueIdOrKey}; since /
    // authorAccountId live in summary, undefined when not passed.
    expect(parsed.request).toEqual({ issueIdOrKey: "TEST-1" });
    expect(parsed.summary.since).toBeUndefined();
    expect(parsed.summary.authorAccountId).toBeUndefined();
  });

  it("AC-404-LC-17: invalid since string returns soft error (no jiraGet call)", async () => {
    const result = await listComments({
      issueIdOrKey: "TEST-1",
      since: "not-a-date",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/since.*not a valid ISO date/);
    expect(jiraGet).not.toHaveBeenCalled();
  });

  // ---- CP-2384 AC3 (default 20 + top-level/summary dedup) ----

  it("AC-2384-LC-18: without maxResults, the upstream Atlassian query uses default 20", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ comments: [] });

    await listComments({ issueIdOrKey: "TEST-1" });

    const callArgs = vi.mocked(jiraGet).mock.calls[0];
    expect(callArgs[2]).toMatchObject({ maxResults: 20 });
  });

  it("AC-2384-LC-19: top-level envelope no longer duplicates summary fields (CP-2384 AC3 dedup)", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      total: 5,
      startAt: 0,
      maxResults: 20,
      comments: [
        {
          id: "1",
          author: { displayName: "Alice", accountId: "acc-1" },
          created: "2026-06-15T10:00:00.000+0800",
          body: SAMPLE_ADF,
        },
      ],
    });

    const result = await listComments({
      issueIdOrKey: "TEST-1",
      orderBy: "created",
      since: "2026-06-01",
      authorAccountId: "acc-1",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    // CP-2384 AC3 reverse-assertion: total / orderBy / since /
    // authorAccountId live ONLY in `summary` now (not at top-level).
    expect(parsed).not.toHaveProperty("total");
    expect(parsed).not.toHaveProperty("orderBy");
    expect(parsed).not.toHaveProperty("since");
    expect(parsed).not.toHaveProperty("authorAccountId");
    // They DO exist under summary, exactly once.
    expect(parsed.summary.total).toBe(5);
    expect(parsed.summary.orderBy).toBe("created");
    expect(parsed.summary.since).toBe("2026-06-01T00:00:00.000Z");
    expect(parsed.summary.authorAccountId).toBe("acc-1");
    // request echo is just {issueIdOrKey}.
    expect(parsed.request).toEqual({ issueIdOrKey: "TEST-1" });
  });
});

describe("adfToPlainText (SSSS-401 shared helper)", () => {
  it("renders a heading + paragraph + bullet list", () => {
    const r = adfToPlainText({
      version: 1,
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Plan" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Steps:" }],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "first" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "second" }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(r.text).toContain("## Plan");
    expect(r.text).toContain("Steps:");
    expect(r.text).toContain("- first");
    expect(r.text).toContain("- second");
    expect(r.mentions).toEqual([]);
  });

  it("dedupes mentions and preserves first-seen order", () => {
    const r = adfToPlainText({
      version: 1,
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: "a", text: "@Alice" } },
            { type: "text", text: " + " },
            { type: "mention", attrs: { id: "b", text: "@Bob" } },
            { type: "text", text: " + " },
            { type: "mention", attrs: { id: "a", text: "@Alice" } },
          ],
        },
      ],
    });
    expect(r.mentions).toEqual([
      { accountId: "a", displayName: "Alice" },
      { accountId: "b", displayName: "Bob" },
    ]);
  });

  it("returns empty text + empty mentions for null input", () => {
    expect(adfToPlainText(null)).toEqual({ text: "", mentions: [] });
  });

  it("returns empty text + empty mentions for non-doc input", () => {
    expect(adfToPlainText({ type: "paragraph" })).toEqual({
      text: "",
      mentions: [],
    });
  });

  it("accepts Jira-shaped envelope ({body: {...}}) without unwrap bug", () => {
    const r = adfToPlainText({
      id: "10001",
      body: SAMPLE_ADF,
    });
    expect(r.text).toBe("Looks good to me. @Alice please review.");
  });
});
