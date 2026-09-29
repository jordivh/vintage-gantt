/**
 * Company users — the invitation and account-management behaviour, exercised
 * through the real Convex functions (`convex-test`).
 *
 * A company admin invites an email address; the link is single-use and expires.
 * A regular user can do none of it, not even by calling the function directly.
 * Removing a user withdraws access without deleting any project, and a company
 * always keeps one company admin.
 *
 * The file lives outside `src/convex` on purpose: that directory must only hold
 * deployable modules.
 */
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { generateInvitationToken, hashInvitationToken } from "./invitation-token";

// `auth.ts` is mapped in so Convex Auth's own account and session mutations
// (`auth:store`) are available to `createAccount` / `invalidateSessions`.
const modules = {
  "./planner.ts": () => import("../convex/planner"),
  "./companies.ts": () => import("../convex/companies"),
  "./auth.ts": () => import("../convex/auth"),
  "./auth/emailOtp.ts": () => import("../convex/auth/emailOtp"),
  "./auth/passwordReset.ts": () => import("../convex/auth/passwordReset"),
  "./_generated/api.ts": () => import("../convex/_generated/api"),
  "./_generated/server.ts": () => import("../convex/_generated/server"),
};

/** Runs something that must be refused, and returns the refusal message. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

/** One company with an admin and a regular user. */
async function setup() {
  const t = convexTest(schema, modules);
  const adminId = await t.run((ctx) => ctx.db.insert("users", { name: "Alpha admin", email: "admin@alpha.example" }));
  await t.withIdentity({ subject: adminId }).mutation(api.companies.ensureCompany, {});
  const admin = await t.run((ctx) => ctx.db.get(adminId));
  const companyId = admin?.companyId;
  if (!companyId) throw new Error("setup failed: the admin has no company");
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Alpha user", email: "regular@alpha.example", companyId, companyRole: "user" }),
  );
  return { t, adminId, userId, companyId };
}

describe("company invitations — creating and keeping one link", () => {
  test("an admin invites an address, and only the token's hash is stored", async () => {
    const { t, adminId, companyId } = await setup();
    const created = await t.withIdentity({ subject: adminId }).mutation(api.companies.inviteMember, { email: "New@Example.com" });

    expect(created.email).toBe("new@example.com");
    const rows = await t.run((ctx) => ctx.db.query("invitations").collect());
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].companyId).toBe(companyId);
    expect(rows[0].tokenHash).toBe(await hashInvitationToken(created.token));
    // The raw value never lands in the database.
    expect(JSON.stringify(rows[0]).includes(created.token)).toBe(false);

    const pending = await t.withIdentity({ subject: adminId }).query(api.companies.pendingInvitations, {});
    expect(pending?.length).toBe(1);
    expect(pending?.[0].email).toBe("new@example.com");
  });

  test("a resend leaves exactly one working link", async () => {
    const { t, adminId } = await setup();
    const first = await t.withIdentity({ subject: adminId }).mutation(api.companies.inviteMember, { email: "invitee@example.com" });
    const second = await t.withIdentity({ subject: adminId }).mutation(api.companies.resendInvitation, { email: "invitee@example.com" });

    expect(first.token === second.token).toBe(false);
    const rows = await t.run((ctx) => ctx.db.query("invitations").collect());
    expect(rows.filter((row) => row.status === "pending").length).toBe(1);
    expect(rows.filter((row) => row.status === "revoked").length).toBe(1);
    const live = rows.find((row) => row.status === "pending");
    expect(live?.tokenHash).toBe(await hashInvitationToken(second.token));
  });

  test("an address that already has an account is refused, without naming anyone", async () => {
    const { t, adminId } = await setup();
    const message = await refusal(() =>
      t.withIdentity({ subject: adminId }).mutation(api.companies.inviteMember, { email: "regular@alpha.example" }),
    );
    expect(message.length).toBeGreaterThan(0);
    expect(message.includes("alpha.example")).toBe(false);
  });
});

