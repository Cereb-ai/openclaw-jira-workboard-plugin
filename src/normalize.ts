/**
 * Shared parameter normalization helpers (CP-3751).
 *
 * Why this file exists
 * ────────────────────
 * The 14 jira tools are called by LLM agents that routinely guess a
 * parameter's JSON type wrong: a numeric comment id arrives as `48060`
 * (number) instead of `"48060"`, a page size arrives as `"20"`, a
 * `fields` entry arrives as `10019`. The TypeBox schema used to be
 * strict (`Type.String()` / `Type.Number()` / `Type.Array(Type.String())`)
 * so the wrong guess was rejected BEFORE the handler ran — and three
 * consecutive schema rejections trip the runtime's hard circuit breaker,
 * which kills the session and re-dispatches the ticket.
 *
 * The fix is a two-layer contract:
 *   1. **Schema layer** (`src/index.ts`) — declares ID / pagination /
 *      array-member parameters with a JSON Schema **type array**
 *      (`{ "type": ["string", "number"] }`, emitted via `Type.Unsafe`)
 *      so the TypeBox validator stops rejecting the wrong guess.
 *
 *      CP-3767: this used to be a TypeBox union of string + number.
 *      A TypeBox union serializes to a JSON Schema union keyword, which
 *      the DeepSeek provider's tool-compat hook treats as unsupported —
 *      it flattens the union down to its first variant, so the schema the
 *      model sees (and the tool-call validation) collapsed back to a
 *      single type (`commentId` → string only, `maxResults` → number
 *      only). A type array survives that hook untouched, so the aliases
 *      now emit `{ "type": ["string", "number"] }` instead. The declared
 *      accept-set is unchanged: string or number, never an object / array
 *      / boolean.
 *   2. **Handler layer** (this file) — every handler normalizes its
 *      parameters through these helpers before touching the REST layer,
 *      so downstream Atlassian calls always receive a clean
 *      `string` / `integer` / `string[]`.
 *
 * Content fields (body / summary / question / description / reason / …)
 * are deliberately NOT routed through here — they stay strict, so an
 * object or array is rejected instead of being silently `String()`-ed.
 *
 * Normalization rules
 * ────────────────────
 *   normalizeId        string (trim, non-empty) | finite number → string
 *   normalizeInt       number (integer) | numeric string → integer,
 *                      clamped to `max` when given (never rejected for
 *                      being too large), rejected for non-integers and
 *                      values below `min`
 *   normalizeStringArray
 *                      array whose members are string (trim, non-empty)
 *                      | finite number → string[]; any other member type
 *                      (object / array / boolean / null) is rejected
 */

export type NormResult<T> =
  | { ok: true; value: T; clamped?: boolean }
  | { ok: false; error: string };

/** Render a value's type for error messages without dumping huge payloads. */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Normalize an ID-class parameter (issue key, comment id, attachment id,
 * account id, project key) to a trimmed, non-empty string.
 *
 * Accepts:
 *   - string  → trimmed (leading/trailing whitespace removed)
 *   - number  → String(number) (finite only; NaN / Infinity rejected)
 *
 * Rejects: everything else (boolean, null, undefined, object, array).
 */
export function normalizeId(raw: unknown, field: string): NormResult<string> {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return {
        ok: false,
        error: `${field} must be a non-empty string (or a number). Got an empty string.`,
      };
    }
    return { ok: true, value: trimmed };
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      return {
        ok: false,
        error: `${field} must be a finite number. Got ${String(raw)}.`,
      };
    }
    return { ok: true, value: String(raw) };
  }
  return {
    ok: false,
    error:
      `${field} must be a string or a number (both are normalized to a string). ` +
      `Got ${describeType(raw)}.`,
  };
}

/**
 * Normalize a pagination-class parameter (startAt / maxResults / limit).
 *
 * Accepts:
 *   - number         → must be an integer
 *   - numeric string → trimmed then parsed; must be an integer
 *
 * `min` (default 0) is the lower bound; values below it are rejected.
 * `max` (optional) is the upper bound: values above it are CLAMPED
 * (not rejected) and the result is flagged with `clamped: true` so the
 * caller can surface the effective value.
 */
