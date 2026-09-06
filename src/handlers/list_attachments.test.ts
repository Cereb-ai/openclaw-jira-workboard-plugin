/**
 * list_attachments handler tests (CP-2700 batch 2 — new file).
 *
 * Coverage:
 *   - Happy path: full enumeration of attachments, compact field set,
 *     count == attachments.length, summary block REMOVED.
 *   - Compact field set: avatarUrls / active / timeZone / locale /
 *     accountType / emailAddress / self stripped from author; self /
 *     content / thumbnail present.
 *   - Empty attachments list renders short details + count=0 + [].
 *   - Validation: missing issueIdOrKey.
 *   - Upstream HTTP error path surfaces slim details.
 *   - no-cap semantics: returned array is the full list (no ATTACHMENT_CAP).
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
import { listAttachments } from "../handlers/list_attachments.js";

/**
 * Build a single fake attachment with the FULL Atlassian shape (including
 * fields the compact transform must strip). Mirrors the CP-2676 G7
 * evidence shape used by 批 1 reviewers.
 */
function makeAttachment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    self: "https://api.atlassian.com/.../attachment/100",
    id: "100",
    filename: "screenshot.png",
    size: 204800,
    mimeType: "image/png",
    created: "2026-09-01T10:00:00.000+0800",
    content: "https://api.media.atlassian.com/.../100",
    thumbnail: "https://api.atlassian.com/.../thumbnail/100",
    author: {
      self: "https://api.atlassian.com/.../user/u-1",
      accountId: "u-1",
      emailAddress: "agent@example.com",
      avatarUrls: {
        "48x48": "https://secure.gravatar.com/avatar/abc48",
        "24x24": "https://secure.gravatar.com/avatar/abc24",
        "16x16": "https://secure.gravatar.com/avatar/abc16",
        "32x32": "https://secure.gravatar.com/avatar/abc32",
      },
      displayName: "CerebPilot",
      active: true,
      timeZone: "Asia/Hong_Kong",
      locale: "en_US",
      accountType: "atlassian",
    },
    ...overrides,
  };
}

