/**
 * search handler tests — CP-2384 AC2 (request echo strip), AC4 (return
 * field contract).
 *
 * Coverage:
 *   - Happy path: JQL search returns issues[] with key/id/summary/status/
 *     issuetype/labels/created/parent. No issuelinks at top-level (default
 *     fields dropped it).
 *   - default `fields` (CP-2384): no issuelinks. Caller-supplied `fields`
 *     list passes through, with issuelinks allowed if explicitly requested.
 *   - request echo reduced to `{jql}` only.
 *   - 400/410/network errors surface as error envelopes.
 *
 *   CP-2693 batch 1: `details` = <100-char one-line summary string
 *   (`JQL 命中 X 票, 本次返回 Y 票`), NOT the full structured object.
 *
 *   CP-4287 (0.6.0): opt-in `include` rich fields — whitelist rejection
 *   with zero Jira calls, byte-identical default path, wire-level `comment`
 *   fetch, and issuelinks parity with jira_get.
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
import { search } from "../handlers/search.js";
import { get } from "../handlers/get.js";

const SAMPLE_ISSUE = {
  key: "TEST-1",
  id: "10001",
  fields: {
    summary: "Find me",
    status: { name: "Open" },
    issuetype: { name: "Task" },
    labels: ["code"],
    created: "2026-06-15T10:00:00.000+0800",
    parent: { key: "TEST-0" },
  },
};

describe("search (CP-2384)", () => {
  beforeEach(() => {
    vi.mocked(jiraGet).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("AC-2384-S-1: default fields do NOT include issuelinks (CP-2384 dropped it)", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ issues: [] });

    await search({ jql: "project = TEST" });

    const callArgs = vi.mocked(jiraGet).mock.calls[0];
    const query = callArgs[2] as Record<string, string>;
    expect(query.fields).toBeDefined();
    expect(query.fields).not.toMatch(/\bissuelinks\b/);
    expect(query.fields).toMatch(/\bsummary\b/);
    expect(query.fields).toMatch(/\bstatus\b/);
    expect(query.fields).toMatch(/\bparent\b/);
  });

  it("AC-2384-S-2: caller-supplied fields list passes through (incl. issuelinks if asked)", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ issues: [] });

    await search({
      jql: "project = TEST",
      fields: ["summary", "issuelinks"],
    });

    const callArgs = vi.mocked(jiraGet).mock.calls[0];
    const query = callArgs[2] as Record<string, string>;
    expect(query.fields).toBe("summary,issuelinks");
  });

  it("AC-2384-S-3: happy path — issues[] with key/id/summary/status/issuetype/labels/created/parent", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      total: 1,
      startAt: 0,
      issues: [SAMPLE_ISSUE],
    });

    const result = await search({ jql: "project = TEST" });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(1);
    expect(parsed.total).toBe(1);
    expect(parsed.issues).toHaveLength(1);
    const i = parsed.issues[0];
    expect(i.key).toBe("TEST-1");
    expect(i.id).toBe("10001");
    expect(i.summary).toBe("Find me");
    expect(i.status).toBe("Open");
    expect(i.issuetype).toBe("Task");
    expect(i.labels).toEqual(["code"]);
    expect(i.created).toBe("2026-06-15T10:00:00.000+0800");
    expect(i.parent).toBe("TEST-0");
    // issuelinks absent at the surface (default fields dropped it).
    expect(i.issuelinks).toBeUndefined();
    // CP-2693 batch 1: details is a <100-char one-line summary string.
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/JQL 命中/);
    expect(details).toMatch(/本次返回/);
  });

  it("AC-2384-S-4: request echo reduced to {jql} only", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ issues: [] });

    const result = await search({
      jql: "project = TEST",
      maxResults: 5,
      fields: ["summary"],
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.request).toEqual({ jql: "project = TEST" });
    expect(parsed.request).not.toHaveProperty("maxResults");
    expect(parsed.request).not.toHaveProperty("fields");
  });

  it("AC-2384-S-5: rejects missing jql", async () => {
    const result = await search({});
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/jql/);
    expect(jiraGet).not.toHaveBeenCalled();
    // CP-2693 batch 1: validation error also has slim details.
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
  });

  it("AC-2384-S-6: rejects empty jql", async () => {
    const result = await search({ jql: "  " });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/jql/);
    expect(jiraGet).not.toHaveBeenCalled();
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
  });

  it("AC-2384-S-7: 410 upstream (deprecated /search) surfaces as error envelope", async () => {
    const { JiraHttpError } = await import("../http.js");
    vi.mocked(jiraGet).mockRejectedValueOnce(
      new JiraHttpError(410, "Gone", "deprecated"),
    );
    const result = await search({ jql: "project = TEST" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/jira\.search failed/);
    expect(parsed.error).toMatch(/HTTP 410/);
    // CP-2693 batch 1: HTTP error path also has slim details.
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
  });
});

/* ------------------------------------------------------------------ */
/* CP-4287 — opt-in include rich fields                                */
/* ------------------------------------------------------------------ */

