/* --------------------------------------------------------------------------
 * Password recovery — the rules.
 *
 * A reset is one personal, single-use link with a limited lifetime. This module
 * holds the whole policy in one pure place, so the backend, the screen and the
 * tests cannot drift: how long a link lives, what state it is in, which failures
 * are indistinguishable, and the two messages a visitor may ever see.
 *
 * The request answer is deliberately a constant. Whether an address has an
 * account, whether a link is valid, expired or already spent — nothing about it
 * is observable from the outside, and no message ever contains a link value.
 * ------------------------------------------------------------------------ */

import { EMAIL_PATTERN, normalizeEmail } from "./auth-routes";

export { EMAIL_PATTERN, normalizeEmail };

/** How long a reset link stays usable. */
export const PASSWORD_RESET_TTL_MINUTES = 30;
export const PASSWORD_RESET_TTL_MS = PASSWORD_RESET_TTL_MINUTES * 60 * 1000;

/** The screen a reset link opens, and the shortest password we accept. */
export const RESET_LINK_PATH = "/auth/reset";
export const PASSWORD_MIN_LENGTH = 8;

/**
 * The one answer to a reset request, whatever the address. It names no account
 * and confirms nothing, so a visitor can never learn whether an address exists.
 */
export const RESET_REQUEST_NOTICE =
  "If an account exists for that email address, we have sent a link to set a new password. The link expires after 30 minutes and can be used once.";

/** One message for every rejected link: wrong, expired and already used read the same. */
export const RESET_LINK_ERROR =
  "This password reset link is not valid, has expired or has already been used. Request a new one.";

export const PASSWORD_MISMATCH_ERROR = "The two passwords do not match.";
export const WEAK_PASSWORD_ERROR = "Use a password of at least 8 characters.";

export interface ResetLike {
  usedAt?: unknown;
  expiresAt?: unknown;
  tokenHash?: unknown;
}

export type ResetState = "valid" | "expired" | "used";

/** The state of a reset link at `nowMs`, or null when it is not a link at all. */
export function resetState(record: ResetLike | null | undefined, nowMs: number): ResetState | null {
  if (!record || typeof record.tokenHash !== "string" || !record.tokenHash) return null;
  if (typeof record.usedAt === "string" && record.usedAt) return "used";
  const expiresAt = typeof record.expiresAt === "string" ? record.expiresAt : "";
  const expiry = Date.parse(expiresAt);
  if (!expiresAt || Number.isNaN(expiry) || expiry <= nowMs) return "expired";
  return "valid";
}

export const RESET_ERROR_CODES = ["invalid", "expired", "used", "weak_password"] as const;
export type ResetErrorCode = (typeof RESET_ERROR_CODES)[number];

export interface ResetDecision {
  ok: boolean;
  state: ResetState | null;
  code: ResetErrorCode | null;
  message: string;
}

/**
 * Whether a reset link may be used. Every refusal is the same sentence, so a
 * guessed value, a spent link and an expired one cannot be told apart.
 */
export function resetDecision(record: ResetLike | null | undefined, nowMs: number): ResetDecision {
  const state = resetState(record, nowMs);
  if (state === "valid") return { ok: true, state, code: null, message: "" };
  const code: ResetErrorCode = state === "used" ? "used" : state === "expired" ? "expired" : "invalid";
  return { ok: false, state, code, message: RESET_LINK_ERROR };
}

/** The expiry an account's newest link gets, replacing any earlier one. */
export function resetExpiry(nowMs: number, ttlMs: number = PASSWORD_RESET_TTL_MS): string {
  return new Date(nowMs + ttlMs).toISOString();
}

/** The message for a refused password, or null when it is acceptable. */
export function passwordProblem(password: string): string | null {
  return password.length >= PASSWORD_MIN_LENGTH ? null : WEAK_PASSWORD_ERROR;
}

/** The link a reset email carries. */
export function passwordResetHref(token: string, origin = ""): string {
  const base = origin && origin !== "null" ? origin.replace(/\/+$/, "") : "";
  return `${base}${RESET_LINK_PATH}?token=${encodeURIComponent(token)}`;
}

/** The reset value carried by a URL's query string, or "" when there is none. */
export function readResetToken(search: string): string {
  const query = search.startsWith("?") ? search.slice(1) : search;
  for (const part of query.split("&")) {
    const [key, ...rest] = part.split("=");
    if (key === "token") return decodeURIComponent(rest.join("="));
  }
  return "";
}

/** The code a refused reset threw (`new ConvexError({ code })`). */
export function resetErrorCode(error: unknown): ResetErrorCode | null {
  if (!error || typeof error !== "object" || !("data" in error)) return null;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object" || !("code" in data)) return null;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" && (RESET_ERROR_CODES as readonly string[]).includes(code)
    ? (code as ResetErrorCode)
    : null;
}

/** The English message for a refused reset. Never echoes the link or the password. */
export function resetErrorMessage(error: unknown): string {
  return resetErrorCode(error) === "weak_password" ? WEAK_PASSWORD_ERROR : RESET_LINK_ERROR;
}
