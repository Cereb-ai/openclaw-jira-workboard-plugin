/**
 * CP-3751 — parameter normalization across the jira tool surface.
 *
 * RED-phase reproduction tests (written before the fix):
 *   - `jira_get_comment` with a NUMBER `commentId` was rejected by the
 *     handler's hand-written `typeof !== "string"` check.
 *   - `jira_list_comments` with a numeric-STRING `maxResults` / `startAt`
 *     was rejected by the `typeof !== "number"` check.
 *   - `jira_list_comments` with `maxResults: 500` returned a hard "capped
 *     at 100" ERROR instead of clamping to 100.
 *   - array parameters (`fields` / `mentionAccountIds` / `labels` /
 *     `block.blocks` / `block.blockedBy`) silently DROPPED numeric members
 *     (`.filter((x) => typeof x === "string")`), so a caller asking for
 *     `fields: [10019]` got a request with the wrong field set.
 *
 * GREEN-phase contract (also asserted here):
 *   - content fields (body / summary) stay STRICT: an object or array is
 *     rejected, never silently `String()`-ed.
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
      defaultAssigneeAccountId: "acc-default",
    }),
  };
});

import { jiraGet, jiraPost } from "../http.js";
import { getComment } from "./get_comment.js";
import { listComments } from "./list_comments.js";
import { search } from "./search.js";
import { get } from "./get.js";
import { comment } from "./comment.js";
import { createTask } from "./create_task.js";
import { createSubtask } from "./create_subtask.js";

const SAMPLE_ADF = {
  version: 1,
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Hello from the comment body." }],
    },
  ],
};

const COMMENT_FIXTURE = {
  id: "10042",
  author: { displayName: "Dave", accountId: "acc-3" },
  created: "2026-06-20T08:30:00.000+0800",
  updated: "2026-06-20T08:30:00.000+0800",
  body: SAMPLE_ADF,
};

function parsed(result: { content: { type: "text"; text: string }[] }): Record<string, any> {
  return JSON.parse(result.content[0].text as string);
}

describe("CP-3751 — ID class parameters accept string | number", () => {
  beforeEach(() => {
    vi.mocked(jiraGet).mockReset();
    vi.mocked(jiraPost).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("AC-3751-1: jira_get_comment with a NUMBER commentId returns ok=true and the same body as the string form", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce(COMMENT_FIXTURE);

    const numeric = await getComment({
      issueIdOrKey: "TEST-1",
      commentId: 10042,
    });
    const numericParsed = parsed(numeric);

    expect(numericParsed.ok).toBe(true);
    // The REST path must carry the NORMALIZED string id.
    expect(vi.mocked(jiraGet).mock.calls[0][1]).toBe("issue/TEST-1/comment/10042");
    // The echoed request must also carry the normalized string id.
    expect(numericParsed.request.commentId).toBe("10042");
    expect(numericParsed.comment.body).toBe("Hello from the comment body.");

    vi.mocked(jiraGet).mockResolvedValueOnce(COMMENT_FIXTURE);
    const asString = await getComment({
      issueIdOrKey: "TEST-1",
      commentId: "10042",
    });
    const stringParsed = parsed(asString);

    // Byte-for-byte identical payload for the number vs the string form.
    expect(JSON.stringify(numericParsed)).toBe(JSON.stringify(stringParsed));
  });

  it("AC-3751-2: jira_get_comment rejects an illegal commentId type (object / array / null)", async () => {
    for (const bad of [{ a: 1 }, [1], null]) {
      const result = await getComment({ issueIdOrKey: "TEST-1", commentId: bad });
      const p = parsed(result);
      expect(p.error).toMatch(/commentId/);
    }
    expect(jiraGet).not.toHaveBeenCalled();
  });

  it("AC-3751-3: issueIdOrKey accepts a number (numeric ticket id) on jira_get", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ key: "TEST-1", fields: {} });

    const result = await get({ issueIdOrKey: 24180 });
    const p = parsed(result);

    expect(p.ok).toBe(true);
    expect(vi.mocked(jiraGet).mock.calls[0][1]).toBe("issue/24180");
    expect(p.request.issueIdOrKey).toBe("24180");
  });

  it("AC-3751-4: a padded string id is trimmed before the REST call", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce(COMMENT_FIXTURE);

    const result = await getComment({
      issueIdOrKey: "  TEST-1  ",
      commentId: "  10042  ",
    });

    expect(vi.mocked(jiraGet).mock.calls[0][1]).toBe("issue/TEST-1/comment/10042");
  });
});

describe("CP-3751 — pagination parameters accept number | numeric string and clamp", () => {
  beforeEach(() => {
    vi.mocked(jiraGet).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("AC-3751-5: jira_list_comments with maxResults as a numeric STRING reaches the REST layer as the integer 20", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ total: 0, comments: [] });

    const result = await listComments({
      issueIdOrKey: "TEST-1",
      maxResults: "20",
    });
    const p = parsed(result);

    expect(p.ok).toBe(true);
    expect(vi.mocked(jiraGet).mock.calls[0][2]).toMatchObject({ maxResults: 20 });
  });

  it("AC-3751-6: jira_list_comments with startAt as a numeric STRING reaches the REST layer as the integer 0", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ total: 0, comments: [] });

    const result = await listComments({
      issueIdOrKey: "TEST-1",
      startAt: "0",
    });
    const p = parsed(result);

    expect(p.ok).toBe(true);
    expect(vi.mocked(jiraGet).mock.calls[0][2]).toMatchObject({ startAt: 0 });
  });

  it("AC-3751-7: maxResults 500 is CLAMPED to 100 (no capped-error), ok=true, effective value visible", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ total: 0, comments: [] });

    const result = await listComments({
      issueIdOrKey: "TEST-1",
      maxResults: 500,
    });
    const p = parsed(result);

    expect(p.ok).toBe(true);
    expect(p.error).toBeUndefined();
    // Clamped, not rejected.
    expect(vi.mocked(jiraGet).mock.calls[0][2]).toMatchObject({ maxResults: 100 });
    // The effective value must be visible in the response envelope.
    expect(JSON.stringify(p)).toContain("100");
  });

  it("AC-3751-8: maxResults as an out-of-range numeric STRING is clamped too", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ total: 0, comments: [] });

    const result = await listComments({
      issueIdOrKey: "TEST-1",
      maxResults: "500",
    });
    const p = parsed(result);

    expect(p.ok).toBe(true);
    expect(vi.mocked(jiraGet).mock.calls[0][2]).toMatchObject({ maxResults: 100 });
  });

  it("AC-3751-9: non-integer / negative pagination values are still rejected", async () => {
    const tooSmall = parsed(
      await listComments({ issueIdOrKey: "TEST-1", maxResults: 0 }),
    );
    expect(tooSmall.error).toMatch(/maxResults/);

    const notInteger = parsed(
      await listComments({ issueIdOrKey: "TEST-1", startAt: 2.5 }),
    );
    expect(notInteger.error).toMatch(/startAt/);

    const negative = parsed(
      await listComments({ issueIdOrKey: "TEST-1", startAt: -1 }),
    );
    expect(negative.error).toMatch(/startAt/);

    const garbage = parsed(
      await listComments({ issueIdOrKey: "TEST-1", maxResults: "abc" }),
    );
    expect(garbage.error).toMatch(/maxResults/);

    expect(jiraGet).not.toHaveBeenCalled();
  });

  it("AC-3751-10: jira_search accepts a numeric-string maxResults", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ issues: [] });

    const result = await search({ jql: "project = TEST", maxResults: "5" });
    const p = parsed(result);

    expect(p.ok).toBe(true);
    expect(vi.mocked(jiraGet).mock.calls[0][2]).toMatchObject({ maxResults: 5 });
  });
});

describe("CP-3751 — array members accept string | number", () => {
  beforeEach(() => {
    vi.mocked(jiraGet).mockReset();
    vi.mocked(jiraPost).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("AC-3751-11: jira_get with fields: [10019] normalizes to the string '10019'", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ key: "TEST-1", fields: {} });

    const result = await get({ issueIdOrKey: "TEST-1", fields: [10019] });

    expect(vi.mocked(jiraGet).mock.calls[0][2]).toMatchObject({
      fields: "10019",
    });
  });

  it("AC-3751-12: jira_search with numeric fields members normalizes them", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ issues: [] });

    const result = await search({ jql: "project = TEST", fields: [10019, "status"] });

    expect(vi.mocked(jiraGet).mock.calls[0][2]).toMatchObject({
      fields: "10019,status",
    });
  });

  it("AC-3751-13: jira_comment with mentionAccountIds: [712020] normalizes to a string array", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({
      id: "22475",
      self: "https://example/comment/22475",
      created: "2026-06-20T08:30:00.000+0800",
    });

    const result = await comment({
      issueIdOrKey: "TEST-1",
      body: "hello",
      mentionAccountIds: [712020],
    });
    const p = parsed(result);

    expect(p.ok).toBe(true);
    expect(p.request.mentions).toEqual(["712020"]);
    // The ADF mention node must carry the normalized string id.
    const body = vi.mocked(jiraPost).mock.calls[0][2] as {
      body: { content: { content: { type: string; attrs?: { id: string } }[] }[] };
    };
    const mentionNode = body.body.content[0].content.find(
      (n) => n.type === "mention",
    );
    expect(mentionNode?.attrs?.id).toBe("712020");
  });

  it("AC-3751-14: jira_create_task with labels: [3740] normalizes to a string array", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({
      id: "1",
      key: "TEST-9",
      self: "https://example/issue/TEST-9",
    });

    const result = await createTask({
      project: "TEST",
      summary: "a task",
      requirements: "why",
      scope: "负责: x",
      acceptance_criteria: "AC1: y",
      labels: [3740],
    });
    const p = parsed(result);

    expect(p.ok).toBe(true);
    expect(p.request.labels).toEqual(["plan", "3740"]);
    const fields = (vi.mocked(jiraPost).mock.calls[0][2] as {
      fields: { labels: string[] };
    }).fields;
    expect(fields.labels).toEqual(["plan", "3740"]);
  });

  it("AC-3751-15: jira_create_subtask with numeric labels normalizes to a string array", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({
      id: "1",
      key: "TEST-10",
      self: "https://example/issue/TEST-10",
    });

    const result = await createSubtask({
      project: "TEST",
      parent: "TEST-1",
      summary: "a subtask",
      requirements: "why",
      scope: "负责: x",
      acceptance_criteria: "AC1: y",
      labels: [1234],
    });
    const p = parsed(result);

    expect(p.ok).toBe(true);
    const fields = (vi.mocked(jiraPost).mock.calls[0][2] as {
      fields: { labels: string[] };
    }).fields;
    expect(fields.labels).toEqual(["1234"]);
  });

  it("AC-3751-16: block.blockedBy / block.blocks with numeric members normalize to strings", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({
      id: "1",
      key: "TEST-11",
      self: "https://example/issue/TEST-11",
    });

    const result = await createTask({
      project: "TEST",
      summary: "a task",
      requirements: "why",
      scope: "负责: x",
      acceptance_criteria: "AC1: y",
      block: { blockedBy: [3740], blocks: [] },
    });
    const p = parsed(result);

    expect(p.ok).toBe(true);
    expect(p.block).toEqual([{ direction: "blockedBy", keys: ["3740"] }]);
  });

  it("AC-3751-17: an illegal array member type is rejected with an actionable error", async () => {
    const result = await get({ issueIdOrKey: "TEST-1", fields: [{ a: 1 }] });
    const p = parsed(result);

    expect(p.error).toMatch(/fields/);
    expect(jiraGet).not.toHaveBeenCalled();
  });
});

describe("CP-3751 — content fields stay strict", () => {
  beforeEach(() => {
    vi.mocked(jiraPost).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("AC-3751-18: jira_comment rejects a non-string body (object / array) instead of String()-ing it", async () => {
    for (const bad of [{ a: 1 }, ["x"]]) {
      const result = await comment({ issueIdOrKey: "TEST-1", body: bad });
      const p = parsed(result);
      expect(p.error).toMatch(/body/);
      expect(p.ok).toBeUndefined();
    }
    expect(jiraPost).not.toHaveBeenCalled();
  });

  it("AC-3751-19: jira_create_task rejects a non-string summary (array / object)", async () => {
    for (const bad of [["x"], { a: 1 }]) {
      const result = await createTask({
        project: "TEST",
        summary: bad,
        requirements: "why",
        scope: "负责: x",
        acceptance_criteria: "AC1: y",
      });
      const p = parsed(result);
      expect(p.error).toMatch(/summary/);
    }
    expect(jiraPost).not.toHaveBeenCalled();
  });

  it("AC-3751-20: jira_create_task rejects non-string requirements / scope / acceptance_criteria", async () => {
    const base = {
      project: "TEST",
      summary: "a task",
      requirements: "why",
      scope: "负责: x",
      acceptance_criteria: "AC1: y",
    };
    for (const field of ["requirements", "scope", "acceptance_criteria"]) {
      const result = await createTask({
        ...base,
        [field]: { a: 1 },
      } as Record<string, unknown>);
      const p = parsed(result);
      expect(p.error).toMatch(new RegExp(field));
    }
    expect(jiraPost).not.toHaveBeenCalled();
  });
});
