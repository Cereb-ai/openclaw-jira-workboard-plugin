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

/**
 * CP-3767 — the registered schema must survive the provider tool-compat
 * hook UNCHANGED.
 *
 * Root cause (CP-3765): a TypeBox union of string + number serializes to
 * a JSON Schema union keyword (`anyOf`). The DeepSeek provider's
 * tool-compat hook treats that keyword as unsupported and flattens the
 * union down to its FIRST variant (`selected = nonNullVariants[0]`), so
 * the schema the model sees — and the tool-call validation — collapsed
 * back to a single type (`commentId` → string only, `maxResults` →
 * number only).
 *
 * Fix: the three parameter aliases now emit a JSON Schema **type
 * array** (`{ "type": ["string", "number"] }`), which the hook does not
 * touch. The tests below assert that against the REAL registered
 * metadata (via `getToolPluginMetadata`) and against the REAL hook
 * (`normalizeDeepSeekToolSchemas`).
 */
describe("CP-3767 — registered schema has no union keyword and uses type arrays", () => {
  /** Collect every key that appears anywhere in the serialized schema tree. */
  function collectKeys(node: unknown, into: Set<string> = new Set()): Set<string> {
    if (Array.isArray(node)) {
      for (const entry of node) collectKeys(entry, into);
      return into;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        into.add(key);
        collectKeys(value, into);
      }
    }
    return into;
  }

  function propertySchema(tool: string, path: string[]): Record<string, unknown> {
    const spec = byName.get(tool);
    if (!spec) throw new Error(`unknown tool: ${tool}`);
    let node = spec.parameters as Record<string, unknown>;
    for (const segment of path) {
      const properties = (node.properties ?? {}) as Record<string, Record<string, unknown>>;
      const next = properties[segment];
      if (!next) {
        throw new Error(`missing property ${path.join(".")} on ${tool}`);
      }
      node = next;
    }
    return node;
  }

  it("AC-3767-S-1: no alias-driven field emits a union keyword", () => {
    // `jira_submit_verdict.verdict` is a Literal union and is explicitly
    // OUT OF SCOPE for CP-3767 (AC-1: it must stay a Type.Union). It is
    // the single documented exception — the provider hook rewrites it to
    // `{ type: "string", enum: ["PASS","FAIL"] }`, which is correct.
    for (const [name, spec] of byName) {
      if (name === "jira_submit_verdict") continue;
      const keys = collectKeys(spec.parameters);
      expect(keys.has("anyOf"), `${name} must not contain anyOf`).toBe(false);
      expect(keys.has("oneOf"), `${name} must not contain oneOf`).toBe(false);
    }
    // The exception is exactly one field, and it is a Literal union.
    const verdict = propertySchema("jira_submit_verdict", ["verdict"]);
    expect(Array.isArray(verdict.anyOf)).toBe(true);
    // Sanity: the tree was actually walked (a non-trivial key set).
    expect(collectKeys(byName.get("jira_get")?.parameters).has("properties")).toBe(true);
  });

  it("AC-3767-S-2: id-class fields declare a [string, number] type array", () => {
    const idFields: [string, string][] = [
      ["jira_get", "issueIdOrKey"],
      ["jira_list_comments", "issueIdOrKey"],
      ["jira_get_comment", "issueIdOrKey"],
      ["jira_get_comment", "commentId"],
      ["jira_comment", "issueIdOrKey"],
      ["jira_create_task", "project"],
      ["jira_create_subtask", "project"],
      ["jira_create_subtask", "parent"],
      ["jira_submit_verdict", "issueIdOrKey"],
      ["jira_abandon_task", "issueIdOrKey"],
      ["jira_request_help", "issueIdOrKey"],
      ["jira_transition", "issueIdOrKey"],
      ["jira_list_attachments", "issueIdOrKey"],
      ["jira_get_attachment", "attachmentId"],
      ["jira_upload_attachment", "issueIdOrKey"],
    ];
    for (const [tool, field] of idFields) {
      const schema = propertySchema(tool, [field]);
      expect(Array.isArray(schema.type), `${tool}.${field} type must be an array`).toBe(true);
      expect(schema.type).toContain("string");
      expect(schema.type).toContain("number");
      expect(schema.type).not.toContain("object");
      expect(schema.type).not.toContain("array");
    }
  });

  it("AC-3767-S-3: pagination fields declare a [number, string] type array", () => {
    const paginationFields: [string, string][] = [
      ["jira_search", "maxResults"],
      ["jira_list_comments", "startAt"],
      ["jira_list_comments", "maxResults"],
    ];
    for (const [tool, field] of paginationFields) {
      const schema = propertySchema(tool, [field]);
      expect(Array.isArray(schema.type), `${tool}.${field} type must be an array`).toBe(true);
      expect(schema.type).toContain("number");
      expect(schema.type).toContain("string");
    }
  });

  it("AC-3767-S-4: array-class fields declare items with a [string, number] type array", () => {
    const arrayFields: [string, string[]][] = [
      ["jira_search", ["fields"]],
      ["jira_get", ["fields"]],
      ["jira_comment", ["mentionAccountIds"]],
      ["jira_create_task", ["labels"]],
      ["jira_create_task", ["block", "blockedBy"]],
      ["jira_create_task", ["block", "blocks"]],
      ["jira_create_subtask", ["labels"]],
      ["jira_create_subtask", ["block", "blockedBy"]],
      ["jira_create_subtask", ["block", "blocks"]],
      ["jira_abandon_task", ["labels"]],
    ];
    for (const [tool, path] of arrayFields) {
      const schema = propertySchema(tool, path);
      expect(schema.type, `${tool}.${path.join(".")} must be an array`).toBe("array");
      const items = schema.items as Record<string, unknown>;
      expect(items, `${tool}.${path.join(".")} must declare items`).toBeDefined();
      expect(Array.isArray(items.type)).toBe(true);
      expect(items.type).toContain("string");
      expect(items.type).toContain("number");
    }
  });

  it("AC-3767-S-5: the description still says 'string or number'", () => {
    const described: [string, string[]][] = [
      ["jira_get", ["issueIdOrKey"]],
      ["jira_get_comment", ["commentId"]],
      ["jira_list_comments", ["maxResults"]],
      ["jira_get", ["fields"]],
    ];
    for (const [tool, path] of described) {
      const schema = propertySchema(tool, path);
      const description = String(schema.description ?? "");
      expect(description.toLowerCase()).toContain("string or number");
    }
    // The array ITEM description keeps the same wording.
    const items = propertySchema("jira_get", ["fields"]).items as Record<string, unknown>;
    expect(String(items.description ?? "").toLowerCase()).toContain("string or number");
  });

  it("AC-3767-S-6: the DeepSeek tool-compat hook leaves every type array untouched", async () => {
    // `openclaw/plugin-sdk/provider-tools` ships no type declarations, so
    // it is loaded through a non-literal specifier and typed by hand.
    const sdk = (await import(
      /* @vite-ignore */ ("openclaw/plugin-sdk/provider-tools" as string)
    )) as {
      normalizeDeepSeekToolSchemas: (ctx: unknown) => {
        name: string;
        parameters: unknown;
      }[];
    };
    const tools = metadata.tools.map((t) => ({
      name: t.name,
      parameters: t.parameters as unknown,
    }));
    const normalized = sdk.normalizeDeepSeekToolSchemas({ tools });

    // (a) After the hook, the WHOLE tree is free of union keywords —
    //     the only pre-hook union (verdict) is rewritten to an enum.
    for (const tool of normalized) {
      const keys = collectKeys(tool.parameters);
      expect(keys.has("anyOf"), `${tool.name} must not contain anyOf`).toBe(false);
      expect(keys.has("oneOf"), `${tool.name} must not contain oneOf`).toBe(false);
    }

    // (b) The type arrays survive the hook unchanged — this is the
    //     actual root-cause fix: before CP-3767 the hook collapsed the
    //     union to its first variant and the model only ever saw a
    //     single type.
    const byNameAfter = new Map(normalized.map((t) => [t.name, t.parameters as unknown]));
    const postHookProperty = (tool: string, field: string): Record<string, unknown> => {
      const params = byNameAfter.get(tool) as Record<string, unknown> | undefined;
      if (!params) throw new Error(`unknown tool after hook: ${tool}`);
      const properties = (params.properties ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      const schema = properties[field];
      if (!schema) throw new Error(`missing property ${field} on ${tool}`);
      return schema;
    };
    const expected: [string, string, string[]][] = [
      ["jira_get_comment", "commentId", ["string", "number"]],
      ["jira_get", "issueIdOrKey", ["string", "number"]],
      ["jira_list_comments", "maxResults", ["number", "string"]],
      ["jira_list_comments", "startAt", ["number", "string"]],
      ["jira_create_task", "project", ["string", "number"]],
    ];
    for (const [tool, field, types] of expected) {
      const schema = postHookProperty(tool, field);
      expect(schema.type, `${tool}.${field} type array must survive the hook`).toEqual(
        types,
      );
    }

    // Array-class fields: the ITEMS carry the type array, and it also
    // survives the hook untouched.
    const fieldsSchema = postHookProperty("jira_get", "fields");
    expect(fieldsSchema.type).toBe("array");
    expect((fieldsSchema.items as Record<string, unknown>).type).toEqual([
      "string",
      "number",
    ]);
  });
});

