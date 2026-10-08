/**
 * Resource optimization for the Gantt view.
 *
 * The advisor may move tasks of one project (the open one, its active version)
 * so that every employee sits as close as possible to 90% occupancy per week
 * without ever exceeding 100% because of that project. These cases pin down the
 * rules the feature promises: float first, the critical path only when needed,
 * never a duration / assignment / dependency change, never a task before its
 * dependencies, started work fixed in Monitoring, other projects counted but
 * never changed, an honest warning when a problem cannot be solved, and a
 * version-per-apply that leaves the original untouched.
 */
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { applyPlanningModeMargins, copyTasksToVersion, type PlannerTask } from "./planner-model";
import { createDefaultCalendarSystem, type CalendarSystem, type PlannerCalendar, type Weekday } from "./scheduling-engine";
import { optimizeProject, type OptimizeProjectInput } from "./resource-optimizer";

const modules = {
  "./planner.ts": () => import("../convex/planner"),
  "./companies.ts": () => import("../convex/companies"),
  "./auth.ts": () => import("../convex/auth"),
  "./_generated/api.ts": () => import("../convex/_generated/api"),
  "./_generated/server.ts": () => import("../convex/_generated/server"),
};

/* --------------------------------------------------------------- fixtures */

/** Monday–Friday everywhere, with a person calendar for the employee. */
const systemWith = (people: string[]): CalendarSystem => {
  const base = createDefaultCalendarSystem();
  const calendars: PlannerCalendar[] = people.map((id) => ({
    id,
    name: `${id} — leave`,
    type: "person",
    parentCalendarId: base.defaultCalendarId,
    isDefault: false,
    workingDays: [1, 2, 3, 4, 5] as Weekday[],
  }));
  return { calendars: [...base.calendars, ...calendars], exceptions: [], defaultCalendarId: base.defaultCalendarId };
};

const anna = { id: "res-anna", name: "Anna", hoursPerWeek: 40, calendarId: "cal-anna" };
const system = systemWith(["cal-anna"]);

const task = (over: Partial<PlannerTask> & { id: string; start: string; finish: string }): PlannerTask => ({
  parentId: null,
  name: over.id,
  duration: 1,
  durationUnit: "days",
  isMilestone: false,
  predecessors: "",
  resource: "",
  percent: 0,
  notes: "",
  color: "sage",
  marginPct: 0,
  ...over,
} as PlannerTask);

const run = (input: {
  tasks: PlannerTask[];
  assignments: { taskId: string; resourceId: string }[];
  others?: OptimizeProjectInput[];
  mode?: "planning" | "monitoring";
  today?: string;
}) => optimizeProject({
  projectId: "proj-open",
  projects: [
    { projectId: "proj-open", projectName: "Open project", projectCalendarId: "base", tasks: input.tasks },
    ...(input.others ?? []),
  ],
  resources: [anna],
  assignments: input.assignments,
  system,
  mode: input.mode ?? "planning",
  today: input.today ?? "2026-09-01",
});

const ok = (result: ReturnType<typeof optimizeProject>) => {
  if (!result.ok) throw new Error(result.error);
  return result;
};

const byId = (tasks: PlannerTask[]) => new Map(tasks.map((item) => [item.id, item]));
const weekOf = (result: ReturnType<typeof ok>, start: string) => result.occupancy[0].weeks.find((week) => week.weekStart === start)!;

/** The plan's shape is unchanged: durations, work, dependencies and names. */
const expectPlanIntact = (before: PlannerTask[], after: PlannerTask[]) => {
  expect(after.length).toBe(before.length);
  const map = byId(after);
  for (const item of before) {
    const next = map.get(item.id)!;
    expect(next.duration).toBe(item.duration);
    expect(next.durationUnit).toBe(item.durationUnit);
    expect(next.work ?? 0).toBe(item.work ?? 0);
    expect(next.predecessors).toBe(item.predecessors);
    expect(next.name).toBe(item.name);
    // A task stays one block: its distribution and any workload slices are
    // carried over verbatim, so nothing is split or re-spread.
    expect(next.distribution ?? "even").toBe(item.distribution ?? "even");
    expect(next.allocations).toEqual(item.allocations);
  }
};

