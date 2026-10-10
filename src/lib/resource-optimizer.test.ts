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
import { readFileSync } from "node:fs";
import { convexTest } from "./convex-test-workspace";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { applyPlanningModeMargins, copyTasksToVersion, type PlannerTask } from "./planner-model";
import { createDefaultCalendarSystem, type CalendarSystem, type PlannerCalendar, type Weekday } from "./scheduling-engine";
import {
  EXTENSION_LIMIT,
  groupUnresolvedWeeks,
  maxDurationFor,
  optimizeProject,
  type OptimizationPlan,
  type OptimizeProgress,
  type OptimizeProjectInput,
  type OptimizeResource,
  type OptimizeUnresolved,
} from "./resource-optimizer";
import { runOptimizeJob, type OptimizeJobMessage } from "./optimize-job";
import { computeResourceLoads } from "./capacity-engine";

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
  fixedMilestoneIds?: string[];
  /** 0 turns duration extension off, which is how a case is compared to moves only. */
  maxExtensionDays?: number;
  /** The hard ceiling on scored options, for the limit cases. */
  maxEvaluations?: number;
  resources?: OptimizeResource[];
  calendarSystem?: CalendarSystem;
  timeLimitMs?: number;
  onProgress?: (progress: OptimizeProgress) => void;
}) => optimizeProject({
  projectId: "proj-open",
  projects: [
    { projectId: "proj-open", projectName: "Open project", projectCalendarId: "base", tasks: input.tasks },
    ...(input.others ?? []),
  ],
  resources: input.resources ?? [anna],
  assignments: input.assignments,
  system: input.calendarSystem ?? system,
  mode: input.mode ?? "planning",
  today: input.today ?? "2026-09-01",
  fixedMilestoneIds: input.fixedMilestoneIds,
  limits: {
    maxExtensionDays: input.maxExtensionDays ?? 8,
    ...(input.timeLimitMs !== undefined ? { timeLimitMs: input.timeLimitMs } : {}),
    ...(input.maxEvaluations !== undefined ? { maxEvaluations: input.maxEvaluations } : {}),
  },
  onProgress: input.onProgress,
});

/** A zero-duration row without children — a milestone, with a date to keep. */
const milestone = (id: string, date: string, predecessors: string): PlannerTask =>
  task({ id, name: id, duration: 0, start: date, finish: date, isMilestone: true, predecessors });

/** The hours a task really plans, summed from the capacity engine's daily split. */
const plannedHours = (tasks: PlannerTask[], tasksToMeasure: string[], assignments: { taskId: string; resourceId: string }[]) =>
  Object.fromEntries(tasksToMeasure.map((taskId) => {
    let total = 0;
    for (const report of computeResourceLoads({
      system,
      resources: [anna],
      assignments,
      projects: [{ projectId: "proj-open", projectName: "Open project", projectCalendarId: "base", tasks }],
    })) {
      for (const day of report.days) {
        for (const contribution of day.contributions) if (contribution.taskId === taskId) total += contribution.hours;
      }
    }
    return [taskId, Math.round(total * 100) / 100];
  }));

/** Priority 4 as the preview shows it: distance of every booked week from 90 %. */
const deviationOf = (plan: ReturnType<typeof optimizeProject>) => {
  if (!plan.ok) throw new Error(plan.error);
  return plan.occupancy.reduce((total, resource) => total + resource.weeks.reduce((sum, week) => (
    week.after <= 0 || week.available <= 0 ? sum : sum + Math.abs(week.after - 0.9 * week.available)
  ), 0), 0);
};

/**
 * Every rule that must hold whatever the optimizer decides: a task is never
 * shortened, never grows past +50 % of what it was, keeps its dependencies, stays
 * one block, and keeps its stored work hours.
 */
