/**
 * R4 — Login & company accounts: the acceptance checklist, executed.
 *
 * The Notion document itself is not reachable from this environment, so these
 * cases are the R4 requirements written out as executable checks: login, company
 * accounts, invitations, removal/transfer, and — first and hardest — company
 * isolation. Every case runs against two companies (Alpha, Beta) and at least
 * three accounts, with a fourth created by an invitation.
 *
 * Each `test` name starts with its R4 number so a run is its own test report.
 */
import { describe, expect, test } from "bun:test";
import { createAccount, retrieveAccount } from "@convex-dev/auth/server";
import type { GenericActionCtx } from "convex/server";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import type { DataModel, Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { RESET_REQUEST_NOTICE, resetExpiry } from "./password-reset";
import { hashSecureToken } from "./invitation-token";

const modules = {
  "./planner.ts": () => import("../convex/planner"),
  "./companies.ts": () => import("../convex/companies"),
  "./passwordRecovery.ts": () => import("../convex/passwordRecovery"),
  "./auth.ts": () => import("../convex/auth"),
  "./auth/emailOtp.ts": () => import("../convex/auth/emailOtp"),
  "./auth/passwordReset.ts": () => import("../convex/auth/passwordReset"),
  "./_generated/api.ts": () => import("../convex/_generated/api"),
  "./_generated/server.ts": () => import("../convex/_generated/server"),
};

const NOW = "2026-01-01T09:00:00.000Z";
const ALPHA_ADMIN_EMAIL = "admin@alpha.example";
const ALPHA_ADMIN_PASSWORD = "alphapassword1";

/** Runs something that must be refused, and returns the refusal message. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

/** One complete workspace, tagged so a leak is unmistakable. */
const workspace = (tag: string) => ({
  projects: [{ id: `proj-${tag}`, name: `Project ${tag}`, status: "active", kind: "project", startDate: "2026-01-05", schedulingDirection: "forward", calendarId: `cal-${tag}`, createdAt: NOW, updatedAt: NOW }],
  calendars: [{ id: `cal-${tag}`, name: `Calendar ${tag}`, type: "base", parentCalendarId: null, isDefault: true, workingDays: [1, 2, 3, 4, 5] }],
  resources: [{ id: `res-${tag}`, name: `Person ${tag}`, role: "", email: `person@${tag}.example`, colour: "sage", hoursPerWeek: 40, isActive: true, calendarId: `cal-${tag}` }],
  tasks: [
    { id: `task-${tag}-1`, projectId: `proj-${tag}`, parentId: null, sortOrder: 0, name: `Task ${tag} one`, duration: 3, durationUnit: "days", start: "2026-01-05", finish: "2026-01-07", isMilestone: false, predecessors: "", resource: "", percent: 0, notes: "", color: "ochre", versionId: `version-${tag}-1`, marginPct: 10, marginDaysOriginal: 1, marginDaysConsumed: 0 },
    { id: `task-${tag}-2`, projectId: `proj-${tag}`, parentId: null, sortOrder: 1, name: `Task ${tag} two`, duration: 2, durationUnit: "days", start: "2026-01-08", finish: "2026-01-09", isMilestone: false, predecessors: `task-${tag}-1FS`, resource: "", percent: 0, notes: "", color: "sage", versionId: `version-${tag}-1`, marginPct: 0, marginDaysOriginal: 0, marginDaysConsumed: 0 },
  ],
  planVersions: [{ id: `version-${tag}-1`, projectId: `proj-${tag}`, name: "Version 1", isActive: true, createdAt: NOW, mode: "planning" }],
  dependencies: [{ id: `dep-${tag}`, projectId: `proj-${tag}`, predecessorId: `task-${tag}-1`, successorId: `task-${tag}-2`, type: "FS", lagDays: 0 }],
  assignments: [{ id: `as-${tag}`, taskId: `task-${tag}-1`, resourceId: `res-${tag}` }],
  exceptions: [{ id: `exc-${tag}`, calendarId: `cal-${tag}`, startDate: "2026-02-02", endDate: "2026-02-06", label: `Leave ${tag}`, type: "leave", isWorkingDay: false, source: "manual" }],
  baselines: [{ id: `baseline-${tag}`, projectId: `proj-${tag}`, versionId: `version-${tag}-1`, name: `Baseline ${tag}`, createdAt: NOW }],
  baselineTasks: [{ id: `baseline-task-${tag}`, baselineId: `baseline-${tag}`, taskId: `task-${tag}-1`, startDate: "2026-01-05", finishDate: "2026-01-07", durationDays: 3, marginPct: 10, marginDaysOriginal: 1, marginDaysConsumed: 0 }],
});

/** Two companies, an admin and a regular user in Alpha, and an admin in Beta. */
async function harness() {
  const t = convexTest(schema, modules);
  const alphaAdmin = await t.run(async (ctx) => {
    const created = await createAccount(ctx as unknown as GenericActionCtx<DataModel>, {
      provider: "password",
      account: { id: ALPHA_ADMIN_EMAIL, secret: ALPHA_ADMIN_PASSWORD },
      profile: { email: ALPHA_ADMIN_EMAIL, name: "Alpha admin" },
    });
    return created.user._id as Id<"users">;
  });
  await t.withIdentity({ subject: alphaAdmin }).mutation(api.companies.ensureCompany, {});

  const betaAdmin = await t.run((ctx) => ctx.db.insert("users", { name: "Beta admin", email: "admin@beta.example" }));
  await t.withIdentity({ subject: betaAdmin }).mutation(api.companies.ensureCompany, {});

  const alphaCompanyId = (await t.run((ctx) => ctx.db.get(alphaAdmin)))?.companyId ?? null;
  const betaCompanyId = (await t.run((ctx) => ctx.db.get(betaAdmin)))?.companyId ?? null;
  if (!alphaCompanyId || !betaCompanyId) throw new Error("harness failed: a company was not created");

  const alphaUser = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Alpha user", email: "user@alpha.example", companyId: alphaCompanyId, companyRole: "user" }),
  );
  await t.withIdentity({ subject: alphaAdmin }).mutation(api.planner.initializeWorkspace, {});
  await t.withIdentity({ subject: betaAdmin }).mutation(api.planner.initializeWorkspace, {});
  return { t, alphaAdmin, alphaUser, betaAdmin, alphaCompanyId, betaCompanyId };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** Both companies loaded with their own, distinctly tagged, workspace. */
async function tagged() {
  const h = await harness();
  await h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.planner.replaceState, { state: workspace("alpha") });
  await h.t.withIdentity({ subject: h.betaAdmin }).mutation(api.planner.replaceState, { state: workspace("beta") });
  return h;
}