describe("CP-3767 — value layer still accepts string | number and rejects junk", () => {
  it("AC-3767-S-7: commentId accepts a number, a numeric string and a padded string", () => {
    expect(accepts("jira_get_comment", { issueIdOrKey: "CP-1", commentId: 48172 })).toBe(true);
    expect(accepts("jira_get_comment", { issueIdOrKey: "CP-1", commentId: "48172" })).toBe(true);
    expect(accepts("jira_get_comment", { issueIdOrKey: "CP-1", commentId: " 48172 " })).toBe(true);
  });

  it("AC-3767-S-8: pagination fields accept numeric strings", () => {
    expect(
      accepts("jira_list_comments", {
        issueIdOrKey: "CP-1",
        startAt: "10",
        maxResults: "20",
      }),
    ).toBe(true);
  });

  it("AC-3767-S-9: create_task accepts a numeric project and numeric label members", () => {
    expect(
      accepts("jira_create_task", {
        project: 10000,
        summary: "s",
        requirements: "r",
        scope: "sc",
        acceptance_criteria: "ac",
        labels: [3740],
      }),
    ).toBe(true);
  });

  it("AC-3767-S-10: an object / array id or pagination value is still rejected", () => {
    expect(accepts("jira_get_comment", { issueIdOrKey: "CP-1", commentId: { a: 1 } })).toBe(false);
    expect(accepts("jira_get_comment", { issueIdOrKey: "CP-1", commentId: ["48172"] })).toBe(false);
    expect(accepts("jira_get", { issueIdOrKey: { a: 1 } })).toBe(false);
    expect(accepts("jira_get", { issueIdOrKey: ["CP-1"] })).toBe(false);
    expect(
      accepts("jira_list_comments", { issueIdOrKey: "CP-1", maxResults: { a: 1 } }),
    ).toBe(false);
    expect(
      accepts("jira_list_comments", { issueIdOrKey: "CP-1", maxResults: ["20"] }),
    ).toBe(false);
    expect(
      accepts("jira_list_comments", { issueIdOrKey: "CP-1", startAt: ["10"] }),
    ).toBe(false);
  });
});