const expectPlanSound = (before: PlannerTask[], after: PlannerTask[]) => {
  expect(after.length).toBe(before.length);
  const map = byId(after);
  for (const item of before) {
    const next = map.get(item.id)!;
    expect(next.duration >= item.duration).toBe(true);
    expect(next.duration <= maxDurationFor(item.duration, Boolean(item.isMilestone) || item.duration <= 0)).toBe(true);
    expect(next.durationUnit).toBe(item.durationUnit);
    expect(next.work ?? 0).toBe(item.work ?? 0);
    expect(next.predecessors).toBe(item.predecessors);
    expect(next.name).toBe(item.name);
    expect(next.distribution ?? "even").toBe(item.distribution ?? "even");
    expect(next.allocations).toEqual(item.allocations);
  }
};

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

/* ------------------------------------------------------------------------ */
/* Scope: which employees and which weeks a run looks at.                    */
/* ------------------------------------------------------------------------ */

const ben = { id: "res-ben", name: "Ben", hoursPerWeek: 40, calendarId: "cal-ben" };

/** Everyone in the workspace, including people who never touch this project. */
const twoPeople = [anna, ben];
const twoCalendars = systemWith(["cal-anna", "cal-ben"]);

describe("resource optimization — scope of a run", () => {
  test("an employee who works only on another project is neither calculated nor shown", () => {
    const tasks = [task({ id: "A", name: "A", duration: 5, start: "2026-10-05", finish: "2026-10-09", work: 36 })];
    // Ben is at 200 % in the same week — on another project only. Anna's own week
    // is exactly on target, so this project has nothing to report.
    const other = [{
      projectId: "proj-other",
      projectName: "Other project",
      projectCalendarId: "base",
      tasks: [task({ id: "O", name: "O", duration: 5, start: "2026-10-05", finish: "2026-10-09", work: 80 })],
    }];
    const result = ok(run({
      tasks,
      others: other,
      resources: twoPeople,
      calendarSystem: twoCalendars,
      assignments: [...onAnna(["A"]), { taskId: "O", resourceId: "res-ben" }],
    }));

    // Only the employees the open project uses are part of the preview…
    expect(result.occupancy.map((entry) => entry.resourceName)).toEqual(["Anna"]);
    // …and nothing is reported about anyone else, however busy they are.
    expect(result.unresolved).toEqual([]);
    expect(result.blockers).toEqual([]);
  });

  test("a week this project can never reach is neither calculated nor reported", () => {
    const tasks = [
      task({ id: "A", name: "A", duration: 5, start: "2026-10-05", finish: "2026-10-09", work: 36 }),
      task({ id: "C", name: "C", duration: 5, start: "2026-10-12", finish: "2026-10-16", work: 36, predecessors: "AFS" }),
    ];
    // Eight months later — far outside the period this project could ever use.
    const other = [{
      projectId: "proj-other",
      projectName: "Other project",
      projectCalendarId: "base",
      tasks: [task({ id: "O", name: "O", duration: 5, start: "2027-03-01", finish: "2027-03-05", work: 80 })],
    }];
    const result = ok(run({ tasks, others: other, assignments: onAnna(["A", "C", "O"]) }));

    expect(result.occupancy.every((entry) => entry.weeks.every((week) => week.weekStart.startsWith("2026")))).toBe(true);
    expect(result.unresolved).toEqual([]);
    // The plan is already on target, so nothing needs to change either.
    expect(result.moves).toEqual([]);
  });

  test("a week far below 90 % names the rule that blocked a move", () => {
    // B may not start before D finishes, and the project ends with B, so Anna's
    // light week cannot be filled — the warning says what stopped it.
    const tasks = [
      task({ id: "D", name: "D", duration: 5, start: "2026-10-05", finish: "2026-10-09" }),
      task({ id: "B", name: "B", duration: 3, start: "2026-10-12", finish: "2026-10-14", work: 24, predecessors: "DFS" }),
    ];
    const result = ok(run({ tasks, assignments: onAnna(["B"]) }));

    const problem = result.unresolved.find((item) => item.kind === "off-target")!;
    expect(problem).toBeDefined();
    expect(problem.weekStart).toBe("2026-10-12");
    expect(problem.reason).toContain("Blocked by:");
    expect(problem.reason).toContain("B");
  });

  test("leftover weeks are grouped per employee, the most overloaded first", () => {
    const week = (kind: OptimizeUnresolved["kind"], resourceId: string, resourceName: string, weekStart: string): OptimizeUnresolved => ({
      kind,
      resourceId,
      resourceName,
      weekStart,
      weekEnd: weekStart,
      allocated: kind === "over-capacity" ? 48 : 12,
      available: 40,
      occupancy: kind === "over-capacity" ? 1.2 : 0.3,
      reason: `${resourceName} ${weekStart}`,
    });
    const groups = groupUnresolvedWeeks([
      week("off-target", "res-anna", "Anna", "2026-10-12"),
      week("over-capacity", "res-ben", "Ben", "2026-10-05"),
      week("over-capacity", "res-anna", "Anna", "2026-10-05"),
    ]);

    // One entry per employee instead of one per week, weeks in date order.
    expect(groups.map((group) => group.resourceName)).toEqual(["Anna", "Ben"]);
    expect(groups[0].weeks.map((item) => item.weekStart)).toEqual(["2026-10-05", "2026-10-12"]);
    expect(groups[0].overCapacity).toBe(1);
    expect(groups[1].weeks.length).toBe(1);
  });
});

