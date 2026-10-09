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
  NO_ACCOUNT_FOR_EMAIL_MESSAGE,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULES_TEXT,
  RECOVERY_NO_COMPANY_MESSAGE,
  RECOVERY_NOTICE,
  SELF_REMOVE_MESSAGE,
  WEAK_PASSWORD_MESSAGE,
  addUserDecision,
  mustChangePassword,
  normalizeAccountEmail,
  passwordProblem,
  recoveryPlan,
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

describe("company users — owner recovery, the last resort", () => {
  const facts = {
    accountExists: true,
    companyId: "company-1",
    removed: false,
    currentRole: "company_admin",
    otherActiveAdmins: 1,
  };

  test("an unknown address is refused, and so is an account without a company", () => {
    expect(recoveryPlan({ ...facts, accountExists: false }).ok).toBe(false);
    expect(recoveryPlan({ ...facts, accountExists: false }).message).toBe(NO_ACCOUNT_FOR_EMAIL_MESSAGE);
    expect(recoveryPlan({ ...facts, companyId: null }).ok).toBe(false);
    expect(recoveryPlan({ ...facts, companyId: null }).message).toBe(RECOVERY_NO_COMPANY_MESSAGE);
  });

  test("the account always leaves with a temporary password it must replace", () => {
    const plan = recoveryPlan(facts);
    expect(plan.ok).toBe(true);
    expect(plan.mustChangePassword).toBe(true);
    expect(RECOVERY_NOTICE.toLowerCase().includes("temporary")).toBe(true);
    expect(RECOVERY_NOTICE.toLowerCase().includes("change")).toBe(true);
  });

  test("an admin keeps its role, and a company with another admin is not handed a second one", () => {
    expect(recoveryPlan(facts).grantAdmin).toBe(false);
    expect(recoveryPlan({ ...facts, currentRole: "user", otherActiveAdmins: 1 }).grantAdmin).toBe(false);
  });

  test("admin is handed over only when nobody else could manage the company", () => {
    const plan = recoveryPlan({ ...facts, currentRole: "user", otherActiveAdmins: 0 });
    expect(plan.ok).toBe(true);
    expect(plan.grantAdmin).toBe(true);
    // A missing role is a plain user, which must not leave the company frozen.
    expect(recoveryPlan({ ...facts, currentRole: undefined, otherActiveAdmins: 0 }).grantAdmin).toBe(true);
  });

  test("a removal is lifted, and an active account is left alone", () => {
    expect(recoveryPlan({ ...facts, removed: true }).reinstate).toBe(true);
    expect(recoveryPlan(facts).reinstate).toBe(false);
  });
});
