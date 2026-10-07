/**
 * Company users — the pure rules behind account management.
 *
 * There is no invitation and no email: an admin creates an account directly with
 * a temporary password. A company must keep one admin; only an admin may manage
 * accounts; the password rule is stated once; and an address that is taken
 * anywhere is refused without naming the company it belongs to.
 */
import { describe, expect, test } from "bun:test";
import {
  ADMIN_ONLY_MESSAGE,
  ALREADY_ADMIN_MESSAGE,
  CURRENT_PASSWORD_WRONG_MESSAGE,
  EMAIL_TAKEN_MESSAGE,
  INVALID_EMAIL_MESSAGE,
  LAST_ADMIN_MESSAGE,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULES_TEXT,
  SELF_REMOVE_MESSAGE,
  WEAK_PASSWORD_MESSAGE,
  addUserDecision,
  mustChangePassword,
  normalizeAccountEmail,
  passwordProblem,
  removeMemberDecision,
  resetPasswordDecision,
  transferAdminDecision,
  userCreatedMessage,
} from "./company-users";

describe("company users — the password rule", () => {
  test("a password must be at least ten characters", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(10);
    expect(passwordProblem("x".repeat(9))).toBe(WEAK_PASSWORD_MESSAGE);
    expect(passwordProblem("x".repeat(10))).toBeNull();
    expect(WEAK_PASSWORD_MESSAGE).toContain("10");
  });

  test("the rule is stated next to the field and mentions the length", () => {
    expect(PASSWORD_RULES_TEXT).toContain("10");
  });

  test("an account is marked for a forced change only when the flag is true", () => {
    expect(mustChangePassword({ mustChangePassword: true })).toBe(true);
    expect(mustChangePassword({ mustChangePassword: false })).toBe(false);
    expect(mustChangePassword({})).toBe(false);
    expect(mustChangePassword(null)).toBe(false);
  });
});

describe("company users — creating an account", () => {
  test("a regular user can never create one, even directly", () => {
    const decision = addUserDecision({ actorRole: "user", email: "new@example.com", accountExists: false });
    expect(decision.ok).toBe(false);
    expect(decision.message).toBe(ADMIN_ONLY_MESSAGE);
  });

  test("an admin needs a valid, free email address", () => {
    expect(addUserDecision({ actorRole: "company_admin", email: "new@example.com", accountExists: false }).ok).toBe(true);
    expect(addUserDecision({ actorRole: "company_admin", email: "not-an-address", accountExists: false }).message).toBe(
      INVALID_EMAIL_MESSAGE,
    );
    expect(addUserDecision({ actorRole: "company_admin", email: "taken@example.com", accountExists: true }).message).toBe(
      EMAIL_TAKEN_MESSAGE,
    );
  });

  test("the taken-address message never reveals which company owns it", () => {
    for (const leak of ["alpha", "company", "belongs", "other company"]) {
      expect(EMAIL_TAKEN_MESSAGE.toLowerCase().includes(leak)).toBe(false);
    }
  });

  test("an address is stored in one shape", () => {
    expect(normalizeAccountEmail("  Marta@Example.COM ")).toBe("marta@example.com");
  });

  test("the confirmation names the address and tells the admin to share the password", () => {
    const message = userCreatedMessage(" New@Example.com ");
    expect(message.includes("new@example.com")).toBe(true);
    expect(message.toLowerCase().includes("share")).toBe(true);
    expect(message.toLowerCase().includes("change")).toBe(true);
  });
});

describe("company users — resetting a password", () => {
  test("an admin may reset only an account of their own company", () => {
    expect(resetPasswordDecision({ actorRole: "company_admin", sameCompany: true }).ok).toBe(true);
    expect(resetPasswordDecision({ actorRole: "company_admin", sameCompany: false }).ok).toBe(false);
    expect(resetPasswordDecision({ actorRole: "user", sameCompany: true }).ok).toBe(false);
    expect(resetPasswordDecision({ actorRole: "user", sameCompany: true }).message).toBe(ADMIN_ONLY_MESSAGE);
  });

  test("the wrong-current-password message leaks nothing", () => {
    expect(CURRENT_PASSWORD_WRONG_MESSAGE.toLowerCase().includes("exist")).toBe(false);
  });
});

describe("company users — membership decisions", () => {
  const base = {
    actorRole: "company_admin",
    actorUserId: "user-admin",
    targetUserId: "user-regular",
    targetRole: "user",
    adminCount: 2,
    targetRemoved: false,
  };

  test("a regular user can never manage accounts", () => {
    for (const decision of [removeMemberDecision({ ...base, actorRole: "user" }), transferAdminDecision({ ...base, actorRole: "user" })]) {
      expect(decision.ok).toBe(false);
      expect(decision.message).toBe(ADMIN_ONLY_MESSAGE);
    }
  });

  test("an admin can remove a regular user", () => {
    expect(removeMemberDecision(base).ok).toBe(true);
  });

  test("the last admin can never be removed, and no one can remove themselves", () => {
    const lastAdmin = removeMemberDecision({ ...base, targetUserId: "user-admin2", targetRole: "company_admin", adminCount: 1 });
    expect(lastAdmin.ok).toBe(false);
    expect(lastAdmin.message).toBe(LAST_ADMIN_MESSAGE);
    const self = removeMemberDecision({ ...base, targetUserId: "user-admin" });
    expect(self.ok).toBe(false);
    expect(self.message).toBe(SELF_REMOVE_MESSAGE);
  });

  test("an already-removed account is refused", () => {
    expect(removeMemberDecision({ ...base, targetRemoved: true }).ok).toBe(false);
    expect(transferAdminDecision({ ...base, targetRemoved: true }).ok).toBe(false);
  });

  test("admin transfer needs another active regular user", () => {
    expect(transferAdminDecision(base).ok).toBe(true);
    expect(transferAdminDecision({ ...base, targetUserId: "user-admin" }).message).toBe(ALREADY_ADMIN_MESSAGE);
    expect(transferAdminDecision({ ...base, targetRole: "company_admin" }).message).toBe(ALREADY_ADMIN_MESSAGE);
  });
});