/* ------------------------------------------------------------------------ */
/* Fixed milestones (chosen in the settings dialog before the run).          */
/* ------------------------------------------------------------------------ */

/** Pins the start of the tasks that follow it at Monday 5 October. */
const pinFiveOct = () => task({ id: "P", name: "P", duration: 5, start: "2026-09-28", finish: "2026-10-02" });
/** Unassigned work that holds the project end at Friday 16 October. */
const holdEnd = () => task({ id: "D", name: "D", duration: 10, start: "2026-10-05", finish: "2026-10-16" });

const twoDaysEach = (): PlannerTask[] => [
  task({ id: "A", name: "A", duration: 2, start: "2026-10-08", finish: "2026-10-09", work: 24, predecessors: "PFS", startConstraint: "2026-10-08" }),
  task({ id: "B", name: "B", duration: 2, start: "2026-10-08", finish: "2026-10-09", work: 24, predecessors: "PFS", startConstraint: "2026-10-08" }),
];

describe("resource optimization — fixed milestones", () => {
  test("a fixed milestone keeps its date while other tasks still change", () => {
    // Anna is at 48 h in the week of 5 October, so something has to give — but the
    // milestone the user ticked must not move, and it does not have to: A can move.
    const tasks = [pinFiveOct(), ...twoDaysEach(), milestone("M", "2026-10-12", "BFS"), holdEnd()];
    const result = ok(run({ tasks, assignments: onAnna(["A", "B"]), fixedMilestoneIds: ["M"] }));

    const m = result.milestones.find((item) => item.taskId === "M")!;
    expect(m.fixed).toBe(true);
    expect(m.moved).toBe(false);
    expect(m.newDate).toBe("2026-10-12");
    expect(result.fixedMilestoneIds).toEqual(["M"]);

    // Other tasks did change, and the milestone is not one of them.
    expect(result.moves.length).toBeGreaterThan(0);
    expect(result.moves.some((move) => move.taskId === "M")).toBe(false);
    expect(result.unresolved.some((problem) => problem.kind === "over-capacity")).toBe(false);
    expect(weekOf(result, "2026-10-05").after <= 40).toBe(true);
    expect(result.finishDeltaWorkingDays).toBe(0);
    expectPlanSound(tasks, result.tasks);
  });

  test("a milestone that is not fixed moves when the overload needs it", () => {
    // Two critical 40 h tasks in one week: the only way to the hard limit is to
    // move work past the milestone's date, so the milestone travels with it.
    const tasks = [
      pinFiveOct(),
      task({ id: "A", name: "A", duration: 5, start: "2026-10-05", finish: "2026-10-09", work: 40, predecessors: "PFS" }),
      task({ id: "B", name: "B", duration: 5, start: "2026-10-05", finish: "2026-10-09", work: 40, predecessors: "PFS" }),
      milestone("M", "2026-10-12", "AFS,BFS"),
    ];
    const result = ok(run({ tasks, assignments: onAnna(["A", "B"]) }));

    expect(result.fixedMilestoneIds).toEqual([]);
    const m = result.milestones.find((item) => item.taskId === "M")!;
    expect(m.fixed).toBe(false);
    expect(m.moved).toBe(true);
    expect(m.oldDate).toBe("2026-10-12");
    expect(m.newDate).toBe("2026-10-19");
    expect(result.unresolved.some((problem) => problem.kind === "over-capacity")).toBe(false);
    expectPlanSound(tasks, result.tasks);
  });

  test("an overload that would need a fixed milestone to move is reported, and nothing moves", () => {
    // Every way out of the overload would delay milestone M, which is fixed. The
    // plan is left exactly as it is and the conflict is named instead.
    const tasks = [
      pinFiveOct(),
      task({ id: "A", name: "A", duration: 4, start: "2026-10-05", finish: "2026-10-08", work: 32, predecessors: "PFS" }),
      task({ id: "B", name: "B", duration: 2, start: "2026-10-05", finish: "2026-10-06", work: 16, predecessors: "PFS" }),
      milestone("M", "2026-10-09", "AFS,BFS"),
    ];
    const result = ok(run({ tasks, assignments: onAnna(["A", "B"]), fixedMilestoneIds: ["M"] }));

    expect(result.moves).toEqual([]);
    expect(result.tasks).toEqual(tasks);
    const m = result.milestones.find((item) => item.taskId === "M")!;
    expect(m.newDate).toBe("2026-10-09");
    expect(m.moved).toBe(false);

    // The overload is reported, and the reason names the milestone, the employee
    // and the week that is involved.
    expect(result.unresolved.some((problem) => problem.kind === "over-capacity" && problem.weekStart === "2026-10-05")).toBe(true);
    const blocker = result.blockers.find((item) => item.kind === "fixed-milestone")!;
    expect(blocker).toBeDefined();
    expect(blocker.milestoneName).toBe("M");
    expect(blocker.milestoneDate).toBe("2026-10-09");
    expect(blocker.resourceNames).toEqual(["Anna"]);
    expect(blocker.weeks).toEqual(["2026-10-05"]);
    expect(blocker.reason).toContain("M");
    expect(blocker.reason).toContain("Anna");
  });
});

