/**
 * Session access — when the shell may show protected data.
 *
 * A valid session survives a refresh (the shell keeps it while the state is
 * resolving and grants it once resolved). A signed-out visitor, a removed
 * account and a suspended company all end access, which clears the screen and
 * returns to Sign in.
 */
import { describe, expect, test } from "bun:test";
import { ACCESS_ENDED_MESSAGE, accessEnded, accessState, authIsLoading, workspaceLoadStep } from "./session-access";

const granted = { isLoading: false, isAuthenticated: true, removed: false, companyActive: true };

describe("session access", () => {
  test("signed-out browsers don't wait for the skipped user subscription", () => {
    expect(authIsLoading(false, false, true)).toBe(false);
    expect(authIsLoading(true, false, true)).toBe(true);
    expect(authIsLoading(false, true, true)).toBe(true);
    expect(authIsLoading(false, true, false)).toBe(false);
  });

  test("workspace seed results hydrate even before the mutation promise resolves", () => {
    expect(workspaceLoadStep(false, false)).toBe("initialize");
    expect(workspaceLoadStep(false, true)).toBe("wait");
    expect(workspaceLoadStep(true, true)).toBe("hydrate");
    expect(workspaceLoadStep(true, false)).toBe("hydrate");
  });
  test("a valid session is granted once resolved — refresh does not lose it", () => {
    expect(accessState({ ...granted, isLoading: true })).toBe("loading");
    expect(accessState(granted)).toBe("granted");
  });

  test("a signed-out visitor has no access", () => {
    expect(accessState({ ...granted, isAuthenticated: false })).toBe("signed-out");
    expect(accessEnded("signed-out")).toBe(true);
  });

  test("a removed account has no access, whatever else is true", () => {
    expect(accessState({ ...granted, removed: true })).toBe("denied");
    expect(accessEnded("denied")).toBe(true);
  });

  test("a suspended company is cut off", () => {
    expect(accessState({ ...granted, companyActive: false })).toBe("denied");
  });

  test("loading neither shows data nor redirects", () => {
    expect(accessEnded("loading")).toBe(false);
    expect(accessEnded("granted")).toBe(false);
  });

  test("the message an ended session shows names no cause", () => {
    expect(ACCESS_ENDED_MESSAGE.toLowerCase().includes("removed")).toBe(false);
    expect(ACCESS_ENDED_MESSAGE.toLowerCase().includes("suspended")).toBe(false);
    expect(ACCESS_ENDED_MESSAGE.toLowerCase().includes("sign in")).toBe(true);
  });
});