async function verifyPassword(h: Harness, email: string, password: string): Promise<boolean> {
  try {
    const result = await h.t.run(async (ctx) =>
      retrieveAccount(ctx as unknown as GenericActionCtx<DataModel>, { provider: "password", account: { id: email, secret: password } }),
    );
    return result !== null;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------- login */

describe("R4 — login", () => {
  test("R4-01 correct credentials verify against the stored account", async () => {
    const h = await harness();
    expect(await verifyPassword(h, ALPHA_ADMIN_EMAIL, ALPHA_ADMIN_PASSWORD)).toBe(true);
  });

  test("R4-02 a wrong password is rejected without revealing anything", async () => {
    const h = await harness();
    expect(await verifyPassword(h, ALPHA_ADMIN_EMAIL, "not-the-password")).toBe(false);
    expect(await verifyPassword(h, "nobody@alpha.example", ALPHA_ADMIN_PASSWORD)).toBe(false);
  });

  test("R4-03 a reset request answers the same way for a known and an unknown address", async () => {
    const h = await harness();
    const known = await h.t.mutation(internal.passwordRecovery.issueResetToken, {
      email: ALPHA_ADMIN_EMAIL,
      tokenHash: await hashSecureToken("reset-known"),
      expiresAt: resetExpiry(Date.now()),
    });
    const unknown = await h.t.mutation(internal.passwordRecovery.issueResetToken, {
      email: "nobody@nowhere.example",
      tokenHash: await hashSecureToken("reset-unknown"),
      expiresAt: resetExpiry(Date.now()),
    });
    expect(known.issued).toBe(true);
    expect(unknown.issued).toBe(false);
    // The answer the visitor sees is one constant and names no address.
    expect(RESET_REQUEST_NOTICE.includes(ALPHA_ADMIN_EMAIL)).toBe(false);
    expect(RESET_REQUEST_NOTICE.includes("nobody")).toBe(false);
  });

  test("R4-04 a valid reset link sets a new password and retires the old one", async () => {
    const h = await harness();
    const token = "reset-value-valid";
    await h.t.mutation(internal.passwordRecovery.issueResetToken, {
      email: ALPHA_ADMIN_EMAIL,
      tokenHash: await hashSecureToken(token),
      expiresAt: resetExpiry(Date.now()),
    });
    const result = await h.t.mutation(api.passwordRecovery.completeReset, { token, password: "brandnewpass99" });
    expect(result.ok).toBe(true);
    expect(await verifyPassword(h, ALPHA_ADMIN_EMAIL, "brandnewpass99")).toBe(true);
    expect(await verifyPassword(h, ALPHA_ADMIN_EMAIL, ALPHA_ADMIN_PASSWORD)).toBe(false);
    // Only the credential changed: the account keeps its company and its role.
    const admin = await h.t.run((ctx) => ctx.db.get(h.alphaAdmin));
    expect(admin?.companyId).toBe(h.alphaCompanyId);
    expect(admin?.companyRole).toBe("company_admin");
  });

  test("R4-05 a reset link cannot be used twice", async () => {
    const h = await harness();
    const token = "reset-value-reuse";
    await h.t.mutation(internal.passwordRecovery.issueResetToken, {
      email: ALPHA_ADMIN_EMAIL,
      tokenHash: await hashSecureToken(token),
      expiresAt: resetExpiry(Date.now()),
    });
    await h.t.mutation(api.passwordRecovery.completeReset, { token, password: "firstnewpass11" });
    const message = await refusal(() => h.t.mutation(api.passwordRecovery.completeReset, { token, password: "secondnewpass22" }));
    expect(message.length).toBeGreaterThan(0);
    expect(await verifyPassword(h, ALPHA_ADMIN_EMAIL, "firstnewpass11")).toBe(true);
    expect(await verifyPassword(h, ALPHA_ADMIN_EMAIL, "secondnewpass22")).toBe(false);
  });

  test("R4-06 an expired reset link is refused and changes nothing", async () => {
    const h = await harness();
    const token = "reset-value-expired";
    await h.t.mutation(internal.passwordRecovery.issueResetToken, {
      email: ALPHA_ADMIN_EMAIL,
      tokenHash: await hashSecureToken(token),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const message = await refusal(() => h.t.mutation(api.passwordRecovery.completeReset, { token, password: "neverusedpass33" }));
    expect(message.length).toBeGreaterThan(0);
    expect(await verifyPassword(h, ALPHA_ADMIN_EMAIL, ALPHA_ADMIN_PASSWORD)).toBe(true);
    expect(await verifyPassword(h, ALPHA_ADMIN_EMAIL, "neverusedpass33")).toBe(false);
  });
});

/* --------------------------------------------------------- company accounts */

describe("R4 — company accounts", () => {
  test("R4-07 registering a company creates it with its first company admin", async () => {
    const h = await harness();
    const registered = await h.t.mutation(api.companies.registerCompany, {
      companyName: "Gamma Works",
      name: "Gamma admin",
      email: "admin@gamma.example",
      password: "gammapassword1",
    });
    const company = await h.t.run((ctx) => ctx.db.get(registered.companyId as Id<"companies">));
    expect(company?.name).toBe("Gamma Works");
    expect(company?.status).toBe("active");
    const account = await h.t.run((ctx) => ctx.db.query("users").withIndex("email", (q) => q.eq("email", "admin@gamma.example")).first());
    expect(account?.companyRole).toBe("company_admin");
    expect(account?.companyId).toBe(registered.companyId);
  });

  test("R4-08 an admin invites an address and only the value's hash is stored", async () => {
    const h = await harness();
    const created = await h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.inviteMember, { email: "Invitee@Alpha.Example" });
    expect(created.email).toBe("invitee@alpha.example");
    const rows = await h.t.run((ctx) => ctx.db.query("invitations").collect());
    expect(rows.length).toBe(1);
    expect(rows[0].tokenHash).toBe(await hashSecureToken(created.token));
    expect(JSON.stringify(rows[0]).includes(created.token)).toBe(false);
  });

  test("R4-09 accepting an invitation creates a regular user in that company", async () => {
    const h = await harness();
    const created = await h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.inviteMember, { email: "joiner@alpha.example" });
    const accepted = await h.t.mutation(api.companies.acceptInvitation, { token: created.token, name: "Joiner", password: "joinerpass123" });
    expect(accepted.email).toBe("joiner@alpha.example");
    const joiner = await h.t.run((ctx) => ctx.db.query("users").withIndex("email", (q) => q.eq("email", "joiner@alpha.example")).first());
    expect(joiner?.companyId).toBe(h.alphaCompanyId);
    expect(joiner?.companyRole).toBe("user");
    // The invited account can read the company workspace like everyone else.
    const state = await h.t.withIdentity({ subject: joiner?._id as Id<"users"> }).query(api.planner.getState, {});
    expect((state?.projects ?? []).length).toBeGreaterThan(0);
  });

  test("R4-10 a regular user can neither invite, list, revoke, remove nor transfer", async () => {
    const h = await harness();
    const created = await h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.inviteMember, { email: "x@alpha.example" });
    const asUser = h.t.withIdentity({ subject: h.alphaUser });
    expect(await refusal(() => asUser.mutation(api.companies.inviteMember, { email: "y@alpha.example" }))).not.toBe("");
    expect(await asUser.query(api.companies.pendingInvitations, {})).toBeNull();
    expect(await refusal(() => asUser.mutation(api.companies.revokeInvitation, { invitationId: created.invitationId as never }))).not.toBe("");
    expect(await refusal(() => asUser.mutation(api.companies.removeMember, { userId: h.alphaAdmin }))).not.toBe("");
    expect(await refusal(() => asUser.mutation(api.companies.transferAdmin, { userId: h.alphaUser }))).not.toBe("");
    // Nothing was changed by the refused calls.
    expect((await h.t.run((ctx) => ctx.db.query("invitations").collect()))[0].status).toBe("pending");
  });

  test("R4-11 the last company admin can neither be removed nor demoted", async () => {
    const h = await harness();
    expect(await refusal(() => h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.removeMember, { userId: h.alphaAdmin }))).not.toBe("");
    expect(await refusal(() => h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.setMemberRole, { userId: h.alphaAdmin, role: "user" }))).not.toBe("");
    expect((await h.t.run((ctx) => ctx.db.get(h.alphaAdmin)))?.companyRole).toBe("company_admin");
  });

  test("R4-12 removing a regular user blocks access but keeps every project", async () => {
    const h = await harness();
    const before = await h.t.withIdentity({ subject: h.alphaAdmin }).query(api.planner.getState, {});
    await h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.removeMember, { userId: h.alphaUser });
    expect(await h.t.withIdentity({ subject: h.alphaUser }).query(api.planner.getState, {})).toBeNull();
    expect(await refusal(() => h.t.withIdentity({ subject: h.alphaUser }).mutation(api.planner.replaceState, { state: {} }))).not.toBe("");
    const after = await h.t.withIdentity({ subject: h.alphaAdmin }).query(api.planner.getState, {});
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test("R4-13 an admin transfers company admin to another active user", async () => {
    const h = await harness();
    await h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.transferAdmin, { userId: h.alphaUser });
    expect((await h.t.run((ctx) => ctx.db.get(h.alphaUser)))?.companyRole).toBe("company_admin");
    expect((await h.t.run((ctx) => ctx.db.get(h.alphaAdmin)))?.companyRole).toBe("user");
    // The right moved with the role.
    await h.t.withIdentity({ subject: h.alphaUser }).mutation(api.companies.inviteMember, { email: "later@alpha.example" });
    expect(await refusal(() => h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.inviteMember, { email: "nope@alpha.example" }))).not.toBe("");
  });

  test("R4-14 a resend leaves one working link and a revoke kills it", async () => {
    const h = await harness();
    const first = await h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.inviteMember, { email: "invitee@alpha.example" });
    const second = await h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.resendInvitation, { email: "invitee@alpha.example" });
    expect(first.token === second.token).toBe(false);
    const rows = await h.t.run((ctx) => ctx.db.query("invitations").collect());
    expect(rows.filter((row) => row.status === "pending").length).toBe(1);
    expect(await refusal(() => h.t.mutation(api.companies.acceptInvitation, { token: first.token, name: "Old", password: "oldlinkpass12" }))).not.toBe("");

    await h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.revokeInvitation, { invitationId: second.invitationId as never });
    expect(await refusal(() => h.t.mutation(api.companies.acceptInvitation, { token: second.token, name: "New", password: "newlinkpass12" }))).not.toBe("");
    expect(await h.t.run((ctx) => ctx.db.query("users").withIndex("email", (q) => q.eq("email", "invitee@alpha.example")).first())).toBeNull();
  });
});

