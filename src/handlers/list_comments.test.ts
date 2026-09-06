/**
 * list_comments handler tests (SSSS-401; CP-2384; CP-2669 G3-G6).
 *
 * Coverage:
 *   - Happy path: ADF body → plain text + mentions; correct URL query.
 *   - Validation: missing issueIdOrKey, bad startAt/maxResults/orderBy.
 *   - Empty comments array.
 *   - Auth/config failure path (returns error envelope, not throws).
 *   - Upstream HTTP failure path.
 *   - ADF body of unexpected shape (non-doc) does not throw — returns "".
 *
 *   CP-2384: client-side filter (since + authorAccountId) + AC3 dedup.
 *
 *   CP-2669 G3: per-comment body > 500 chars → truncated to 500 chars +
 *               tail marker pointing at jira_get_comment {id}.
 *   CP-2669 G4: default maxResults dropped 20 → 10.
 *   CP-2669 G5: response shape slimmed to {ok, method, request{issueIdOrKey},
 *               total, returned, comments, [nextStartAt]}. rawCount / count /
 *               summary {} all gone. nextStartAt only when remaining.
 *   CP-2669 G6: ToolResult.details is a <100-char one-line summary string,
 *               NOT the full structured object.
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

/** Build a comment whose body is exactly `bodyLen` chars of plain text. */
function longBodyAdf(bodyLen: number): unknown {
  const text = "x".repeat(bodyLen);
  return {
    version: 1,
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: text }] }],
  };
}

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
      maxResults: 10,
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
    // CP-2669 G5: total/returned are the only two count fields at the
    // top level. rawCount / count / summary{} are gone.
    expect(parsed.total).toBe(1);
    expect(parsed.returned).toBe(1);
    expect(parsed.comments).toHaveLength(1);

    const c = parsed.comments[0];
    expect(c.id).toBe("10001");
    expect(c.author).toEqual({ displayName: "Bob", accountId: "acc-2" });
    expect(c.body).toBe("Looks good to me. @Alice please review.");
    expect(c.mentions).toEqual([
      { accountId: "acc-1", displayName: "Alice" },
    ]);

    // CP-2669 G6: details is a <100-char one-line summary string,
    // not the full structured object.
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
    expect(result.details as string).toMatch(/TEST-1.*共.*1.*条评论.*本次返回 1 条/);
  });

  it("AC-401-LC-2: URL query uses startAt / maxResults / orderBy defaults", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ comments: [] });

    await listComments({ issueIdOrKey: "TEST-1" });

    expect(jiraGet).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(jiraGet).mock.calls[0];
    expect(callArgs[1]).toBe("issue/TEST-1/comment");
    // CP-2669 G4: default maxResults dropped 20 → 10.
    expect(callArgs[2]).toEqual({
      startAt: 0,
      maxResults: 10,
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

  it("AC-401-LC-9: empty comments list (total=0, returned=0, no nextStartAt)", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      total: 0,
      startAt: 0,
      maxResults: 10,
      comments: [],
    });

    const result = await listComments({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(true);
    expect(parsed.total).toBe(0);
    expect(parsed.returned).toBe(0);
    expect(parsed.comments).toEqual([]);
    // CP-2669 G5: no nextStartAt when there's nothing to paginate.
    expect(parsed).not.toHaveProperty("nextStartAt");
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
    // CP-2669 G6: error path also has slim details summary.
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
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
      maxResults: 10,
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
    // CP-2669 G5: total is the upstream total (3); returned is
    // post-filter (2). No rawCount / count / summary.
    expect(parsed.total).toBe(3);
    expect(parsed.returned).toBe(2);
    expect(parsed.comments.map((c: { id: string }) => c.id)).toEqual(["2", "3"]);
    // CP-2669 G5: since is no longer echoed anywhere (filter still
    // applied, but the response is slim).
    expect(parsed).not.toHaveProperty("since");
    expect(parsed).not.toHaveProperty("summary");
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
    expect(parsed.total).toBe(0);
    expect(parsed.returned).toBe(0);
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
    expect(parsed.total).toBe(2);
    expect(parsed.returned).toBe(0);
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
    expect(parsed.returned).toBe(2);
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
    expect(parsed.returned).toBe(0);
    expect(parsed.total).toBe(1);
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
    expect(parsed.returned).toBe(1);
    // CP-2669 G5: only issueIdOrKey survives in the request echo.
    expect(parsed.request).toEqual({ issueIdOrKey: "TEST-1" });
    expect(parsed).not.toHaveProperty("since");
    expect(parsed).not.toHaveProperty("authorAccountId");
    expect(parsed).not.toHaveProperty("summary");
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

  // ---- CP-2384 AC3 (default 20) + CP-2669 G4 (default 10) ----

  it("AC-2384-LC-18: without maxResults, the upstream Atlassian query uses default 10 (CP-2669 G4)", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ comments: [] });

    await listComments({ issueIdOrKey: "TEST-1" });

    const callArgs = vi.mocked(jiraGet).mock.calls[0];
    expect(callArgs[2]).toMatchObject({ maxResults: 10 });
  });

  it("AC-2384-LC-19: top-level envelope is slim (CP-2669 G5) — no rawCount/count/summary/startAt/maxResults", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      total: 5,
      startAt: 0,
      maxResults: 10,
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

    // CP-2669 G5 reverse-assertion: nothing that the agent already
    // knows (filter params, page cursors it sent) is echoed back.
    expect(parsed).not.toHaveProperty("startAt");
    expect(parsed).not.toHaveProperty("maxResults");
    expect(parsed).not.toHaveProperty("rawCount");
    expect(parsed).not.toHaveProperty("count");
    expect(parsed).not.toHaveProperty("summary");
    expect(parsed).not.toHaveProperty("orderBy");
    expect(parsed).not.toHaveProperty("since");
    expect(parsed).not.toHaveProperty("authorAccountId");
    // Only the slim fields survive: ok / method / request / total /
    // returned / comments (and optional nextStartAt).
    expect(parsed.ok).toBe(true);
    expect(parsed.method).toBe("list_comments");
    expect(parsed.request).toEqual({ issueIdOrKey: "TEST-1" });
    expect(parsed.total).toBe(5);
    expect(parsed.returned).toBe(1);
    expect(parsed.comments).toHaveLength(1);
  });

  // ---- CP-2669 G3: body truncation > 500 chars ----

  it("AC-2669-LC-20: body > 500 chars is truncated to 500 + tail marker pointing at jira_get_comment {id}", async () => {
    const bodyLen = 1200;
    vi.mocked(jiraGet).mockResolvedValueOnce({
      total: 1,
      startAt: 0,
      maxResults: 10,
      comments: [
        {
          id: "9001",
          author: { displayName: "Verbose", accountId: "acc-1" },
          created: "2026-06-15T10:00:00.000+0800",
          body: longBodyAdf(bodyLen),
        },
      ],
    });

    const result = await listComments({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);

    const body = parsed.comments[0].body as string;
    // First 500 chars are the original "x" * 500.
    expect(body.startsWith("x".repeat(500))).toBe(true);
    // Tail marker carries the ORIGINAL pre-truncation length and the
    // jira_get_comment {id} pointer.
    expect(body).toContain(`共 ${bodyLen} 字符`);
    expect(body).toContain("jira_get_comment 9001 获取");
    // Whole body is well under 1200 chars (truncation worked).
    expect(body.length).toBeLessThan(bodyLen);
  });

  it("AC-2669-LC-21: body exactly at 500 chars is NOT truncated", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      total: 1,
      startAt: 0,
      maxResults: 10,
      comments: [
        {
          id: "9002",
          author: { displayName: "Edge", accountId: "acc-2" },
          created: "2026-06-15T10:00:00.000+0800",
          body: longBodyAdf(500),
        },
      ],
    });

    const result = await listComments({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);
    const body = parsed.comments[0].body as string;
    expect(body).toBe("x".repeat(500));
    expect(body).not.toContain("正文已截断");
  });

  it("AC-2669-LC-22: body under 500 chars passes through untouched", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      total: 1,
      startAt: 0,
      maxResults: 10,
      comments: [
        {
          id: "9003",
          author: { displayName: "Short", accountId: "acc-3" },
          created: "2026-06-15T10:00:00.000+0800",
          body: SAMPLE_ADF,
        },
      ],
    });

    const result = await listComments({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.comments[0].body).toBe(
      "Looks good to me. @Alice please review.",
    );
  });

  // ---- CP-2669 G5: nextStartAt presence (only when remaining) ----

  it("AC-2669-LC-23: nextStartAt is present and points at next page when more comments remain", async () => {
    // total=25, page size=10, startAt=0 → page 1 returns 10, 15 remain.
    vi.mocked(jiraGet).mockResolvedValueOnce({
      total: 25,
      startAt: 0,
      maxResults: 10,
      comments: Array.from({ length: 10 }, (_, i) => ({
        id: String(1000 + i),
        author: { displayName: "U", accountId: "u" },
        created: "2026-06-15T10:00:00.000+0800",
        body: SAMPLE_ADF,
      })),
    });

    const result = await listComments({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.total).toBe(25);
    expect(parsed.returned).toBe(10);
    expect(parsed).toHaveProperty("nextStartAt");
    // "最后一条偏移 + 1" = 0 + 10 = 10
    expect(parsed.nextStartAt).toBe(10);
    // Details summary mentions the pagination hint.
    expect(result.details as string).toMatch(/→10 翻页/);
  });

  it("AC-2669-LC-24: nextStartAt is absent when no more comments remain", async () => {
    // total=8, page size=10, all returned in one page.
    vi.mocked(jiraGet).mockResolvedValueOnce({
      total: 8,
      startAt: 0,
      maxResults: 10,
      comments: Array.from({ length: 8 }, (_, i) => ({
        id: String(2000 + i),
        author: { displayName: "U", accountId: "u" },
        created: "2026-06-15T10:00:00.000+0800",
        body: SAMPLE_ADF,
      })),
    });

    const result = await listComments({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.total).toBe(8);
    expect(parsed.returned).toBe(8);
    expect(parsed).not.toHaveProperty("nextStartAt");
    expect(result.details as string).not.toMatch(/翻页/);
  });

  it("AC-2669-LC-25: nextStartAt walks the offset forward across pages (startAt=20, total=25)", async () => {
    // Caller already paged through 0-9 and 10-19, now on page 3.
    vi.mocked(jiraGet).mockResolvedValueOnce({
      total: 25,
      startAt: 20,
      maxResults: 10,
      comments: Array.from({ length: 5 }, (_, i) => ({
        id: String(3000 + i),
        author: { displayName: "U", accountId: "u" },
        created: "2026-06-15T10:00:00.000+0800",
        body: SAMPLE_ADF,
      })),
    });

    const result = await listComments({
      issueIdOrKey: "TEST-1",
      startAt: 20,
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.total).toBe(25);
    expect(parsed.returned).toBe(5);
    // startAt=20, page size=10, last offset=29, next=30. But total=25
    // so hasMore = (20 + 10 < 25) = false → no nextStartAt.
    expect(parsed).not.toHaveProperty("nextStartAt");
  });

  // ---- CP-2669 G6: details summary never duplicates the full object ----

  it("AC-2669-LC-26: details is a short summary string, NOT the full structured object", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      total: 1,
      startAt: 0,
      maxResults: 10,
      comments: [
        {
          id: "10001",
          author: { displayName: "Bob", accountId: "acc-2" },
          created: "2026-06-15T10:00:00.000+0800",
          body: SAMPLE_ADF,
        },
      ],
    });

    const result = await listComments({ issueIdOrKey: "TEST-1" });
    // Type + length + content shape check.
    expect(typeof result.details).toBe("string");
    const summary = result.details as string;
    expect(summary.length).toBeLessThan(100);
    // Must mention the ticket key + count info, but not the whole JSON.
    expect(summary).toContain("TEST-1");
    expect(summary).toMatch(/共.*1.*条评论/);
    expect(summary).not.toContain("mentions");
    expect(summary).not.toContain("author");
    // The full payload is still in content[0].text, separately.
    expect(result.content[0].text as string).toContain("mentions");
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