/* ------------------------------------------------------------------------ */
/* Extending task duration (the same work over more working days).           */
/* ------------------------------------------------------------------------ */

describe("resource optimization — extending task duration", () => {
  test("an overload is cleared by extending a task, within the +50 % limit", () => {
    // Anna is at 48 h in the week of 8 October. Nothing may move earlier (P) and
    // moving later would delay the project, so A is spread over three working
    // days instead — exactly +50 %, and its 24 h stay 24 h.
    const tasks = [
      pinFiveOct(),
      ...twoDaysEach(),
      task({ id: "X", name: "X", duration: 5, start: "2026-10-12", finish: "2026-10-16", work: 32 }),
    ];
    const assignments = onAnna(["A", "B", "X"]);
    const result = ok(run({ tasks, assignments }));

    expect(result.moves.length).toBe(1);
    const move = result.moves[0];
    expect(move.taskId).toBe("A");
    expect(move.changeKind).toBe("extended");
    expect(move.shiftDays).toBe(0);
    expect(move.extensionDays).toBe(1);
    expect(move.oldDuration).toBe(2);
    expect(move.newDuration).toBe(3);
    expect(move.extensionPct).toBe(50);
    expect(move.oldWork).toBe(24);
    expect(move.newWork).toBe(24);

    expect(result.unresolved.some((problem) => problem.kind === "over-capacity")).toBe(false);
    expect(weekOf(result, "2026-10-05").after).toBe(40);
    expect(result.finishDeltaWorkingDays).toBe(0);
    expect(result.workHoursPreserved).toBe(true);
    expectPlanSound(tasks, result.tasks);
    // The same hours, measured by the capacity engine before and after.
    expect(plannedHours(result.tasks, ["A"], assignments)).toEqual(plannedHours(tasks, ["A"], assignments));
  });

  test("extending gives a better result than moving alone", () => {
    // Two pinned tasks in one week. Moving one later clears the limit but leaves a
    // badly booked week; moving it and spreading it comes much closer to 90 %.
    const tasks = [
      pinFiveOct(),
      task({ id: "A", name: "A", duration: 5, start: "2026-10-05", finish: "2026-10-09", work: 40, predecessors: "PFS" }),
      task({ id: "B", name: "B", duration: 4, start: "2026-10-05", finish: "2026-10-08", work: 32, predecessors: "PFS" }),
      holdEnd(),
    ];
    const assignments = onAnna(["A", "B"]);

    const withExtension: OptimizationPlan = ok(run({ tasks, assignments }));
    const movesOnly = ok(run({ tasks, assignments, maxExtensionDays: 0 }));

    // Both clear the hard limit; the run that may extend is measurably closer to
    // the 90 % target, at the very same project end date.
    expect(withExtension.unresolved.some((problem) => problem.kind === "over-capacity")).toBe(false);
    expect(movesOnly.unresolved.some((problem) => problem.kind === "over-capacity")).toBe(false);
    expect(withExtension.finishDeltaWorkingDays).toBe(movesOnly.finishDeltaWorkingDays);
    expect(deviationOf(withExtension)).toBeLessThan(deviationOf(movesOnly));

    const move = withExtension.moves.find((item) => item.taskId === "A")!;
    expect(move.extensionDays).toBeGreaterThan(0);
    expect(move.changeKind).toBe("both");
    expect(move.newDuration <= maxDurationFor(5, false)).toBe(true);
    expect(withExtension.workHoursPreserved).toBe(true);
    expectPlanSound(tasks, withExtension.tasks);
  });

  test("moving gives the better result when both are possible", () => {
    // A fixed milestone sits one day after A's finish, so A can be neither moved
    // nor extended; B may do either, and moving it one day is what helps most.
    const tasks = [pinFiveOct(), ...twoDaysEach(), milestone("M", "2026-10-12", "AFS"), holdEnd()];
    const assignments = onAnna(["A", "B"]);
    const result = ok(run({ tasks, assignments, fixedMilestoneIds: ["M"] }));
    const movesOnly = ok(run({ tasks, assignments, fixedMilestoneIds: ["M"], maxExtensionDays: 0 }));

    expect(result.moves.length).toBeGreaterThan(0);
    for (const move of result.moves) {
      expect(move.extensionDays).toBe(0);
      expect(move.shiftDays).not.toBe(0);
    }
    expect(result.unresolved.some((problem) => problem.kind === "over-capacity")).toBe(false);
    expect(result.milestones[0].newDate).toBe("2026-10-12");
    // Extension was available and adds nothing here: the move is the answer.
    expect(movesOnly.moves.map((move) => [move.taskId, move.newStart])).toEqual(result.moves.map((move) => [move.taskId, move.newStart]));
    expectPlanSound(tasks, result.tasks);
  });

  test("the +50 % limit is never exceeded and a one-day task cannot be spread further", () => {
    // A one-day task has no headroom at all under the limit, so the overload it
    // sits in can only be lifted by moving it — which its fixed milestone forbids.
    const tasks = [
      pinFiveOct(),
      task({ id: "V", name: "V", duration: 1, start: "2026-10-05", finish: "2026-10-05", work: 16, predecessors: "PFS", startConstraint: "2026-10-05" }),
      task({ id: "W", name: "W", duration: 1, start: "2026-10-05", finish: "2026-10-05", work: 16, predecessors: "PFS", startConstraint: "2026-10-05" }),
      milestone("MV", "2026-10-06", "VFS,WFS"),
    ];
    const other = [{
      projectId: "proj-other",
      projectName: "Other project",
      projectCalendarId: "base",
      tasks: [task({ id: "O", name: "O", duration: 4, start: "2026-10-05", finish: "2026-10-08", work: 32 })],
    }];
    const result = ok(run({ tasks, others: other, assignments: onAnna(["V", "W", "O"]), fixedMilestoneIds: ["MV"] }));

    // The limit holds: no duration grew, and none could have.
    expect(result.tasks.map((item) => item.duration)).toEqual(tasks.map((item) => item.duration));
    expect(result.moves.every((move) => move.extensionDays === 0)).toBe(true);
    expect(maxDurationFor(4, false)).toBe(6);
    expect(maxDurationFor(5, false)).toBe(7);
    expect(maxDurationFor(1, false)).toBe(1);
    expect(maxDurationFor(0, true)).toBe(0);
    expect(EXTENSION_LIMIT).toBe(1.5);

    // The remaining overload is reported, and so is the limit that stops it.
    expect(result.unresolved.some((problem) => problem.kind === "over-capacity" && problem.weekStart === "2026-10-05")).toBe(true);
    const limit = result.blockers.find((item) => item.kind === "extension-limit")!;
    expect(limit).toBeDefined();
    expect(limit.taskNames).toEqual(["V", "W"]);
    expect(limit.resourceNames).toEqual(["Anna"]);
    expect(limit.weeks).toEqual(["2026-10-05"]);
    expect(limit.reason).toContain("+50%");
    expect(result.blockers.some((item) => item.kind === "fixed-milestone" && item.milestoneName === "MV")).toBe(true);
  });

  test("no task is ever shortened and every extended task keeps exactly its work hours", () => {
    const tasks = [
      pinFiveOct(),
      ...twoDaysEach(),
      task({ id: "X", name: "X", duration: 5, start: "2026-10-12", finish: "2026-10-16", work: 32 }),
    ];
    const assignments = onAnna(["A", "B", "X"]);
    const result = ok(run({ tasks, assignments }));
    const before = byId(tasks);

    expect(result.workHoursPreserved).toBe(true);
    const extended = result.moves.filter((move) => move.extensionDays > 0);
    expect(extended.length).toBeGreaterThan(0);
    const hoursBefore = plannedHours(tasks, extended.map((move) => move.taskId), assignments);
    const hoursAfter = plannedHours(result.tasks, extended.map((move) => move.taskId), assignments);
    for (const move of extended) {
      const source = before.get(move.taskId)!;
      expect(move.newDuration > move.oldDuration).toBe(true);
      expect(move.newDuration - move.oldDuration <= Math.floor(source.duration * (EXTENSION_LIMIT - 1))).toBe(true);
      // The same hours, only over more days.
      expect(hoursAfter[move.taskId]).toBe(hoursBefore[move.taskId]);
    }
    for (const item of tasks) {
      const after = byId(result.tasks).get(item.id)!;
      expect(after.duration >= item.duration).toBe(true);
    }
  });

  test("a started task is neither moved nor extended in monitoring mode", () => {
    const tasks = [
      task({ id: "A", name: "A", duration: 5, start: "2026-10-05", finish: "2026-10-09", work: 40 }),
      task({ id: "B", name: "B", duration: 2, start: "2026-10-05", finish: "2026-10-06", work: 16 }),
    ];
    const assignments = onAnna(["A", "B"]);
    const today = "2026-10-07";

    const monitoring = ok(run({ tasks, assignments, mode: "monitoring", today }));
    expect(monitoring.moves).toEqual([]);
    expect(monitoring.tasks.map((item) => [item.start, item.finish, item.duration])).toEqual(
      tasks.map((item) => [item.start, item.finish, item.duration]),
    );
    expect(monitoring.unresolved.some((problem) => problem.kind === "over-capacity" && problem.weekStart === "2026-10-05")).toBe(true);

    // The very same plan may change while planning, so the rule is the mode's.
    const planning = ok(run({ tasks, assignments, mode: "planning", today }));
    expect(planning.moves.length).toBeGreaterThan(0);
  });
});

