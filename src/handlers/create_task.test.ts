/**
 * create_task handler tests — CP-2384 AC2 (request echo strip — incomplete
 * pre-batch-1, only request: {fields} was deferred to CP-2693 batch 1), AC4
 * (issue.id/key/self + blockPlan + block_errors preserved), AC6 (反断言 block
 * feedback NOT stripped).
 *
 * CP-2693 batch 1 (v0.5 提案 RRmzJTZ7Q8 §8 create_task 条目):
 *   - `request: {fields}` 全量回声去除 (12 工具单点最大冗余 — 含
 *     buildTaskDescription 生成的 ADF description 1-3KB+). 与 create_subtask
 *     同构 (a89b512 L186-190), 只留 key 类 project/summary/labels.
 *   - `summary{key,id,url}` 块去除 (issue{id,key,self} 已覆盖).
 *   - `block` / `block_errors` 结果反馈完整保留 (CP-2384 反断言).
 *   - `details` = <100-char one-line summary string.
 *
 * Coverage:
 *   - Happy path: POST /issue returns id/key/self; issue carries the new
 *     ticket identifiers; block feedback preserved; request echo is
 *     {project, summary, labels} only (NOT full fields ADF description).
 *   - request.fields NOT echoed in response (12 工具单点最大冗余去除).
 *   - summary block REMOVED (issue{key,id,self} covers it).
 *   - block blockPlan + block_errors surface untouched.
 *   - Validation: missing project/summary/requirements/scope/
 *     acceptance_criteria — each returns a clear error and POST is never
 *     called.
 *   - requirements > 600 chars rejects + sanity-check (AC 内容混入 detects).
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

// Mock the block module so create_task doesn't try to actually POST
// /issueLink during tests.
vi.mock("../handlers/block.js", () => ({
  block: vi.fn(async () => ({
    content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    details: { ok: true },
  })),
}));

import { jiraPost } from "../http.js";
import { createTask } from "../handlers/create_task.js";
import { block } from "../handlers/block.js";

const BASE_INPUT = {
  project: "TEST",
  summary: "main task summary",
  requirements: "Why: test\n\n## What\n\n- step 1",
  scope: "✅ 负责\n- impl",
  acceptance_criteria: "AC1: ...\nAC2: ...",
} as const;

describe("create_task (CP-2384 + CP-2693 batch 1)", () => {
  beforeEach(() => {
    vi.mocked(jiraPost).mockReset();
    vi.mocked(block).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("AC-2693-CT-1: happy path — issue.id/key/self + block feedback preserved + request echo slimmed (CP-2693 batch 1)", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({
      id: "10042",
      key: "TEST-2",
      self: "https://example.atlassian.net/rest/api/3/issue/10042",
    });
    const result = await createTask({
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
    // CP-2693 batch 1: request echo reduced to {project, summary, labels}
    // (12 工具单点最大冗余去除: request:{fields} 含 buildTaskDescription
    // 生成的 ADF description 1-3KB+).
    expect(parsed.request).toEqual({
      project: "TEST",
      summary: "main task summary",
      labels: ["plan"],
    });
    expect(parsed.request).not.toHaveProperty("fields");
    // CP-2693 batch 1: summary block REMOVED (issue{key,id,self} 覆盖).
    expect(parsed).not.toHaveProperty("summary");
    // block plan preserved.
    expect(parsed.block).toEqual([
      { direction: "blocks", keys: ["TEST-3"] },
      { direction: "blockedBy", keys: ["TEST-4"] },
    ]);
    expect(parsed.block_errors).toBeUndefined();
    // block() called twice (one per direction).
    expect(block).toHaveBeenCalledTimes(2);
    // CP-2693 batch 1: details = <100-char one-line summary string.
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/TEST-2/);
    expect(details).toMatch(/主任务/);
  });

  it("AC-2693-CT-2: POST /issue receives the full `fields` ADF description (internal contract unchanged)", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({
      id: "10043",
      key: "TEST-5",
      self: "url",
    });
    await createTask(BASE_INPUT);

    expect(jiraPost).toHaveBeenCalledTimes(1);
    const [, path, body] = vi.mocked(jiraPost).mock.calls[0];
    expect(path).toBe("issue");
    const fields = (body as { fields: Record<string, unknown> }).fields;
    // Server-side still gets the rendered ADF description (requirements +
    // scope + acceptance_criteria wrapped into the standard 3 sections).
    expect(fields.summary).toBe("main task summary");
    expect(fields.project).toEqual({ key: "TEST" });
    expect(fields.issuetype).toEqual({ name: "Task" });
    const desc = fields.description as {
      type: string;
      content: Array<{ type: string }>;
    };
    expect(desc.type).toBe("doc");
    // Internal ADF contract NOT touched (echo strip is response-only).
    expect(Array.isArray(desc.content)).toBe(true);
  });

  it("AC-2693-CT-3: caller-supplied extra labels merged with auto 'plan' label", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({
      id: "10044",
      key: "TEST-6",
      self: "url",
    });
    const result = await createTask({ ...BASE_INPUT, labels: ["code", "urgent"] });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.request.labels).toEqual(["plan", "code", "urgent"]);
  });

  it("AC-2693-CT-4: block_errors surface when block() returns ok:false (CP-2384 反断言 — block feedback NOT stripped)", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({
      id: "10045",
      key: "TEST-7",
      self: "url",
    });
    vi.mocked(block).mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ ok: false }) }],
      details: { ok: false, error: "no perms" },
    } as never);

    const result = await createTask({
      ...BASE_INPUT,
      block: { blocks: ["TEST-3"] },
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.block_errors).toBeDefined();
    expect(parsed.block_errors[0]).toMatch(/no perms/);
  });

  it("AC-2693-CT-5: rejects missing project", async () => {
    const result = await createTask({ ...BASE_INPUT, project: "" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/project/);
    expect(jiraPost).not.toHaveBeenCalled();
    // CP-2693 batch 1: validation error also has slim details.
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
  });

  it("AC-2693-CT-6: rejects missing summary", async () => {
    const result = await createTask({ ...BASE_INPUT, summary: "" });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/summary/);
    expect(jiraPost).not.toHaveBeenCalled();
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
  });

  it("AC-2693-CT-7: rejects missing requirements / scope / acceptance_criteria", async () => {
    for (const field of ["requirements", "scope", "acceptance_criteria"]) {
      const input = { ...BASE_INPUT } as Record<string, unknown>;
      input[field] = "";
      const result = await createTask(input);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.error).toMatch(new RegExp(field));
      expect(jiraPost).not.toHaveBeenCalled();
      vi.mocked(jiraPost).mockReset();
    }
  });

  it("AC-2693-CT-8: rejects requirements > 600 chars (sanity-check粒度)", async () => {
    const result = await createTask({
      ...BASE_INPUT,
      requirements: "x".repeat(601),
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/requirements.*> 600/);
    expect(jiraPost).not.toHaveBeenCalled();
  });

  it("AC-2693-CT-9: rejects requirements 字段混入 AC/Scope 关键词", async () => {
    const result = await createTask({
      ...BASE_INPUT,
      requirements: "**断言** blah",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/AC 或 Scope 内容/);
    expect(jiraPost).not.toHaveBeenCalled();
  });

  it("AC-2693-CT-10: 401 upstream surfaces as error envelope", async () => {
    const { JiraHttpError } = await import("../http.js");
    vi.mocked(jiraPost).mockRejectedValueOnce(
      new JiraHttpError(401, "Unauthorized", "bad token"),
    );
    const result = await createTask(BASE_INPUT);
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/jira\.create_task failed/);
    expect(parsed.error).toMatch(/HTTP 401/);
    // CP-2693 batch 1: HTTP error path also has slim details.
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
  });

  it("AC-2693-CT-11: happy path WITHOUT `block` arg skips block()", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({
      id: "10046",
      key: "TEST-8",
      self: "url",
    });
    const result = await createTask(BASE_INPUT);
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.block).toBeUndefined();
    expect(parsed.block_errors).toBeUndefined();
    expect(block).not.toHaveBeenCalled();
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
  });
});