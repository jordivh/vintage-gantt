/**
 * Company isolation — automated cross-company read and write checks.
 *
 * Two companies are stood up in a mock Convex backend running the real
 * functions (`convex-test`), each with a full workspace: projects, tasks,
 * dependencies, plan versions, baselines, baseline snapshots, calendars,
 * calendar exceptions, resources and task assignments. Every check then asks the
 * same question from the other side: can Company Beta see, name, change or
 * remove anything of Company Alpha's — by identifier, by title, or by count?
 *
 * These are the guarantees the security change rests on, so every data type has
 * its own assertions rather than one shared sample. The file lives outside
 * `src/convex` on purpose: the function directory must only hold deployable
 * modules.
 */
import { describe, expect, test } from "bun:test";
import { convexTest } from "./convex-test-workspace";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import {
  normalizeWorkspaceRelations,
  outsideCompanyReferences,
  workspaceIsolationReport,
} from "./company-integrity";

// The modules map is explicit instead of `import.meta.glob`, which only exists
// under Vite. Only the modules that hold the data path are needed; the
// `_generated` entries are how convex-test finds the functions directory.
const modules = {
  "./planner.ts": () => import("../convex/planner"),
  "./companies.ts": () => import("../convex/companies"),
  "./_generated/api.ts": () => import("../convex/_generated/api"),
  "./_generated/server.ts": () => import("../convex/_generated/server"),
};

const NOW = "2026-01-01T09:00:00.000Z";

