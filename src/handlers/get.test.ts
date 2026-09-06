/**
 * get handler tests — server-side fields whitelist (SSSS-401, SSSS-404 R2;
 * CP-2384; CP-2669 G2 description→plain text + G6 details summary).
 *
 * Coverage:
 *   - Default behavior: `fields` query param uses DEFAULT_FIELDS whitelist
 *     (excludes `comment`/`worklog` to save context; includes 13 fields
 *     per SSSS-401 AC1 / SSSS-404 AC2 / CP-2384).
 *   - Empty `fields: []` → same default whitelist.
 *   - `fields: ['*all']` → no `fields` query param at all (full payload).
 *   - `fields: ['customfield_10019']` → passes through verbatim.
 *   - 404 upstream surfaces as error envelope.
 *   - SSSS-404 R2: DEFAULT_FIELDS has exactly 13 items including issuelinks.
 *   - CP-2384 AC1: top-level `issue.issuelinks` is compact `{blocks,
 *     blockedBy}` (each item {key, statusCategory}), NOT the raw array
 *     with nested inwardIssue/outwardIssue objects.
 *   - CP-2391 AC1: non-blocks link types (Relates / Duplicate / Clones)
 *     are filtered out by `link.type.name === "Blocks"` guard before
 *     classification, so they cannot leak into either blocks or blockedBy
 *     (regression for the CP-2385 FAIL where Jira populated both
 *     inwardIssue + outwardIssue on bidirectional links).
 *   - CP-2669 G2: `issue.description` is plain text (adfToPlainText),
 *     NOT the raw ADF doc. null description → null. Empty ADF → "".
 *   - CP-2669 G6: `ToolResult.details` is a <100-char one-line summary
 *     string ("成功获取 <key>: <summary>, N 附件"), NOT the full
 *     structured object.
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
import { get } from "../handlers/get.js";

const SAMPLE_ISSUE = {
  key: "TEST-1",
  id: "10001",
  fields: {
    summary: "Test ticket",
    status: { name: "Open" },
    issuetype: { name: "Task" },
    priority: { name: "Medium" },
    labels: ["code"],
    assignee: { displayName: "Alice", accountId: "acc-1" },
    reporter: { displayName: "Bob", accountId: "acc-2" },
    created: "2026-06-15T10:00:00.000+0800",
    updated: "2026-06-15T10:00:00.000+0800",
    parent: { key: "TEST-0", fields: { summary: "Parent" } },
    description: {
      version: 1,
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "A description." }],
        },
      ],
    },
  },
};

describe("get default fields whitelist (SSSS-401)", () => {
  beforeEach(() => {
    vi.mocked(jiraGet).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("AC-401-G-1: no fields arg → query uses DEFAULT_FIELDS whitelist (excludes comment/worklog)", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce(SAMPLE_ISSUE);

    await get({ issueIdOrKey: "TEST-1" });

    expect(jiraGet).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(jiraGet).mock.calls[0];
    expect(callArgs[1]).toBe("issue/TEST-1");
    const query = callArgs[2] as Record<string, string>;
    // Whitelist excludes comment/worklog (the heaviest sub-resources).
    expect(query.fields).toBeDefined();
    expect(query.fields).not.toMatch(/\bcomment\b/);
    expect(query.fields).not.toMatch(/\bworklog\b/);
    // Whitelist includes the curated keys the formatter surfaces.
    expect(query.fields).toMatch(/\bsummary\b/);
    expect(query.fields).toMatch(/\bstatus\b/);
    expect(query.fields).toMatch(/\bdescription\b/);
    // SSSS-404 R2: issuelinks now part of the default whitelist.
    expect(query.fields).toMatch(/\bissuelinks\b/);
  });

  it("AC-401-G-2: empty fields:[] → same default whitelist", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce(SAMPLE_ISSUE);

    await get({ issueIdOrKey: "TEST-1", fields: [] });

    const callArgs = vi.mocked(jiraGet).mock.calls[0];
    const query = callArgs[2] as Record<string, string>;
    expect(query.fields).toBeDefined();
    expect(query.fields).not.toMatch(/\bcomment\b/);
  });

  it("AC-401-G-3: fields:['*all'] → no fields query param (full payload)", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce(SAMPLE_ISSUE);

    await get({ issueIdOrKey: "TEST-1", fields: ["*all"] });

    const callArgs = vi.mocked(jiraGet).mock.calls[0];
    const query = callArgs[2] as Record<string, string>;
    expect(query.fields).toBe("*all");
  });

  it("AC-401-G-4: fields:[customfield_10019] → passes through verbatim", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce(SAMPLE_ISSUE);

    await get({
      issueIdOrKey: "TEST-1",
      fields: ["customfield_10019"],
    });

    const callArgs = vi.mocked(jiraGet).mock.calls[0];
    const query = callArgs[2] as Record<string, string>;
    expect(query.fields).toBe("customfield_10019");
  });

  it("AC-401-G-5: response shape (curated keys + description + fields dict)", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce(SAMPLE_ISSUE);

    const result = await get({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(true);
    expect(parsed.issue.key).toBe("TEST-1");
    expect(parsed.issue.summary).toBe("Test ticket");
    expect(parsed.issue.status).toBe("Open");
    expect(parsed.issue.assignee).toBe("Alice");
    expect(parsed.issue.parent).toEqual({ key: "TEST-0", summary: "Parent" });
    expect(parsed.issue.description).toBeDefined();
    expect(parsed.issue.fields).toBeDefined();
  });

  it("AC-401-G-6: 404 upstream surfaces as error envelope", async () => {
    const { JiraHttpError } = await import("../http.js");
    vi.mocked(jiraGet).mockRejectedValueOnce(
      new JiraHttpError(404, "Not Found", "no such issue"),
    );

    const result = await get({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/HTTP 404/);
  });

  it("AC-404-G-7: DEFAULT_FIELDS has exactly 13 items including issuelinks (SSSS-404 R2)", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce(SAMPLE_ISSUE);

    await get({ issueIdOrKey: "TEST-1" });

    const callArgs = vi.mocked(jiraGet).mock.calls[0];
    const query = callArgs[2] as Record<string, string>;
    const fieldsList = query.fields.split(",");
    // AC2 reverse-assertion: exactly 13 fields, attachment + issuelinks included (0.5.0).
    expect(fieldsList).toHaveLength(13);
    expect(fieldsList).toContain("issuelinks");
    expect(fieldsList).toContain("attachment");
    expect(fieldsList).toContain("summary");
    expect(fieldsList).toContain("status");
    expect(fieldsList).toContain("description");
    expect(fieldsList).toContain("parent");
  });

  it("AC-404-G-8: response surfaces issuelinks as the compact {blocks, blockedBy} shape (CP-2384 AC1)", async () => {
    const issueWithLinks = {
      ...SAMPLE_ISSUE,
      fields: {
        ...SAMPLE_ISSUE.fields,
        issuelinks: [
          {
            id: "10001",
            type: { name: "blocks", inward: "is blocked by", outward: "blocks" },
            outwardIssue: {
              key: "TEST-2",
              fields: {
                summary: "downstream",
                status: { statusCategory: { name: "In Progress" } },
              },
            },
          },
          {
            id: "10002",
            type: { name: "blocks", inward: "is blocked by", outward: "blocks" },
            inwardIssue: {
              key: "TEST-3",
              fields: {
                summary: "upstream",
                status: { statusCategory: { name: "Done" } },
              },
            },
          },
        ],
      },
    };
    vi.mocked(jiraGet).mockResolvedValueOnce(issueWithLinks);

    const result = await get({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);

    const links = parsed.issue.issuelinks;
    // CP-2384 AC1: top-level issuelinks is the compact object, NOT a flat array.
    expect(Array.isArray(links)).toBe(false);
    expect(links).toHaveProperty("blocks");
    expect(links).toHaveProperty("blockedBy");
    // outwardIssue → blocks list
    expect(links.blocks).toHaveLength(1);
    expect(links.blocks[0]).toEqual({
      key: "TEST-2",
      statusCategory: "In Progress",
    });
    // inwardIssue → blockedBy list
    expect(links.blockedBy).toHaveLength(1);
    expect(links.blockedBy[0]).toEqual({
      key: "TEST-3",
      statusCategory: "Done",
    });
    // No raw inwardIssue/outwardIssue keys in the surface.
    for (const item of [...links.blocks, ...links.blockedBy]) {
      expect(item).not.toHaveProperty("outwardIssue");
      expect(item).not.toHaveProperty("inwardIssue");
    }
    // AC reverse: raw arrays still available under fields.issuelinks (callers
    // that pass fields:['*all'] and want the raw shape can drill in there).
    expect(parsed.issue.fields.issuelinks).toHaveLength(2);
  });

  // ---- CP-2384 AC1 (≤50 chars per link) + AC2 (request echo strip) ----

  it("AC-2384-G-9: every compact issuelinks entry serializes to ≤50 chars", async () => {
    // Realistic Jira keys (PROJECT-NN format, max ~12 chars). 20 links.
    const links = Array.from({ length: 20 }, (_, i) => ({
      id: String(10000 + i),
      type: { name: "blocks", inward: "is blocked by", outward: "blocks" },
      outwardIssue: {
        key: `LINK-${String(i).padStart(4, "0")}`,
        fields: {
          status: { statusCategory: { name: "In Progress" } },
        },
      },
    }));
    vi.mocked(jiraGet).mockResolvedValueOnce({
      ...SAMPLE_ISSUE,
      fields: { ...SAMPLE_ISSUE.fields, issuelinks: links },
    });

    const result = await get({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.issue.issuelinks.blocks).toHaveLength(20);
    // CP-2384 contract: each link JSON ≤ 50 chars (we strip the raw
    // inward/outward nested objects to keep the line tiny).
    for (const item of parsed.issue.issuelinks.blocks) {
      expect(JSON.stringify(item).length).toBeLessThanOrEqual(50);
    }
  });

  it("AC-2384-G-10: request echo is reduced to {issueIdOrKey} only (CP-2384 AC2)", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce(SAMPLE_ISSUE);

    const result = await get({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.request).toBeDefined();
    expect(parsed.request.issueIdOrKey).toBe("TEST-1");
    // CP-2384 dropped `fields` from request echo (it was just the query
    // string we sent upstream — redundant).
    expect(parsed.request).not.toHaveProperty("fields");
  });

  it("AC-2391-G-12: non-blocks links (Relates / Duplicate / Clones) are dropped, not duplicated (CP-2391 AC1)", async () => {
    // Reproduces the Jira Cloud shape that triggered CP-2385 FAIL: a
    // bidirectional Relates / Duplicate link populates BOTH inwardIssue
    // and outwardIssue. Before CP-2391, the formatter pushed that link
    // into both `blocks` AND `blockedBy`, polluting the dependency
    // topology that downstream orchestrators consume.
    const issueWithMixedLinks = {
      ...SAMPLE_ISSUE,
      fields: {
        ...SAMPLE_ISSUE.fields,
        issuelinks: [
          // Real Blocks link — should land in `blockedBy` (TEST-3 blocks us).
          {
            id: "20001",
            type: { name: "blocks", inward: "is blocked by", outward: "blocks" },
            inwardIssue: {
              key: "TEST-3",
              fields: {
                status: { statusCategory: { name: "Done" } },
              },
            },
          },
          // Jira-bidirectional Relates link with BOTH sides populated.
          // CP-2391: this must NOT appear in either list.
          {
            id: "20002",
            type: { name: "Relates", inward: "relates to", outward: "relates to" },
            inwardIssue: {
              key: "TEST-9",
              fields: {
                status: { statusCategory: { name: "In Progress" } },
              },
            },
            outwardIssue: {
              key: "TEST-10",
              fields: {
                status: { statusCategory: { name: "To Do" } },
              },
            },
          },
          // Jira-bidirectional Duplicate link with BOTH sides populated.
          // CP-2391: this must NOT appear in either list.
          {
            id: "20003",
            type: { name: "Duplicate", inward: "is duplicated by", outward: "duplicates" },
            inwardIssue: {
              key: "TEST-11",
              fields: {
                status: { statusCategory: { name: "Done" } },
              },
            },
            outwardIssue: {
              key: "TEST-12",
              fields: {
                status: { statusCategory: { name: "Done" } },
              },
            },
          },
          // Clones link — also a non-blocks type.
          {
            id: "20004",
            type: { name: "Clones", inward: "is cloned by", outward: "clones" },
            outwardIssue: {
              key: "TEST-13",
              fields: {
                status: { statusCategory: { name: "In Progress" } },
              },
            },
          },
        ],
      },
    };
    vi.mocked(jiraGet).mockResolvedValueOnce(issueWithMixedLinks);

    const result = await get({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);
    const links = parsed.issue.issuelinks;

    // Only the one real Blocks link should survive — neither Relates,
    // nor Duplicate, nor Clones should appear in either list.
    expect(links.blocks).toEqual([]);
    expect(links.blockedBy).toHaveLength(1);
    expect(links.blockedBy[0].key).toBe("TEST-3");

    // Cross-check: none of the discarded keys appears anywhere in the
    // compact surface (regardless of which list).
    const allKeys = [
      ...links.blocks.map((b: { key: string }) => b.key),
      ...links.blockedBy.map((b: { key: string }) => b.key),
    ];
    expect(allKeys).not.toContain("TEST-9");
    expect(allKeys).not.toContain("TEST-10");
    expect(allKeys).not.toContain("TEST-11");
    expect(allKeys).not.toContain("TEST-12");
    expect(allKeys).not.toContain("TEST-13");

    // Raw array is preserved under fields.issuelinks so callers that want
    // the unfiltered shape can still see the Relates / Duplicate links.
    expect(parsed.issue.fields.issuelinks).toHaveLength(4);
  });

  it("AC-2391-G-13: blocks link with BOTH inwardIssue and outwardIssue populated is kept exactly once (CP-2391 regression)", async () => {
    // Defensive: when a Blocks-type link itself happens to carry both
    // sides (Jira allows this), the formatter must keep both directions
    // distinctly (one in blocks, one in blockedBy) — not silently drop it.
    const issueWithBidirBlocks = {
      ...SAMPLE_ISSUE,
      fields: {
        ...SAMPLE_ISSUE.fields,
        issuelinks: [
          {
            id: "30001",
            type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
            outwardIssue: {
              key: "TEST-20",
              fields: {
                status: { statusCategory: { name: "In Progress" } },
              },
            },
            inwardIssue: {
              key: "TEST-21",
              fields: {
                status: { statusCategory: { name: "To Do" } },
              },
            },
          },
        ],
      },
    };
    vi.mocked(jiraGet).mockResolvedValueOnce(issueWithBidirBlocks);

    const result = await get({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);
    const links = parsed.issue.issuelinks;

    expect(links.blocks).toHaveLength(1);
    expect(links.blocks[0].key).toBe("TEST-20");
    expect(links.blockedBy).toHaveLength(1);
    expect(links.blockedBy[0].key).toBe("TEST-21");
  });

  it("AC-2384-G-11: error path retains the HTTP error envelope (CP-2384 反断言)", async () => {
    const { JiraHttpError } = await import("../http.js");
    vi.mocked(jiraGet).mockRejectedValueOnce(
      new JiraHttpError(403, "Forbidden", "no perms"),
    );

    const result = await get({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/jira\.get failed/);
    expect(parsed.error).toMatch(/HTTP 403/);
    expect(parsed.error).toMatch(/Forbidden/);
    // CP-2669 G6: error path has a slim details summary, not the
    // full envelope.
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
  });

  // ---- CP-2669 G2: description is plain text (not ADF doc) ----

  it("AC-2669-G-14: issue.description is plain text (adfToPlainText), NOT ADF doc", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce(SAMPLE_ISSUE);

    const result = await get({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);

    // Description is a plain string, not a doc object.
    expect(typeof parsed.issue.description).toBe("string");
    expect(parsed.issue.description).toBe("A description.");
    // The ADF `version` / `type` keys are gone from the top-level surface.
    expect(parsed.issue.description).not.toHaveProperty("version");
    expect(parsed.issue.description).not.toHaveProperty("type");
    expect(parsed.issue.description).not.toHaveProperty("content");
    // The raw ADF is still reachable under fields.description for callers
    // that need it (default whitelist already pulls the field server-side).
    expect(parsed.issue.fields.description).toHaveProperty("version");
    expect(parsed.issue.fields.description).toHaveProperty("type");
    expect(parsed.issue.fields.description).toHaveProperty("content");
  });

  it("AC-2669-G-15: null / missing description renders as null (no throw, no ADF default)", async () => {
    const issueNoDescription = {
      ...SAMPLE_ISSUE,
      fields: { ...SAMPLE_ISSUE.fields, description: null },
    };
    vi.mocked(jiraGet).mockResolvedValueOnce(issueNoDescription);

    const result = await get({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.issue.description).toBeNull();
    // No error path; ok flag stays true.
    expect(parsed.ok).toBe(true);
  });

  it("AC-2669-G-16: description with multiple ADF blocks renders as plain text with block separators", async () => {
    const issueMultiBlock = {
      ...SAMPLE_ISSUE,
      fields: {
        ...SAMPLE_ISSUE.fields,
        description: {
          version: 1,
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "First paragraph." }],
            },
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "bullet a" }],
                    },
                  ],
                },
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "bullet b" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    };
    vi.mocked(jiraGet).mockResolvedValueOnce(issueMultiBlock);

    const result = await get({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(typeof parsed.issue.description).toBe("string");
    expect(parsed.issue.description as string).toContain("First paragraph.");
    expect(parsed.issue.description as string).toContain("- bullet a");
    expect(parsed.issue.description as string).toContain("- bullet b");
  });

  // ---- CP-2669 G6: details is a short summary, not the full object ----

  it("AC-2669-G-17: details is a <100-char one-line summary, NOT the full structured object", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce(SAMPLE_ISSUE);

    const result = await get({ issueIdOrKey: "TEST-1" });

    expect(typeof result.details).toBe("string");
    const summary = result.details as string;
    expect(summary.length).toBeLessThan(100);
    // Must mention the ticket key + summary.
    expect(summary).toContain("TEST-1");
    expect(summary).toContain("Test ticket");
    // Must NOT contain the full structured payload keys (otherwise
    // we're back to the pre-CP-2669 details=content duplication).
    expect(summary).not.toContain("issuelinks");
    expect(summary).not.toContain("attachmentCount");
    expect(summary).not.toContain("\"ok\"");
    // Full payload is still in content[0].text.
    expect(result.content[0].text as string).toContain("issuelinks");
  });

  it("AC-2669-G-18: details mentions attachment count when attachments > 0", async () => {
    const issueWithAtts = {
      ...SAMPLE_ISSUE,
      fields: {
        ...SAMPLE_ISSUE.fields,
        attachment: [
          { id: "1", self: "u/1", filename: "a.png", size: 100, mimeType: "image/png", created: "2026-06-15T10:00:00.000+0800", content: "u/1/content", author: { displayName: "Bob", accountId: "acc-2" } },
          { id: "2", self: "u/2", filename: "b.png", size: 200, mimeType: "image/png", created: "2026-06-14T10:00:00.000+0800", content: "u/2/content", author: { displayName: "Bob", accountId: "acc-2" } },
        ],
      },
    };
    vi.mocked(jiraGet).mockResolvedValueOnce(issueWithAtts);

    const result = await get({ issueIdOrKey: "TEST-1" });
    const summary = result.details as string;
    expect(summary).toMatch(/2 附件/);
    expect(summary.length).toBeLessThan(100);
  });

  it("AC-2669-G-19: details omits the attachment segment when 0 attachments", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      ...SAMPLE_ISSUE,
      fields: { ...SAMPLE_ISSUE.fields, attachment: [] },
    });

    const result = await get({ issueIdOrKey: "TEST-1" });
    const summary = result.details as string;
    expect(summary).not.toMatch(/附件/);
    expect(summary.length).toBeLessThan(100);
  });
});
