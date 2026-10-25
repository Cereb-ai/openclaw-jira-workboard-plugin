/**
 * Tool schema layer tests (CP-3751).
 *
 * The handler layer (src/handlers/param_normalization.test.ts) proves the
 * VALUES are normalized correctly. These tests prove the other half of
 * the contract: the **schema** no longer rejects the wrong type guess
 * BEFORE the handler runs.
 *
 * Why this matters: the original bug was `jira_get_comment` with a
 * numeric commentId being rejected with `must be string` by the TypeBox
 * validator — the handler never even saw the value. Three consecutive
 * schema rejections trip the runtime's hard circuit breaker → the agent
 * session dies and the ticket is re-dispatched.
 *
 * These tests run against the REAL compiled tool schemas (read out of
 * the plugin entry via `getToolPluginMetadata`), so they also cover
 * schema-construction mistakes — e.g. `Type.Optional(StringOrNumberArray)`
 * (passing the FACTORY instead of the schema) silently produced a
 * non-array property that rejected every value.
 */
import { describe, it, expect } from "vitest";
import { Value } from "typebox/value";
import plugin from "./index.js";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";

const metadata = getToolPluginMetadata(plugin);
if (!metadata) throw new Error("plugin metadata not found");

const byName = new Map<string, { parameters: unknown }>();
for (const t of metadata.tools) {
  byName.set(t.name, { parameters: t.parameters });
}

function accepts(tool: string, params: unknown): boolean {
  const spec = byName.get(tool);
  if (!spec) throw new Error(`unknown tool: ${tool}`);
  return Value.Check(spec.parameters as never, params);
}

describe("CP-3751 — schema layer accepts string | number", () => {
  it("AC-3751-S-1: all 14 tools are registered", () => {
    expect(metadata.tools.length).toBe(14);
  });

  it("AC-3751-S-2: id-class params accept a number", () => {
    expect(accepts("jira_get_comment", { issueIdOrKey: "CP-1", commentId: 48060 })).toBe(true);
    expect(accepts("jira_get", { issueIdOrKey: 24180 })).toBe(true);
    expect(accepts("jira_get_attachment", { attachmentId: 12345 })).toBe(true);
    expect(accepts("jira_list_attachments", { issueIdOrKey: 24180 })).toBe(true);
    expect(accepts("jira_list_comments", { issueIdOrKey: 24180 })).toBe(true);
    expect(accepts("jira_comment", { issueIdOrKey: 24180, body: "x" })).toBe(true);
    expect(accepts("jira_transition", { issueIdOrKey: 24180, targetStatus: "done" })).toBe(true);
    expect(accepts("jira_upload_attachment", { issueIdOrKey: 24180, filePath: "/tmp/x" })).toBe(true);
    expect(accepts("jira_submit_verdict", { issueIdOrKey: 24180, verdict: "PASS", summary: "s" })).toBe(true);
    expect(accepts("jira_abandon_task", { issueIdOrKey: 24180, reason: "r" })).toBe(true);
    expect(accepts("jira_request_help", { issueIdOrKey: 24180, question: "q" })).toBe(true);
  });

  it("AC-3751-S-3: id-class params still accept a string", () => {
    expect(accepts("jira_get_comment", { issueIdOrKey: "CP-1", commentId: "48060" })).toBe(true);
    expect(accepts("jira_get", { issueIdOrKey: "CP-1" })).toBe(true);
    expect(accepts("jira_get_attachment", { attachmentId: "12345" })).toBe(true);
  });

  it("AC-3751-S-4: pagination params accept a numeric string AND a number", () => {
    expect(accepts("jira_list_comments", { issueIdOrKey: "CP-1", maxResults: "20" })).toBe(true);
    expect(accepts("jira_list_comments", { issueIdOrKey: "CP-1", maxResults: 20 })).toBe(true);
    expect(accepts("jira_list_comments", { issueIdOrKey: "CP-1", startAt: "0" })).toBe(true);
    expect(accepts("jira_list_comments", { issueIdOrKey: "CP-1", startAt: 0 })).toBe(true);
    expect(accepts("jira_search", { jql: "project = CP", maxResults: "5" })).toBe(true);
    expect(accepts("jira_search", { jql: "project = CP", maxResults: 5 })).toBe(true);
  });

  it("AC-3751-S-5: array-member params accept numeric members", () => {
    expect(accepts("jira_get", { issueIdOrKey: "CP-1", fields: [10019] })).toBe(true);
    expect(accepts("jira_get", { issueIdOrKey: "CP-1", fields: ["customfield_10019"] })).toBe(true);
    expect(accepts("jira_search", { jql: "project = CP", fields: [10019, "status"] })).toBe(true);
    expect(accepts("jira_comment", { issueIdOrKey: "CP-1", body: "x", mentionAccountIds: [712020] })).toBe(true);
    expect(
      accepts("jira_create_task", {
        project: "CP",
        summary: "s",
        requirements: "r",
        scope: "sc",
        acceptance_criteria: "ac",
        labels: [3740],
      }),
    ).toBe(true);
    expect(
      accepts("jira_create_subtask", {
        project: "CP",
        parent: "CP-1",
        summary: "s",
        requirements: "r",
        scope: "sc",
        acceptance_criteria: "ac",
        labels: [3740],
      }),
    ).toBe(true);
    expect(
      accepts("jira_abandon_task", { issueIdOrKey: "CP-1", reason: "r", labels: [1234] }),
    ).toBe(true);
  });

  it("AC-3751-S-6: block.blockedBy / block.blocks accept numeric members", () => {
    // Regression: `Type.Optional(StringOrNumberArray)` passed the FACTORY
    // instead of the schema, producing a non-array property that rejected
    // EVERY value (including a plain string array).
    expect(
      accepts("jira_create_task", {
        project: "CP",
        summary: "s",
        requirements: "r",
        scope: "sc",
        acceptance_criteria: "ac",
        block: { blockedBy: [3740] },
      }),
    ).toBe(true);
    expect(
      accepts("jira_create_task", {
        project: "CP",
        summary: "s",
        requirements: "r",
        scope: "sc",
        acceptance_criteria: "ac",
        block: { blockedBy: ["CP-3740"] },
      }),
    ).toBe(true);
    expect(
      accepts("jira_create_task", {
        project: "CP",
        summary: "s",
        requirements: "r",
        scope: "sc",
        acceptance_criteria: "ac",
        block: { blocks: [3740] },
      }),
    ).toBe(true);
    expect(
      accepts("jira_create_subtask", {
        project: "CP",
        parent: "CP-1",
        summary: "s",
        requirements: "r",
        scope: "sc",
        acceptance_criteria: "ac",
        labels: ["code"],
        block: { blockedBy: [3740], blocks: [3750] },
      }),
    ).toBe(true);
  });
});

