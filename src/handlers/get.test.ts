/**
 * get handler tests — server-side fields whitelist (SSSS-401, SSSS-404 R2).
 *
 * Coverage:
 *   - Default behavior: `fields` query param uses DEFAULT_FIELDS whitelist
 *     (excludes `comment`/`worklog` to save context; includes 12 fields
 *     per SSSS-401 AC1 / SSSS-404 AC2).
 *   - Empty `fields: []` → same default whitelist.
 *   - `fields: ['*all']` → no `fields` query param at all (full payload).
 *   - `fields: ['customfield_10019']` → passes through verbatim.
 *   - 404 upstream surfaces as error envelope.
 *   - SSSS-404 R2: DEFAULT_FIELDS has exactly 12 items including issuelinks.
 *
 * The formatter itself is unchanged — we still surface summary/status/
 * issuetype/priority/labels/assignee/reporter/created/updated/parent/
 * description/issuelinks + the full fields dict (back-compat). The
 * savings happen upstream at the Atlassian query string.
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

  it("AC-401-G-5: response shape unchanged (curated keys + description + fields dict)", async () => {
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

  it("AC-404-G-7: DEFAULT_FIELDS has exactly 12 items including issuelinks (SSSS-404 R2)", async () => {
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

  it("AC-404-G-8: response surfaces issuelinks array verbatim", async () => {
    const issueWithLinks = {
      ...SAMPLE_ISSUE,
      fields: {
        ...SAMPLE_ISSUE.fields,
        issuelinks: [
          {
            id: "10001",
            type: { name: "blocks", inward: "is blocked by", outward: "blocks" },
            outwardIssue: { key: "TEST-2", fields: { summary: "downstream" } },
          },
        ],
      },
    };
    vi.mocked(jiraGet).mockResolvedValueOnce(issueWithLinks);

    const result = await get({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.issue.issuelinks).toHaveLength(1);
    expect(parsed.issue.issuelinks[0].outwardIssue.key).toBe("TEST-2");
  });
});