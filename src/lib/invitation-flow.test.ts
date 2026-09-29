/**
 * The invitation flow — the link as its own record, the page it opens, and the
 * email that carries it.
 *
 * Exercised through the real Convex functions (`convex-test`): what a link
 * reports before anything happens, what accepting creates, and what happens when
 * the link is opened while another account is signed in. The email template is
 * pure, so its exact wording and structure are asserted directly.
 *
 * The file lives outside `src/convex` on purpose: that directory must only hold
 * deployable modules.
 */
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import {
  INVITATION_CANCEL,
  INVITATION_SIGN_OUT_AND_ACCEPT,
  INVITATION_TTL_DAYS,
  invitationAnonymousSessionNotice,
  invitationHandledNotice,
  invitationSessionNotice,
  invitationStateMessage,
} from "./company-users";
import { INVITATION_BUTTON_LABEL, invitationEmail, invitationEmailSubject } from "./invitation-email";
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

/** One company, its admin, and the id of the invitation rows it owns. */
async function setup() {
  const t = convexTest(schema, modules);
  const adminId = await t.run((ctx) => ctx.db.insert("users", { name: "Alpha admin", email: "admin@alpha.example" }));
  const report = await t.withIdentity({ subject: adminId }).mutation(api.companies.ensureCompany, {});
  const admin = await t.run((ctx) => ctx.db.get(adminId));
  const companyId = admin?.companyId;
  if (!companyId) throw new Error("setup failed: the admin has no company");
  return { t, adminId, companyId, companyName: report.companyName };
}

/** Every invitation row, newest first. */
const rowsOf = (t: Awaited<ReturnType<typeof setup>>["t"]) => t.run((ctx) => ctx.db.query("invitations").collect());

/** The users holding one email address. */
const accountsFor = (t: Awaited<ReturnType<typeof setup>>["t"], email: string) =>
  t.run((ctx) => ctx.db.query("users").withIndex("email", (q) => q.eq("email", email)).collect());

