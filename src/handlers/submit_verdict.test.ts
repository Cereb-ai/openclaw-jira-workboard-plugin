import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Hoist-friendly mocks: declare factories inline (vi.mock is hoisted
// to top of file before any module-level consts).
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

import { jiraGet, jiraPost, jiraPut } from "../http.js";
import { submitVerdict, findFailKeyword, checkVerdictConsistency } from "../handlers/submit_verdict.js";
import { JiraPluginError } from "../auth.js";

describe("submit_verdict FAIL escalation (SSSS-252)", () => {
  beforeEach(() => {
    vi.mocked(jiraGet).mockReset();
    vi.mocked(jiraPost).mockReset();
    vi.mocked(jiraPut).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("AC-252-1: verdict=FAIL with reason → comment + label + clear assignee", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" }); // comment
    vi.mocked(jiraPut).mockResolvedValueOnce({}); // add label
    vi.mocked(jiraPut).mockResolvedValueOnce({}); // clear assignee

    const result = await submitVerdict({
      issueIdOrKey: "TEST-1",
      verdict: "FAIL",
      summary: "tests failed",
      reason: "vitest timeout in integration",
    });

    expect(jiraPost).toHaveBeenCalledTimes(1);
    expect(jiraPut).toHaveBeenCalledTimes(2);
    // First PUT: label
    expect(vi.mocked(jiraPut).mock.calls[0][2]).toEqual({
      update: { labels: [{ add: "escalated" }] },
    });
    // Second PUT: clear assignee
    expect(vi.mocked(jiraPut).mock.calls[1][2]).toEqual({
      fields: { assignee: null },
    });
    const body = result.content[0].text as string;
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(true);
    expect(parsed.verdict).toBe("FAIL");
    expect(parsed.label).toBe("escalated");
    expect(parsed.assigneeCleared).toBe(true);
    // CP-2710 batch 3: summary 块去除, verdict 已统一在顶层
    expect(parsed).not.toHaveProperty("summary");
    expect(parsed.verdict).toBe("FAIL");
    // details <100 字符一句话语义摘要
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/TEST-1 已 FAIL/);
  });

  it("AC-252-2: verdict=FAIL with empty reason → throws JiraPluginError (no side effect)", async () => {
    await expect(
      submitVerdict({
        issueIdOrKey: "TEST-1",
        verdict: "FAIL",
        summary: "tests failed",
        reason: "",
      }),
    ).rejects.toThrow(JiraPluginError);

    await expect(
      submitVerdict({
        issueIdOrKey: "TEST-1",
        verdict: "FAIL",
        summary: "tests failed",
      }),
    ).rejects.toThrow(JiraPluginError);

    // No HTTP calls made before throw
    expect(jiraPost).not.toHaveBeenCalled();
    expect(jiraPut).not.toHaveBeenCalled();
  });

  it("AC-252-3: verdict=FAIL, label PUT fails → partial result with hint", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" }); // comment OK
    vi.mocked(jiraPut).mockRejectedValueOnce(new Error("label 500")); // label fails

    const result = await submitVerdict({
      issueIdOrKey: "TEST-1",
      verdict: "FAIL",
      summary: "tests failed",
      reason: "vitest timeout",
    });

    const body = result.content[0].text as string;
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.partial).toBe(true);
    expect(parsed.verdict).toBe("FAIL");
    expect(parsed.comment.id).toBe("c1");
    // The hint about retrying is embedded in the error message
    // (no separate hint field for FAIL partial — single error string).
    expect(parsed.error).toMatch(/retry/i);
    // CP-2710 batch 3: partial 结构 0 改动, 仅 details 摘要化
    expect(parsed).not.toHaveProperty("summary");
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/TEST-1 部分完成/);
  });

  it("AC-252-4: verdict=PASS still transitions (no FAIL handling kicks in)", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" }); // comment
    vi.mocked(jiraGet).mockResolvedValueOnce({
      transitions: [
        { id: "11", name: "Done", to: { name: "已完成", statusCategory: { id: 3, key: "done" } } },
      ],
    });
    vi.mocked(jiraPost).mockResolvedValueOnce({}); // transition execute

    const result = await submitVerdict({
      issueIdOrKey: "TEST-1",
      verdict: "PASS",
      summary: "all green",
      evidence: "vitest 110/110",
    });

    const body = result.content[0].text as string;
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(true);
    // CP-2710 batch 3: 顶层 verdict="PASS" 补齐, summary 块去除
    expect(parsed.verdict).toBe("PASS");
    expect(parsed.transition.to).toBe("已完成");
    expect(parsed.transition.toCategory).toBe("done");
    expect(parsed).not.toHaveProperty("summary");
    // details <100 字符一句话语义摘要
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/TEST-1 已 PASS/);
    // No label add PUT for PASS
    expect(jiraPut).not.toHaveBeenCalled();
  });

  it("AC-252-5: verdict=BLOCKED rejected (removed in 0.4.0)", async () => {
    const result = await submitVerdict({
      issueIdOrKey: "TEST-1",
      verdict: "BLOCKED",
      summary: "should be rejected",
    });
    const parsed = JSON.parse((result.content[0].text as string));
    expect(parsed.error).toMatch(/verdict.*one of/);
    expect(jiraPost).not.toHaveBeenCalled();
  });

  it("CP-2710-3: validation error path (missing verdict) carries slim details", async () => {
    const result = await submitVerdict({
      issueIdOrKey: "TEST-1",
      summary: "no verdict",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/verdict.*one of/);
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/jira_submit_verdict 失败/);
  });

  it("CP-2710-4: PASS partial (comment OK, transition execute fails) keeps partial structure + details summary", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" }); // comment
    vi.mocked(jiraGet).mockResolvedValueOnce({
      transitions: [
        { id: "11", name: "Done", to: { name: "已完成", statusCategory: { id: 3, key: "done" } } },
      ],
    });
    vi.mocked(jiraPost).mockRejectedValueOnce(new Error("transition 500")); // execute fails

    const result = await submitVerdict({
      issueIdOrKey: "TEST-1",
      verdict: "PASS",
      summary: "all green",
    });

    const body = result.content[0].text as string;
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.partial).toBe(true);
    // CP-2710 batch 3: PASS 分支 partial 也要带 verdict 字段
    expect(parsed.verdict).toBe("PASS");
    expect(parsed.comment.id).toBe("c1");
    expect(parsed).not.toHaveProperty("summary");
    // hint 文案完整保留 (CP-2710 红线 #28510)
    expect(parsed.hint).toMatch(/transition/);
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/TEST-1 部分完成/);
  });

  it("CP-2710-5: FAIL success no longer carries hint (CP-2710 草稿池: 语义冗余于 label 反馈)", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" }); // comment
    vi.mocked(jiraPut).mockResolvedValueOnce({}); // add label
    vi.mocked(jiraPut).mockResolvedValueOnce({}); // clear assignee

    const result = await submitVerdict({
      issueIdOrKey: "TEST-1",
      verdict: "FAIL",
      summary: "tests failed",
      reason: "vitest timeout",
    });

    const body = result.content[0].text as string;
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(true);
    expect(parsed.verdict).toBe("FAIL");
    expect(parsed.label).toBe("escalated");
    expect(parsed.assigneeCleared).toBe(true);
    // FAIL 成功路径不再有 hint (CP-2710 草稿池: 与 label 反馈语义冗余)
    expect(parsed).not.toHaveProperty("hint");
  });
});

