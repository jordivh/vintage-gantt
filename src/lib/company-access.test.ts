/**
 * Company isolation — the deep-link rule.
 *
 * A URL id is untrusted: it may name a record of another company. Resolution is
 * therefore always against the caller's own ids, and anything that does not
 * resolve is answered with one generic sentence that carries no identifier.
 */
import { describe, expect, test } from "bun:test";
import { UNAVAILABLE_NOTICE, scopedRefStatus } from "./company-access";

describe("company isolation — deep links", () => {
  test("an id the company holds resolves as found", () => {
    expect(scopedRefStatus("res-beta", ["res-beta", "res-beta-2"])).toBe("found");
  });

  test("an empty request is unset, not unavailable", () => {
    expect(scopedRefStatus("", ["res-beta"])).toBe("unset");
    expect(scopedRefStatus("   ", ["res-beta"])).toBe("unset");
  });

  test("another company's id, a deleted id and a typo all resolve as unavailable", () => {
    const own = ["res-beta"];
    expect(scopedRefStatus("res-alpha", own)).toBe("unavailable");
    expect(scopedRefStatus("res-deleted", own)).toBe("unavailable");
    expect(scopedRefStatus("res-btea", own)).toBe("unavailable");
    expect(scopedRefStatus("proj-alpha", own)).toBe("unavailable");
  });

  test("resolution is exact — no prefix or substring match can name another company", () => {
    expect(scopedRefStatus("res-beta", ["res-beta-2"])).toBe("unavailable");
    expect(scopedRefStatus("res", ["res-beta"])).toBe("unavailable");
  });

  test("the generic notice names no company, project or user", () => {
    const lowered = UNAVAILABLE_NOTICE.toLowerCase();
    for (const leak of ["alpha", "beta", "company", "project", "user", "id"]) {
      expect(lowered.includes(leak)).toBe(false);
    }
  });
});