/* --------------------------- the step-by-step method, its limits and its job */

/**
 * How the button now calculates: everything is prepared once, then the movable
 * tasks are walked one at a time with a bounded set of options — never all
 * combinations — under a wall-clock limit, as a background worker job so the page
 * never blocks. These cases pin that down on projects big enough that trying every
 * combination could not finish, and re-check the rules on the result.
 */
describe("resource optimization — the step-by-step method", () => {
  /** `count` two-day tasks, all starting the same Monday, all on the same employee. */
  const pile = (count: number): PlannerTask[] => Array.from({ length: count }, (_, index) => task({
    id: `T${index}`, name: `T${index}`, duration: 2, start: "2026-10-05", finish: "2026-10-06", work: 16,
  }));
  const pileAssignments = (count: number) => onAnna(Array.from({ length: count }, (_, index) => `T${index}`));

  test("a run reports each phase and where it spent the time", () => {
    const phases: OptimizeProgress[] = [];
    const tasks = pile(20);
    const result = ok(run({ tasks, assignments: pileAssignments(20), onProgress: (progress) => phases.push(progress) }));

    expect(phases[0].phase).toBe("preparing");
    expect(phases.some((progress) => progress.phase === "optimizing")).toBe(true);
    expect(phases.some((progress) => progress.phase === "reporting")).toBe(true);
    for (const progress of phases) expect(progress.ratio >= 0 && progress.ratio <= 1).toBe(true);
    // The phases are measured, they add up, and they cover the run.
    const { prepareMs, optimizeMs, reportMs, totalMs, evaluations } = result.timings;
    expect(evaluations).toBeGreaterThan(0);
    expect(prepareMs + optimizeMs + reportMs <= totalMs + 1).toBe(true);
    expect(result.timeLimited).toBe(false);
  });

  test("the largest project finishes inside the time budget and keeps every rule", () => {
    const tasks = [...pile(80), milestone("M", "2026-12-18", "T79")];
    const result = ok(run({
      tasks,
      assignments: pileAssignments(80),
      fixedMilestoneIds: ["M"],
      timeLimitMs: 10_000,
      // Room to work: with a ceiling high enough the search finishes on its own,
      // inside the 10-second budget.
      maxEvaluations: 100_000,
    }));

    expect(result.timeLimited).toBe(false);
    expect(result.timings.totalMs).toBeLessThan(10_000);
    expect(result.workHoursPreserved).toBe(true);
    // It really optimizes: the pile of same-week tasks is spread out.
    expect(result.moves.length).toBeGreaterThan(0);
    // No rule is broken: the fixed milestone keeps its date and every task keeps
    // its dependencies, work hours and duration range.
    expect(byId(result.tasks).get("M")!.start).toBe("2026-12-18");
    expectPlanSound(tasks, result.tasks);
  });

  test("never all combinations: the options grow with the tasks, not exponentially", () => {
    const small = ok(run({ tasks: pile(20), assignments: pileAssignments(20), timeLimitMs: 10_000 }));
    const large = ok(run({ tasks: pile(40), assignments: pileAssignments(40), timeLimitMs: 10_000 }));

    // A task tries at most its allowed window (start days × the six duration
    // steps), a few rounds over it — and twice the tasks stay about twice the
    // options instead of exploding into combinations.
    expect(small.timings.evaluations <= 20 * 21 * 6 * 4).toBe(true);
    expect(large.timings.evaluations <= small.timings.evaluations * 3 + 50).toBe(true);
  });

  test("the same input always gives exactly the same plan", () => {
    const first = ok(run({ tasks: pile(30), assignments: pileAssignments(30), timeLimitMs: 10_000 }));
    const second = ok(run({ tasks: pile(30), assignments: pileAssignments(30), timeLimitMs: 10_000 }));

    expect(second.moves).toEqual(first.moves);
    expect(second.tasks).toEqual(first.tasks);
    expect(second.unresolved).toEqual(first.unresolved);
    expect(second.timings.evaluations).toBe(first.timings.evaluations);
  });

  test("the option ceiling is a hard limit too, and the result says so", () => {
    const tasks = pile(80);
    const result = ok(run({ tasks, assignments: pileAssignments(80), timeLimitMs: 10_000, maxEvaluations: 200 }));

    // Every loop has a maximum: 200 options scored, then the search ends and the
    // best plan so far is returned, marked as possibly not optimal.
    expect(result.timeLimited).toBe(true);
    expect(result.timings.evaluations <= 300).toBe(true);
    expectPlanSound(tasks, result.tasks);
  });

  test("the 10-second limit stops the search early and still returns a valid plan", () => {
    const tasks = pile(60);
    const result = ok(run({ tasks, assignments: pileAssignments(60), timeLimitMs: 1 }));

    expect(result.timeLimited).toBe(true);
    expect(result.workHoursPreserved).toBe(true);
    expectPlanSound(tasks, result.tasks);
    for (const move of result.moves) {
      expect(move.newDuration >= move.oldDuration).toBe(true);
      expect(move.newDuration - move.oldDuration <= Math.floor(move.oldDuration * (EXTENSION_LIMIT - 1))).toBe(true);
    }
  });

  test("the background job reports progress and one result, and writes nothing", () => {
    const messages: OptimizeJobMessage[] = [];
    const tasks = pile(16);
    const snapshot = JSON.stringify(tasks);
    const result = runOptimizeJob({
      projectId: "proj-open",
      projects: [{ projectId: "proj-open", projectName: "Open project", projectCalendarId: "base", tasks }],
      resources: [anna],
      assignments: pileAssignments(16),
      system,
      mode: "planning",
      today: "2026-09-01",
    }, (message) => messages.push(message));

    expect(result.ok).toBe(true);
    expect(messages.some((message) => message.type === "progress")).toBe(true);
    expect(messages[messages.length - 1].type).toBe("result");
    // The job is pure: a cancelled run can never leave anything behind.
    expect(JSON.stringify(tasks)).toBe(snapshot);
  });

  test("a job that cannot run reports the failure instead of throwing", () => {
    const messages: OptimizeJobMessage[] = [];
    const result = runOptimizeJob({
      projectId: "not-this-project",
      projects: [{ projectId: "proj-open", projectName: "Open project", projectCalendarId: "base", tasks: pile(5) }],
      resources: [anna],
      assignments: pileAssignments(5),
      system,
      mode: "planning",
      today: "2026-09-01",
    }, (message) => messages.push(message));

    expect(result.ok).toBe(false);
    expect(messages[messages.length - 1].type).toBe("result");
    const last = messages[messages.length - 1];
    if (last.type === "result" && !last.result.ok) expect(last.result.error).toContain("workspace");
  });
});

/* --------------------------------- how the page runs it: never on the main thread */

describe("resource optimization — the page stays responsive", () => {
  const dashboard = () => readFileSync("src/pages/Dashboard.tsx", "utf8");

  test("the whole calculation runs in a background worker with progress and a Cancel", () => {
    const page = dashboard();
    const worker = readFileSync("src/lib/optimize-worker.ts", "utf8");

    // The engine runs in the worker module, never inline on the page.
    expect(worker).toContain("runOptimizeJob");
    expect(page).toContain('new Worker(new URL("../lib/optimize-worker.ts", import.meta.url), { type: "module" })');
    // "Optimizing…" with progress while it runs, and Cancel dropping the worker.
    expect(page).toContain("Optimizing…");
    expect(page).toContain("cancelOptimizeRun");
    expect(page).toContain("optimizeWorker.current?.terminate()");
    expect(page).toContain("setOptimizeRun(null)");
  });

  test("a run that hit the time limit says its result may not be optimal", () => {
    expect(dashboard()).toContain("optimizePlan.timeLimited");
  });
});