// ─── CP-2805 / CP-2806: verdict ↔ summary consistency guard ──────────────────
// Plugin-layer hard enforcement of the CP-1918 FAIL keyword whitelist
// (mirror of agent-skills task-dispatcher/bin/verdict_guard.py). Rejects
// any submitVerdict call where summary contains a whitelisted FAIL
// keyword but verdict="PASS" — BEFORE any Jira write, with zero side
// effects. Tested both at the pure-helper level (findFailKeyword /
// checkVerdictConsistency) and at the submitVerdict integration level.

describe("findFailKeyword (pure helper, CP-1918 whitelist)", () => {
  it("returns literal 'FAIL' substring when present (case-sensitive)", () => {
    expect(findFailKeyword("CB build FAIL x2 mypy strict")).toBe("FAIL");
    expect(findFailKeyword("fail lower")).toBeNull();           // case-sensitive
    expect(findFailKeyword("FailureMode")).toBeNull();           // no boundary match
  });

  it("returns first whitelist match by list order (mirror CP-1918 Python semantics)", () => {
    // CP-1918: Python's find_fail_keyword returns the FIRST match in keyword
    // list order, NOT longest-match-first. "FAIL" is at index 0 in
    // FAIL_KEYWORDS, so it always wins when present (including inside the
    // longer CN phrases, since "门禁 FAIL" contains "FAIL" as substring).
    expect(findFailKeyword("前端 门禁 FAIL 后端 OK")).toBe("FAIL");
    expect(findFailKeyword("前置门禁不达成 FAIL")).toBe("FAIL");
    // when "FAIL" is absent but "门禁 FAIL" is present, "门禁 FAIL" wins
    expect(findFailKeyword("某 门禁 FAIL 复盘")).toBe("FAIL"); // "FAIL" still matches as substring
    // when "FAIL" and "门禁 FAIL" both absent, "前置门禁不达成" wins
    expect(findFailKeyword("发布 前置门禁不达成")).toBe("前置门禁不达成");
  });

  it("returns '前置门禁不达成' when present", () => {
    expect(findFailKeyword("本次发布 前置门禁不达成")).toBe("前置门禁不达成");
  });

  it("returns null for fuzzy words that are NOT on the whitelist", () => {
    expect(findFailKeyword("失败 了")).toBeNull();
    expect(findFailKeyword("未通过 review")).toBeNull();
    expect(findFailKeyword("fail 小写")).toBeNull();
    expect(findFailKeyword("Failure 大写首字母")).toBeNull();
  });

  it("returns null for empty / non-string input", () => {
    expect(findFailKeyword("")).toBeNull();
    // @ts-expect-error — guard against non-string callers
    expect(findFailKeyword(null)).toBeNull();
    // @ts-expect-error — guard against non-string callers
    expect(findFailKeyword(undefined)).toBeNull();
  });

  it("accepts custom keyword set (test-only injection)", () => {
    expect(findFailKeyword("trigger word here", ["trigger"])).toBe("trigger");
    expect(findFailKeyword("trigger word here", ["absent"])).toBeNull();
  });
});