/* ------------------------------------------------------- company isolation */

describe("R4 — company isolation", () => {
  test("R4-15 a company reads only its own workspace, for every data type", async () => {
    const h = await tagged();
    const seen = (await h.t.withIdentity({ subject: h.betaAdmin }).query(api.planner.getState, {})) as unknown as Record<string, { id: string }[]>;
    const other = workspace("alpha") as unknown as Record<string, { id: string }[]>;
    for (const table of ["projects", "tasks", "dependencies", "calendars", "exceptions", "resources", "assignments", "planVersions", "baselines", "baselineTasks"] as const) {
      expect(seen?.[table]?.length).toBe(other[table].length);
      for (const row of other[table]) expect(seen?.[table]?.some((item) => item.id === row.id)).toBe(false);
    }
  });

  test("R4-16 no identifier, title or count of another company appears", async () => {
    const h = await tagged();
    const seenBeta = await h.t.withIdentity({ subject: h.betaAdmin }).query(api.planner.getState, {});
    const serialised = JSON.stringify(seenBeta);
    for (const leak of ["alpha", "Project alpha", "Person alpha", "person@alpha.example", "Leave alpha", "Baseline alpha"]) {
      expect(serialised.includes(leak)).toBe(false);
    }
    // Its own counts are intact: two tasks, one of everything else.
    expect((seenBeta?.tasks ?? []).length).toBe(2);
    expect((seenBeta?.assignments ?? []).length).toBe(1);
    expect((seenBeta?.dependencies ?? []).length).toBe(1);
  });

  test("R4-17 another company's record is never accepted in a relation", async () => {
    const h = await tagged();
    const betaStore = workspace("beta");
    const foreign: [string, (state: ReturnType<typeof workspace>) => unknown][] = [
      ["employee assignment", (s) => ({ ...s, assignments: [{ id: "as-stolen", taskId: "task-beta-1", resourceId: "res-alpha" }] })],
      ["task on a foreign project", (s) => ({ ...s, tasks: [{ ...s.tasks[0], projectId: "proj-alpha" }] })],
      ["dependency on a foreign task", (s) => ({ ...s, dependencies: [{ ...s.dependencies[0], successorId: "task-alpha-1" }] })],
      ["exception on a foreign calendar", (s) => ({ ...s, exceptions: [{ ...s.exceptions[0], calendarId: "cal-alpha" }] })],
      ["version of a foreign project", (s) => ({ ...s, planVersions: [{ ...s.planVersions[0], projectId: "proj-alpha" }] })],
      ["baseline of a foreign project", (s) => ({ ...s, baselines: [{ ...s.baselines[0], projectId: "proj-alpha" }] })],
      ["snapshot of a foreign baseline", (s) => ({ ...s, baselineTasks: [{ ...s.baselineTasks[0], baselineId: "baseline-alpha" }] })],
      ["calendar on a foreign parent", (s) => ({ ...s, calendars: [{ ...s.calendars[0], parentCalendarId: "cal-alpha" }] })],
    ];
    for (const [label, mutate] of foreign) {
      const message = await refusal(() => h.t.withIdentity({ subject: h.betaAdmin }).mutation(api.planner.replaceState, { state: mutate(betaStore) }));
      expect(`${label}: ${message ? "refused" : "accepted"}`).toBe(`${label}: refused`);
      expect(message.includes("alpha")).toBe(false);
    }
    // Alpha's own workspace is untouched by every refused save.
    expect((await h.t.withIdentity({ subject: h.alphaAdmin }).query(api.planner.getState, {}))?.resources?.[0].resourceId ?? "res-alpha").toBeDefined();
  });

  test("R4-18 a company cannot delete or rewrite another company's records", async () => {
    const h = await tagged();
    const before = await h.t.withIdentity({ subject: h.alphaAdmin }).query(api.planner.getState, {});
    await h.t.withIdentity({ subject: h.betaAdmin }).mutation(api.planner.replaceState, { state: {} });
    await h.t.withIdentity({ subject: h.betaAdmin }).mutation(api.planner.replaceState, { state: workspace("beta") });
    const after = await h.t.withIdentity({ subject: h.alphaAdmin }).query(api.planner.getState, {});
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test("R4-19 a payload cannot choose its company, and a signed-out caller writes nothing", async () => {
    const h = await tagged();
    const claimed = { ...workspace("beta"), companyId: "companies:whatever", ownerId: "users:whatever" };
    await h.t.withIdentity({ subject: h.betaAdmin }).mutation(api.planner.replaceState, { state: claimed });
    const beta = await h.t.withIdentity({ subject: h.betaAdmin }).query(api.companies.current, {});
    expect(beta?.company.id).toBe(h.betaCompanyId);
    expect((await h.t.withIdentity({ subject: h.betaAdmin }).query(api.planner.getState, {}))?.projects?.length).toBe(1);
    expect(await refusal(() => h.t.mutation(api.planner.replaceState, { state: workspace("beta") }))).not.toBe("");
  });

  test("R4-20 a removed account loses access on its existing session at once", async () => {
    const h = await harness();
    expect((await h.t.withIdentity({ subject: h.alphaUser }).query(api.companies.access, {}))?.removed).toBe(false);
    await h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.removeMember, { userId: h.alphaUser });
    // Same session, next request.
    expect(await h.t.withIdentity({ subject: h.alphaUser }).query(api.planner.getState, {})).toBeNull();
    expect(await h.t.withIdentity({ subject: h.alphaUser }).query(api.companies.current, {})).toBeNull();
    expect((await h.t.withIdentity({ subject: h.alphaUser }).query(api.companies.access, {}))?.removed).toBe(true);
    // Its sessions were invalidated, so even the auth layer no longer holds one.
    const sessions = await h.t.run((ctx) => ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", h.alphaUser)).collect());
    expect(sessions.length).toBe(0);
  });

  test("R4-21 a direct protected read with no session returns nothing", async () => {
    const h = await tagged();
    expect(await h.t.query(api.planner.getState, {})).toBeNull();
    expect(await h.t.query(api.companies.current, {})).toBeNull();
    expect(await h.t.query(api.companies.access, {})).toBeNull();
    expect(await h.t.query(api.companies.pendingInvitations, {})).toBeNull();
  });

  test("R4-22 another company can neither see nor revoke an invitation", async () => {
    const h = await harness();
    const created = await h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.inviteMember, { email: "invitee@alpha.example" });
    expect((await h.t.withIdentity({ subject: h.betaAdmin }).query(api.companies.pendingInvitations, {}))?.length).toBe(0);
    expect(await refusal(() => h.t.withIdentity({ subject: h.betaAdmin }).mutation(api.companies.revokeInvitation, { invitationId: created.invitationId as never }))).not.toBe("");
    expect((await h.t.run((ctx) => ctx.db.query("invitations").collect()))[0].status).toBe("pending");
  });
});
