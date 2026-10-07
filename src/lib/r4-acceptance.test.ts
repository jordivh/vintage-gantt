/**
 * R4 — Login & company accounts: the acceptance checklist, executed.
 *
 * The R4 requirements written out as executable checks: login, company accounts
 * managed without any email, removal/transfer, self-service account changes, and
 * — first and hardest — company isolation. Every case runs against two companies
 * (Alpha, Beta) and at least three accounts.
 *
 * Each `test` name starts with its R4 number so a run is its own test report.
 */
import { describe, expect, test } from "bun:test";
import { createAccount, retrieveAccount } from "@convex-dev/auth/server";
import type { GenericActionCtx, GenericMutationCtx } from "convex/server";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import type { DataModel, Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";

const modules = {
  "./planner.ts": () => import("../convex/planner"),
  "./companies.ts": () => import("../convex/companies"),
  "./auth.ts": () => import("../convex/auth"),
  "./_generated/api.ts": () => import("../convex/_generated/api"),
  "./_generated/server.ts": () => import("../convex/_generated/server"),
};

const NOW = "2026-01-01T09:00:00.000Z";
const ALPHA_ADMIN_EMAIL = "admin@alpha.example";
const ALPHA_ADMIN_PASSWORD = "alphapassword1";

/**
 * Inserts a complete workspace directly for an account that has no company yet,
 * which is how the pre-company ("legacy") workspaces in the deployment look.
 */
async function insertLegacyWorkspace(ctx: GenericMutationCtx<DataModel>, ownerId: Id<"users">, tag: string) {
  const w = workspace(tag);
  for (const row of w.projects) await ctx.db.insert("projects", { ...row, ownerId });
  for (const row of w.calendars) await ctx.db.insert("calendars", { ...row, ownerId });
  for (const row of w.resources) await ctx.db.insert("resources", { ...row, ownerId });
  for (const row of w.tasks) await ctx.db.insert("tasks", { ...row, ownerId });
  for (const row of w.planVersions) await ctx.db.insert("planVersions", { ...row, ownerId });
  for (const row of w.dependencies) await ctx.db.insert("dependencies", { ...row, ownerId });
  for (const row of w.assignments) await ctx.db.insert("taskAssignments", { ...row, ownerId });
  for (const row of w.exceptions) await ctx.db.insert("calendarExceptions", { ...row, ownerId });
  for (const row of w.baselines) await ctx.db.insert("baselines", { ...row, ownerId });
  for (const row of w.baselineTasks) await ctx.db.insert("baselineTasks", { ...row, ownerId });
}

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
  projects: [{ id: `proj-${tag}`, name: `Project ${tag}`, status: "active", kind: "project" as const, startDate: "2026-01-05", schedulingDirection: "forward", calendarId: `cal-${tag}`, createdAt: NOW, updatedAt: NOW }],
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

/** The account row of one address. */
const accountFor = (h: Harness, email: string) =>
  h.t.run((ctx) => ctx.db.query("users").withIndex("email", (q) => q.eq("email", email)).first());

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
    const company = await h.t.run((ctx) => ctx.db.get(registered.companyId as unknown as Id<"companies">));
    expect(company?.name).toBe("Gamma Works");
    expect(company?.status).toBe("active");
    const account = await accountFor(h, "admin@gamma.example");
    expect(account?.companyRole).toBe("company_admin");
    expect(account?.companyId).toBe(company?._id);
  });

  test("R4-08 an admin adds a user who is active at once and must change the password", async () => {
    const h = await harness();
    const created = await h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.addCompanyUser, {
      name: "New user",
      email: " New@Alpha.Example ",
      password: "temporary-pass-1",
    });
    expect(created.email).toBe("new@alpha.example");

    const account = await accountFor(h, "new@alpha.example");
    expect(account?.companyId).toBe(h.alphaCompanyId);
    expect(account?.companyRole).toBe("user");
    expect(account?.name).toBe("New user");
    expect(account?.mustChangePassword).toBe(true);
    // The password is hashed, never stored in the clear on the account row.
    expect(JSON.stringify(account).includes("temporary-pass-1")).toBe(false);
    // The credentials exist and match what the admin typed.
    expect(await verifyPassword(h, "new@alpha.example", "temporary-pass-1")).toBe(true);
  });

  test("R4-09 an address already used in another company is refused and names no company", async () => {
    const h = await harness();
    const message = await refusal(() =>
      h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.addCompanyUser, {
        name: "Copy",
        email: "admin@beta.example",
        password: "temporary-pass-1",
      }),
    );
    expect(message.length).toBeGreaterThan(0);
    expect(message.includes("beta")).toBe(false);
    // Nothing was created for that address.
    expect((await h.t.run((ctx) => ctx.db.query("users").withIndex("email", (q) => q.eq("email", "admin@beta.example")).collect())).length).toBe(1);
  });

  test("R4-10 a new user must change the password first and then reads the workspace", async () => {
    const h = await harness();
    const created = await h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.addCompanyUser, {
      name: "Joiner",
      email: "joiner@alpha.example",
      password: "temporary-pass-1",
    });
    const joiner = created.userId as Id<"users">;

    // With the temporary password the account reads and writes no planning data.
    expect(await h.t.withIdentity({ subject: joiner }).query(api.planner.getState, {})).toBeNull();
    expect(await refusal(() => h.t.withIdentity({ subject: joiner }).mutation(api.planner.replaceState, { state: {} }))).not.toBe("");

    // The new password must follow the rule and differ from the temporary one.
    const same = await refusal(() =>
      h.t.withIdentity({ subject: joiner }).mutation(api.companies.changeOwnPassword, {
        currentPassword: "temporary-pass-1",
        newPassword: "temporary-pass-1",
      }),
    );
    expect(same.length).toBeGreaterThan(0);
    const weak = await refusal(() =>
      h.t.withIdentity({ subject: joiner }).mutation(api.companies.changeOwnPassword, {
        currentPassword: "temporary-pass-1",
        newPassword: "short",
      }),
    );
    expect(weak.length).toBeGreaterThan(0);

    await h.t.withIdentity({ subject: joiner }).mutation(api.companies.changeOwnPassword, {
      currentPassword: "temporary-pass-1",
      newPassword: "joiner-password-1",
    });

    // Now the account is a normal user of the company.
    expect((await accountFor(h, "joiner@alpha.example"))?.mustChangePassword).toBe(false);
    expect((await h.t.withIdentity({ subject: joiner }).query(api.planner.getState, {}))?.projects?.length).toBeGreaterThan(0);
    expect(await verifyPassword(h, "joiner@alpha.example", "temporary-pass-1")).toBe(false);
    expect(await verifyPassword(h, "joiner@alpha.example", "joiner-password-1")).toBe(true);
  });

  test("R4-11 an admin resets a password: sessions dropped and a forced change again", async () => {
    const h = await harness();
    const created = await h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.addCompanyUser, {
      name: "Reset me",
      email: "reset@alpha.example",
      password: "temporary-pass-1",
    });
    const target = created.userId as Id<"users">;
    await h.t.withIdentity({ subject: target }).mutation(api.companies.changeOwnPassword, {
      currentPassword: "temporary-pass-1",
      newPassword: "own-password-1x",
    });
    expect((await accountFor(h, "reset@alpha.example"))?.mustChangePassword).toBe(false);

    await h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.resetUserPassword, {
      userId: target,
      password: "reset-temp-pass-1",
    });

    const after = await h.t.run((ctx) => ctx.db.get(target));
    expect(after?.mustChangePassword).toBe(true);
    expect(await verifyPassword(h, "reset@alpha.example", "own-password-1x")).toBe(false);
    expect(await verifyPassword(h, "reset@alpha.example", "reset-temp-pass-1")).toBe(true);

    // The open session is cut off: no planning data is readable again.
    expect(await h.t.withIdentity({ subject: target }).query(api.planner.getState, {})).toBeNull();
  });

  test("R4-12 a regular user can neither add, reset, remove nor transfer", async () => {
    const h = await harness();
    const asUser = h.t.withIdentity({ subject: h.alphaUser });
    expect(await refusal(() => asUser.mutation(api.companies.addCompanyUser, { name: "X", email: "x@alpha.example", password: "temporary-pass-1" }))).not.toBe("");
    expect(await refusal(() => asUser.mutation(api.companies.resetUserPassword, { userId: h.alphaAdmin, password: "temporary-pass-1" }))).not.toBe("");
    expect(await refusal(() => asUser.mutation(api.companies.removeMember, { userId: h.alphaAdmin }))).not.toBe("");
    expect(await refusal(() => asUser.mutation(api.companies.transferAdmin, { userId: h.alphaUser }))).not.toBe("");
  });

  test("R4-13 another company cannot reset this company's user", async () => {
    const h = await harness();
    await h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.addCompanyUser, {
      name: "Alpha member",
      email: "member@alpha.example",
      password: "temporary-pass-1",
    });
    const member = await accountFor(h, "member@alpha.example");
    const message = await refusal(() =>
      h.t.withIdentity({ subject: h.betaAdmin }).mutation(api.companies.resetUserPassword, {
        userId: member?._id as Id<"users">,
        password: "other-temp-pass-1",
      }),
    );
    expect(message.length).toBeGreaterThan(0);
    expect(await verifyPassword(h, "member@alpha.example", "temporary-pass-1")).toBe(true);
  });

  test("R4-14 the last company admin can neither be removed nor demoted", async () => {
    const h = await harness();
    expect(await refusal(() => h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.removeMember, { userId: h.alphaAdmin }))).not.toBe("");
    expect(await refusal(() => h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.setMemberRole, { userId: h.alphaAdmin, role: "user" }))).not.toBe("");
    expect((await h.t.run((ctx) => ctx.db.get(h.alphaAdmin)))?.companyRole).toBe("company_admin");
  });

  test("R4-15 removing a regular user blocks access but keeps every project", async () => {
    const h = await harness();
    const before = await h.t.withIdentity({ subject: h.alphaAdmin }).query(api.planner.getState, {});
    await h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.removeMember, { userId: h.alphaUser });
    expect(await h.t.withIdentity({ subject: h.alphaUser }).query(api.planner.getState, {})).toBeNull();
    expect(await refusal(() => h.t.withIdentity({ subject: h.alphaUser }).mutation(api.planner.replaceState, { state: {} }))).not.toBe("");
    const after = await h.t.withIdentity({ subject: h.alphaAdmin }).query(api.planner.getState, {});
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test("R4-16 an admin transfers company admin to another active user", async () => {
    const h = await harness();
    await h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.transferAdmin, { userId: h.alphaUser });
    expect((await h.t.run((ctx) => ctx.db.get(h.alphaUser)))?.companyRole).toBe("company_admin");
    expect((await h.t.run((ctx) => ctx.db.get(h.alphaAdmin)))?.companyRole).toBe("user");
    // The right moved with the role.
    await h.t.withIdentity({ subject: h.alphaUser }).mutation(api.companies.addCompanyUser, { name: "Later", email: "later@alpha.example", password: "temporary-pass-1" });
    expect(await refusal(() => h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.addCompanyUser, { name: "Nope", email: "nope@alpha.example", password: "temporary-pass-1" }))).not.toBe("");
  });
});

