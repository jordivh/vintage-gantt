import { describe, expect, test } from "bun:test";
import {
  AUTH_PATHS,
  authHref,
  EMAIL_PATTERN,
  errorCode,
  normalizeEmail,
  REGISTRATION_ERROR_CODES,
  REGISTRATION_FALLBACK,
  REGISTRATION_MESSAGES,
  registrationMessage,
  registrationMessageFor,
  resolveRedirectAfterAuth,
  SIGN_IN_ERROR,
  signInHref,
} from "./auth-routes";

/** What the browser receives when a Convex function throws `ConvexError`. */
const convexError = (code: string) => ({ name: "ConvexError", message: "Server Error", data: { code } });

describe("normalizeEmail", () => {
  test("trims and lower-cases so one address has one shape", () => {
    expect(normalizeEmail("  Marta.Visser@Example.COM ")).toBe("marta.visser@example.com");
  });

  test("leaves an already normalised address alone", () => {
    expect(normalizeEmail("name@example.com")).toBe("name@example.com");
  });

  test("accepts ordinary addresses and refuses malformed ones", () => {
    expect(EMAIL_PATTERN.test("name@example.com")).toBe(true);
    expect(EMAIL_PATTERN.test("marta@keystone-exhibit.co.uk")).toBe(true);
    expect(EMAIL_PATTERN.test("name@example")).toBe(false);
    expect(EMAIL_PATTERN.test("name example.com")).toBe(false);
    expect(EMAIL_PATTERN.test("")).toBe(false);
  });
});

describe("resolveRedirectAfterAuth", () => {
  test("keeps an in-app destination, including its query string", () => {
    expect(resolveRedirectAfterAuth("/projects?filter=active")).toBe("/projects?filter=active");
    expect(resolveRedirectAfterAuth("/reports/margins")).toBe("/reports/margins");
  });

  test("falls back to the dashboard when nothing was requested", () => {
    expect(resolveRedirectAfterAuth(null)).toBe("/dashboard");
    expect(resolveRedirectAfterAuth(undefined)).toBe("/dashboard");
    expect(resolveRedirectAfterAuth("")).toBe("/dashboard");
  });

  test("refuses anything that is not an in-app path", () => {
    expect(resolveRedirectAfterAuth("https://evil.example/steal")).toBe("/dashboard");
    expect(resolveRedirectAfterAuth("//evil.example/steal")).toBe("/dashboard");
    expect(resolveRedirectAfterAuth("projects")).toBe("/dashboard");
  });

  test("uses the caller's fallback when one is given", () => {
    expect(resolveRedirectAfterAuth(null, "/capacity")).toBe("/capacity");
    expect(resolveRedirectAfterAuth("/projects", "/capacity")).toBe("/projects");
  });
});

describe("auth links", () => {
  test("sign-in keeps a destination worth returning to", () => {
    expect(signInHref("/projects?filter=active")).toBe("/auth?returnTo=%2Fprojects%3Ffilter%3Dactive");
  });

  test("sign-in stays plain for the default destination", () => {
    expect(signInHref("/dashboard")).toBe(AUTH_PATHS.signIn);
    expect(signInHref(null)).toBe(AUTH_PATHS.signIn);
    expect(signInHref("//evil.example")).toBe(AUTH_PATHS.signIn);
  });

  test("another screen carries the normalised address and the destination", () => {
    expect(authHref(AUTH_PATHS.reset, " Marta@Example.com ", { sent: "1" })).toBe(
      "/auth/reset?email=marta%40example.com&sent=1",
    );
    expect(authHref(AUTH_PATHS.forgot)).toBe("/auth/forgot");
    expect(authHref(AUTH_PATHS.register, undefined, { returnTo: "/capacity" })).toBe(
      "/auth/register?returnTo=%2Fcapacity",
    );
  });
});

describe("failed sign-in and reset messages", () => {
  test("there is exactly one sign-in error and it names no cause", () => {
    expect(SIGN_IN_ERROR).toBe("The email address or password is incorrect.");
    expect(SIGN_IN_ERROR).toContain("email address or password");
    expect(SIGN_IN_ERROR.includes("exist")).toBe(false);
    expect(SIGN_IN_ERROR.includes("found")).toBe(false);
  });

});

describe("registration failures", () => {
  test("every backend code has an English message", () => {
    for (const code of REGISTRATION_ERROR_CODES) {
      expect(typeof REGISTRATION_MESSAGES[code]).toBe("string");
      expect(REGISTRATION_MESSAGES[code].length).toBeGreaterThan(0);
    }
  });

  test("a taken address is the only message that mentions the account", () => {
    expect(registrationMessage(convexError("email_taken"))).toBe(
      "An account already uses this email address. Sign in instead.",
    );
    expect(registrationMessage(convexError("weak_password"))).toBe("Use a password of at least 8 characters.");
    expect(registrationMessage(convexError("invalid_email"))).toBe("Enter a valid email address.");
    expect(registrationMessage(convexError("missing_name"))).toBe("Enter your name.");
    expect(registrationMessage(convexError("missing_company"))).toBe("Enter your company name.");
  });

  test("a code the screen already knows can be named directly", () => {
    expect(registrationMessageFor("email_taken")).toBe("An account already uses this email address. Sign in instead.");
    expect(registrationMessageFor("invalid_email")).toBe(REGISTRATION_MESSAGES.invalid_email);
  });

  test("anything else falls back instead of leaking server text", () => {
    expect(registrationMessage(new Error("Uncaught Error: db write failed at companies.ts:42"))).toBe(
      REGISTRATION_FALLBACK,
    );
    expect(registrationMessage(undefined)).toBe(REGISTRATION_FALLBACK);
    expect(registrationMessage(convexError("something_else"))).toBe(REGISTRATION_FALLBACK);
  });

  test("only the known codes are read out of a thrown value", () => {
    expect(errorCode(convexError("email_taken"))).toBe("email_taken");
    expect(errorCode(convexError("nope"))).toBeNull();
    expect(errorCode({ data: "not-an-object" })).toBeNull();
    expect(errorCode(null)).toBeNull();
  });
});