describe("company invitations — regular users and other companies", () => {
  test("a regular user can neither invite, list nor revoke", async () => {
    const { t, adminId, userId } = await setup();
    const created = await t.withIdentity({ subject: adminId }).mutation(api.companies.inviteMember, { email: "x@example.com" });

    const invite = await refusal(() =>
      t.withIdentity({ subject: userId }).mutation(api.companies.inviteMember, { email: "y@example.com" }),
    );
    expect(invite.length).toBeGreaterThan(0);

    expect(await t.withIdentity({ subject: userId }).query(api.companies.pendingInvitations, {})).toBeNull();

    const revoke = await refusal(() =>
      t.withIdentity({ subject: userId }).mutation(api.companies.revokeInvitation, { invitationId: created.invitationId as never }),
    );
    expect(revoke.length).toBeGreaterThan(0);
    expect((await t.run((ctx) => ctx.db.query("invitations").collect()))[0].status).toBe("pending");
  });

  test("another company can neither see nor revoke an invitation", async () => {
    const { t, adminId } = await setup();
    const created = await t.withIdentity({ subject: adminId }).mutation(api.companies.inviteMember, { email: "invitee@example.com" });
    const otherId = await t.run((ctx) => ctx.db.insert("users", { name: "Beta admin", email: "admin@beta.example" }));
    await t.withIdentity({ subject: otherId }).mutation(api.companies.ensureCompany, {});

    expect((await t.withIdentity({ subject: otherId }).query(api.companies.pendingInvitations, {}))?.length).toBe(0);
    const revoke = await refusal(() =>
      t.withIdentity({ subject: otherId }).mutation(api.companies.revokeInvitation, { invitationId: created.invitationId as never }),
    );
    expect(revoke.length).toBeGreaterThan(0);
  });
});

