/**
 * Deleting a project (and a task, an employee, a calendar) must reach the
 * database, take every related row with it, and stay gone after the next
 * sign-in. These cases drive the same server calls the screens now await, and
 * read the raw tables back so "gone" means gone from the database, not just from
 * the screen.
 */
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";

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

/**
 * Two projects, each fully self-contained: its own tasks, plan version, baseline
 * with one snapshot, one assignment and one dependency between its own two tasks.
 */
const workspace = (tag: string) => ({
  projects: [0, 1].map((n) => ({ id: `proj-${tag}-${n}`, name: `Project ${tag} ${n}`, status: "active", kind: "project" as const, startDate: "2026-01-05", schedulingDirection: "forward", calendarId: `cal-${tag}`, createdAt: NOW, updatedAt: NOW })),
  calendars: [
    { id: `cal-${tag}`, name: `Calendar ${tag}`, type: "base", parentCalendarId: null, isDefault: true, workingDays: [1, 2, 3, 4, 5] },
    { id: `cal-person-${tag}`, name: `Person ${tag} — leave`, type: "person", parentCalendarId: `cal-${tag}`, isDefault: false, workingDays: [1, 2, 3, 4, 5] },
  ],
  resources: [{ id: `res-${tag}`, name: `Person ${tag}`, role: "", email: `person@${tag}.example`, colour: "sage", hoursPerWeek: 40, isActive: true, calendarId: `cal-person-${tag}` }],
  tasks: [0, 1].flatMap((n) => [0, 1].map((k) => ({ id: `task-${tag}-${n}-${k}`, projectId: `proj-${tag}-${n}`, parentId: null, sortOrder: k, name: `Task ${tag} ${n}.${k}`, duration: 3, durationUnit: "days", start: "2026-01-05", finish: "2026-01-07", isMilestone: false, predecessors: "", resource: "", percent: 0, notes: "", color: "ochre", versionId: `version-${tag}-${n}`, marginPct: 10, marginDaysOriginal: 1, marginDaysConsumed: 0 }))),
  planVersions: [0, 1].map((n) => ({ id: `version-${tag}-${n}`, projectId: `proj-${tag}-${n}`, name: "Version 1", isActive: true, createdAt: NOW, mode: "planning" })),
  dependencies: [0, 1].map((n) => ({ id: `dep-${tag}-${n}`, projectId: `proj-${tag}-${n}`, predecessorId: `task-${tag}-${n}-0`, successorId: `task-${tag}-${n}-1`, type: "FS", lagDays: 0 })),
  assignments: [0, 1].map((n) => ({ id: `as-${tag}-${n}`, taskId: `task-${tag}-${n}-0`, resourceId: `res-${tag}` })),
  exceptions: [{ id: `exc-${tag}`, calendarId: `cal-person-${tag}`, startDate: "2026-02-02", endDate: "2026-02-06", label: `Leave ${tag}`, type: "leave", isWorkingDay: false, source: "manual" }],
  baselines: [0, 1].map((n) => ({ id: `baseline-${tag}-${n}`, projectId: `proj-${tag}-${n}`, versionId: `version-${tag}-${n}`, name: `Baseline ${tag} ${n}`, createdAt: NOW })),
  baselineTasks: [0, 1].map((n) => ({ id: `baseline-task-${tag}-${n}`, baselineId: `baseline-${tag}-${n}`, taskId: `task-${tag}-${n}-0`, startDate: "2026-01-05", finishDate: "2026-01-07", durationDays: 3, marginPct: 10, marginDaysOriginal: 1, marginDaysConsumed: 0 })),
});

async function company(t: ReturnType<typeof convexTest>, tag: string, email: string) {
  const userId = await t.run((ctx) => ctx.db.insert("users", { name: `Admin ${tag}`, email }));
  await t.withIdentity({ subject: userId }).mutation(api.companies.ensureCompany, {});
  await t.withIdentity({ subject: userId }).mutation(api.planner.replaceState, { state: workspace(tag) });
  return userId;
}

