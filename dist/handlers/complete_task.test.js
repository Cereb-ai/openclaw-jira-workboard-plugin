import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// Hoist-friendly mocks: declare factories inline (vi.mock is hoisted
// to top of file before any module-level consts).
vi.mock("../http.js", () => ({
    jiraGet: vi.fn(),
    jiraPost: vi.fn(),
    jiraPut: vi.fn(),
    JiraHttpError: class extends Error {
        status;
        statusText;
        body;
        constructor(status, statusText, body) {
            super(`HTTP ${status} ${statusText}`);
            this.status = status;
            this.statusText = statusText;
            this.body = body;
        }
    },
}));
vi.mock("../auth.js", async (importOriginal) => {
    const actual = (await importOriginal());
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
import { completeTask } from "../handlers/complete_task.js";
import { JiraPluginError } from "../auth.js";
describe("complete_task FAIL escalation (SSSS-252)", () => {
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
        const result = await completeTask({
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
        const body = result.content[0].text;
        const parsed = JSON.parse(body);
        expect(parsed.ok).toBe(true);
        expect(parsed.verdict).toBe("FAIL");
        expect(parsed.label).toBe("escalated");
        expect(parsed.assigneeCleared).toBe(true);
        expect(parsed.summary.verdict).toBe("FAIL");
    });
    it("AC-252-2: verdict=FAIL with empty reason → throws JiraPluginError (no side effect)", async () => {
        await expect(completeTask({
            issueIdOrKey: "TEST-1",
            verdict: "FAIL",
            summary: "tests failed",
            reason: "",
        })).rejects.toThrow(JiraPluginError);
        await expect(completeTask({
            issueIdOrKey: "TEST-1",
            verdict: "FAIL",
            summary: "tests failed",
        })).rejects.toThrow(JiraPluginError);
        // No HTTP calls made before throw
        expect(jiraPost).not.toHaveBeenCalled();
        expect(jiraPut).not.toHaveBeenCalled();
    });
    it("AC-252-3: verdict=FAIL, label PUT fails → partial result with hint", async () => {
        vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" }); // comment OK
        vi.mocked(jiraPut).mockRejectedValueOnce(new Error("label 500")); // label fails
        const result = await completeTask({
            issueIdOrKey: "TEST-1",
            verdict: "FAIL",
            summary: "tests failed",
            reason: "vitest timeout",
        });
        const body = result.content[0].text;
        const parsed = JSON.parse(body);
        expect(parsed.ok).toBe(false);
        expect(parsed.partial).toBe(true);
        expect(parsed.verdict).toBe("FAIL");
        expect(parsed.comment.id).toBe("c1");
        // The hint about retrying is embedded in the error message
        // (no separate hint field for FAIL partial — single error string).
        expect(parsed.error).toMatch(/retry/i);
    });
    it("AC-252-4: verdict=PASS still transitions (no FAIL handling kicks in)", async () => {
        vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" }); // comment
        vi.mocked(jiraGet).mockResolvedValueOnce({
            transitions: [
                { id: "11", name: "Done", to: { name: "已完成" } },
            ],
        });
        vi.mocked(jiraPost).mockResolvedValueOnce({}); // transition execute
        const result = await completeTask({
            issueIdOrKey: "TEST-1",
            verdict: "PASS",
            summary: "all green",
            evidence: "vitest 110/110",
        });
        const body = result.content[0].text;
        const parsed = JSON.parse(body);
        expect(parsed.ok).toBe(true);
        expect(parsed.summary.verdict).toBe("PASS");
        expect(parsed.summary.transitionedTo).toBe("已完成");
        // No label add PUT for PASS
        expect(jiraPut).not.toHaveBeenCalled();
    });
    it("AC-252-5: verdict=BLOCKED transitions (not escalated)", async () => {
        vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" });
        vi.mocked(jiraGet).mockResolvedValueOnce({
            transitions: [{ id: "11", name: "Done", to: { name: "已完成" } }],
        });
        vi.mocked(jiraPost).mockResolvedValueOnce({});
        const result = await completeTask({
            issueIdOrKey: "TEST-1",
            verdict: "BLOCKED",
            summary: "waiting for input",
        });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.summary.verdict).toBe("BLOCKED");
        expect(parsed.summary.transitionedTo).toBe("已完成");
        expect(jiraPut).not.toHaveBeenCalled();
    });
});
describe("dispatch escalate_task alias (SSSS-252)", () => {
    beforeEach(() => {
        vi.mocked(jiraGet).mockReset();
        vi.mocked(jiraPost).mockReset();
        vi.mocked(jiraPut).mockReset();
    });
    afterEach(() => {
        vi.clearAllMocks();
    });
    it("AC-252-6: escalate_task → completeTask({verdict:FAIL, reason})", async () => {
        const { dispatch } = await import("../dispatch.js");
        // SSSS-254 S1 fix: alias now subtask-guards before forwarding, so the
        // test must mock jiraGet to return subtask=true for the guard to pass.
        vi.mocked(jiraGet).mockResolvedValueOnce({
            fields: { issuetype: { subtask: true, name: "Sub-task" } },
        });
        vi.mocked(jiraPost).mockResolvedValueOnce({ id: "c1", self: "http://x/c1" });
        vi.mocked(jiraPut).mockResolvedValueOnce({});
        vi.mocked(jiraPut).mockResolvedValueOnce({});
        const result = await dispatch({
            method: "escalate_task",
            args: { issueIdOrKey: "TEST-2", reason: "stuck on dependency" },
        });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.ok).toBe(true);
        expect(parsed.label).toBe("escalated");
        expect(parsed.assigneeCleared).toBe(true);
    });
    it("AC-254-S1: escalate_task on main task (subtask=false) → fail-fast, no side effect", async () => {
        // SSSS-254 S1 fix: the alias preserves the old escalateTask contract
        // by fail-fast on main tasks before any side effect.
        const { dispatch } = await import("../dispatch.js");
        vi.mocked(jiraGet).mockResolvedValueOnce({
            fields: { issuetype: { subtask: false, name: "Task" } },
        });
        const result = await dispatch({
            method: "escalate_task",
            args: { issueIdOrKey: "TEST-MAIN", reason: "should not reach here" },
        });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.ok).toBeUndefined();
        expect(parsed.error).toContain("escalate_task 只能用于子任务");
        expect(parsed.error).toContain("use request_help instead");
        // No comment / label / assignee PUTs were issued — guard fail-fast.
        expect(jiraPost).not.toHaveBeenCalled();
        expect(jiraPut).not.toHaveBeenCalled();
    });
    it("AC-254-S1: escalate_task with empty issueIdOrKey → fail-fast (no API call)", async () => {
        const { dispatch } = await import("../dispatch.js");
        const result = await dispatch({
            method: "escalate_task",
            args: { reason: "missing key" },
        });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.error).toContain("non-empty `issueIdOrKey`");
        // No HTTP calls made before fail.
        expect(jiraGet).not.toHaveBeenCalled();
        expect(jiraPost).not.toHaveBeenCalled();
        expect(jiraPut).not.toHaveBeenCalled();
    });
});