const onAnna = (ids: string[]) => ids.map((taskId) => ({ taskId, resourceId: "res-anna" }));

/* ------------------------------------------------------------------- tests */

describe("resource optimization — float first", () => {
  test("an employee above 100% is brought back to the hard limit within float, without touching the project end", () => {
    const tasks = [
      task({ id: "A", name: "A", duration: 5, start: "2026-10-05", finish: "2026-10-09", work: 40 }),
      task({ id: "B", name: "B", duration: 2, start: "2026-10-08", finish: "2026-10-09", work: 16 }),
      // Unassigned work that fixes the project end, so A and B keep a float.
      task({ id: "C", name: "C", duration: 10, start: "2026-10-05", finish: "2026-10-16", work: 40 }),
    ];
    const result = ok(run({ tasks, assignments: onAnna(["A", "B"]) }));

    // Anna's overloaded week (56 h against 40 h) is gone.
    expect(weekOf(result, "2026-10-05").before).toBe(56);
    expect(weekOf(result, "2026-10-05").after <= 40).toBe(true);
    expect(result.unresolved.some((problem) => problem.kind === "over-capacity")).toBe(false);
    // Float only, so the project end date must not move.
    expect(result.finishDeltaWorkingDays).toBe(0);
    expect(result.newProjectFinish).toBe("2026-10-16");
    // Nothing but a start date changed, and no move was on the critical path.
    expectPlanIntact(tasks, result.tasks);
    for (const move of result.moves) expect(move.critical).toBe(false);
    for (const move of result.moves) expect(move.floatUsed <= move.floatAvailable).toBe(true);
  });

  test("a task that cannot move earlier because of its dependencies stays put, and the week is reported", () => {
    const tasks = [
      task({ id: "P", name: "P", duration: 5, start: "2026-10-05", finish: "2026-10-09" }),
      task({ id: "B", name: "B", duration: 3, start: "2026-10-12", finish: "2026-10-14", work: 24, predecessors: "PFS" }),
      task({ id: "D", name: "D", duration: 5, start: "2026-10-12", finish: "2026-10-16" }),
      task({ id: "E", name: "E", duration: 2, start: "2026-10-19", finish: "2026-10-20", work: 16, predecessors: "DFS" }),
    ];
    const result = ok(run({ tasks, assignments: onAnna(["B", "E"]) }));

    // Filling Anna's light week would need E to start before D allows, so no task
    // moves and the week is reported as far from the target.
    expect(result.moves).toEqual([]);
    expect(result.unresolved.some((problem) => problem.kind === "off-target" && problem.weekStart === "2026-10-12")).toBe(true);
    const after = byId(result.tasks);
    // The dependency is never crossed: E still starts on or after D's next day.
    expect(after.get("E")!.start >= "2026-10-19").toBe(true);
    expect(after.get("B")!.start >= "2026-10-12").toBe(true);
  });

  test("a lighter week is filled by moving a task earlier, up to 90%", () => {
    const tasks = [
      task({ id: "A", name: "A", duration: 3, start: "2026-10-05", finish: "2026-10-07", work: 24 }),
      task({ id: "B", name: "B", duration: 2, start: "2026-10-12", finish: "2026-10-13", work: 12 }),
      task({ id: "C", name: "C", duration: 10, start: "2026-10-05", finish: "2026-10-16", work: 40 }),
    ];
    const result = ok(run({ tasks, assignments: onAnna(["A", "B"]) }));

    const week = weekOf(result, "2026-10-05");
    expect(week.before).toBe(24);
    expect(week.after).toBe(36); // 24 h + 12 h = 36 h of 40 h = exactly 90 %
    const move = result.moves.find((item) => item.taskId === "B")!;
    expect(move.shiftDays).toBeLessThan(0);
    expect(move.newStart).toBe("2026-10-08");
    expect(result.finishDeltaWorkingDays).toBe(0);
    expect(result.unresolved).toEqual([]);
  });
});

