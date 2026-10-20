/* --------------------------------------------------------------------------
 * Session access — when the signed-in shell may show protected data.
 *
 * A page refresh must not lose a valid session, and a session that ends — sign
 * out, an account removed by a company admin, a suspended company — must not
 * leave a single protected record on screen. This module is the one pure rule
 * both facts are read from, so the store, the guard and the tests agree.
 * ------------------------------------------------------------------------ */

export const ACCESS_ENDED_MESSAGE = "Your access has ended. Please sign in again.";

export interface AccessFacts {
  /** The auth state has not been resolved yet: neither show nor redirect. */
  isLoading: boolean;
  isAuthenticated: boolean;
  /** A company admin removed this account's access. */
  removed: boolean;
  /** The company is active (a suspended company is cut off from its data). */
  companyActive: boolean;
}

export type AccessState = "loading" | "signed-out" | "denied" | "granted";

/**
 * - `loading` — the session is still being resolved; keep the shell as it is.
 * - `signed-out` — no session: protected data must be cleared and the visitor
 *   sent back to Sign in.
 * - `denied` — a session exists but no longer grants access: same treatment.
 * - `granted` — the session may read and write the company's data.
 */
export function accessState(facts: AccessFacts): AccessState {
  if (facts.isLoading) return "loading";
  if (!facts.isAuthenticated) return "signed-out";
  if (facts.removed) return "denied";
  if (!facts.companyActive) return "denied";
  return "granted";
}

/** A skipped user query must not keep signed-out browsers on the loading screen. */
export function authIsLoading(authLoading: boolean, authenticated: boolean, userPending: boolean): boolean {
  return authLoading || (authenticated && userPending);
}

/** A seed in flight blocks another seed, not hydration of its reactive result. */
export function workspaceLoadStep(hasState: boolean, initializing: boolean): "initialize" | "wait" | "hydrate" {
  if (hasState) return "hydrate";
  return initializing ? "wait" : "initialize";
}

/**
 * Whether the store should cover the route with "Loading planning data…".
 *
 * `RequireAuth` lives inside the store's children, so blocking `children`
 * before `access === "granted"` — or while `mustChangePassword` is true —
 * freezes an unauthenticated visitor or a temporary-password account on the
 * loading screen forever and prevents `<RequireAuth>` from redirecting to
 * `/auth` or `/account/password`.
 */
export function shouldBlockForPlanningReads(facts: {
  workspaceRoute: boolean;
  access: AccessState;
  mustChangePassword: boolean;
  hasPendingSave: boolean;
  saveBlocked: boolean;
  hydrated: boolean;
  remoteStatePending: boolean;
  waitingForRequestedVersion: boolean;
}): boolean {
  if (!facts.workspaceRoute || facts.access !== "granted" || facts.mustChangePassword) return false;
  if (facts.hasPendingSave || facts.saveBlocked) return false;
  return (!facts.hydrated && facts.remoteStatePending) || facts.waitingForRequestedVersion;
}

/** True when protected data must be cleared and the visitor returned to Sign in. */
export function accessEnded(state: AccessState): boolean {
  return state === "signed-out" || state === "denied";
}