/* ------------------------------------------------ an account's own settings */

describe("R4 — an account changes its own details", () => {
  test("R4-17 changing the email keeps this session and retires the old one", async () => {
    const h = await harness();
    const changed = await h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.changeOwnEmail, {
      currentPassword: ALPHA_ADMIN_PASSWORD,
      email: "owner@alpha.example",
    });
    expect(changed.email).toBe("owner@alpha.example");
    expect(await verifyPassword(h, "owner@alpha.example", ALPHA_ADMIN_PASSWORD)).toBe(true);
    expect(await verifyPassword(h, ALPHA_ADMIN_EMAIL, ALPHA_ADMIN_PASSWORD)).toBe(false);
    // The account keeps its company and role.
    const account = await h.t.run((ctx) => ctx.db.get(h.alphaAdmin));
    expect(account?.companyId).toBe(h.alphaCompanyId);
    expect(account?.companyRole).toBe("company_admin");
  });

  test("R4-18 changing the email needs the current password and a free address", async () => {
    const h = await harness();
    expect(await refusal(() =>
      h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.changeOwnEmail, {
        currentPassword: "wrong-password",
        email: "owner@alpha.example",
      }),
    )).not.toBe("");
    expect(await refusal(() =>
      h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.changeOwnEmail, {
        currentPassword: ALPHA_ADMIN_PASSWORD,
        email: "admin@beta.example",
      }),
    )).not.toBe("");
    expect(await verifyPassword(h, ALPHA_ADMIN_EMAIL, ALPHA_ADMIN_PASSWORD)).toBe(true);
  });

  test("R4-19 changing the password needs the current one and keeps the account usable", async () => {
    const h = await harness();
    expect(await refusal(() =>
      h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.changeOwnPassword, {
        currentPassword: "wrong-password",
        newPassword: "another-password-1",
      }),
    )).not.toBe("");
    await h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.changeOwnPassword, {
      currentPassword: ALPHA_ADMIN_PASSWORD,
      newPassword: "another-password-1",
    });
    expect(await verifyPassword(h, ALPHA_ADMIN_EMAIL, ALPHA_ADMIN_PASSWORD)).toBe(false);
    expect(await verifyPassword(h, ALPHA_ADMIN_EMAIL, "another-password-1")).toBe(true);
    expect((await h.t.withIdentity({ subject: h.alphaAdmin }).query(api.planner.getState, {}))?.projects?.length).toBeGreaterThan(0);
  });

  test("R4-20 a name can be changed, and nothing else follows from it", async () => {
    const h = await harness();
    await h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.changeOwnName, { name: "Renamed admin" });
    const account = await h.t.run((ctx) => ctx.db.get(h.alphaAdmin));
    expect(account?.name).toBe("Renamed admin");
    expect(account?.companyRole).toBe("company_admin");
  });
});