const RICH_ISSUE = {
  key: "TEST-2",
  id: "10002",
  fields: {
    summary: "Rich one",
    status: {
      name: "进行中",
      statusCategory: { id: 4, key: "indeterminate", name: "进行中" },
    },
    issuetype: { name: "子任务" },
    labels: ["code"],
    created: "2026-10-01T09:00:00.000+0800",
    updated: "2026-11-06T02:30:00.000+0000",
    parent: { key: "TEST-0" },
    assignee: { displayName: "张三", accountId: "712020:abc", emailAddress: "z@x" },
    comment: {
      total: 7,
      comments: [{ id: "1" }, { id: "2" }],
    },
    issuelinks: [
      {
        type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
        outwardIssue: {
          key: "TEST-3",
          fields: { status: { statusCategory: { name: "完成" } } },
        },
        inwardIssue: {
          key: "TEST-4",
          fields: { status: { statusCategory: { name: "待办" } } },
        },
      },
      {
        // Non-blocks link must be dropped by the shared parser.
        type: { name: "Relates", inward: "relates to", outward: "relates to" },
        outwardIssue: { key: "TEST-9", fields: {} },
      },
    ],
  },
};

describe("search include (CP-4287)", () => {
  beforeEach(() => {
    vi.mocked(jiraGet).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("AC-4287-1a: unknown include token is rejected with ZERO Jira calls", async () => {
    const result = await search({
      jql: "project = TEST",
      include: ["statusCategory", "commentTotal"],
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBeUndefined();
    expect(parsed.error).toMatch(/commentTotal/);
    expect(parsed.error).toMatch(/statusCategory/);
    expect(jiraGet).not.toHaveBeenCalled();
    expect(typeof result.details).toBe("string");
  });

  it("AC-4287-1b: non-array include is rejected with ZERO Jira calls", async () => {
    const result = await search({ jql: "project = TEST", include: "assignee" });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.error).toMatch(/include/);
    expect(jiraGet).not.toHaveBeenCalled();
  });

  it("AC-4287-1c: all five whitelisted tokens are accepted", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ issues: [] });
    const result = await search({
      jql: "project = TEST",
      include: ["statusCategory", "assignee", "updated", "commentCount", "issuelinks"],
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(true);
    expect(jiraGet).toHaveBeenCalledTimes(1);
  });

  it("AC-4287-2a: no include → row is byte-identical to v0.5.4 (8 keys, same order)", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ issues: [SAMPLE_ISSUE] });
    const result = await search({ jql: "project = TEST" });
    const parsed = JSON.parse(result.content[0].text as string);
    const row = parsed.issues[0];

    expect(Object.keys(row)).toEqual([
      "key",
      "id",
      "summary",
      "status",
      "issuetype",
      "labels",
      "created",
      "parent",
    ]);
    expect(JSON.stringify(row)).toBe(
      JSON.stringify({
        key: "TEST-1",
        id: "10001",
        summary: "Find me",
        status: "Open",
        issuetype: "Task",
        labels: ["code"],
        created: "2026-06-15T10:00:00.000+0800",
        parent: "TEST-0",
      }),
    );
  });

  it("AC-4287-2b: empty include array is a no-op (same 8 keys, unchanged wire fields)", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ issues: [SAMPLE_ISSUE] });
    const result = await search({ jql: "project = TEST", include: [] });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(Object.keys(parsed.issues[0])).toEqual([
      "key",
      "id",
      "summary",
      "status",
      "issuetype",
      "labels",
      "created",
      "parent",
    ]);
    const query = vi.mocked(jiraGet).mock.calls[0][2] as Record<string, string>;
    expect(query.fields).toBe("summary,status,issuetype,labels,created,parent");
  });

  it("AC-4287-3a: rich values are read from the real Jira fields (contract fixture)", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ total: 1, issues: [RICH_ISSUE] });
    const result = await search({
      jql: "project = TEST",
      include: ["statusCategory", "assignee", "updated", "commentCount", "issuelinks"],
    });
    const parsed = JSON.parse(result.content[0].text as string);
    const row = parsed.issues[0];

    expect(row.statusCategory).toBe("indeterminate");
    expect(row.assignee).toEqual({
      displayName: "张三",
      accountId: "712020:abc",
    });
    expect(row.updated).toBe("2026-11-06T02:30:00.000+0000");
    expect(row.commentCount).toBe(7); // comment.total wins over comments.length
    expect(row.issuelinks).toEqual({
      blocks: [{ key: "TEST-3", statusCategory: "完成" }],
      blockedBy: [{ key: "TEST-4", statusCategory: "待办" }],
    });
    // Order contract: rich keys follow `parent`, in whitelist order.
    expect(Object.keys(row)).toEqual([
      "key",
      "id",
      "summary",
      "status",
      "issuetype",
      "labels",
      "created",
      "parent",
      "statusCategory",
      "assignee",
      "updated",
      "commentCount",
      "issuelinks",
    ]);
  });

  it("AC-4287-3b: statusCategory missing → \"\", assignee unassigned → null, commentCount falls back to comments.length", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      issues: [
        {
          key: "TEST-5",
          id: "10005",
          fields: {
            summary: "No extras",
            status: { name: "Open" },
            issuetype: { name: "Task" },
            labels: [],
            created: "2026-10-01T09:00:00.000+0800",
            comment: { comments: [{ id: "1" }, { id: "2" }, { id: "3" }] },
          },
        },
      ],
    });
    const result = await search({
      jql: "project = TEST",
      include: ["statusCategory", "assignee", "commentCount"],
    });
    const row = JSON.parse(result.content[0].text as string).issues[0];

    expect(row.statusCategory).toBe("");
    expect(row.assignee).toBeNull();
    expect(row.commentCount).toBe(3);
  });

  it("AC-4287-3c: commentCount with no comment object → 0", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ issues: [SAMPLE_ISSUE] });
    const result = await search({ jql: "project = TEST", include: ["commentCount"] });
    const row = JSON.parse(result.content[0].text as string).issues[0];
    expect(row.commentCount).toBe(0);
  });

  it("AC-4287-3d: include tokens are merged into the server-side fields (comment really fetched)", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ issues: [] });
    await search({
      jql: "project = TEST",
      include: ["statusCategory", "commentCount", "issuelinks"],
    });
    const query = vi.mocked(jiraGet).mock.calls[0][2] as Record<string, string>;
    expect(query.fields.split(",")).toEqual([
      "summary",
      "status",
      "issuetype",
      "labels",
      "created",
      "parent",
      "comment",
      "issuelinks",
    ]);
    expect(query.fields).not.toMatch(/status,status/);
  });

  it("AC-4287-3e: include unions with an explicit fields list (no duplicates)", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ issues: [] });
    await search({
      jql: "project = TEST",
      fields: ["summary", "status"],
      include: ["commentCount", "statusCategory"],
    });
    const query = vi.mocked(jiraGet).mock.calls[0][2] as Record<string, string>;
    expect(query.fields).toBe("summary,status,comment");
  });

  it("AC-4287-4: issuelinks is the same compact shape (and same parser) as jira_get", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ total: 1, issues: [RICH_ISSUE] });
    const searchResult = await search({
      jql: "project = TEST",
      include: ["issuelinks"],
    });
    const searchLinks = JSON.parse(searchResult.content[0].text as string).issues[0]
      .issuelinks;

    vi.mocked(jiraGet).mockResolvedValueOnce(RICH_ISSUE);
    const getResult = await get({ issueIdOrKey: "TEST-2" });
    const getLinks = JSON.parse(getResult.content[0].text as string).issue.issuelinks;

    expect(searchLinks).toEqual(getLinks);
    expect(Object.keys(searchLinks)).toEqual(["blocks", "blockedBy"]);
  });

  it("AC-4287-2c: requesting one token adds exactly one key", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ issues: [RICH_ISSUE] });
    const result = await search({ jql: "project = TEST", include: ["updated"] });
    const row = JSON.parse(result.content[0].text as string).issues[0];

    expect(Object.keys(row)).toHaveLength(9);
    expect(row.updated).toBe("2026-11-06T02:30:00.000+0000");
    expect(row.statusCategory).toBeUndefined();
    expect(row.assignee).toBeUndefined();
    expect(row.commentCount).toBeUndefined();
    expect(row.issuelinks).toBeUndefined();
  });
});