describe("checkVerdictConsistency (pure helper, CP-1918 mirror)", () => {
  it("rejects: summary 含 FAIL keyword + verdict=PASS", () => {
    const r = checkVerdictConsistency("CB build FAIL x2", "PASS");
    expect(r).not.toBeNull();
    expect(r?.matched).toBe("FAIL");
    expect(r?.reason).toMatch(/FAIL/);
    expect(r?.reason).toMatch(/PASS/);
  });

  it("rejects: summary 含 '门禁 FAIL' + verdict=PASS", () => {
    // CP-1918 mirror: "FAIL" sits at whitelist index 0, so any "门禁 FAIL"
    // substring (which contains "FAIL") is reported as matched="FAIL".
    // The fact that "门禁 FAIL" is reachable at all is verified by the
    // AC-2805-2 integration test (rejection with 0 side effect).
    const r = checkVerdictConsistency("某 门禁 FAIL 复盘", "PASS");
    expect(r?.matched).toBe("FAIL"); // whitelist-order semantics
    // 小写 "门禁 fail" 不命中 (case-sensitive)
    expect(checkVerdictConsistency("某 门禁 fail 复盘", "PASS")).toBeNull();
  });

  it("rejects: summary 含 '前置门禁不达成' + verdict=PASS", () => {
    // "前置门禁不达成" is all CN chars, no ASCII "FAIL" inside, so
    // whitelist order picks it specifically (index 2, indices 0+1 miss).
    const r = checkVerdictConsistency("本次发布 前置门禁不达成", "PASS");
    expect(r?.matched).toBe("前置门禁不达成");
  });

  it("accepts: summary 含 FAIL keyword + verdict=FAIL", () => {
    expect(checkVerdictConsistency("CB build FAIL x2", "FAIL")).toBeNull();
    expect(checkVerdictConsistency("门禁 FAIL", "FAIL")).toBeNull();
    expect(checkVerdictConsistency("前置门禁不达成", "FAIL")).toBeNull();
  });

  it("accepts: summary 无 FAIL keyword + verdict=PASS (normal path)", () => {
    expect(checkVerdictConsistency("vitest 110/110 green", "PASS")).toBeNull();
    expect(checkVerdictConsistency("失败 but模糊词被忽略", "PASS")).toBeNull();
    expect(checkVerdictConsistency("未通过 模糊词被忽略", "PASS")).toBeNull();
    expect(checkVerdictConsistency("fail 小写被忽略", "PASS")).toBeNull();
  });

  it("accepts: summary 无 FAIL keyword + verdict=FAIL (normal path)", () => {
    expect(checkVerdictConsistency("tests broken", "FAIL")).toBeNull();
  });
});