export function normalizeInt(
  raw: unknown,
  field: string,
  opts: { min?: number; max?: number } = {},
): NormResult<number> {
  const min = opts.min ?? 0;
  const max = opts.max;

  // Wording is kept compatible with the pre-CP-3751 messages so existing
  // callers / tests that match on "positive integer" / "non-negative
  // integer" keep working: the only change is that a numeric STRING is
  // now accepted alongside a number.
  const label =
    min <= 0
      ? "non-negative integer"
      : min === 1
        ? "positive integer"
        : `integer >= ${min}`;

  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return {
        ok: false,
        error:
          `${field} must be a ${label} (number or numeric string are both accepted). ` +
          `Got an empty string.`,
      };
    }
    if (!/^[+-]?\d+$/.test(trimmed)) {
      return {
        ok: false,
        error:
          `${field} must be a ${label} (number or numeric string are both accepted). ` +
          `Got "${trimmed}".`,
      };
    }
    n = Number(trimmed);
  } else {
    return {
      ok: false,
      error:
        `${field} must be a ${label} (number or numeric string are both accepted). ` +
        `Got ${describeType(raw)}.`,
    };
  }

  if (!Number.isInteger(n)) {
    return {
      ok: false,
      error:
        `${field} must be a ${label} (number or numeric string are both accepted). ` +
        `Got ${String(n)}.`,
    };
  }
  if (n < min) {
    return {
      ok: false,
      error:
        `${field} must be a ${label} (number or numeric string are both accepted). ` +
        `Got ${String(n)}.`,
    };
  }
  if (max !== undefined && n > max) {
    return { ok: true, value: max, clamped: true };
  }
  return { ok: true, value: n };
}

/**
 * Normalize an array-class parameter (fields / mentions / labels /
 * block.blocks / block.blockedBy) to a trimmed string[].
 *
 * Accepts members of type string (trimmed, must be non-empty) or
 * finite number. Rejects any other member type (object / array /
 * boolean / null) instead of silently dropping it, so the caller gets
 * an actionable error rather than a quietly truncated request.
 *
 * An EMPTY array is accepted (callers use it to mean "no extra labels"
 * / "default field set"); it is not an error.
 */
export function normalizeStringArray(
  raw: unknown,
  field: string,
): NormResult<string[]> {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error:
        `${field} must be an array of strings or numbers. Got ${describeType(raw)}.`,
    };
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed.length === 0) {
        return {
          ok: false,
          error: `${field} must not contain empty strings.`,
        };
      }
      out.push(trimmed);
      continue;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        return {
          ok: false,
          error: `${field} must not contain non-finite numbers.`,
        };
      }
      out.push(String(item));
      continue;
    }
    return {
      ok: false,
      error:
        `${field} members must be strings or numbers (both normalized to strings). ` +
        `Got a ${describeType(item)} member.`,
    };
  }
  return { ok: true, value: out };
}

/**
 * Normalize the optional `block` parameter of create_task / create_subtask.
 *
 * Shape: `{ blockedBy?: string[], blocks?: string[] }` — both directions
 * are optional and independent. CP-3751: each member accepts string |
 * number → normalized to a string array.
 *
 * A missing / null `block` yields two empty arrays (not an error).
 */
export function normalizeBlockParam(
  raw: unknown,
): NormResult<{ blockedBy: string[]; blocks: string[] }> {
  if (raw === undefined || raw === null) {
    return { ok: true, value: { blockedBy: [], blocks: [] } };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      error: `block must be an object with optional \`blockedBy\` / \`blocks\` arrays.`,
    };
  }
  const obj = raw as Record<string, unknown>;
  const blockedBy =
    obj.blockedBy === undefined || obj.blockedBy === null
      ? { ok: true as const, value: [] as string[] }
      : normalizeStringArray(obj.blockedBy, "block.blockedBy");
  if (!blockedBy.ok) return blockedBy;
  const blocks =
    obj.blocks === undefined || obj.blocks === null
      ? { ok: true as const, value: [] as string[] }
      : normalizeStringArray(obj.blocks, "block.blocks");
  if (!blocks.ok) return blocks;
  return { ok: true, value: { blockedBy: blockedBy.value, blocks: blocks.value } };
}