describe("CP-3751 — schema layer keeps content fields strict", () => {
  it("AC-3751-S-7: an object body is rejected", () => {
    expect(accepts("jira_comment", { issueIdOrKey: "CP-1", body: { a: 1 } })).toBe(false);
  });

  it("AC-3751-S-8: an array summary is rejected", () => {
    expect(
      accepts("jira_create_task", {
        project: "CP",
        summary: [],
        requirements: "r",
        scope: "sc",
        acceptance_criteria: "ac",
      }),
    ).toBe(false);
    expect(
      accepts("jira_create_subtask", {
        project: "CP",
        parent: "CP-1",
        summary: [],
        requirements: "r",
        scope: "sc",
        acceptance_criteria: "ac",
        labels: ["code"],
      }),
    ).toBe(false);
  });

  it("AC-3751-S-9: an object question / reason / requirements is rejected", () => {
    expect(accepts("jira_request_help", { issueIdOrKey: "CP-1", question: { a: 1 } })).toBe(false);
    expect(accepts("jira_abandon_task", { issueIdOrKey: "CP-1", reason: { a: 1 } })).toBe(false);
    expect(
      accepts("jira_create_task", {
        project: "CP",
        summary: "s",
        requirements: { a: 1 },
        scope: "sc",
        acceptance_criteria: "ac",
      }),
    ).toBe(false);
  });

  it("AC-3751-S-10: an object jql / targetStatus / verdict is rejected", () => {
    expect(accepts("jira_search", { jql: { a: 1 } })).toBe(false);
    expect(accepts("jira_transition", { issueIdOrKey: "CP-1", targetStatus: { a: 1 } })).toBe(false);
    expect(
      accepts("jira_submit_verdict", { issueIdOrKey: "CP-1", verdict: { a: 1 }, summary: "s" }),
    ).toBe(false);
  });
});

/**
 * CP-3758 — R1 follow-up of CP-3751 (schema layer).
 *
 * `create_task.project` / `create_subtask.project` / `create_subtask.parent`
 * stayed `Type.String()` in the CP-3751 pass, so a numeric project / parent
 * was rejected by the TypeBox validator BEFORE the handler could normalize
 * it. These tests run against the REAL compiled tool schemas.
 */
describe("CP-3758 — project / parent accept string | number at the schema layer", () => {
  const createTaskBase = {
    summary: "s",
    requirements: "r",
    scope: "sc",
    acceptance_criteria: "ac",
  };

  it("AC-3758-S-1: create_task.project accepts a string, a number and a padded string", () => {
    expect(accepts("jira_create_task", { ...createTaskBase, project: "CP" })).toBe(true);
    expect(accepts("jira_create_task", { ...createTaskBase, project: 10000 })).toBe(true);
    expect(accepts("jira_create_task", { ...createTaskBase, project: " CP " })).toBe(true);
  });

  it("AC-3758-S-2: create_subtask.project / .parent accept a string, a number and a padded string", () => {
    const base = { ...createTaskBase, labels: ["code"] };
    expect(accepts("jira_create_subtask", { ...base, project: "CP", parent: "CP-1" })).toBe(true);
    expect(accepts("jira_create_subtask", { ...base, project: 10000, parent: 24180 })).toBe(true);
    expect(accepts("jira_create_subtask", { ...base, project: " CP ", parent: " CP-1 " })).toBe(true);
    // Mixed: numeric parent + string project.
    expect(accepts("jira_create_subtask", { ...base, project: "CP", parent: 24180 })).toBe(true);
  });

  it("AC-3758-S-3: an object / array project or parent is still rejected", () => {
    expect(accepts("jira_create_task", { ...createTaskBase, project: { a: 1 } })).toBe(false);
    expect(accepts("jira_create_task", { ...createTaskBase, project: ["CP"] })).toBe(false);
    const base = { ...createTaskBase, labels: ["code"] };
    expect(accepts("jira_create_subtask", { ...base, project: "CP", parent: { a: 1 } })).toBe(false);
    expect(accepts("jira_create_subtask", { ...base, project: { a: 1 }, parent: "CP-1" })).toBe(false);
  });
});