describe("an invitation link — what it reports before anything happens", () => {
  test("a live link names the invited address and the inviting company", async () => {
    const { t, adminId, companyName } = await setup();
    const created = await t.withIdentity({ subject: adminId }).mutation(api.companies.inviteMember, {
      email: "Joiner@Example.com",
    });

    const preview = await t.query(api.companies.invitationPreview, { token: created.token });
    expect(preview.state).toBe("pending");
    expect(preview.email).toBe("joiner@example.com");
    expect(preview.companyName).toBe(companyName);
    expect(preview.message).toBe("");
  });

  test("the address is normalised, so a link always reports one spelling", async () => {
    const { t, adminId } = await setup();
    const created = await t.withIdentity({ subject: adminId }).mutation(api.companies.inviteMember, {
      email: " Joiner@Example.com ",
    });
    const preview = await t.query(api.companies.invitationPreview, { token: created.token });
    expect(preview.email).toBe("joiner@example.com");
  });

  test("an unknown link says only that, and names nothing", async () => {
    const { t } = await setup();
    const preview = await t.query(api.companies.invitationPreview, { token: generateInvitationToken() });
    expect(preview.state).toBe("invalid");
    expect(preview.email).toBeNull();
    expect(preview.companyName).toBeNull();
    expect(preview.message).toBe(invitationStateMessage("invalid"));
  });

  test("an empty link says only that, and never throws", async () => {
    const { t } = await setup();
    const preview = await t.query(api.companies.invitationPreview, { token: "   " });
    expect(preview.state).toBe("invalid");
    expect(preview.email).toBeNull();
  });

  test("an expired, revoked and already-used link each report their own neutral sentence", async () => {
    const { t, adminId, companyId } = await setup();

    // Expired: a pending row whose expiry has passed can never be used.
    const expiredToken = generateInvitationToken();
    const expiredHash = await hashInvitationToken(expiredToken);
    await t.run((ctx) =>
      ctx.db.insert("invitations", {
        companyId,
        email: "late@example.com",
        tokenHash: expiredHash,
        status: "pending",
        invitedByUserId: adminId,
        createdAt: new Date(Date.now() - 10_000).toISOString(),
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    );
    const expired = await t.query(api.companies.invitationPreview, { token: expiredToken });
    expect(expired.state).toBe("expired");
    expect(expired.message).toBe(invitationStateMessage("expired"));
    expect(expired.email).toBeNull();

    // Revoked: an admin withdrew the link.
    const revoked = await t.withIdentity({ subject: adminId }).mutation(api.companies.inviteMember, {
      email: "gone@example.com",
    });
    await t
      .withIdentity({ subject: adminId })
      .mutation(api.companies.revokeInvitation, { invitationId: revoked.invitationId as never });
    const revokedPreview = await t.query(api.companies.invitationPreview, { token: revoked.token });
    expect(revokedPreview.state).toBe("revoked");
    expect(revokedPreview.message).toBe(invitationStateMessage("revoked"));
    expect(revokedPreview.companyName).toBeNull();

    // Used: the link was spent by a successful acceptance.
    const used = await t.withIdentity({ subject: adminId }).mutation(api.companies.inviteMember, {
      email: "done@example.com",
    });
    await t.mutation(api.companies.acceptInvitation, { token: used.token, name: "Done", password: "password123" });
    const usedPreview = await t.query(api.companies.invitationPreview, { token: used.token });
    expect(usedPreview.state).toBe("accepted");
    expect(usedPreview.message).toBe(invitationStateMessage("accepted"));
  });

  test("looking at a link never signs anybody in and creates no account", async () => {
    const { t, adminId } = await setup();
    const created = await t.withIdentity({ subject: adminId }).mutation(api.companies.inviteMember, {
      email: "joiner@example.com",
    });

    await t.query(api.companies.invitationPreview, { token: created.token });
    expect((await accountsFor(t, "joiner@example.com")).length).toBe(0);
    expect((await rowsOf(t))[0].status).toBe("pending");
  });
});

describe("an invitation link — creating the invited account", () => {
  test("a live link creates one new regular user in the inviting company, and is spent", async () => {
    const { t, adminId, companyId } = await setup();
    const created = await t.withIdentity({ subject: adminId }).mutation(api.companies.inviteMember, {
      email: "joiner@example.com",
    });

    const accepted = await t.mutation(api.companies.acceptInvitation, {
      token: created.token,
      name: "Joiner",
      password: "password123",
    });
    expect(accepted.email).toBe("joiner@example.com");

    const joiners = await accountsFor(t, "joiner@example.com");
    expect(joiners.length).toBe(1);
    expect(joiners[0].companyId).toBe(companyId);
    // A regular user: they never manage users or invitations.
    expect(joiners[0].companyRole).toBe("user");

    const rows = await rowsOf(t);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("accepted");
    expect(rows[0].acceptedByUserId).toBe(joiners[0]._id);

    const reuse = await refusal(() =>
      t.mutation(api.companies.acceptInvitation, { token: created.token, name: "Joiner", password: "password123" }),
    );
    expect(reuse.length).toBeGreaterThan(0);
    expect((await accountsFor(t, "joiner@example.com")).length).toBe(1);
  });

  test("the link never authenticates or touches an account that already exists", async () => {
    const { t, adminId, companyId } = await setup();
    const created = await t.withIdentity({ subject: adminId }).mutation(api.companies.inviteMember, {
      email: "later@example.com",
    });
    // The address gains its own account after the invitation was sent.
    const existingId = await t.run((ctx) =>
      ctx.db.insert("users", { name: "Later", email: "later@example.com", companyId, companyRole: "user" }),
    );

    const message = await refusal(() =>
      t.mutation(api.companies.acceptInvitation, { token: created.token, name: "Later", password: "password123" }),
    );
    expect(message.length).toBeGreaterThan(0);

    // The existing account is untouched and no second one was created.
    expect((await t.run((ctx) => ctx.db.get(existingId)))?.name).toBe("Later");
    expect((await accountsFor(t, "later@example.com")).length).toBe(1);

    // And it stays refused for as long as that account exists.
    const again = await refusal(() =>
      t.mutation(api.companies.acceptInvitation, { token: created.token, name: "Later", password: "password123" }),
    );
    expect(again.length).toBeGreaterThan(0);
    expect((await accountsFor(t, "later@example.com")).length).toBe(1);
  });

  test("a revoked link is refused and creates nothing", async () => {
    const { t, adminId } = await setup();
    const created = await t.withIdentity({ subject: adminId }).mutation(api.companies.inviteMember, {
      email: "invitee@example.com",
    });
    await t
      .withIdentity({ subject: adminId })
      .mutation(api.companies.revokeInvitation, { invitationId: created.invitationId as never });

    const message = await refusal(() =>
      t.mutation(api.companies.acceptInvitation, { token: created.token, name: "Invitee", password: "password123" }),
    );
    expect(message.length).toBeGreaterThan(0);
    expect((await accountsFor(t, "invitee@example.com")).length).toBe(0);
  });

  test("an expired link is refused and creates nothing", async () => {
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
    expect((await accountsFor(t, "late@example.com")).length).toBe(0);
  });
});

describe("an invitation opened while an account is signed in", () => {
  test("the account the invitation was sent to settles it, and no second account is created", async () => {
    const { t, adminId, companyId } = await setup();
    const created = await t.withIdentity({ subject: adminId }).mutation(api.companies.inviteMember, {
      email: "same@example.com",
    });
    const sameId = await t.run((ctx) =>
      ctx.db.insert("users", { name: "Same", email: "Same@Example.com", companyId, companyRole: "user" }),
    );

    const settled = await t
      .withIdentity({ subject: sameId })
      .mutation(api.companies.handleInvitationForCurrentAccount, { token: created.token });

    expect(settled.ok).toBe(true);
    expect(settled.email).toBe("same@example.com");
    expect(settled.alreadyMember).toBe(true);

    const rows = await rowsOf(t);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("accepted");
    expect(rows[0].acceptedByUserId).toBe(sameId);
    // Exactly one account for that address, whatever the stored spelling, so no
    // duplicate was ever created.
    const addresses = (await t.run((ctx) => ctx.db.query("users").collect())).filter(
      (account) => (account.email ?? "").trim().toLowerCase() === "same@example.com",
    );
    expect(addresses.length).toBe(1);
  });

  test("a signed-in account for a different address is refused and the link stays live", async () => {
    const { t, adminId, companyId } = await setup();
    const created = await t.withIdentity({ subject: adminId }).mutation(api.companies.inviteMember, {
      email: "invitee@example.com",
    });
    const otherId = await t.run((ctx) =>
      ctx.db.insert("users", { name: "Other", email: "other@alpha.example", companyId, companyRole: "user" }),
    );

    const message = await refusal(() =>
      t.withIdentity({ subject: otherId }).mutation(api.companies.handleInvitationForCurrentAccount, {
        token: created.token,
      }),
    );
    expect(message.length).toBeGreaterThan(0);

    expect((await rowsOf(t))[0].status).toBe("pending");
    expect((await t.query(api.companies.invitationPreview, { token: created.token })).state).toBe("pending");
  });

  test("a visitor who is not signed in at all is refused", async () => {
    const { t, adminId } = await setup();
    const created = await t.withIdentity({ subject: adminId }).mutation(api.companies.inviteMember, {
      email: "invitee@example.com",
    });

    const message = await refusal(() =>
      t.mutation(api.companies.handleInvitationForCurrentAccount, { token: created.token }),
    );
    expect(message.length).toBeGreaterThan(0);
    expect((await rowsOf(t))[0].status).toBe("pending");
  });

  test("a removed account cannot settle an invitation", async () => {
    const { t, adminId, companyId } = await setup();
    const created = await t.withIdentity({ subject: adminId }).mutation(api.companies.inviteMember, {
      email: "removed@example.com",
    });
    const removedId = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Removed",
        email: "removed@example.com",
        companyId,
        companyRole: "user",
        removedAt: new Date().toISOString(),
      }),
    );

    const message = await refusal(() =>
      t.withIdentity({ subject: removedId }).mutation(api.companies.handleInvitationForCurrentAccount, {
        token: created.token,
      }),
    );
    expect(message.length).toBeGreaterThan(0);
    expect((await rowsOf(t))[0].status).toBe("pending");
  });
});

