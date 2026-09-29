/**
 * Company users — the pure rules behind invitations and account management.
 *
 * A used, expired, revoked or unknown link must fail safely; a company must keep
 * one admin; only an admin may manage users; and an invitation is a single-use
 * value that is never stored in the clear.
 */
import { describe, expect, test } from "bun:test";
import {
  ADMIN_ONLY_MESSAGE,
  ALREADY_ADMIN_MESSAGE,
  INVITATION_ERROR_MESSAGES,
  INVITATION_TTL_DAYS,
  INVITATION_TTL_MS,
  LAST_ADMIN_MESSAGE,
  SELF_REMOVE_MESSAGE,
  invitationAcceptHref,
  invitationDecision,
  invitationErrorCode,
  invitationErrorMessage,
  invitationExpiry,
  invitationState,
  inviteDecision,
  isUsableInvitation,
  removeMemberDecision,
  replaceableInvitations,
  transferAdminDecision,
} from "./company-users";
import { generateInvitationToken, hashInvitationToken } from "./invitation-token";

const NOW = Date.parse("2026-05-01T12:00:00.000Z");
const future = (ms: number) => new Date(NOW + ms).toISOString();
const past = (ms: number) => new Date(NOW - ms).toISOString();

const pending = { status: "pending", expiresAt: future(60_000) };

describe("company users — invitation states", () => {
  test("an invitation lasts a week by default", () => {
    expect(INVITATION_TTL_DAYS).toBe(7);
    expect(Date.parse(invitationExpiry(NOW)) - NOW).toBe(INVITATION_TTL_MS);
  });

  test("a pending invitation past its expiry reads as expired, not pending", () => {
    expect(invitationState({ status: "pending", expiresAt: past(1000) }, NOW)).toBe("expired");
    expect(invitationState(pending, NOW)).toBe("pending");
    expect(invitationState({ status: "pending" }, NOW)).toBe("expired");
  });

  test("accepted and revoked are final, whatever the dates say", () => {
    expect(invitationState({ status: "accepted", expiresAt: future(60_000) }, NOW)).toBe("accepted");
    expect(invitationState({ status: "revoked", expiresAt: future(60_000) }, NOW)).toBe("revoked");
  });

  test("a record that is not an invitation is unknown, never usable", () => {
    expect(invitationState(null, NOW)).toBeNull();
    expect(invitationState({ status: "whatever" }, NOW)).toBeNull();
    expect(isUsableInvitation(null, NOW)).toBe(false);
    expect(isUsableInvitation(pending, NOW)).toBe(true);
  });
});

describe("company users — acceptance decisions", () => {
  test("only a live pending invitation may be accepted", () => {
    expect(invitationDecision(pending, NOW).ok).toBe(true);
    expect(invitationDecision({ status: "pending", expiresAt: past(1) }, NOW).code).toBe("expired");
    expect(invitationDecision({ status: "accepted" }, NOW).code).toBe("used");
    expect(invitationDecision({ status: "revoked" }, NOW).code).toBe("revoked");
    expect(invitationDecision(null, NOW).code).toBe("invalid");
  });

  test("every refusal has a generic message that names nothing", () => {
    for (const record of [null, { status: "accepted" }, { status: "revoked" }, { status: "pending", expiresAt: past(1) }]) {
      const decision = invitationDecision(record, NOW);
      expect(decision.ok).toBe(false);
      const lowered = decision.message.toLowerCase();
      for (const leak of ["alpha", "beta", "company name", "@", "id "]) expect(lowered.includes(leak)).toBe(false);
    }
  });

  test("a thrown invitation error maps back to its message", () => {
    const thrown = { data: { code: "expired" } };
    expect(invitationErrorCode(thrown)).toBe("expired");
    expect(invitationErrorMessage(thrown)).toBe(INVITATION_ERROR_MESSAGES.expired);
    expect(invitationErrorCode(new Error("boom"))).toBeNull();
    expect(invitationErrorMessage(new Error("boom"))).toBe(INVITATION_ERROR_MESSAGES.fallback);
  });

  test("the acceptance link carries the token, encoded", () => {
    expect(invitationAcceptHref("abc", "https://app.example")).toBe("https://app.example/auth/accept?token=abc");
    expect(invitationAcceptHref("abc", "https://app.example/")).toBe("https://app.example/auth/accept?token=abc");
    expect(invitationAcceptHref("a b")).toBe("/auth/accept?token=a%20b");
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

  test("a regular user can never manage users", () => {
    for (const decision of [
      removeMemberDecision({ ...base, actorRole: "user" }),
      transferAdminDecision({ ...base, actorRole: "user" }),
      inviteDecision({ actorRole: "user", email: "new@example.com", accountExists: false }),
    ]) {
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

  test("an invitation needs an address without an account", () => {
    expect(inviteDecision({ actorRole: "company_admin", email: "new@example.com", accountExists: false }).ok).toBe(true);
    expect(inviteDecision({ actorRole: "company_admin", email: "taken@example.com", accountExists: true }).ok).toBe(false);
    expect(inviteDecision({ actorRole: "company_admin", email: "", accountExists: false }).ok).toBe(false);
  });

  test("a resend replaces exactly the pending invitations for that address", () => {
    const rows = [
      { email: "a@example.com", status: "pending" },
      { email: "a@example.com", status: "revoked" },
      { email: "b@example.com", status: "pending" },
    ];
    const replaced = replaceableInvitations(rows, "A@Example.com");
    expect(replaced.length).toBe(1);
    expect(replaced[0].status).toBe("pending");
    expect(replaced[0].email).toBe("a@example.com");
  });
});

describe("company users — invitation tokens", () => {
  test("a token is long, and only its hash is stored", async () => {
    const token = generateInvitationToken();
    expect(token.length).toBe(64);
    const hash = await hashInvitationToken(token);
    expect(hash).toBe(await hashInvitationToken(token));
    expect(hash).not.toBe(token);
    expect(hash.length).toBe(64);
  });

  test("two invitations never share a token", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateInvitationToken()));
    expect(tokens.size).toBe(50);
  });
});
