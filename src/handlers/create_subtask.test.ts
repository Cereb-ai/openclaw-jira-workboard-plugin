/**
 * create_subtask handler tests — CP-2384 AC2 (request echo strip to
 * {parent, summary, labels}), AC4 (issue.id/key/self + blockPlan +
 * block_errors preserved), AC6 (反断言 block feedback NOT stripped).
 *
 * Coverage:
 *   - Happy path: POST /issue returns id/key/self; issue/summary carry
 *     the new ticket identifiers; block feedback preserved.
 *   - Request echo strip: only {parent, summary, labels} remain (NO full
 *     `fields` ADF description).
 *   - block blockPlan + block_errors surface untouched.
 *   - Validation: missing parent/project/summary/requirements/scope/
 *     acceptance_criteria/labels — each returns a clear error and POST is
 *     never called.
 *   - Upstream HTTP errors surface as error envelopes.
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

// Mock the block module so create_subtask doesn't try to actually POST
// /issueLink during tests.
vi.mock("../handlers/block.js", () => ({
  block: vi.fn(async () => ({
    content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    details: { ok: true },
  })),
}));

import { jiraPost } from "../http.js";
import { createSubtask } from "../handlers/create_subtask.js";
import { block } from "../handlers/block.js";

const BASE_INPUT = {
  project: "TEST",
  parent: "TEST-1",
  summary: "subtask summary",
  requirements: "do X",
  scope: "✅ 负责\n- impl",
  acceptance_criteria: "AC1: ...\nAC2: ...",
  labels: ["code"],
} as const;

describe("create_subtask (CP-2384)", () => {
  beforeEach(() => {
    vi.mocked(jiraPost).mockReset();
    vi.mocked(block).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("AC-2384-CS-1: happy path — issue.id/key/self + summary + block feedback preserved (CP-2384 AC4)", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({
      id: "10042",
      key: "TEST-2",
      self: "https://example.atlassian.net/rest/api/3/issue/10042",
    });
    // block is mocked to return ok; track invocation.
    const result = await createSubtask({
      ...BASE_INPUT,
      block: { blocks: ["TEST-3"], blockedBy: ["TEST-4"] },
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(true);
    // Result feedback NOT stripped.
    expect(parsed.issue).toEqual({
      id: "10042",
      key: "TEST-2",
      self: "https://example.atlassian.net/rest/api/3/issue/10042",
    });
    expect(parsed.summary).toEqual({
      key: "TEST-2",
      id: "10042",
      url: "https://example.atlassian.net/rest/api/3/issue/10042",
      parent: "TEST-1",
    });
    // block plan preserved.
    expect(parsed.block).toEqual([
      { direction: "blocks", keys: ["TEST-3"] },
      { direction: "blockedBy", keys: ["TEST-4"] },
    ]);
    expect(parsed.block_errors).toBeUndefined();
    // block() called twice (one per direction).
    expect(block).toHaveBeenCalledTimes(2);
  });

  it("AC-2384-CS-2: request echo reduced to {parent, summary, labels} (CP-2384 AC2)", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({
      id: "10043",
      key: "TEST-5",
      self: "url",
    });
    const result = await createSubtask(BASE_INPUT);
    const parsed = JSON.parse(result.content[0].text as string);

    // Echo only the key-class identifiers — NOT the full `fields` ADF
    // description (which would be the entire requirements + scope +
    // acceptance_criteria text, exactly the bit we're trying to shrink).
    expect(parsed.request).toEqual({
      parent: "TEST-1",
      summary: "subtask summary",
      labels: ["code"],
    });
    expect(parsed.request).not.toHaveProperty("fields");
    expect(parsed.request).not.toHaveProperty("project");
    expect(parsed.request).not.toHaveProperty("requirements");
    expect(parsed.request).not.toHaveProperty("scope");
    expect(parsed.request).not.toHaveProperty("acceptance_criteria");
  });

  it("AC-2384-CS-3: POST /issue receives the full `fields` ADF description (internal contract unchanged)", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({
      id: "10044",
      key: "TEST-6",
      self: "url",
    });
    await createSubtask(BASE_INPUT);

    expect(jiraPost).toHaveBeenCalledTimes(1);
    const [cfg, path, body] = vi.mocked(jiraPost).mock.calls[0];
    expect(path).toBe("issue");
    const fields = (body as { fields: Record<string, unknown> }).fields;
    // Server-side still gets the rendered ADF description (requirements +
    // scope + acceptance_criteria wrapped into the standard 3 sections).
    expect(fields.summary).toBe("subtask summary");
    const desc = fields.description as {
      type: string;
      content: Array<{ type: string }>;
    };
    expect(desc.type).toBe("doc");
    // Internal ADF contract NOT touched by CP-2384 (echo strip is response-only).
    expect(Array.isArray(desc.content)).toBe(true);
  });

  it("AC-2384-CS-4: block_errors surface when block() returns ok:false (CP-2384 反断言 — block feedback NOT stripped)", async () => {
    // Override the mock for THIS test only.
    vi.mocked(jiraPost).mockResolvedValueOnce({
      id: "10045",
      key: "TEST-7",
      self: "url",
    });
    vi.mocked(block).mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ ok: false }) }],
      details: { ok: false, error: "no perms" },
    } as never);

    const result = await createSubtask({
      ...BASE_INPUT,
      block: { blocks: ["TEST-3"] },
    });
    const parsed = JSON.parse(result.content[0].text as string);

    // block_errors preserved.
    expect(parsed.block_errors).toBeDefined();
    expect(parsed.block_errors[0]).toMatch(/no perms/);
  });

  it("AC-2384-CS-5: rejects missing project", async () => {
    const result = await createSubtask({ ...BASE_INPUT, project: "" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/project/);
    expect(jiraPost).not.toHaveBeenCalled();
  });

  it("AC-2384-CS-6: rejects missing labels", async () => {
    const result = await createSubtask({ ...BASE_INPUT, labels: [] });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/labels/);
    expect(jiraPost).not.toHaveBeenCalled();
  });

  it("AC-2384-CS-7: rejects missing requirements / scope / acceptance_criteria", async () => {
    for (const field of ["requirements", "scope", "acceptance_criteria"]) {
      const input = { ...BASE_INPUT } as Record<string, unknown>;
      input[field] = "";
      const result = await createSubtask(input);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.error).toMatch(new RegExp(field));
      expect(jiraPost).not.toHaveBeenCalled();
      vi.mocked(jiraPost).mockReset();
    }
  });

  it("AC-2384-CS-8: 401 upstream surfaces as error envelope", async () => {
    const { JiraHttpError } = await import("../http.js");
    vi.mocked(jiraPost).mockRejectedValueOnce(
      new JiraHttpError(401, "Unauthorized", "bad token"),
    );
    const result = await createSubtask(BASE_INPUT);
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/jira\.create_subtask failed/);
    expect(parsed.error).toMatch(/HTTP 401/);
  });

  it("AC-2384-CS-9: happy path WITHOUT `block` arg skips block()", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({
      id: "10046",
      key: "TEST-8",
      self: "url",
    });
    const result = await createSubtask(BASE_INPUT);
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.block).toBeUndefined();
    expect(parsed.block_errors).toBeUndefined();
    expect(block).not.toHaveBeenCalled();
  });
});