/** Exactly what the app does when the account signs in again. */
const signInAgain = async (t: ReturnType<typeof convexTest>, userId: Id<"users">) => {
  await t.withIdentity({ subject: userId }).mutation(api.companies.ensureCompany, {});
  await t.withIdentity({ subject: userId }).mutation(api.planner.ensureTestProject, {});
  return await t.withIdentity({ subject: userId }).query(api.planner.getState, {});
};

const table = async (t: ReturnType<typeof convexTest>, name: "projects" | "tasks" | "dependencies" | "taskAssignments" | "planVersions" | "baselines" | "baselineTasks" | "resources" | "calendars" | "calendarExceptions") =>
  await t.run((ctx) => ctx.db.query(name).collect());

const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();

/** A refusal message, or "" when the call unexpectedly succeeded. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

describe("deleting a project", () => {
  test("is stored in the database and stays gone after signing in again", async () => {
    const t = convexTest(schema, modules);
    const admin = await company(t, "alpha", "admin@alpha.example");

    await t.withIdentity({ subject: admin }).mutation(api.planner.deleteProject, { projectId: "proj-alpha-0" });

    // Gone from the raw table, not merely hidden from a view.
    expect(ids(await table(t, "projects")).includes("proj-alpha-0")).toBe(false);

    const after = await signInAgain(t, admin);
    expect(after?.projects.some((project) => project.id === "proj-alpha-0")).toBe(false);
    expect(ids(await table(t, "projects")).includes("proj-alpha-0")).toBe(false);
  });

  test("takes its tasks, dependencies, plan versions, baselines, snapshots and assignments with it", async () => {
    const t = convexTest(schema, modules);
    const admin = await company(t, "alpha", "admin@alpha.example");

    const result = await t.withIdentity({ subject: admin }).mutation(api.planner.deleteProject, { projectId: "proj-alpha-0" });
    expect(result.removed).toEqual({ tasks: 2, dependencies: 1, assignments: 1, planVersions: 1, baselines: 1, baselineTasks: 1 });

    expect(ids(await table(t, "tasks"))).toEqual(["task-alpha-1-0", "task-alpha-1-1"]);
    expect(ids(await table(t, "dependencies"))).toEqual(["dep-alpha-1"]);
    expect(ids(await table(t, "taskAssignments"))).toEqual(["as-alpha-1"]);
    expect(ids(await table(t, "planVersions"))).toEqual(["version-alpha-1"]);
    expect(ids(await table(t, "baselines"))).toEqual(["baseline-alpha-1"]);
    expect(ids(await table(t, "baselineTasks"))).toEqual(["baseline-task-alpha-1"]);

    // No row anywhere still points at the deleted project or its tasks.
    const orphans = [
      ...(await table(t, "tasks")), ...(await table(t, "dependencies")), ...(await table(t, "planVersions")), ...(await table(t, "baselines")),
    ].filter((row) => (row as { projectId?: string }).projectId === "proj-alpha-0");
    expect(orphans.length).toBe(0);
    expect((await table(t, "taskAssignments")).some((row) => row.taskId === "task-alpha-0-0")).toBe(false);
    expect((await table(t, "baselineTasks")).some((row) => row.baselineId === "baseline-alpha-0")).toBe(false);

    // The other project is untouched, so the plan still adds up.
    const after = await t.withIdentity({ subject: admin }).query(api.planner.getState, {});
    expect((after?.projects ?? []).length).toBe(1);
    expect((after?.tasks ?? []).length).toBe(2);
    expect((after?.assignments ?? []).length).toBe(1);
  });

  test("also removes a dependency another project filed against a deleted task", async () => {
    const t = convexTest(schema, modules);
    const admin = await company(t, "alpha", "admin@alpha.example");
    // Project 1's own link row names a task of project 0.
    await t.withIdentity({ subject: admin }).mutation(api.planner.replaceState, {
      state: { ...workspace("alpha"), dependencies: [...workspace("alpha").dependencies, { id: "dep-alpha-cross", projectId: "proj-alpha-1", predecessorId: "task-alpha-0-0", successorId: "task-alpha-1-1", type: "FS", lagDays: 0 }] },
    });

    await t.withIdentity({ subject: admin }).mutation(api.planner.deleteProject, { projectId: "proj-alpha-0" });

    expect(ids(await table(t, "dependencies"))).toEqual(["dep-alpha-1"]);
    expect((await table(t, "dependencies")).some((row) => row.predecessorId === "task-alpha-0-0" || row.successorId === "task-alpha-0-0")).toBe(false);
  });

  test("leaves capacity with nothing to count for the deleted project", async () => {
    const t = convexTest(schema, modules);
    const admin = await company(t, "alpha", "admin@alpha.example");
    expect((await table(t, "taskAssignments")).length).toBe(2);

    await t.withIdentity({ subject: admin }).mutation(api.planner.deleteProject, { projectId: "proj-alpha-0" });

    const after = await table(t, "taskAssignments");
    // Capacity and workload are read from assignments: the deleted project has none left.
    expect(after.length).toBe(1);
    expect(after.every((row) => row.taskId !== "task-alpha-0-0")).toBe(true);
    const taskIds = new Set((await table(t, "tasks")).map((row) => row.id));
    expect(after.every((row) => taskIds.has(row.taskId))).toBe(true);
  });

  test("refuses the last project and another company's project", async () => {
    const t = convexTest(schema, modules);
    const alpha = await company(t, "alpha", "admin@alpha.example");
    const beta = await company(t, "beta", "admin@beta.example");

    // One project left: the workspace must keep at least one.
    await t.withIdentity({ subject: alpha }).mutation(api.planner.deleteProject, { projectId: "proj-alpha-0" });
    expect(await refusal(() => t.withIdentity({ subject: alpha }).mutation(api.planner.deleteProject, { projectId: "proj-alpha-1" }))).toContain("at least one project");
    expect(ids(await table(t, "projects"))).toEqual(["proj-alpha-1", "proj-beta-0", "proj-beta-1"]);

    // Another company's project id is not reachable, and nothing of Beta's moves.
    expect(await refusal(() => t.withIdentity({ subject: alpha }).mutation(api.planner.deleteProject, { projectId: "proj-beta-0" }))).not.toBe("");
    const betaAfter = await t.withIdentity({ subject: beta }).query(api.planner.getState, {});
    expect((betaAfter?.projects ?? []).length).toBe(2);
    expect((betaAfter?.tasks ?? []).length).toBe(4);
    expect((betaAfter?.assignments ?? []).length).toBe(2);
    expect(ids(await table(t, "projects")).includes("proj-beta-0")).toBe(true);
  });

  test("refuses a template", async () => {
    const t = convexTest(schema, modules);
    const admin = await company(t, "alpha", "admin@alpha.example");
    const base = workspace("alpha");
    // A consistent payload holding only a template.
    await t.withIdentity({ subject: admin }).mutation(api.planner.replaceState, {
      state: {
        ...base,
        projects: [{ ...base.projects[0], id: "tpl-alpha", kind: "template" as const, status: "template" }],
        tasks: [],
        dependencies: [],
        assignments: [],
        planVersions: [{ ...base.planVersions[0], projectId: "tpl-alpha" }],
        baselines: [],
        baselineTasks: [],
      },
    });
    expect(await refusal(() => t.withIdentity({ subject: admin }).mutation(api.planner.deleteProject, { projectId: "tpl-alpha" }))).toContain("template");
    expect(ids(await table(t, "projects"))).toEqual(["tpl-alpha"]);
  });
});

describe("deleting a task", () => {
  test("removes the task, its subtree, its assignments and every dependency that named it", async () => {
    const t = convexTest(schema, modules);
    const admin = await company(t, "alpha", "admin@alpha.example");

    // A child of task-alpha-0-0, so the subtree rule is exercised.
    await t.withIdentity({ subject: admin }).mutation(api.planner.replaceState, {
      state: { ...workspace("alpha"), tasks: [...workspace("alpha").tasks, { ...workspace("alpha").tasks[0], id: "task-alpha-child", parentId: "task-alpha-0-0", sortOrder: 2 }] },
    });

    const result = await t.withIdentity({ subject: admin }).mutation(api.planner.deleteTasks, { projectId: "proj-alpha-0", taskIds: ["task-alpha-0-0"] });
    expect(result.taskIds.sort()).toEqual(["task-alpha-0-0", "task-alpha-child"]);

    const remaining = ids(await table(t, "tasks"));
    expect(remaining.includes("task-alpha-0-0")).toBe(false);
    expect(remaining.includes("task-alpha-child")).toBe(false);
    expect(remaining.includes("task-alpha-1-0")).toBe(true);
    expect((await table(t, "taskAssignments")).some((row) => row.taskId === "task-alpha-0-0")).toBe(false);
    expect((await table(t, "dependencies")).some((row) => row.predecessorId === "task-alpha-0-0" || row.successorId === "task-alpha-0-0")).toBe(false);

    const after = await signInAgain(t, admin);
    expect((after?.tasks ?? []).some((task) => task.id === "task-alpha-0-0")).toBe(false);
  });
});

describe("deleting an employee", () => {
  test("removes the employee, their assignments, their person calendar and its leave", async () => {
    const t = convexTest(schema, modules);
    const admin = await company(t, "alpha", "admin@alpha.example");

    const result = await t.withIdentity({ subject: admin }).mutation(api.planner.deleteResource, { resourceId: "res-alpha" });
    expect(result.removed).toEqual({ assignments: 2, exceptions: 1, calendars: 1 });

    expect(ids(await table(t, "resources"))).toEqual([]);
    expect(ids(await table(t, "taskAssignments"))).toEqual([]);
    // The employee's own calendar left with them; the shared base calendar stayed.
    expect(ids(await table(t, "calendars"))).toEqual(["cal-alpha"]);
    expect(ids(await table(t, "calendarExceptions"))).toEqual([]);

    const after = await signInAgain(t, admin);
    expect((after?.resources ?? []).length).toBe(0);
    expect((after?.assignments ?? []).length).toBe(0);
  });

  test("never takes the shared base calendar with an employee", async () => {
    const t = convexTest(schema, modules);
    const admin = await company(t, "alpha", "admin@alpha.example");
    const base = workspace("alpha");
    // A malformed-but-possible state: the employee points at the base calendar.
    await t.withIdentity({ subject: admin }).mutation(api.planner.replaceState, {
      state: {
        ...base,
        calendars: [base.calendars[0]],
        resources: base.resources.map((resource) => ({ ...resource, calendarId: "cal-alpha" })),
        exceptions: base.exceptions.map((exception) => ({ ...exception, calendarId: "cal-alpha" })),
      },
    });
    const result = await t.withIdentity({ subject: admin }).mutation(api.planner.deleteResource, { resourceId: "res-alpha" });
    expect(result.removed.calendars).toBe(0);
    expect(ids(await table(t, "calendars"))).toEqual(["cal-alpha"]);
    expect(ids(await table(t, "resources"))).toEqual([]);
  });

  test("refuses an employee of another company", async () => {
    const t = convexTest(schema, modules);
    const alpha = await company(t, "alpha", "admin@alpha.example");
    await company(t, "beta", "admin@beta.example");
    expect(await refusal(() => t.withIdentity({ subject: alpha }).mutation(api.planner.deleteResource, { resourceId: "res-beta" }))).not.toBe("");
    expect(ids(await table(t, "resources")).includes("res-beta")).toBe(true);
  });
});

describe("deleting a calendar", () => {
  test("removes the calendar and its leave rows, but protects the base one and any calendar in use", async () => {
    const t = convexTest(schema, modules);
    const admin = await company(t, "alpha", "admin@alpha.example");
    const base = workspace("alpha");
    const spare = { id: "cal-alpha-spare", name: "Spare", type: "project", parentCalendarId: "cal-alpha", isDefault: false, workingDays: [1, 2, 3, 4, 5] };

    expect(await refusal(() => t.withIdentity({ subject: admin }).mutation(api.planner.deleteCalendar, { calendarId: "cal-alpha" }))).toContain("base calendar");

    // In use by a project: refused.
    await t.withIdentity({ subject: admin }).mutation(api.planner.replaceState, { state: { ...base, projects: base.projects.map((project) => ({ ...project, calendarId: "cal-alpha-spare" })), calendars: [...base.calendars, spare] } });
    expect(await refusal(() => t.withIdentity({ subject: admin }).mutation(api.planner.deleteCalendar, { calendarId: "cal-alpha-spare" }))).toContain("still use this calendar");

    // In use by an employee: refused.
    await t.withIdentity({ subject: admin }).mutation(api.planner.replaceState, { state: { ...base, resources: base.resources.map((resource) => ({ ...resource, calendarId: "cal-alpha-spare" })), calendars: [...base.calendars, spare] } });
    expect(await refusal(() => t.withIdentity({ subject: admin }).mutation(api.planner.deleteCalendar, { calendarId: "cal-alpha-spare" }))).toContain("employee");

    // Unused: it goes, and takes its own leave with it.
    await t.withIdentity({ subject: admin }).mutation(api.planner.replaceState, {
      state: { ...base, calendars: [...base.calendars, spare], exceptions: [...base.exceptions, { id: "exc-alpha-spare", calendarId: "cal-alpha-spare", startDate: "2026-03-02", endDate: "2026-03-04", label: "Spare leave", type: "leave", isWorkingDay: false, source: "manual" }] },
    });
    const result = await t.withIdentity({ subject: admin }).mutation(api.planner.deleteCalendar, { calendarId: "cal-alpha-spare" });
    expect(result.removed.exceptions).toBe(1);
    expect(ids(await table(t, "calendars"))).toEqual(["cal-alpha", "cal-person-alpha"]);
    expect(ids(await table(t, "calendarExceptions"))).toEqual(["exc-alpha"]);

    const after = await signInAgain(t, admin);
    expect((after?.calendars ?? []).some((calendar) => calendar.id === "cal-alpha-spare")).toBe(false);
    expect((after?.exceptions ?? []).some((exception) => exception.id === "exc-alpha-spare")).toBe(false);
  });
});

describe("seeding", () => {
  test("creates the demo workspace exactly once for a brand-new company", async () => {
    const t = convexTest(schema, modules);
    const admin = await t.run((ctx) => ctx.db.insert("users", { name: "Fresh", email: "fresh@example.com" }));
    await t.withIdentity({ subject: admin }).mutation(api.companies.ensureCompany, {});
    await t.withIdentity({ subject: admin }).mutation(api.planner.initializeWorkspace, {});
    const first = ids(await table(t, "projects"));
    expect(first.length).toBeGreaterThan(0);

    // Signing in again, and seeding again, adds nothing.
    await signInAgain(t, admin);
    await t.withIdentity({ subject: admin }).mutation(api.planner.initializeWorkspace, {});
    expect(ids(await table(t, "projects"))).toEqual(first);
    for (const name of ["resources", "calendars", "tasks", "planVersions"] as const) {
      const rows = ids(await table(t, name));
      expect(new Set(rows).size).toBe(rows.length);
    }
  });

  test("never recreates a removed project, and never duplicates data, when a marker is missing", async () => {
    const t = convexTest(schema, modules);
    const admin = await company(t, "alpha", "admin@alpha.example");

    // Markers lost (say, a migrated company): the demo content must not be rebuilt.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("seedRuns").collect()) await ctx.db.delete(row._id);
    });
    await t.withIdentity({ subject: admin }).mutation(api.planner.deleteProject, { projectId: "proj-alpha-0" });
    const projectsBefore = ids(await table(t, "projects"));
    const resourcesBefore = ids(await table(t, "resources"));

    await signInAgain(t, admin);
    await t.withIdentity({ subject: admin }).mutation(api.planner.initializeWorkspace, {});

    expect(ids(await table(t, "projects"))).toEqual(projectsBefore);
    expect(ids(await table(t, "resources"))).toEqual(resourcesBefore);
    expect((await table(t, "projects")).some((row) => row.id === "proj-alpha-0")).toBe(false);
    const taskIds = ids(await table(t, "tasks"));
    expect(new Set(taskIds).size).toBe(taskIds.length);
  });
});