describe("resource optimization — critical path when float is not enough", () => {
  test("an overload that cannot be solved within float moves a critical path task, delaying the project as little as possible", () => {
    const tasks = [
      task({ id: "P", name: "P", duration: 5, start: "2026-09-28", finish: "2026-10-02" }),
      // Both critical, both on Anna, both blocked from moving earlier by P.
      task({ id: "A", name: "A", duration: 5, start: "2026-10-05", finish: "2026-10-09", work: 40, predecessors: "PFS" }),
      task({ id: "B", name: "B", duration: 5, start: "2026-10-05", finish: "2026-10-09", work: 40, predecessors: "PFS" }),
    ];
    const result = ok(run({ tasks, assignments: onAnna(["A", "B"]) }));

    expect(result.movedCriticalTasks).toBe(true);
    expect(result.moves.some((move) => move.floatAvailable === 0)).toBe(true);
    expect(result.unresolved.some((problem) => problem.kind === "over-capacity")).toBe(false);
    // One week of work has to give way: five working days later, and not more.
    expect(result.finishDeltaWorkingDays).toBe(5);
    expectPlanIntact(tasks, result.tasks);
    // No task ever starts before its predecessor allows.
    const after = byId(result.tasks);
    expect(after.get("A")!.start >= "2026-10-05").toBe(true);
    expect(after.get("B")!.start >= "2026-10-05").toBe(true);
  });
});

describe("resource optimization — other projects and modes", () => {
  test("another project's workload limits the result, and that project is never changed", () => {
    // P fixes the start of A and B, so neither may be pulled earlier: the only
    // remedy for the overload is to move work later.
    const tasks = [
      task({ id: "P", name: "P", duration: 5, start: "2026-09-28", finish: "2026-10-02" }),
      task({ id: "A", name: "A", duration: 5, start: "2026-10-05", finish: "2026-10-09", work: 40, predecessors: "PFS" }),
      task({ id: "B", name: "B", duration: 2, start: "2026-10-08", finish: "2026-10-09", work: 16, predecessors: "PFS" }),
    ];
    const other = [{
      projectId: "proj-other",
      projectName: "Other project",
      projectCalendarId: "base",
      tasks: [task({ id: "O", name: "Other project task", duration: 5, start: "2026-10-12", finish: "2026-10-16", work: 40, versionId: "ver-other" })],
    }];
    const snapshot = JSON.stringify(other);

    // On this project alone, two working days of delay are enough.
    const alone = ok(run({ tasks, assignments: onAnna(["A", "B"]) }));
    expect(alone.finishDeltaWorkingDays).toBe(2);

    // The other project's task fills Anna's whole second week, so the overload
    // can only be lifted by moving past it — a longer delay, forced by work the
    // open project does not own.
    const result = ok(run({ tasks, others: other, assignments: onAnna(["A", "B", "O"]) }));
    expect(result.finishDeltaWorkingDays).toBe(7);
    expect(result.unresolved.some((problem) => problem.kind === "over-capacity")).toBe(false);
    // The other project's hours are counted…
    expect(weekOf(result, "2026-10-12").after >= 40).toBe(true);
    // …but its rows are never part of the result, its task never moves, and the
    // input is not touched.
    const move = result.moves.find((item) => item.taskId === "B")!;
    expect(move.newStart).toBe("2026-10-19");
    expect(result.tasks.some((item) => item.id === "O")).toBe(false);
    expect(JSON.stringify(other)).toBe(snapshot);
  });

  test("a started task may move while planning, and is fixed while monitoring", () => {
    const tasks = [
      task({ id: "A", name: "A", duration: 5, start: "2026-10-05", finish: "2026-10-09", work: 40 }),
      task({ id: "B", name: "B", duration: 2, start: "2026-10-05", finish: "2026-10-06", work: 16 }),
    ];
    const assignments = onAnna(["A", "B"]);
    const today = "2026-10-07"; // both tasks have started

    const planning = ok(run({ tasks, assignments, mode: "planning", today }));
    expect(planning.moves.some((move) => move.taskId === "B" && move.newStart !== "2026-10-05")).toBe(true);
    expect(planning.unresolved.some((problem) => problem.kind === "over-capacity")).toBe(false);

    // Monitoring tracks reality: started work is fixed, so the overload stays
    // and is reported rather than forced away.
    const monitoring = ok(run({ tasks, assignments, mode: "monitoring", today }));
    expect(monitoring.moves).toEqual([]);
    expect(monitoring.tasks).toEqual(tasks);
    expect(monitoring.unresolved.some((problem) => problem.kind === "over-capacity" && problem.weekStart === "2026-10-05")).toBe(true);
  });

  test("an unsolvable overload is shown as a warning, naming the other project's share", () => {
    const other = [{
      projectId: "proj-other",
      projectName: "Other project",
      projectCalendarId: "base",
      // 48 h against a 40 h week: over capacity on its own.
      tasks: [task({ id: "O", name: "Other project task", duration: 5, start: "2026-10-05", finish: "2026-10-09", work: 48 })],
    }];
    const tasks = [task({ id: "A", name: "A", duration: 1, start: "2026-10-08", finish: "2026-10-08", work: 8 })];
    const result = ok(run({ tasks, others: other, assignments: onAnna(["A", "O"]) }));

    const problem = result.unresolved.find((item) => item.kind === "over-capacity")!;
    expect(problem).toBeDefined();
    expect(problem.reason).toContain("Other projects already plan");
    expect(problem.allocated).toBeGreaterThan(problem.available);
  });
});

