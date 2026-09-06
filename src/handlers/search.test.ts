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