/** One complete workspace, tagged so a leak is unmistakable in an assertion. */
const workspace = (tag: string) => ({
  projects: [
    {
      id: `proj-${tag}`,
      name: `Project ${tag}`,
      status: "active",
      kind: "project",
      startDate: "2026-01-05",
      schedulingDirection: "forward",
      calendarId: `cal-${tag}`,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
  calendars: [
    {
      id: `cal-${tag}`,
      name: `Calendar ${tag}`,
      type: "base",
      parentCalendarId: null,
      isDefault: true,
      workingDays: [1, 2, 3, 4, 5],
    },
  ],
  resources: [
    {
      id: `res-${tag}`,
      name: `Person ${tag}`,
      role: "",
      email: `person@${tag}.example`,
      colour: "sage",
      hoursPerWeek: 40,
      isActive: true,
      calendarId: `cal-${tag}`,
    },
  ],
  tasks: [
    {
      id: `task-${tag}-1`,
      projectId: `proj-${tag}`,
      parentId: null,
      sortOrder: 0,
      name: `Task ${tag} one`,
      duration: 3,
      durationUnit: "days",
      start: "2026-01-05",
      finish: "2026-01-07",
      isMilestone: false,
      predecessors: "",
      resource: "",
      percent: 0,
      notes: "",
      color: "ochre",
      versionId: `version-${tag}-1`,
      marginPct: 10,
      marginDaysOriginal: 1,
      marginDaysConsumed: 0,
    },
    {
      id: `task-${tag}-2`,
      projectId: `proj-${tag}`,
      parentId: null,
      sortOrder: 1,
      name: `Task ${tag} two`,
      duration: 2,
      durationUnit: "days",
      start: "2026-01-08",
      finish: "2026-01-09",
      isMilestone: false,
      predecessors: `task-${tag}-1FS`,
      resource: "",
      percent: 0,
      notes: "",
      color: "sage",
      versionId: `version-${tag}-1`,
      marginPct: 0,
      marginDaysOriginal: 0,
      marginDaysConsumed: 0,
    },
  ],
  planVersions: [
    { id: `version-${tag}-1`, projectId: `proj-${tag}`, name: "Version 1", isActive: true, createdAt: NOW, mode: "planning" },
  ],
  dependencies: [
    {
      id: `dep-${tag}`,
      projectId: `proj-${tag}`,
      predecessorId: `task-${tag}-1`,
      successorId: `task-${tag}-2`,
      type: "FS",
      lagDays: 0,
    },
  ],
  assignments: [{ id: `as-${tag}`, taskId: `task-${tag}-1`, resourceId: `res-${tag}` }],
  exceptions: [
    {
      id: `exc-${tag}`,
      calendarId: `cal-${tag}`,
      startDate: "2026-02-02",
      endDate: "2026-02-06",
      label: `Leave ${tag}`,
      type: "leave",
      isWorkingDay: false,
      source: "manual",
    },
  ],
  baselines: [
    { id: `baseline-${tag}`, projectId: `proj-${tag}`, versionId: `version-${tag}-1`, name: `Baseline ${tag}`, createdAt: NOW },
  ],
  baselineTasks: [
    {
      id: `baseline-task-${tag}`,
      baselineId: `baseline-${tag}`,
      taskId: `task-${tag}-1`,
      startDate: "2026-01-05",
      finishDate: "2026-01-07",
      durationDays: 3,
      marginPct: 10,
      marginDaysOriginal: 1,
      marginDaysConsumed: 0,
    },
  ],
});

type Store = ReturnType<typeof workspace>;

/** Runs something that must be refused, and returns the refusal message. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

/** Two companies, each with one account and its own complete workspace. */
async function twoCompanies() {
  const t = convexTest(schema, modules);
  const alpha = await t.run((ctx) => ctx.db.insert("users", { name: "Alpha admin", email: "admin@alpha.example" }));
  const beta = await t.run((ctx) => ctx.db.insert("users", { name: "Beta admin", email: "admin@beta.example" }));
  await t.withIdentity({ subject: alpha }).mutation(api.companies.ensureCompany, {});
  await t.withIdentity({ subject: beta }).mutation(api.companies.ensureCompany, {});
  await t.withIdentity({ subject: alpha }).mutation(api.planner.replaceState, { state: workspace("alpha") });
  await t.withIdentity({ subject: beta }).mutation(api.planner.replaceState, { state: workspace("beta") });
  return { t, alpha, beta };
}

describe("company isolation — reads", () => {
  test("a company reads only its own workspace, for every data type", async () => {
    const { t, beta } = await twoCompanies();
    const seen = (await t.withIdentity({ subject: beta }).query(api.planner.getState, {})) as unknown as Record<
      string,
      { id: string }[]
    >;
    const other = workspace("alpha") as unknown as Record<string, { id: string }[]>;

    for (const table of [
      "projects",
      "tasks",
      "dependencies",
      "calendars",
      "exceptions",
      "resources",
      "assignments",
      "planVersions",
      "baselines",
      "baselineTasks",
    ] as const) {
      const own = seen?.[table];
      const foreign = other[table];
      // Same shape, no overlap: exactly this company's own records.
      expect(own?.length).toBe(foreign.length);
      for (const row of foreign) expect(own?.some((item) => item.id === row.id)).toBe(false);
    }
  });

  test("no identifier, title or count of the other company appears anywhere", async () => {
    const { t, beta } = await twoCompanies();
    const seen = await t.withIdentity({ subject: beta }).query(api.planner.getState, {});
    const serialised = JSON.stringify(seen);
    expect(serialised.includes("alpha")).toBe(false);
    expect(serialised.includes("Project alpha")).toBe(false);
    expect(serialised.includes("Person alpha")).toBe(false);
    expect(serialised.includes("person@alpha.example")).toBe(false);
    expect(serialised.includes("Leave alpha")).toBe(false);
    // Counts stay this company's own: two tasks, one of everything else.
    expect((seen?.tasks ?? []).length).toBe(2);
    expect((seen?.assignments ?? []).length).toBe(1);
    expect((seen?.dependencies ?? []).length).toBe(1);
  });

  test("a signed-out caller reads nothing at all", async () => {
    const { t } = await twoCompanies();
    expect(await t.query(api.planner.getState, {})).toBeNull();
  });

  test("the company record itself only ever describes the caller's company", async () => {
    const { t, alpha, beta } = await twoCompanies();
    const seenAlpha = await t.withIdentity({ subject: alpha }).query(api.companies.current, {});
    const seenBeta = await t.withIdentity({ subject: beta }).query(api.companies.current, {});
    expect(seenAlpha?.company.id === seenBeta?.company.id).toBe(false);
    expect((seenAlpha?.members ?? []).every((member) => member.email === "admin@alpha.example")).toBe(true);
    expect((seenBeta?.members ?? []).some((member) => member.email === "admin@alpha.example")).toBe(false);
  });
});

describe("company isolation — writes", () => {
  test("another company's employee can never be assigned to a task", async () => {
    const { t, alpha, beta } = await twoCompanies();
    const state = { ...workspace("beta"), assignments: [{ id: "as-stolen", taskId: "task-beta-1", resourceId: "res-alpha" }] };

    const message = await refusal(() => t.withIdentity({ subject: beta }).mutation(api.planner.replaceState, { state }));
    expect(message.length).toBeGreaterThan(0);
    expect(message.includes("alpha")).toBe(false);

    // Refused, so the stored workspace is untouched — for both companies.
    const alphaAfter = await t.withIdentity({ subject: alpha }).query(api.planner.getState, {});
    const betaAfter = await t.withIdentity({ subject: beta }).query(api.planner.getState, {});
    expect((betaAfter?.assignments ?? []).length).toBe(1);
    expect((betaAfter?.assignments ?? [])[0].resourceId).toBe("res-beta");
    expect((alphaAfter?.resources ?? []).length).toBe(1);
    expect((alphaAfter?.assignments ?? [])[0].resourceId).toBe("res-alpha");
  });

  test("another company's project, task, calendar, version or baseline is refused as a relation", async () => {
    const { t, beta } = await twoCompanies();
    const betaStore = workspace("beta");

    const foreignRelations: [string, (sample: Store) => unknown][] = [
      ["task on another company's project", (s) => ({ ...s, tasks: [{ ...s.tasks[0], projectId: "proj-alpha" }] })],
      ["dependency on another company's task", (s) => ({ ...s, dependencies: [{ ...s.dependencies[0], successorId: "task-alpha-1" }] })],
      ["exception on another company's calendar", (s) => ({ ...s, exceptions: [{ ...s.exceptions[0], calendarId: "cal-alpha" }] })],
      ["version of another company's project", (s) => ({ ...s, planVersions: [{ ...s.planVersions[0], projectId: "proj-alpha" }] })],
      ["baseline of another company's project", (s) => ({ ...s, baselines: [{ ...s.baselines[0], projectId: "proj-alpha" }] })],
      ["snapshot of another company's baseline", (s) => ({ ...s, baselineTasks: [{ ...s.baselineTasks[0], baselineId: "baseline-alpha" }] })],
      ["assignment of another company's task", (s) => ({ ...s, assignments: [{ ...s.assignments[0], taskId: "task-alpha-1" }] })],
      ["calendar hanging off another company's parent", (s) => ({ ...s, calendars: [{ ...s.calendars[0], parentCalendarId: "cal-alpha" }] })],
    ];

    for (const [label, mutate] of foreignRelations) {
      const message = await refusal(() =>
        t.withIdentity({ subject: beta }).mutation(api.planner.replaceState, { state: mutate(betaStore) }),
      );
      expect(`${label}: ${message ? "refused" : "accepted"}`).toBe(`${label}: refused`);
      expect(message.includes("alpha")).toBe(false);
    }
  });

  test("a company cannot delete, empty or rewrite another company's records", async () => {
    const { t, alpha, beta } = await twoCompanies();
    const before = await t.withIdentity({ subject: alpha }).query(api.planner.getState, {});

    // Beta replaces its own workspace with an empty one, and then with a full
    // one whose ids are Beta's own. Neither may touch Alpha's rows.
    await t.withIdentity({ subject: beta }).mutation(api.planner.replaceState, { state: {} });
    await t.withIdentity({ subject: beta }).mutation(api.planner.replaceState, { state: workspace("beta") });

    const after = await t.withIdentity({ subject: alpha }).query(api.planner.getState, {});
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect((after?.projects ?? []).length).toBe(1);
    expect((after?.tasks ?? []).length).toBe(2);
  });

  test("a payload cannot choose its company, and a signed-out caller writes nothing", async () => {
    const { t, beta } = await twoCompanies();
    const claimed = { ...workspace("beta"), companyId: "companies:whatever", ownerId: "users:whatever" };
    await t.withIdentity({ subject: beta }).mutation(api.planner.replaceState, { state: claimed });
    // Whatever id the payload carries, the rows stay in the caller's own
    // company and the caller sees one company with one member.
    const company = await t.withIdentity({ subject: beta }).query(api.companies.current, {});
    const seen = await t.withIdentity({ subject: beta }).query(api.planner.getState, {});
    expect(company?.members.length).toBe(1);
    expect((seen?.projects ?? []).length).toBe(1);

    const message = await refusal(() => t.mutation(api.planner.replaceState, { state: workspace("beta") }));
    expect(message.length).toBeGreaterThan(0);
  });
});

describe("company isolation — the seeded workspace", () => {
  test("the built-in workspaces round-trip through a save without a refusal", async () => {
    // The strict gate must never fire for the app's own data. This seeds the
    // real built-in projects (TP-R2 and the R3 trio) and then saves back exactly
    // what was read, the way the client does on every edit.
    const t = convexTest(schema, modules);
    const user = await t.run((ctx) => ctx.db.insert("users", { name: "Starter", email: "starter@example.com" }));
    await t.withIdentity({ subject: user }).mutation(api.companies.ensureCompany, {});
    await t.withIdentity({ subject: user }).mutation(api.planner.initializeWorkspace, {});

    const state = (await t.withIdentity({ subject: user }).query(api.planner.getState, {})) as unknown as Record<string, unknown>;
    expect((state.tasks as unknown[]).length).toBeGreaterThan(0);
    const { company: _company, role: _role, companyId: _companyId, ...rows } = state;

    const message = await refusal(() =>
      t.withIdentity({ subject: user }).mutation(api.planner.replaceState, { state: rows }),
    );
    expect(message).toBe("");

    const after = await t.withIdentity({ subject: user }).query(api.planner.getState, {});
    expect((after?.tasks ?? []).length).toBe((state.tasks as unknown[]).length);
    expect((after?.projects ?? []).length).toBe((state.projects as unknown[]).length);
    expect((after?.assignments ?? []).length).toBe((state.assignments as unknown[]).length);
    expect((after?.dependencies ?? []).length).toBe((state.dependencies as unknown[]).length);
    expect((after?.baselines ?? []).length).toBe((state.baselines as unknown[]).length);

    const audit = await t.query(internal.planner.isolationAudit, {});
    expect(audit.companiesWithForeignReferences).toBe(0);
  });
});

describe("company isolation — the relation rules", () => {
  test("a workspace that only refers to itself has nothing outside it", () => {
    expect(outsideCompanyReferences(workspace("alpha"))).toEqual([]);
  });

  test("a foreign assignment is reported as a reference outside the company", () => {
    const rows = { ...workspace("beta"), assignments: [{ id: "as-x", taskId: "task-beta-1", resourceId: "res-alpha" }] };
    const violations = outsideCompanyReferences(rows);
    expect(violations.length).toBe(1);
    expect(violations[0].table).toBe("assignments");
    expect(violations[0].field).toBe("resourceId");
    expect(violations[0].target).toBe("resources");
  });

  test("the audit counts every data type and must report no foreign references", async () => {
    const { t } = await twoCompanies();
    const audit = await t.query(internal.planner.isolationAudit, {});
    expect(audit.companies).toBe(2);
    expect(audit.companiesWithForeignReferences).toBe(0);
    for (const report of audit.reports) {
      expect(report.outsideCompany).toEqual([]);
      expect(report.projects).toBe(1);
      expect(report.tasks).toBe(2);
      expect(report.dependencies).toBe(1);
      expect(report.calendars).toBe(1);
      expect(report.exceptions).toBe(1);
      expect(report.resources).toBe(1);
      expect(report.assignments).toBe(1);
      expect(report.planVersions).toBe(1);
      expect(report.baselines).toBe(1);
      expect(report.baselineTasks).toBe(1);
    }
    const report = workspaceIsolationReport(workspace("alpha"));
    expect(report.outsideCompany.length).toBe(0);
    expect(report.tasks).toBe(2);
  });

  test("the client repair drops inert links and keeps every plan figure", () => {
    const rows = {
      ...workspace("beta"),
      assignments: [
        { id: "as-good", taskId: "task-beta-1", resourceId: "res-beta" },
        { id: "as-gone-task", taskId: "task-deleted", resourceId: "res-beta" },
        { id: "as-foreign", taskId: "task-beta-2", resourceId: "res-alpha" },
      ],
      dependencies: [
        { id: "dep-good", projectId: "proj-beta", predecessorId: "task-beta-1", successorId: "task-beta-2", type: "FS", lagDays: 0 },
        { id: "dep-foreign", projectId: "proj-beta", predecessorId: "task-alpha-1", successorId: "task-beta-2", type: "FS", lagDays: 0 },
      ],
      exceptions: [
        { id: "exc-good", calendarId: "cal-beta", startDate: "2026-02-02", endDate: "2026-02-06", label: "Leave beta", type: "leave", isWorkingDay: false, source: "manual" },
        { id: "exc-foreign", calendarId: "cal-alpha", startDate: "2026-03-02", endDate: "2026-03-06", label: "Leave alpha", type: "leave", isWorkingDay: false, source: "manual" },
      ],
    };
    const repaired = normalizeWorkspaceRelations(rows);
    expect((repaired.rows.assignments ?? []).map((row) => row.id)).toEqual(["as-good"]);
    expect((repaired.rows.dependencies ?? []).map((row) => row.id)).toEqual(["dep-good"]);
    expect((repaired.rows.exceptions ?? []).map((row) => row.id)).toEqual(["exc-good"]);
    expect(repaired.dropped.length).toBe(4);
    // Nothing that carries a plan figure is removed or rewritten.
    expect(repaired.rows.tasks).toEqual(rows.tasks as never);
    expect(repaired.rows.baselines).toEqual(rows.baselines as never);
    expect(repaired.rows.baselineTasks).toEqual(rows.baselineTasks as never);
    expect(repaired.rows.planVersions).toEqual(rows.planVersions as never);
    expect(repaired.rows.calendars).toEqual(rows.calendars as never);
    expect(repaired.rows.projects).toEqual(rows.projects as never);
    expect(repaired.rows.resources).toEqual(rows.resources as never);
    expect(outsideCompanyReferences(repaired.rows)).toEqual([]);
  });
});
