import { describe, expect, test } from "bun:test";
import {
  canManageMembers,
  COMPANY_ADMIN,
  COMPANY_ROLES,
  COMPANY_SCOPED_TABLES,
  COMPANY_USER,
  defaultCompanyName,
  memberAttachDecision,
  migrationSummaryLines,
  needsCompany,
  normalizeCompanyRole,
  planningTotals,
  planningTotalsDifferences,
  planningTotalsMatch,
  roleChangeDecision,
  rowsNeedingCompany,
  workspaceCountDifferences,
  workspaceCounts,
  type CompanyMigrationReport,
  type WorkspaceSnapshot,
} from "./company-scope";

const owned = (id: string, companyId?: string) => ({ id, companyId });
const unowned = (id: string) => ({ id });

const task = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  parentId: null,
  duration: 1,
  start: "2026-10-05",
  finish: "2026-10-05",
  isMilestone: false,
  work: 8,
  marginDaysOriginal: 0,
  marginDaysConsumed: 0,
  ...over,
});

const snapshot = (over: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot => ({
  projects: [owned("proj-1")],
  tasks: [
    // A summary row (t2's parent), a leaf with work and reserve, and a milestone.
    task("t1", { duration: 0, work: 0, marginDaysOriginal: 2, marginDaysConsumed: 1 }),
    task("t2", { parentId: "t1", duration: 5, finish: "2026-10-12", marginDaysOriginal: 1 }),
    task("t3", { duration: 0, isMilestone: true, start: "2026-10-20", finish: "2026-10-20", work: 0 }),
  ],
  dependencies: [owned("dep-1")],
  calendars: [owned("cal-1")],
  calendarExceptions: [owned("exc-1")],
  resources: [owned("res-1")],
  taskAssignments: [owned("as-1")],
  planVersions: [owned("version-1")],
  baselines: [owned("baseline-1")],
  baselineTasks: [owned("bt-1"), owned("bt-2")],
  seedRuns: [owned("seed-1")],
  ...over,
});

describe("company account types", () => {
  test("there are exactly two, and only the admin manages users", () => {
    expect(COMPANY_ROLES.length).toBe(2);
    expect(COMPANY_ROLES[0]).toBe("company_admin");
    expect(COMPANY_ROLES[1]).toBe("user");
    expect(canManageMembers(COMPANY_ADMIN)).toBeTruthy();
    expect(canManageMembers(COMPANY_USER)).toBeFalsy();
  });

  test("anything unknown or missing falls back to a plain user, never an admin", () => {
    expect(normalizeCompanyRole(undefined)).toBe(COMPANY_USER);
    expect(normalizeCompanyRole("owner")).toBe(COMPANY_USER);
    expect(normalizeCompanyRole("company_admin")).toBe(COMPANY_ADMIN);
    expect(canManageMembers(undefined)).toBeFalsy();
  });
});

describe("default company name", () => {
  test("uses the organisation's domain for a work address", () => {
    expect(defaultCompanyName({ email: "jan@acme.be" })).toBe("Acme");
    expect(defaultCompanyName({ email: "jan@GemeenteUtrecht.nl" })).toBe("Gemeenteutrecht");
  });

  test("falls back to the account name for a shared mailbox, then to a generic name", () => {
    expect(defaultCompanyName({ name: "Jan Peeters", email: "jan@gmail.com" })).toBe("Jan Peeters's company");
    expect(defaultCompanyName({})).toBe("My company");
  });
});

describe("company-owned records", () => {
  test("lists every kind of company-owned record", () => {
    for (const table of [
      "projects", "tasks", "dependencies", "calendars", "calendarExceptions",
      "resources", "taskAssignments", "planVersions", "baselines", "baselineTasks",
    ]) {
      expect(COMPANY_SCOPED_TABLES).toContain(table);
    }
  });

  test("spots rows that still need a company link", () => {
    expect(needsCompany(unowned("proj-1"))).toBeTruthy();
    expect(needsCompany({ id: "proj-1", companyId: "" })).toBeTruthy();
    expect(needsCompany(owned("proj-1", "company-1"))).toBeFalsy();
    expect(rowsNeedingCompany([owned("a"), unowned("b"), owned("c", "company-1")]).length).toBe(2);
  });

  test("counts the records per table", () => {
    expect(workspaceCounts(snapshot())).toEqual({
      projects: 1, tasks: 3, dependencies: 1, calendars: 1, calendarExceptions: 1, resources: 1,
      taskAssignments: 1, planVersions: 1, baselines: 1, baselineTasks: 2, seedRuns: 1,
    });
    expect(workspaceCounts({})).toEqual({
      projects: 0, tasks: 0, dependencies: 0, calendars: 0, calendarExceptions: 0, resources: 0,
      taskAssignments: 0, planVersions: 0, baselines: 0, baselineTasks: 0, seedRuns: 0,
    });
  });

  test("reports which counts changed", () => {
    const before = workspaceCounts(snapshot());
    expect(workspaceCountDifferences(before, before).length).toBe(0);
    const after = workspaceCounts(snapshot({ tasks: [], baselineTasks: [] }));
    const differences = workspaceCountDifferences(before, after);
    expect(differences.length).toBe(2);
    expect(differences).toContain("tasks: 3 → 0");
    expect(differences).toContain("baselineTasks: 2 → 0");
  });
});

describe("planning totals", () => {
  test("are derived from the stored records only", () => {
    expect(planningTotals(snapshot())).toEqual({
      tasks: 3,
      leafTasks: 2,
      summaryTasks: 1,
      milestones: 1,
      totalDurationDays: 5,
      totalWorkHours: 8,
      marginPlannedDays: 3,
      marginConsumedDays: 1,
      dependencies: 1,
      baselineSnapshots: 2,
      earliestStart: "2026-10-05",
      latestFinish: "2026-10-20",
    });
  });

  test("are unchanged by linking records to a company", () => {
    const linked = snapshot({
      projects: [owned("proj-1", "company-1")],
      tasks: snapshot().tasks!.map((row) => ({ ...row, companyId: "company-1" })),
      baselines: [owned("baseline-1", "company-1")],
      baselineTasks: [owned("bt-1", "company-1"), owned("bt-2", "company-1")],
    });
    expect(planningTotalsMatch(planningTotals(snapshot()), planningTotals(linked))).toBeTruthy();
    expect(planningTotalsDifferences(planningTotals(snapshot()), planningTotals(linked)).length).toBe(0);
  });

  test("a moved date, duration, workload or margin is detected", () => {
    const before = planningTotals(snapshot());
    const movedDate = planningTotals(snapshot({ tasks: snapshot().tasks!.map((row) => row.id === "t3" ? { ...row, start: "2026-10-15", finish: "2026-10-15" } : row) }));
    expect(planningTotalsMatch(before, movedDate)).toBeFalsy();
    expect(planningTotalsDifferences(before, movedDate)).toContain("latestFinish: 2026-10-20 → 2026-10-15");

    const noMargin = planningTotals(snapshot({ tasks: snapshot().tasks!.map((row) => row.id === "t2" ? { ...row, marginDaysOriginal: 0 } : row) }));
    expect(planningTotalsDifferences(before, noMargin)).toContain("marginPlannedDays: 3 → 2");

    const heavier = planningTotals(snapshot({ tasks: snapshot().tasks!.map((row) => row.id === "t1" ? { ...row, duration: 4 } : row) }));
    expect(planningTotalsDifferences(before, heavier)).toContain("totalDurationDays: 5 → 9");
  });

  test("an empty workspace has no dates at all", () => {
    const totals = planningTotals({});
    expect(totals.tasks).toBe(0);
    expect(totals.earliestStart).toBeNull();
    expect(totals.latestFinish).toBeNull();
  });
});

describe("migration report", () => {
  const report = (over: Partial<CompanyMigrationReport> = {}): CompanyMigrationReport => ({
    created: true,
    companyId: "company-1",
    companyName: "Acme",
    role: COMPANY_ADMIN,
    rowsLinked: 12,
    rowsLinkedPerTable: { projects: 2, tasks: 8 },
    counts: { before: workspaceCounts(snapshot()), after: workspaceCounts(snapshot()) },
    totals: { before: planningTotals(snapshot()), after: planningTotals(snapshot()) },
    mismatch: [],
    ...over,
  });

  test("summarises what was linked and what the plan still totals", () => {
    const lines = migrationSummaryLines(report());
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("Created company \"Acme\" and linked 12 existing record(s).");
    expect(lines[1]).toContain("1 projects");
    expect(lines[1]).toContain("3 tasks");
    expect(lines[2]).toContain("3 tasks");
    expect(lines[2]).toContain("margin 3 d planned / 1 d consumed");
  });

  test("reports a mismatch instead of hiding it", () => {
    const lines = migrationSummaryLines(report({ created: false, mismatch: ["tasks: 3 → 2"] }));
    expect(lines[0]).toContain("already exists");
    expect(lines[lines.length - 1]).toContain("Mismatch detected");
    expect(lines[lines.length - 1]).toContain("tasks: 3 → 2");
  });
});

describe("access rules", () => {
  test("only a company admin changes account types, and the last admin stays", () => {
    expect(roleChangeDecision({ actorUserId: "u1", actorRole: COMPANY_ADMIN, targetUserId: "u2", nextRole: COMPANY_ADMIN, adminCount: 1 }).ok).toBeTruthy();
    expect(roleChangeDecision({ actorUserId: "u1", actorRole: COMPANY_ADMIN, targetUserId: "u2", nextRole: COMPANY_USER, adminCount: 2 }).ok).toBeTruthy();
    const demoteLast = roleChangeDecision({ actorUserId: "u1", actorRole: COMPANY_ADMIN, targetUserId: "u1", nextRole: COMPANY_USER, adminCount: 1 });
    expect(demoteLast.ok).toBeFalsy();
    expect(demoteLast.message).toContain("at least one company admin");
    const byUser = roleChangeDecision({ actorUserId: "u1", actorRole: COMPANY_USER, targetUserId: "u2", nextRole: COMPANY_ADMIN, adminCount: 1 });
    expect(byUser.ok).toBeFalsy();
    expect(byUser.message).toContain("Only a company admin");
    expect(roleChangeDecision({ actorUserId: "u1", actorRole: COMPANY_ADMIN, targetUserId: "u2", nextRole: "owner", adminCount: 2 }).ok).toBeFalsy();
  });

  test("an account can only be added to a company it does not already belong to", () => {
    expect(memberAttachDecision({ actorRole: COMPANY_ADMIN, existingCompanyId: null, companyId: "company-1" }).ok).toBeTruthy();
    expect(memberAttachDecision({ actorRole: COMPANY_ADMIN, existingCompanyId: "company-1", companyId: "company-1" }).ok).toBeFalsy();
    expect(memberAttachDecision({ actorRole: COMPANY_ADMIN, existingCompanyId: "company-2", companyId: "company-1" }).ok).toBeFalsy();
    expect(memberAttachDecision({ actorRole: COMPANY_USER, existingCompanyId: null, companyId: "company-1" }).ok).toBeFalsy();
  });
});