describe("the notice shown when a link is opened while another account is signed in", () => {
  test("names the signed-in account, the invited address, the company and both actions", () => {
    const notice = invitationSessionNotice({
      currentEmail: "admin@alpha.example",
      currentName: "Alpha admin",
      invitedEmail: "joiner@example.com",
      companyName: "Alpha BV",
    });
    expect(notice.includes("admin@alpha.example")).toBe(true);
    expect(notice.includes("Alpha admin")).toBe(true);
    expect(notice.includes("joiner@example.com")).toBe(true);
    expect(notice.includes("Alpha BV")).toBe(true);
    expect(notice.includes(INVITATION_SIGN_OUT_AND_ACCEPT)).toBe(true);
    expect(notice.includes(INVITATION_CANCEL)).toBe(true);
    // Nothing happens without a choice.
    expect(notice.includes("Nothing changes until you choose")).toBe(true);
  });

  test("says plainly when the invitation is for the account already signed in", () => {
    const notice = invitationHandledNotice({
      email: "joiner@example.com",
      companyName: "Alpha BV",
      alreadyMember: true,
    });
    expect(notice.includes("joiner@example.com")).toBe(true);
    expect(notice.includes("Alpha BV")).toBe(true);
    expect(notice.includes("No second account was created")).toBe(true);
  });

  test("describes a temporary session that carries no address", () => {
    const notice = invitationAnonymousSessionNotice("Alpha BV", "joiner@example.com");
    expect(notice.includes("temporary session")).toBe(true);
    expect(notice.includes("joiner@example.com")).toBe(true);
    expect(notice.includes("Alpha BV")).toBe(true);
    expect(notice.includes(INVITATION_SIGN_OUT_AND_ACCEPT)).toBe(true);
  });
});