/* ------------------------------------------------------- company isolation */

describe("R4 — company isolation", () => {
  test("R4-21 a company reads only its own workspace, for every data type", async () => {
    const h = await tagged();
    const seen = (await h.t.withIdentity({ subject: h.betaAdmin }).query(api.planner.getState, {})) as unknown as Record<string, { id: string }[]>;
    const other = workspace("alpha") as unknown as Record<string, { id: string }[]>;
    for (const table of ["projects", "tasks", "dependencies", "calendars", "exceptions", "resources", "assignments", "planVersions", "baselines", "baselineTasks"] as const) {
      expect(seen?.[table]?.length).toBe(other[table].length);
      for (const row of other[table]) expect(seen?.[table]?.some((item) => item.id === row.id)).toBe(false);
    }
  });

  test("R4-22 no identifier, title or count of another company appears", async () => {
    const h = await tagged();
    const seenBeta = await h.t.withIdentity({ subject: h.betaAdmin }).query(api.planner.getState, {});
    const serialised = JSON.stringify(seenBeta);
    for (const leak of ["alpha", "Project alpha", "Person alpha", "person@alpha.example", "Leave alpha", "Baseline alpha"]) {
      expect(serialised.includes(leak)).toBe(false);
    }
    expect((seenBeta?.tasks ?? []).length).toBe(2);
    expect((seenBeta?.assignments ?? []).length).toBe(1);
    expect((seenBeta?.dependencies ?? []).length).toBe(1);
  });

  test("R4-23 another company's record is never accepted in a relation", async () => {
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
    const alphaNow = await h.t.withIdentity({ subject: h.alphaAdmin }).query(api.planner.getState, {});
    expect(alphaNow?.resources?.[0].id).toBe("res-alpha");
    expect(alphaNow?.projects?.[0].id).toBe("proj-alpha");
  });

  test("R4-24 a company cannot delete or rewrite another company's records", async () => {
    const h = await tagged();
    const before = await h.t.withIdentity({ subject: h.alphaAdmin }).query(api.planner.getState, {});
    await h.t.withIdentity({ subject: h.betaAdmin }).mutation(api.planner.replaceState, { state: {} });
    await h.t.withIdentity({ subject: h.betaAdmin }).mutation(api.planner.replaceState, { state: workspace("beta") });
    const after = await h.t.withIdentity({ subject: h.alphaAdmin }).query(api.planner.getState, {});
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test("R4-25 a payload cannot choose its company, and a signed-out caller writes nothing", async () => {
    const h = await tagged();
    const claimed = { ...workspace("beta"), companyId: "companies:whatever", ownerId: "users:whatever" };
    await h.t.withIdentity({ subject: h.betaAdmin }).mutation(api.planner.replaceState, { state: claimed });
    const beta = await h.t.withIdentity({ subject: h.betaAdmin }).query(api.companies.current, {});
    expect(beta?.company.id).toBe(h.betaCompanyId);
    expect((await h.t.withIdentity({ subject: h.betaAdmin }).query(api.planner.getState, {}))?.projects?.length).toBe(1);
    expect(await refusal(() => h.t.mutation(api.planner.replaceState, { state: workspace("beta") }))).not.toBe("");
  });

  test("R4-26 a removed account loses access on its existing session at once", async () => {
    const h = await harness();
    expect((await h.t.withIdentity({ subject: h.alphaUser }).query(api.companies.access, {}))?.removed).toBe(false);
    await h.t.withIdentity({ subject: h.alphaAdmin }).mutation(api.companies.removeMember, { userId: h.alphaUser });
    expect(await h.t.withIdentity({ subject: h.alphaUser }).query(api.planner.getState, {})).toBeNull();
    expect(await h.t.withIdentity({ subject: h.alphaUser }).query(api.companies.current, {})).toBeNull();
    expect((await h.t.withIdentity({ subject: h.alphaUser }).query(api.companies.access, {}))?.removed).toBe(true);
    const sessions = await h.t.run((ctx) => ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", h.alphaUser)).collect());
    expect(sessions.length).toBe(0);
  });

  test("R4-27 a direct protected read with no session returns nothing", async () => {
    const h = await tagged();
    expect(await h.t.query(api.planner.getState, {})).toBeNull();
    expect(await h.t.query(api.companies.current, {})).toBeNull();
    expect(await h.t.query(api.companies.access, {})).toBeNull();
  });

  test("R4-28 a pre-company workspace stays readable and survives its company unchanged", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", { name: "Legacy account", isAnonymous: true });
      await insertLegacyWorkspace(ctx, id, "legacy");
      return id;
    });

    const before = await t.withIdentity({ subject: userId }).query(api.planner.getState, {});
    expect(before?.companyId).toBeNull();
    expect((before?.projects ?? []).length).toBe(1);
    expect((before?.tasks ?? []).length).toBe(2);
    expect((before?.baselines ?? []).length).toBe(1);

    const report = await t.withIdentity({ subject: userId }).mutation(api.companies.ensureCompany, {});
    expect(report.created).toBe(true);
    expect(report.mismatch.length).toBe(0);
    expect(report.counts.before).toEqual(report.counts.after);
    expect(report.totals.before).toEqual(report.totals.after);
    expect(report.rowsLinked).toBeGreaterThan(0);

    const after = await t.withIdentity({ subject: userId }).query(api.planner.getState, {});
    expect(after?.companyId).toBe(report.companyId);
    for (const table of ["projects", "tasks", "dependencies", "calendars", "exceptions", "resources", "assignments", "planVersions", "baselines", "baselineTasks"] as const) {
      expect(`${table}: ${JSON.stringify(after?.[table])}`).toBe(`${table}: ${JSON.stringify(before?.[table])}`);
    }
  });

  test("R4-29 one pre-company workspace is invisible to another pre-company account", async () => {
    const t = convexTest(schema, modules);
    const [delta, omega] = await t.run(async (ctx) => {
      const a = await ctx.db.insert("users", { name: "Legacy delta", isAnonymous: true });
      const b = await ctx.db.insert("users", { name: "Legacy omega", isAnonymous: true });
      await insertLegacyWorkspace(ctx, a, "delta");
      await insertLegacyWorkspace(ctx, b, "omega");
      return [a, b] as const;
    });

    const seen = (await t.withIdentity({ subject: omega }).query(api.planner.getState, {})) as unknown as Record<string, { id: string }[]>;
    expect(seen?.projects?.[0]?.id).toBe("proj-omega");
    expect((seen?.tasks ?? []).length).toBe(2);
    const serialised = JSON.stringify(seen);
    for (const leak of ["proj-delta", "task-delta-1", "person@delta.example", "Leave delta", "Baseline delta"]) {
      expect(serialised.includes(leak)).toBe(false);
    }
    const deltaSeen = (await t.withIdentity({ subject: delta }).query(api.planner.getState, {})) as unknown as Record<string, { id: string }[]>;
    expect(deltaSeen?.projects?.[0]?.id).toBe("proj-delta");
    expect(JSON.stringify(deltaSeen).includes("proj-omega")).toBe(false);
  });
});