describe("resource optimization — apply and cancel", () => {
  const tasks = [
    task({ id: "A", name: "A", duration: 5, start: "2026-10-05", finish: "2026-10-09", work: 40 }),
    task({ id: "B", name: "B", duration: 2, start: "2026-10-08", finish: "2026-10-09", work: 16 }),
    task({ id: "C", name: "C", duration: 10, start: "2026-10-05", finish: "2026-10-16", work: 40 }),
  ];
  const assignments = onAnna(["A", "B"]);

  test("cancel changes nothing: the preview never writes and never mutates the plan", () => {
    const snapshot = JSON.stringify(tasks);
    const result = ok(run({ tasks, assignments }));
    expect(result.moves.length).toBeGreaterThan(0);
    // Computing the preview leaves the plan exactly as it was — Cancel is free.
    expect(JSON.stringify(tasks)).toBe(snapshot);
  });

  test("apply copies the optimized planning into a new version; the original rows are untouched", () => {
    const result = ok(run({ tasks, assignments }));
    const before = JSON.stringify(tasks);
    let counter = 0;
    const copy = copyTasksToVersion(result.tasks, "version-optimized", () => `task-copy-${++counter}`);
    expect(copy.error).toBeUndefined();
    expect(copy.tasks.length).toBe(tasks.length);
    // Fresh ids, same names, and the moved dates travel along.
    const copies = byId(copy.tasks);
    for (const item of tasks) expect(copies.has(item.id)).toBe(false);
    for (const move of result.moves) {
      const copied = copy.tasks.find((item) => item.name === move.taskName)!;
      expect(copied.start).toBe(move.newStart);
      expect(copied.finish).toBe(move.newFinish);
    }
    // Planning-mode margins are re-derived for the new version, as "New version" does.
    expect(applyPlanningModeMargins(copy.tasks).length).toBe(tasks.length);
    // The source version is not touched by the copy.
    expect(JSON.stringify(tasks)).toBe(before);
  });

  test("the applied version is stored next to the untouched original", async () => {
    const now = "2026-01-01T09:00:00.000Z";
    const base = createDefaultCalendarSystem();
    const seed = {
      projects: [{ id: "proj-open", name: "Open project", status: "active", kind: "project" as const, startDate: "2026-10-05", schedulingDirection: "forward", calendarId: base.defaultCalendarId, createdAt: now, updatedAt: now }],
      calendars: [
        { id: base.defaultCalendarId, name: "Standard workweek", type: "base" as const, parentCalendarId: null, isDefault: true, workingDays: [1, 2, 3, 4, 5] },
        { id: "cal-anna", name: "Anna — leave", type: "person" as const, parentCalendarId: base.defaultCalendarId, isDefault: false, workingDays: [1, 2, 3, 4, 5] },
      ],
      resources: [{ id: "res-anna", name: "Anna", role: "", email: "anna@example.com", colour: "sage", hoursPerWeek: 40, isActive: true, calendarId: "cal-anna" }],
      tasks: tasks.map((item, index) => ({ ...item, projectId: "proj-open", versionId: "ver-1", sortOrder: index })),
      planVersions: [{ id: "ver-1", projectId: "proj-open", name: "Version 1", isActive: true, createdAt: now, mode: "planning" }],
      dependencies: [],
      exceptions: [],
      assignments: assignments.map((item, index) => ({ id: `as-${index}`, taskId: item.taskId, resourceId: item.resourceId })),
      baselines: [],
      baselineTasks: [],
    };

    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", { name: "Admin", email: "admin@example.com" }));
    await t.withIdentity({ subject: userId }).mutation(api.companies.ensureCompany, {});
    await t.withIdentity({ subject: userId }).mutation(api.planner.replaceState, { state: seed });

    const live = (await t.withIdentity({ subject: userId }).query(api.planner.getState, {}))!;
    const liveTasks = (live.tasks as (PlannerTask & { id: string; projectId?: string; sortOrder?: number })[])
      .map(({ projectId, sortOrder, ...rest }) => { void projectId; void sortOrder; return rest as PlannerTask; });
    const result = ok(run({ tasks: liveTasks, assignments }));

    // Exactly what "Apply" writes: a second version plus its copies, and the
    // first version kept exactly as it is.
    let counter = 0;
    const copy = copyTasksToVersion(result.tasks, "ver-2", () => `task-copy-${++counter}`);
    const planned = applyPlanningModeMargins(copy.tasks);
    await t.withIdentity({ subject: userId }).mutation(api.planner.replaceState, {
      state: {
        ...seed,
        tasks: [...seed.tasks, ...planned.map((item, index) => ({ ...item, projectId: "proj-open", versionId: "ver-2", sortOrder: seed.tasks.length + index }))],
        planVersions: [{ ...seed.planVersions[0], isActive: false }, { id: "ver-2", projectId: "proj-open", name: "Optimized", isActive: true, createdAt: now, mode: "planning" }],
        assignments: [...seed.assignments, ...assignments.map((item, index) => ({ id: `as-copy-${index}`, taskId: copy.idMap.get(item.taskId)!, resourceId: item.resourceId }))],
      },
    });

    const after = (await t.withIdentity({ subject: userId }).query(api.planner.getState, {}))!;
    const versions = after.planVersions as { id: string; isActive: boolean }[];
    expect(versions.map((version) => version.id).sort()).toEqual(["ver-1", "ver-2"]);
    expect(versions.find((version) => version.id === "ver-2")!.isActive).toBe(true);

    const rows = after.tasks as (PlannerTask & { versionId?: string; id: string })[];
    const originals = new Map(rows.filter((row) => row.versionId === "ver-1").map((row) => [row.id, row]));
    // The original version is byte-for-byte the plan it was.
    for (const item of tasks) {
      expect(originals.get(item.id)!.start).toBe(item.start);
      expect(originals.get(item.id)!.finish).toBe(item.finish);
    }
    // The new version holds the optimized dates for every moved task.
    const optimized = new Map(rows.filter((row) => row.versionId === "ver-2").map((row) => [row.id, row]));
    expect(optimized.size).toBe(tasks.length);
    for (const item of tasks) {
      const copyId = copy.idMap.get(item.id)!;
      const sourceId = result.moves.find((move) => move.taskName === item.name);
      expect(optimized.get(copyId)!.start).toBe(sourceId ? sourceId.newStart : item.start);
      expect(optimized.get(copyId)!.finish).toBe(sourceId ? sourceId.newFinish : item.finish);
    }
    // A version was created next to the original, and the original is active=false.
    expect(originals.size).toBe(tasks.length);
  });
});