describe("list_attachments (CP-2700 batch 2)", () => {
  beforeEach(() => {
    vi.mocked(jiraGet).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("AC-2700-LA-1: happy path — attachments array returned with compact field set, summary block REMOVED", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      fields: { attachment: [makeAttachment()] },
    });

    const result = await listAttachments({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(true);
    expect(parsed.method).toBe("list_attachments");
    expect(parsed.request.issueIdOrKey).toBe("TEST-1");
    expect(parsed.count).toBe(1);
    expect(parsed.attachments).toHaveLength(1);

    const a = parsed.attachments[0];
    // Compact field set per v0.5 §list_attachments 草稿池 (对齐 get.ts
    // compactAttachment L109).
    expect(a).toEqual({
      id: "100",
      self: "https://api.atlassian.com/.../attachment/100",
      filename: "screenshot.png",
      size: 204800,
      mimeType: "image/png",
      created: "2026-09-01T10:00:00.000+0800",
      content: "https://api.media.atlassian.com/.../100",
      thumbnail: "https://api.atlassian.com/.../thumbnail/100",
      author: {
        displayName: "CerebPilot",
        accountId: "u-1",
      },
    });
    // Stripped author fields must NOT appear.
    expect(a.author).not.toHaveProperty("avatarUrls");
    expect(a.author).not.toHaveProperty("active");
    expect(a.author).not.toHaveProperty("timeZone");
    expect(a.author).not.toHaveProperty("locale");
    expect(a.author).not.toHaveProperty("accountType");
    expect(a.author).not.toHaveProperty("emailAddress");
    expect(a.author).not.toHaveProperty("self");

    // Summary block REMOVED (count == attachments.length == summary.attachmentCount
    // was 3-way duplication).
    expect(parsed).not.toHaveProperty("summary");
    expect(parsed).not.toHaveProperty("attachmentCount");
  });

  it("AC-2700-LA-1b: details = <100-char one-line semantic summary with count + total size", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      fields: {
        attachment: [
          makeAttachment({ id: "1", size: 1024 * 1024 }),
          makeAttachment({ id: "2", size: 1024 * 1024 * 2 }),
        ],
      },
    });

    const result = await listAttachments({ issueIdOrKey: "TEST-1" });
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/TEST-1 共 2 个附件/);
    expect(details).toMatch(/总大小 3\.0 MB/);
  });

  it("AC-2700-LA-2: empty attachments list renders short details + count=0 + []", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      fields: { attachment: [] },
    });

    const result = await listAttachments({ issueIdOrKey: "TEST-EMPTY" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.count).toBe(0);
    expect(parsed.attachments).toEqual([]);
    expect(parsed).not.toHaveProperty("summary");
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
    expect(result.details).toMatch(/TEST-EMPTY 无附件/);
  });

  it("AC-2700-LA-3: missing fields.attachment renders as empty list (no throw)", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({ fields: {} });

    const result = await listAttachments({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.count).toBe(0);
    expect(parsed.attachments).toEqual([]);
  });

  it("AC-2700-LA-4: no-cap semantics — returns full list (escape hatch from jira_get 5-cap)", async () => {
    // 12 attachments, well above the jira_get ATTACHMENT_CAP=5.
    const many = Array.from({ length: 12 }, (_, i) =>
      makeAttachment({ id: String(100 + i), filename: `f${i}.png` }),
    );
    vi.mocked(jiraGet).mockResolvedValueOnce({
      fields: { attachment: many },
    });

    const result = await listAttachments({ issueIdOrKey: "TEST-MANY" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.count).toBe(12);
    expect(parsed.attachments).toHaveLength(12);
    expect((result.details as string)).toMatch(/12 个附件/);
  });

  it("AC-2700-LA-5: rejects missing issueIdOrKey; error path has slim details", async () => {
    const result = await listAttachments({});
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/issueIdOrKey/);
    expect(jiraGet).not.toHaveBeenCalled();
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
    expect((result.details as string)).toMatch(/jira_list_attachments 失败/);
  });

  it("AC-2700-LA-6: 401 upstream surfaces as error envelope with slim details", async () => {
    const { JiraHttpError } = await import("../http.js");
    vi.mocked(jiraGet).mockRejectedValueOnce(
      new JiraHttpError(401, "Unauthorized", "bad token"),
    );

    const result = await listAttachments({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/HTTP 401/);
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/jira_list_attachments 失败/);
  });

  it("AC-2700-LA-7: count == attachments.length (regression guard against off-by-one)", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      fields: {
        attachment: [
          makeAttachment({ id: "1" }),
          makeAttachment({ id: "2" }),
          makeAttachment({ id: "3" }),
        ],
      },
    });

    const result = await listAttachments({ issueIdOrKey: "TEST-3" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.count).toBe(parsed.attachments.length);
    expect(parsed.count).toBe(3);
  });

  it("AC-2700-LA-8: NO file content in response — `content` field is URL only", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      fields: { attachment: [makeAttachment()] },
    });

    const result = await listAttachments({ issueIdOrKey: "TEST-1" });
    const parsed = JSON.parse(result.content[0].text as string);
    const a = parsed.attachments[0];
    // `content` is the download URL, NOT base64 / NOT bytes.
    expect(a.content).toMatch(/^https?:\/\//);
    expect(typeof a.content).toBe("string");
    expect(a).not.toHaveProperty("data");
    expect(a).not.toHaveProperty("base64");
    expect(a).not.toHaveProperty("bytes");
  });

  it("AC-2700-LA-9 (CP-2700 batch 2): details is NOT a duplication of full content payload", async () => {
    vi.mocked(jiraGet).mockResolvedValueOnce({
      fields: { attachment: [makeAttachment()] },
    });

    const result = await listAttachments({ issueIdOrKey: "TEST-1" });
    expect(typeof result.details).toBe("string");
    // The compact summary string must not be the full structured object.
    expect(result.details).not.toEqual(JSON.parse(result.content[0].text as string));
  });
});
