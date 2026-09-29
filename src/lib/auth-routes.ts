/**
 * The auth screens' shared rules: where a visitor is sent after signing in, how
 * an email address is normalised, and the one English message each failure gets.
 *
 * Deliberately pure — no Convex, no React, no DOM — so the backend
 * (`src/convex/companies.ts`) can share the registration error codes with the
 * screens without pulling in browser code, and so the rules can be unit tested.
 */

/* --------------------------------------------------------------- addresses */

/** Every address is compared, stored and looked up in this one shape. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** A very small check: something@something.something, no spaces. */
export const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/* ------------------------------------------------------------------ routes */

export const AUTH_PATHS = {
  signIn: "/auth",
  register: "/auth/register",
  forgot: "/auth/forgot",
  reset: "/auth/reset",
} as const;

/** Where a signed-in visitor lands when the URL asked for nothing specific. */
export const DEFAULT_AUTH_REDIRECT = "/dashboard";

/**
 * Only an in-app path is ever accepted, so `?returnTo=` cannot be used to send
 * someone to another site. `//evil.example` is a protocol-relative URL and is
 * refused for the same reason.
 */
export function resolveRedirectAfterAuth(
  returnTo: string | null | undefined,
  fallback: string = DEFAULT_AUTH_REDIRECT,
): string {
  if (returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//")) return returnTo;
  return fallback;
}

/** A sign-in link that remembers where the visitor was going. */
export function signInHref(returnTo?: string | null): string {
  if (!returnTo || returnTo === DEFAULT_AUTH_REDIRECT || !returnTo.startsWith("/") || returnTo.startsWith("//")) {
    return AUTH_PATHS.signIn;
  }
  return `${AUTH_PATHS.signIn}?returnTo=${encodeURIComponent(returnTo)}`;
}

/** One of the other auth screens, carrying the address that was typed. */
export function authHref(path: string, email?: string, extra?: Record<string, string>): string {
  const query = new URLSearchParams();
  const address = normalizeEmail(email ?? "");
  if (address) query.set("email", address);
  for (const [key, value] of Object.entries(extra ?? {})) query.set(key, value);
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}

/* ---------------------------------------------------------------- messages */

/**
 * One message for every failed sign-in: a wrong password, an address with no
 * account, and a rate-limited address all look and read the same, so the screen
 * never says whether an email address exists.
 */
export const SIGN_IN_ERROR = "The email address or password is incorrect.";

// The password-reset messages live with the reset rules in `./password-reset`
// (RESET_REQUEST_NOTICE and RESET_LINK_ERROR), so the policy stays in one place.

/* --------------------------------------------------- registration failures */

/** The registration failures the backend reports, and never anything else. */
export const REGISTRATION_ERROR_CODES = [
  "missing_name",
  "missing_company",
  "invalid_email",
  "weak_password",
  "email_taken",
] as const;
export type RegistrationErrorCode = (typeof REGISTRATION_ERROR_CODES)[number];

export const REGISTRATION_MESSAGES: Record<RegistrationErrorCode, string> = {
  missing_name: "Enter your name.",
  missing_company: "Enter your company name.",
  invalid_email: "Enter a valid email address.",
  weak_password: "Use a password of at least 8 characters.",
  email_taken: "An account already uses this email address. Sign in instead.",
};

export const REGISTRATION_FALLBACK = "We could not create the company account. Please try again.";

function isRegistrationErrorCode(value: unknown): value is RegistrationErrorCode {
  return typeof value === "string" && (REGISTRATION_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Reads the code a Convex function threw. `registerCompany` reports a failure
 * with `new ConvexError({ code })`, which reaches the browser as the error's
 * `data` payload.
 */
export function errorCode(error: unknown): RegistrationErrorCode | null {
  if (!error || typeof error !== "object" || !("data" in error)) return null;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object" || !("code" in data)) return null;
  const code = (data as { code?: unknown }).code;
  return isRegistrationErrorCode(code) ? code : null;
}

/** The English message for one known registration failure. */
export function registrationMessageFor(code: RegistrationErrorCode): string {
  return REGISTRATION_MESSAGES[code];
}

/** The English message for a failed registration, with a safe fallback. */
export function registrationMessage(error: unknown): string {
  const code = errorCode(error);
  return code ? REGISTRATION_MESSAGES[code] : REGISTRATION_FALLBACK;
}
