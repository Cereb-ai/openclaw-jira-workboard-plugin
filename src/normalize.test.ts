/**
 * normalize.ts unit tests (CP-3751).
 *
 * These are the RED-phase reproduction tests for the parameter-typing
 * hardening: before the fix the plugin rejected a numeric comment id,
 * a numeric-string page size and numeric array members outright
 * ("must be string" / "must be number"), which burned the agent's
 * circuit-breaker budget on a pure type guess.
 *
 * Coverage:
 *   - normalizeId      : number / string / padded string / empty / illegal types
 *   - normalizeInt     : number / numeric string / padded string / clamp /
 *                        non-integer / negative / illegal types
 *   - normalizeStringArray: string[] / number[] / mixed / empty / illegal member
 */
import { describe, it, expect } from "vitest";
import {
  normalizeId,
  normalizeInt,
  normalizeStringArray,
} from "./normalize.js";

describe("normalizeId (CP-3751)", () => {
  it("AC-3751-N-1: a number id is normalized to its string form", () => {
    const r = normalizeId(48060, "commentId");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("48060");
  });

  it("AC-3751-N-2: a string id is trimmed", () => {
    const r = normalizeId("  CP-3751  ", "issueIdOrKey");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("CP-3751");
  });

  it("AC-3751-N-3: an empty / whitespace-only id is rejected", () => {
    expect(normalizeId("", "commentId").ok).toBe(false);
    expect(normalizeId("   ", "commentId").ok).toBe(false);
  });

  it("AC-3751-N-4: illegal types (object / array / boolean / null) are rejected", () => {
    for (const bad of [{ a: 1 }, [1], true, null, undefined]) {
      const r = normalizeId(bad, "commentId");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("commentId");
    }
  });

  it("AC-3751-N-5: a non-finite number is rejected", () => {
    expect(normalizeId(Number.NaN, "commentId").ok).toBe(false);
    expect(normalizeId(Number.POSITIVE_INFINITY, "commentId").ok).toBe(false);
  });
});

describe("normalizeInt (CP-3751)", () => {
  it("AC-3751-N-6: a number is accepted when it is an integer", () => {
    const r = normalizeInt(20, "maxResults");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(20);
  });

  it("AC-3751-N-7: a numeric string is accepted and converted to an integer", () => {
    const r = normalizeInt("20", "maxResults");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(20);
  });

  it("AC-3751-N-8: a padded numeric string is trimmed before parsing", () => {
    const r = normalizeInt("  20  ", "startAt");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(20);
  });

  it("AC-3751-N-9: a value above `max` is CLAMPED (not rejected) and flagged", () => {
    const r = normalizeInt(500, "maxResults", { min: 1, max: 100 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(100);
      expect(r.clamped).toBe(true);
    }
  });

  it("AC-3751-N-10: a numeric string above `max` is clamped too", () => {
    const r = normalizeInt("500", "maxResults", { min: 1, max: 100 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(100);
      expect(r.clamped).toBe(true);
    }
  });

  it("AC-3751-N-11: a non-integer number is rejected", () => {
    expect(normalizeInt(2.5, "maxResults", { min: 1 }).ok).toBe(false);
  });

  it("AC-3751-N-12: a non-numeric string is rejected", () => {
    expect(normalizeInt("abc", "maxResults").ok).toBe(false);
    expect(normalizeInt("2.5", "maxResults").ok).toBe(false);
  });

  it("AC-3751-N-13: a value below `min` is rejected", () => {
    expect(normalizeInt(-1, "startAt", { min: 0 }).ok).toBe(false);
    expect(normalizeInt("0", "maxResults", { min: 1 }).ok).toBe(false);
  });

  it("AC-3751-N-14: illegal types (object / array / boolean / null) are rejected", () => {
    for (const bad of [{ a: 1 }, [1], true, null, undefined]) {
      const r = normalizeInt(bad, "maxResults");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("maxResults");
    }
  });

  it("AC-3751-N-15: an empty string is rejected", () => {
    expect(normalizeInt("", "maxResults").ok).toBe(false);
    expect(normalizeInt("   ", "maxResults").ok).toBe(false);
  });
});

describe("normalizeStringArray (CP-3751)", () => {
  it("AC-3751-N-16: a string array is accepted and trimmed", () => {
    const r = normalizeStringArray([" summary ", "status"], "fields");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(["summary", "status"]);
  });

  it("AC-3751-N-17: numeric members are normalized to strings", () => {
    const r = normalizeStringArray([10019], "fields");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(["10019"]);
  });

  it("AC-3751-N-18: mixed string / number members are normalized", () => {
    const r = normalizeStringArray([712020, "acc-2"], "mentionAccountIds");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(["712020", "acc-2"]);
  });

  it("AC-3751-N-19: an empty array is accepted", () => {
    const r = normalizeStringArray([], "labels");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it("AC-3751-N-20: an empty-string member is rejected", () => {
    expect(normalizeStringArray(["ok", ""], "labels").ok).toBe(false);
  });

  it("AC-3751-N-21: illegal member types (object / array / boolean / null) are rejected", () => {
    for (const bad of [{ a: 1 }, [1], true, null]) {
      const r = normalizeStringArray(["ok", bad], "labels");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("labels");
    }
  });

  it("AC-3751-N-22: a non-array value is rejected", () => {
    expect(normalizeStringArray("summary", "fields").ok).toBe(false);
    expect(normalizeStringArray(undefined, "fields").ok).toBe(false);
  });
});