describe("the invitation email", () => {
  const link = "https://app.example/auth/accept?token=abc123";
  const expiresAt = "2026-10-06T09:00:00.000Z";

  test("names the company and the inviter, and carries one button with the URL as an href", () => {
    const { subject, html } = invitationEmail({
      companyName: "Alpha BV",
      inviterName: "Nadia",
      link,
      expiresAt,
    });

    expect(subject).toBe(invitationEmailSubject("Alpha BV"));
    expect(subject.includes("Alpha BV")).toBe(true);
    expect(html.includes("Nadia")).toBe(true);
    expect(html.includes("Alpha BV")).toBe(true);
    expect(html.includes(INVITATION_BUTTON_LABEL)).toBe(true);

    // Exactly one call to action, and the link appears once — as the href.
    expect(html.split("<a ").length - 1).toBe(1);
    expect(html.split(link).length - 1).toBe(1);
    expect(html.includes(`href="${link}"`)).toBe(true);
  });

  test("never renders the link as a code block or a verification code", () => {
    const { html } = invitationEmail({ companyName: "Alpha BV", inviterName: "Nadia", link, expiresAt });
    expect(html.includes("<code")).toBe(false);
    expect(html.includes("<pre")).toBe(false);
    expect(html.includes(`>${link}<`)).toBe(false);
    expect(html.toLowerCase().includes("verification code")).toBe(false);
  });

  test("states the expiry period and that the link works only once", () => {
    const { html } = invitationEmail({ companyName: "Alpha BV", inviterName: "Nadia", link, expiresAt });
    expect(html.includes("6 October 2026")).toBe(true);
    expect(html.includes(`${INVITATION_TTL_DAYS} days from now`)).toBe(true);
    expect(html.toLowerCase().includes("works once")).toBe(true);
  });

  test("reads correctly when the inviter's name is unknown", () => {
    const { html } = invitationEmail({ companyName: "Alpha BV", inviterName: "", link, expiresAt });
    expect(html.includes("You have been invited")).toBe(true);
    expect(html.includes("undefined")).toBe(false);
    expect(html.includes("null")).toBe(false);
  });

  test("still names the platform when the company name is missing", () => {
    const { subject, html } = invitationEmail({ companyName: "", inviterName: "Nadia", link, expiresAt });
    expect(subject.includes("Vintage GANTT")).toBe(true);
    expect(html.includes("a company")).toBe(true);
  });
});