describe("submit_verdict verdict↔summary consistency guard (CP-2805)", () => {
  beforeEach(() => {
    vi.mocked(jiraGet).mockReset();
    vi.mocked(jiraPost).mockReset();
    vi.mocked(jiraPut).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("AC-2805-1 (CP-2799 repro): summary 含 'FAIL' + verdict=PASS → reject 0 side effect", async () => {
    const result = await submitVerdict({
      issueIdOrKey: "CP-2799",
      verdict: "PASS",
      summary: "CB build FAIL x2 mypy strict 实证 CP-2799",
      evidence: "vitest 0/110",
    });

    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/FAIL/);                  // matched keyword echoed
    expect(parsed.error).toMatch(/PASS/);                  // verdict echoed
    expect(parsed.error).toMatch(/verdict 改 "FAIL"/);     // repair hint A (intent FAIL)
    expect(parsed.error).toMatch(/去除 "FAIL"/);            // repair hint B (intent PASS)

    // AC3 timing + AC1 zero side-effect: no Jira write at all
    expect(jiraPost).not.toHaveBeenCalled();
    expect(jiraGet).not.toHaveBeenCalled();
    expect(jiraPut).not.toHaveBeenCalled();

    // details <100 字符, 含 issue key + 拒收语义
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/CP-2799/);
    expect(details).toMatch(/拒收|FAIL/);
  });

  it("AC-2805-2: summary 含 '门禁 FAIL' + verdict=PASS → reject 0 side effect", async () => {
    // Note: CP-1918 / mirror puts "FAIL" first in whitelist, so the matched
    // keyword reported will always be "FAIL" whenever "门禁 FAIL" appears
    // (because "门禁 FAIL" contains "FAIL" as substring). Test only that
    // the call is rejected with 0 side effect — the matched-keyword echo
    // is verified by the dedicated pure-helper unit tests.
    const result = await submitVerdict({
      issueIdOrKey: "CP-2799",
      verdict: "PASS",
      summary: "前端 门禁 FAIL 后端 OK",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/FAIL/);
    expect(parsed.error).toMatch(/verdict 改 "FAIL"|去除 "FAIL"/);
    expect(jiraPost).not.toHaveBeenCalled();
    expect(jiraGet).not.toHaveBeenCalled();
    expect(jiraPut).not.toHaveBeenCalled();
  });

  it("AC-2805-3: summary 含 '前置门禁不达成' + verdict=PASS → reject 0 side effect", async () => {
    const result = await submitVerdict({
      issueIdOrKey: "CP-2799",
      verdict: "PASS",
      summary: "本次发布 前置门禁不达成 不应 PASS",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/前置门禁不达成/);
    expect(jiraPost).not.toHaveBeenCalled();
    expect(jiraGet).not.toHaveBeenCalled();
    expect(jiraPut).not.toHaveBeenCalled();
  });

  it("AC-2805-4: summary 含 FAIL keyword + verdict=FAIL → 原 FAIL 流 (0 误拦)", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" });
    vi.mocked(jiraPut).mockResolvedValueOnce({}); // add label
    vi.mocked(jiraPut).mockResolvedValueOnce({}); // clear assignee

    const result = await submitVerdict({
      issueIdOrKey: "CP-2799",
      verdict: "FAIL",
      summary: "CB build FAIL x2 mypy strict",
      reason: "mypy 3 红门未通过",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.verdict).toBe("FAIL");
    expect(parsed.label).toBe("escalated");
    expect(parsed.assigneeCleared).toBe(true);
    expect(jiraPost).toHaveBeenCalledTimes(1);
    expect(jiraPut).toHaveBeenCalledTimes(2);
  });

  it("AC-2805-5: summary 无 FAIL + verdict=PASS → 原 PASS 流 (0 误拦)", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" });
    vi.mocked(jiraGet).mockResolvedValueOnce({
      transitions: [
        { id: "11", name: "Done", to: { name: "已完成", statusCategory: { id: 3, key: "done" } } },
      ],
    });
    vi.mocked(jiraPost).mockResolvedValueOnce({}); // transition execute

    const result = await submitVerdict({
      issueIdOrKey: "CP-2799",
      verdict: "PASS",
      summary: "vitest 110/110 green",
      evidence: "all tests pass",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.verdict).toBe("PASS");
    expect(parsed.transition.to).toBe("已完成");
    expect(jiraPost).toHaveBeenCalledTimes(2);
  });

  it("AC-2805-6: summary 无 FAIL + verdict=FAIL+reason → 原 FAIL 流 (0 误拦)", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" });
    vi.mocked(jiraPut).mockResolvedValueOnce({});
    vi.mocked(jiraPut).mockResolvedValueOnce({});

    const result = await submitVerdict({
      issueIdOrKey: "CP-2799",
      verdict: "FAIL",
      summary: "tests broken without FAIL keyword",
      reason: "vitest timeout",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.verdict).toBe("FAIL");
    expect(parsed.label).toBe("escalated");
  });

  it("AC-2805-7 (keyword boundary): 模糊词 '失败' + verdict=PASS → 0 命中通过", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" });
    vi.mocked(jiraGet).mockResolvedValueOnce({
      transitions: [
        { id: "11", name: "Done", to: { name: "已完成", statusCategory: { id: 3, key: "done" } } },
      ],
    });
    vi.mocked(jiraPost).mockResolvedValueOnce({});
    const result = await submitVerdict({
      issueIdOrKey: "CP-2799",
      verdict: "PASS",
      summary: "上线 失败 但与 CP-1918 关键词无关",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.ok).toBe(true); // 通过, 0 误拦
    expect(parsed.verdict).toBe("PASS");
  });

  it("AC-2805-8 (keyword boundary): 模糊词 '未通过' + verdict=PASS → 0 命中通过", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" });
    vi.mocked(jiraGet).mockResolvedValueOnce({
      transitions: [
        { id: "11", name: "Done", to: { name: "已完成", statusCategory: { id: 3, key: "done" } } },
      ],
    });
    vi.mocked(jiraPost).mockResolvedValueOnce({});
    const result = await submitVerdict({
      issueIdOrKey: "CP-2799",
      verdict: "PASS",
      summary: "review 未通过 但已修复",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.ok).toBe(true);
  });

  it("AC-2805-9 (keyword boundary): 小写 'fail' + verdict=PASS → 0 命中通过 (case-sensitive)", async () => {
    vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" });
    vi.mocked(jiraGet).mockResolvedValueOnce({
      transitions: [
        { id: "11", name: "Done", to: { name: "已完成", statusCategory: { id: 3, key: "done" } } },
      ],
    });
    vi.mocked(jiraPost).mockResolvedValueOnce({});
    const result = await submitVerdict({
      issueIdOrKey: "CP-2799",
      verdict: "PASS",
      summary: "git commit fail locally, ignored",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.ok).toBe(true);
  });

  it("AC-2805-10: empty summary is rejected by prior param validation (FAIL invariant precedes guard)", async () => {
    const result = await submitVerdict({
      issueIdOrKey: "CP-2799",
      verdict: "PASS",
      summary: "",
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.error).toMatch(/summary/);
    expect(jiraPost).not.toHaveBeenCalled();
    expect(jiraGet).not.toHaveBeenCalled();
    expect(jiraPut).not.toHaveBeenCalled();
  });
});
