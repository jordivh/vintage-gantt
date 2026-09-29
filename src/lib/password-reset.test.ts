/**
 * Password recovery — the pure policy.
 *
 * A request always answers the same way; a link is single-use and expires; a
 * wrong, spent or expired link is indistinguishable; and no message, link or
 * token ever contains a secret.
 */
import { describe, expect, test } from "bun:test";
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MISMATCH_ERROR,
  PASSWORD_RESET_TTL_MINUTES,
  PASSWORD_RESET_TTL_MS,
  RESET_LINK_ERROR,
  RESET_REQUEST_NOTICE,
  WEAK_PASSWORD_ERROR,
  passwordProblem,
  passwordResetHref,
  readResetToken,
  resetDecision,
  resetErrorCode,
  resetErrorMessage,
  resetExpiry,
  resetState,
} from "./password-reset";

const NOW = Date.parse("2026-03-02T10:00:00.000Z");
const future = (ms: number) => new Date(NOW + ms).toISOString();
const past = (ms: number) => new Date(NOW - ms).toISOString();
const live = { tokenHash: "abc", expiresAt: future(60_000) };

describe("password reset — the request answer", () => {
  test("one constant answer, identical for every address", () => {
    expect(RESET_REQUEST_NOTICE.includes("@")).toBe(false);
    expect(RESET_REQUEST_NOTICE.includes("exists for that email")).toBe(true);
    expect(RESET_REQUEST_NOTICE.toLowerCase().includes("token")).toBe(false);
  });
});

describe("password reset — link lifetime", () => {
  test("a link lasts a limited, configured time", () => {
    expect(PASSWORD_RESET_TTL_MINUTES).toBe(30);
    expect(Date.parse(resetExpiry(NOW)) - NOW).toBe(PASSWORD_RESET_TTL_MS);
  });

  test("valid, expired and used are all the states a link can be in", () => {
    expect(resetState(live, NOW)).toBe("valid");
    expect(resetState({ ...live, expiresAt: past(1) }, NOW)).toBe("expired");
    expect(resetState({ ...live, usedAt: past(1) }, NOW)).toBe("used");
    // A used link stays used even if its clock has not run out.
    expect(resetState({ ...live, usedAt: past(1) }, NOW)).toBe("used");
    expect(resetState(null, NOW)).toBeNull();
    expect(resetState({ expiresAt: future(1000) }, NOW)).toBeNull();
  });
});

describe("password reset — decisions", () => {
  test("only a live link may be used", () => {
    expect(resetDecision(live, NOW).ok).toBe(true);
    expect(resetDecision({ ...live, expiresAt: past(1) }, NOW).code).toBe("expired");
    expect(resetDecision({ ...live, usedAt: past(1) }, NOW).code).toBe("used");
    expect(resetDecision(null, NOW).code).toBe("invalid");
  });

  test("every rejected link reads the same and names nothing", () => {
    for (const record of [null, { ...live, expiresAt: past(1) }, { ...live, usedAt: past(1) }]) {
      const decision = resetDecision(record, NOW);
      expect(decision.ok).toBe(false);
      expect(decision.message).toBe(RESET_LINK_ERROR);
      expect(decision.message.includes("token")).toBe(false);
      expect(decision.message.includes("expired for")).toBe(false);
    }
  });

  test("a thrown reset error maps back to a safe message", () => {
    expect(resetErrorCode({ data: { code: "expired" } })).toBe("expired");
    expect(resetErrorMessage({ data: { code: "used" } })).toBe(RESET_LINK_ERROR);
    expect(resetErrorMessage({ data: { code: "weak_password" } })).toBe(WEAK_PASSWORD_ERROR);
    expect(resetErrorCode(new Error("boom"))).toBeNull();
    expect(resetErrorMessage({ data: { code: "nope" } })).toBe(RESET_LINK_ERROR);
  });
});

describe("password reset — the link and the password", () => {
  test("the link carries the value on the app's own origin", () => {
    expect(passwordResetHref("abc", "https://app.example")).toBe("https://app.example/auth/reset?token=abc");
    expect(passwordResetHref("abc", "https://app.example/")).toBe("https://app.example/auth/reset?token=abc");
    expect(passwordResetHref("a b")).toBe("/auth/reset?token=a%20b");
  });

  test("the value is read back from a URL, and nothing else is", () => {
    expect(readResetToken("?token=abc")).toBe("abc");
    expect(readResetToken("?email=x%40y.z&token=a%20b&sent=1")).toBe("a b");
    expect(readResetToken("?sent=1")).toBe("");
    expect(readResetToken("")).toBe("");
  });

  test("a short password is refused; a long one is accepted", () => {
    expect(passwordProblem("x".repeat(PASSWORD_MIN_LENGTH - 1))).toBe(WEAK_PASSWORD_ERROR);
    expect(passwordProblem("x".repeat(PASSWORD_MIN_LENGTH))).toBeNull();
    expect(PASSWORD_MISMATCH_ERROR.includes("password")).toBe(true);
  });
});
