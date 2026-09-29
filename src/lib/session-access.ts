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

/** True when protected data must be cleared and the visitor returned to Sign in. */
export function accessEnded(state: AccessState): boolean {
  return state === "signed-out" || state === "denied";
}