describe("company invitations — accepting", () => {
  test("a live link creates a regular user, and can never be used twice", async () => {
    const { t, adminId, companyId } = await setup();
    const created = await t.withIdentity({ subject: adminId }).mutation(api.companies.inviteMember, { email: "joiner@example.com" });

    const accepted = await t.mutation(api.companies.acceptInvitation, { token: created.token, name: "Joiner", password: "password123" });
    expect(accepted.email).toBe("joiner@example.com");

    const joiner = await t.run((ctx) =>
      ctx.db.query("users").withIndex("email", (q) => q.eq("email", "joiner@example.com")).first(),
    );
    expect(joiner?.companyId).toBe(companyId);
    expect(joiner?.companyRole).toBe("user");
    expect(joiner?.name).toBe("Joiner");

    const reuse = await refusal(() =>
      t.mutation(api.companies.acceptInvitation, { token: created.token, name: "Joiner", password: "password123" }),
    );
    expect(reuse.length).toBeGreaterThan(0);
  });

  test("a revoked link fails safely and creates nothing", async () => {
    const { t, adminId } = await setup();
    const created = await t.withIdentity({ subject: adminId }).mutation(api.companies.inviteMember, { email: "invitee@example.com" });
    await t.withIdentity({ subject: adminId }).mutation(api.companies.revokeInvitation, { invitationId: created.invitationId as never });

    const message = await refusal(() =>
      t.mutation(api.companies.acceptInvitation, { token: created.token, name: "Invitee", password: "password123" }),
    );
    expect(message.length).toBeGreaterThan(0);
    expect(await t.run((ctx) => ctx.db.query("users").withIndex("email", (q) => q.eq("email", "invitee@example.com")).first())).toBeNull();
  });

  test("an expired link fails safely and creates nothing", async () => {
    const { t, adminId, companyId } = await setup();
    const token = generateInvitationToken();
    const tokenHash = await hashInvitationToken(token);
    await t.run((ctx) =>
      ctx.db.insert("invitations", {
        companyId,
        email: "late@example.com",
        tokenHash,
        status: "pending",
        invitedByUserId: adminId,
        createdAt: new Date(Date.now() - 10_000).toISOString(),
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    );

    const message = await refusal(() =>
      t.mutation(api.companies.acceptInvitation, { token, name: "Late", password: "password123" }),
    );
    expect(message.length).toBeGreaterThan(0);
    expect(await t.run((ctx) => ctx.db.query("users").withIndex("email", (q) => q.eq("email", "late@example.com")).first())).toBeNull();
    // The expired invitation is not silently consumed.
    expect((await t.run((ctx) => ctx.db.query("invitations").collect()))[0].status).toBe("pending");
  });

  test("an unknown token fails safely, and a weak password is refused", async () => {
    const { t, adminId } = await setup();
    const unknown = await refusal(() =>
      t.mutation(api.companies.acceptInvitation, { token: generateInvitationToken(), name: "Nobody", password: "password123" }),
    );
    expect(unknown.length).toBeGreaterThan(0);

    const created = await t.withIdentity({ subject: adminId }).mutation(api.companies.inviteMember, { email: "joiner@example.com" });
    const weak = await refusal(() =>
      t.mutation(api.companies.acceptInvitation, { token: created.token, name: "Joiner", password: "short" }),
    );
    expect(weak.length).toBeGreaterThan(0);
    // A failed attempt does not burn the still-valid link.
    const rows = await t.run((ctx) => ctx.db.query("invitations").collect());
    expect(rows[0].status).toBe("pending");
  });
});

describe("company users — removal and admin transfer", () => {
  test("removing a regular user blocks access but keeps every project", async () => {
    const { t, adminId, userId } = await setup();
    await t.withIdentity({ subject: adminId }).mutation(api.planner.initializeWorkspace, {});
    const before = await t.withIdentity({ subject: adminId }).query(api.planner.getState, {});

    await t.withIdentity({ subject: adminId }).mutation(api.companies.removeMember, { userId });

    // The removed account reads nothing and writes nothing.
    expect(await t.withIdentity({ subject: userId }).query(api.planner.getState, {})).toBeNull();
    const write = await refusal(() => t.withIdentity({ subject: userId }).mutation(api.planner.replaceState, { state: {} }));
    expect(write.length).toBeGreaterThan(0);

    // Nothing the company owns changed, and the account is gone from the list.
    const after = await t.withIdentity({ subject: adminId }).query(api.planner.getState, {});
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    const current = await t.withIdentity({ subject: adminId }).query(api.companies.current, {});
    expect(current?.members.some((member) => member.userId === userId)).toBe(false);
  });

  test("the last company admin can neither be removed nor demoted", async () => {
    const { t, adminId } = await setup();
    const removed = await refusal(() => t.withIdentity({ subject: adminId }).mutation(api.companies.removeMember, { userId: adminId }));
    expect(removed.length).toBeGreaterThan(0);
    const demoted = await refusal(() =>
      t.withIdentity({ subject: adminId }).mutation(api.companies.setMemberRole, { userId: adminId, role: "user" }),
    );
    expect(demoted.length).toBeGreaterThan(0);
  });

  test("an admin transfers company admin to another active user", async () => {
    const { t, adminId, userId } = await setup();
    await t.withIdentity({ subject: adminId }).mutation(api.companies.transferAdmin, { userId });

    expect((await t.run((ctx) => ctx.db.get(adminId)))?.companyRole).toBe("user");
    expect((await t.run((ctx) => ctx.db.get(userId)))?.companyRole).toBe("company_admin");

    // The new admin manages users; the former admin no longer can.
    await t.withIdentity({ subject: userId }).mutation(api.companies.inviteMember, { email: "later@example.com" });
    const denied = await refusal(() =>
      t.withIdentity({ subject: adminId }).mutation(api.companies.inviteMember, { email: "nope@example.com" }),
    );
    expect(denied.length).toBeGreaterThan(0);
  });

  test("a regular user cannot remove or transfer, even by calling directly", async () => {
    const { t, userId, adminId } = await setup();
    const removed = await refusal(() => t.withIdentity({ subject: userId }).mutation(api.companies.removeMember, { userId: adminId }));
    expect(removed.length).toBeGreaterThan(0);
    const transferred = await refusal(() => t.withIdentity({ subject: userId }).mutation(api.companies.transferAdmin, { userId }));
    expect(transferred.length).toBeGreaterThan(0);
  });
});
