import { describe, expect, test } from "bun:test";
import {
  addWorkingDays,
  ensureWorkingDay,
  resolveWorkingDay,
  scheduleTasks,
  workingDaysBetween,
  type CalendarException,
  type CalendarSystem,
  type PlannerCalendar,
} from "./scheduling-engine";
import {
  applyMarginConsumption,
  applyModeCommit,
  applyPlanningModeMargins,
  applyReplanMargins,
  dependenciesForTasks,
  fieldModeReadOnly,
  formatPredecessorsForDisplay,
  marginAfterPctChange,
  orderTasksForDisplay,
  planFinishDate,
  recalculateTasks,
  remapCopiedTasks,
  replanScopeIds,
  settleMonitoringPlan,
  startConstraintFor,
  startEditRestriction,
  withCalculatedPlanningFields,
  type PlannerTask,
} from "./planner-model";

/* ------------------------------------------------------------------ helpers */

const baseCalendar = (overrides: Partial<PlannerCalendar> = {}): PlannerCalendar => ({
  id: "base",
  name: "Belgium — standard",
  type: "base",
  parentCalendarId: null,
  isDefault: true,
  workingDays: [1, 2, 3, 4, 5],
  ...overrides,
});

const projectCalendar = (overrides: Partial<PlannerCalendar> = {}): PlannerCalendar => ({
  id: "proj",
  name: "Riverside Arts Festival",
  type: "project",
  parentCalendarId: "base",
  isDefault: false,
  ...overrides,
});

const personCalendar = (overrides: Partial<PlannerCalendar> = {}): PlannerCalendar => ({
  id: "person",
  name: "M. Alvarez — leave",
  type: "person",
  parentCalendarId: "proj",
  isDefault: false,
  ...overrides,
});

const exception = (overrides: Partial<CalendarException>): CalendarException => ({
  id: overrides.id ?? "exception",
  calendarId: "base",
  startDate: "2025-01-01",
  endDate: "2025-01-01",
  label: "Exception",
  type: "holiday",
  isWorkingDay: false,
  source: "manual",
  ...overrides,
});

const systemWith = (exceptions: CalendarException[]): CalendarSystem => ({
  calendars: [baseCalendar(), projectCalendar(), personCalendar()],
  exceptions,
  defaultCalendarId: "base",
});

/* ----------------------------------------------------- working-day resolver */

describe("resolveWorkingDay", () => {
  test("weekend is not a working day", () => {
    const system = systemWith([]);
    expect(resolveWorkingDay("2025-07-19", "proj", system).isWorkingDay).toBe(false); // Saturday
    expect(resolveWorkingDay("2025-07-20", "proj", system).isWorkingDay).toBe(false); // Sunday
    expect(resolveWorkingDay("2025-07-21", "proj", system).isWorkingDay).toBe(true); // Monday
  });

  test("inherited holiday from the base calendar", () => {
    const system = systemWith([
      exception({ id: "be-national", calendarId: "base", startDate: "2025-07-21", endDate: "2025-07-21", label: "Belgian National Day" }),
    ]);
    const resolution = resolveWorkingDay("2025-07-21", "proj", system);
    expect(resolution.isWorkingDay).toBe(false);
    expect(resolution.sourceCalendarId).toBe("base");
    expect(resolution.sourceCalendarName).toBe("Belgium — standard");
    expect(resolution.inherited).toBe(true);
    expect(resolution.reason).toBe("Belgian National Day");
  });

  test("local override of an inherited holiday", () => {
    const system = systemWith([
      exception({ id: "be-national", calendarId: "base", startDate: "2025-07-21", endDate: "2025-07-21", label: "Belgian National Day" }),
      exception({ id: "work-through", calendarId: "proj", startDate: "2025-07-21", endDate: "2025-07-21", label: "Festival build day", type: "extra-working", isWorkingDay: true }),
    ]);
    const project = resolveWorkingDay("2025-07-21", "proj", system);
    expect(project.isWorkingDay).toBe(true);
    expect(project.sourceCalendarId).toBe("proj");
    expect(project.inherited).toBe(false);
    expect(project.exception?.type).toBe("extra-working");
    // The base calendar itself is untouched by the project override.
    expect(resolveWorkingDay("2025-07-21", "base", system).isWorkingDay).toBe(false);
  });

  test("extra working day turns a weekend day into a working day", () => {
    const system = systemWith([
      exception({ id: "saturday", calendarId: "base", startDate: "2025-07-26", endDate: "2025-07-26", label: "Stocktake Saturday", type: "extra-working", isWorkingDay: true }),
    ]);
    expect(resolveWorkingDay("2025-07-26", "base", system).isWorkingDay).toBe(true);
    expect(resolveWorkingDay("2025-07-26", "proj", system).isWorkingDay).toBe(true);
  });

  test("multi-day shutdown range", () => {
    const system = systemWith([
      exception({ id: "shutdown", calendarId: "proj", startDate: "2025-08-04", endDate: "2025-08-08", label: "Collective shutdown", type: "shutdown" }),
    ]);
    for (const day of ["2025-08-04", "2025-08-05", "2025-08-06", "2025-08-07", "2025-08-08"]) {
      const resolution = resolveWorkingDay(day, "proj", system);
      expect(resolution.isWorkingDay).toBe(false);
      expect(resolution.sourceCalendarId).toBe("proj");
      expect(resolution.reason).toBe("Collective shutdown");
    }
    expect(resolveWorkingDay("2025-08-11", "proj", system).isWorkingDay).toBe(true); // following Monday
  });

  test("person exception outranks the project and base calendars", () => {
    const system = systemWith([
      exception({ id: "leave", calendarId: "person", startDate: "2025-08-04", endDate: "2025-08-04", label: "Annual leave", type: "leave" }),
      exception({ id: "work", calendarId: "proj", startDate: "2025-08-04", endDate: "2025-08-04", label: "Build day", type: "extra-working", isWorkingDay: true }),
    ]);
    const resolution = resolveWorkingDay("2025-08-04", "person", system);
    expect(resolution.isWorkingDay).toBe(false);
    expect(resolution.sourceCalendarId).toBe("person");
  });
});

/* ------------------------------------------------------- date calculations */

describe("working-day calculations", () => {
  const system = systemWith([
    exception({ id: "be-national", calendarId: "base", startDate: "2025-07-21", endDate: "2025-07-21", label: "Belgian National Day" }),
  ]);

  test("addWorkingDays skips weekends and holidays", () => {
    // Friday 18 July + 1 working day skips the weekend and the Monday holiday.
    expect(addWorkingDays("2025-07-18", 1, "base", system)).toBe("2025-07-22");
    expect(addWorkingDays("2025-07-22", -1, "base", system)).toBe("2025-07-18");
  });

  test("a task spanning a holiday keeps its duration in working days", () => {
    const [scheduled] = scheduleTasks(
      [{ id: "t1", parentId: null, duration: 3, durationUnit: "days", start: "2025-07-18", finish: "2025-07-18" }],
      [],
      { calendarSystem: system, projectCalendarId: "base" },
    );
    expect(scheduled.start).toBe("2025-07-18");
    expect(scheduled.finish).toBe("2025-07-23"); // 18, 22, 23 — the 21st is a holiday
    expect(workingDaysBetween(scheduled.start, scheduled.finish, "base", system)).toBe(3);
  });

  test("tasks never start on a non-working day", () => {
    expect(ensureWorkingDay("2025-07-19", "base", system)).toBe("2025-07-22");
    const [scheduled] = scheduleTasks(
      [{ id: "t1", parentId: null, duration: 2, durationUnit: "days", start: "2025-07-19", finish: "2025-07-20" }],
      [],
      { calendarSystem: system, projectCalendarId: "base" },
    );
    expect(scheduled.start).toBe("2025-07-22");
  });

  test("two projects on different calendars schedule independently", () => {
    const shutdownSystem = systemWith([
      exception({ id: "shutdown", calendarId: "proj", startDate: "2025-08-04", endDate: "2025-08-08", label: "Collective shutdown", type: "shutdown" }),
    ]);
    const scheduled = scheduleTasks(
      [
        { id: "on-base", parentId: null, duration: 3, durationUnit: "days", start: "2025-08-01", finish: "2025-08-01", calendarId: "base" },
        { id: "on-project", parentId: null, duration: 3, durationUnit: "days", start: "2025-08-01", finish: "2025-08-01", calendarId: "proj" },
      ],
      [],
      { calendarSystem: shutdownSystem, projectCalendarId: "base" },
    );
    const byId = new Map(scheduled.map((task) => [task.id, task]));
    expect(byId.get("on-base")?.finish).toBe("2025-08-05"); // 1, 4, 5
    expect(byId.get("on-project")?.finish).toBe("2025-08-12"); // 1, 11, 12 — shutdown in between
  });
});

/* ------------------------------------------------- critical path regression */

/**
 * The TP-R2 test project, stored exactly as the bug was reported: the starts of
 * "Bouwen" (t5) and "Documentatie" (t6) are stale leftovers of earlier edits, and
 * Documentatie carries a 50% margin. Weekends off, no holidays.
 *
 *            | dur | pred | margin
 * 1   t1  Voorbereiding   (summary)
 * 1.1 t2  Concept opstellen  5d   -       20%
 * 1.2 t3  Concept nakijken   2d   t2 FS    0%
 * 2   t4  Uitvoering       (summary)
 * 2.1 t5  Bouwen            10d   t3 FS   10%
 * 2.2 t6  Documentatie      Nd   t3 FS   50%
 * 2.3 t7  Testen             3d   t5 FS    0%
 * 3   t8  Oplevering         0d   t7 FS    -   (milestone)
 */
const tpR2 = (documentatieDays: number, documentatieMarginPct = 50): PlannerTask[] => [
  { id: "t1", parentId: null, name: "Voorbereiding", duration: 7, durationUnit: "days", start: "2026-09-25", finish: "2026-10-05", isMilestone: false, predecessors: "", resource: "", percent: 0, notes: "", color: "sage", marginPct: 0 },
  { id: "t2", parentId: "t1", name: "Concept opstellen", duration: 5, durationUnit: "days", start: "2026-09-25", finish: "2026-10-01", isMilestone: false, predecessors: "", resource: "", percent: 0, notes: "", color: "sage", marginPct: 20 },
  { id: "t3", parentId: "t1", name: "Concept nakijken", duration: 2, durationUnit: "days", start: "2026-10-02", finish: "2026-10-05", isMilestone: false, predecessors: "t2FS", resource: "", percent: 0, notes: "", color: "sage", marginPct: 0 },
  { id: "t4", parentId: null, name: "Uitvoering", duration: 13, durationUnit: "days", start: "2026-10-06", finish: "2026-10-22", isMilestone: false, predecessors: "", resource: "", percent: 0, notes: "", color: "sage", marginPct: 0 },
  { id: "t5", parentId: "t4", name: "Bouwen", duration: 10, durationUnit: "days", start: "2026-10-15", finish: "2026-10-28", isMilestone: false, predecessors: "t3FS", resource: "", percent: 0, notes: "", color: "sage", marginPct: 10 },
  { id: "t6", parentId: "t4", name: "Documentatie", duration: documentatieDays, durationUnit: "days", start: "2026-10-07", finish: "2026-10-23", isMilestone: false, predecessors: "t3FS", resource: "", percent: 0, notes: "", color: "sage", marginPct: documentatieMarginPct },
  { id: "t7", parentId: "t4", name: "Testen", duration: 3, durationUnit: "days", start: "2026-10-29", finish: "2026-11-02", isMilestone: false, predecessors: "t5FS", resource: "", percent: 0, notes: "", color: "sage", marginPct: 0 },
  { id: "t8", parentId: null, name: "Oplevering", duration: 0, durationUnit: "days", start: "2026-11-03", finish: "2026-11-03", isMilestone: true, predecessors: "t7FS", resource: "", percent: 0, notes: "", color: "sage", marginPct: 0 },
];

describe("critical path — TP-R2 test project", () => {
  const system = systemWith([]);
  /** Mirrors a commit in the app: reserve bookkeeping first, then the pass. */
  const commit = (
    previous: PlannerTask[],
    next: PlannerTask[],
    anchoredTaskIds: string[] = [],
  ): PlannerTask[] => {
    const recalculated = recalculateTasks(applyMarginConsumption(previous, next, { calendarSystem: system, projectCalendarId: "base" }), {
      direction: "forward",
      calendarSystem: system,
      projectCalendarId: "base",
      anchoredTaskIds,
    });
    expect(recalculated.error).toBeUndefined();
    return withCalculatedPlanningFields(recalculated.tasks, system, "base");
  };
  const schedule = (
    documentatieDays: number,
    marginPct = 50,
    overrides: Record<string, Partial<PlannerTask>> = {},
    anchoredTaskIds: string[] = [],
  ): PlannerTask[] => {
    // Reserves exist before the pass runs, exactly as they do in the app.
    const seeded = withCalculatedPlanningFields(
      tpR2(documentatieDays, marginPct).map((task) => ({ ...task, ...(overrides[task.id] ?? {}) })),
      system,
      "base",
    );
    return commit(seeded, seeded, anchoredTaskIds);
  };
  /** Mirrors the grid's duration edit: the work grows, its dates follow. */
  const extendBy = (tasks: PlannerTask[], id: string, days: number): PlannerTask[] =>
    tasks.map((task) => {
      if (task.id !== id) return task;
      const duration = task.duration + days;
      return { ...task, duration, finish: addWorkingDays(task.start, duration - 1, "base", system) };
    });
  const byId = (tasks: PlannerTask[]) => new Map(tasks.map((task) => [task.id, task]));
  const criticalIds = (tasks: PlannerTask[]) => tasks.filter((task) => task.isCritical).map((task) => task.id).sort().join(",");

  test("the margin zone occupies time: successors start after the reserve", () => {
    const tasks = byId(schedule(4));
    // 1.1: 5 d work (25 Sep – 1 Oct) + 1 d margin (2 Oct) → 1.2 starts Mon 5 Oct.
    expect(tasks.get("t2")?.finish).toBe("2026-10-01");
    expect(tasks.get("t2")?.marginDaysOriginal).toBe(1);
    expect(tasks.get("t3")?.start).toBe("2026-10-05");
    expect(tasks.get("t5")?.start).toBe("2026-10-07");
    expect(tasks.get("t6")?.start).toBe("2026-10-07");
    // 2.1: 10 d work + 1 d margin → 2.3 starts after that zone.
    expect(tasks.get("t5")?.finish).toBe("2026-10-20");
    expect(tasks.get("t7")?.start).toBe("2026-10-22");
    expect(tasks.get("t8")?.start).toBe("2026-10-27");
  });

  test("extending 1.1 by one day eats its margin and moves nothing", () => {
    const base = schedule(4);
    const tasks = byId(commit(base, extendBy(base, "t2", 1)));
    expect(tasks.get("t2")?.duration).toBe(6);
    expect(tasks.get("t2")?.marginDaysOriginal).toBe(1);
    expect(tasks.get("t2")?.marginDaysConsumed).toBe(1);
    expect((tasks.get("t2")?.marginDaysOriginal ?? 0) - (tasks.get("t2")?.marginDaysConsumed ?? 0)).toBe(0);
    expect(tasks.get("t3")?.start).toBe("2026-10-05");
    expect(tasks.get("t8")?.start).toBe("2026-10-27");
  });

  test("extending 1.1 by two more days shifts everything after it by exactly two days", () => {
    const base = schedule(4);
    const oneDay = commit(base, extendBy(base, "t2", 1));
    const threeDays = commit(oneDay, extendBy(oneDay, "t2", 2));
    const before = byId(oneDay);
    const after = byId(threeDays);
    expect(after.get("t2")?.marginDaysConsumed).toBe(1); // the reserve is spent, never negative
    for (const id of ["t3", "t5", "t6", "t7", "t8"]) {
      expect(addWorkingDays(before.get(id)!.start, 2, "base", system)).toBe(after.get(id)!.start);
    }
    expect(after.get("t3")?.start).toBe("2026-10-07");
    expect(after.get("t8")?.start).toBe("2026-10-29");
  });

  test("shortening gives the reserve back, never more than the original", () => {
    const base = schedule(4);
    const grown = commit(base, extendBy(base, "t2", 3));
    expect(byId(grown).get("t2")?.marginDaysConsumed).toBe(1);
    const shortened = commit(grown, extendBy(grown, "t2", -3));
    expect(byId(shortened).get("t2")?.marginDaysConsumed).toBe(0);
    const tooShort = commit(shortened, extendBy(shortened, "t2", -2));
    expect(byId(tooShort).get("t2")?.marginDaysConsumed).toBe(0);
    expect(byId(tooShort).get("t2")?.marginDaysOriginal).toBe(1);
  });

  test("a start date before the predecessor's margin zone is refused, not corrected", () => {
    const tasks = schedule(4);
    const displayIds = new Map(orderTasksForDisplay(tasks).map((task, index) => [task.id, index + 1]));
    const documentatie = tasks.find((task) => task.id === "t6")!;
    expect(documentatie.start).toBe("2026-10-07");
    expect(startEditRestriction(documentatie, "2026-09-28", tasks, system, "base", displayIds))
      .toBe("Cannot start before 2026-10-07: task 3 (Concept nakijken) must finish first (3FS).");
    expect(startEditRestriction(documentatie, "2026-10-07", tasks, system, "base", displayIds)).toBeNull();
    expect(startEditRestriction(documentatie, "2026-10-09", tasks, system, "base", displayIds)).toBeNull();
  });

  test("an anchored drag can never start before the predecessors allow", () => {
    const tasks = byId(schedule(4, 50, { t6: { start: "2026-09-28", finish: "2026-10-14" } }, ["t6"]));
    expect(tasks.get("t6")?.start).toBe("2026-10-07");
  });

  test("extending Bouwen eats its reserve first, then moves Testen and the milestone", () => {
    const base = schedule(4);
    const tasks = byId(commit(base, extendBy(base, "t5", 5)));
    expect(tasks.get("t5")?.finish).toBe("2026-10-27");
    expect(tasks.get("t5")?.marginDaysConsumed).toBe(1);
    expect(tasks.get("t7")?.start).toBe("2026-10-28");
    expect(tasks.get("t8")?.start).toBe("2026-11-02");
  });

  test("without predecessors the start date is free to edit", () => {
    const tasks = schedule(13, 50, { t6: { predecessors: "" } });
    const displayIds = new Map(orderTasksForDisplay(tasks).map((task, index) => [task.id, index + 1]));
    const documentatie = tasks.find((task) => task.id === "t6")!;
    expect(startEditRestriction(documentatie, "2026-09-28", tasks, system, "base", displayIds)).toBeNull();
    expect(startEditRestriction(documentatie, "2026-08-03", tasks, system, "base", displayIds)).toBeNull();
  });

  test("a hand-dragged Documentatie that reaches the last date is critical", () => {
    // Dragging anchors the task, so its own dates survive the recalculation, and
    // its reserve travels with it: 4 d work + 2 d margin now end the plan.
    const tasks = byId(schedule(4, 50, { t6: { start: "2026-10-21", finish: "2026-10-26" } }, ["t6"]));
    expect(tasks.get("t6")?.start).toBe("2026-10-21");
    expect(tasks.get("t6")?.finish).toBe("2026-10-26");
    expect(tasks.get("t6")?.totalFloat).toBe(0);
    expect(tasks.get("t6")?.isCritical).toBe(true);
    expect(tasks.get("t5")?.isCritical).toBe(false);
    expect(tasks.get("t7")?.isCritical).toBe(false);
  });

  test("float — 2.2 at 4d shows its reserve as slack; the driving chain shows 0 d", () => {
    const tasks = byId(schedule(4));
    expect(tasks.get("t6")?.totalFloat).toBe(8);
    for (const id of ["t2", "t3", "t5", "t7", "t8"]) expect(tasks.get(id)?.totalFloat).toBe(0);
  });

  test("float — a longer Documentatie pushes it onto the driving path", () => {
    const thirteen = byId(schedule(13));
    expect(thirteen.get("t6")?.totalFloat).toBe(0);
    expect(thirteen.get("t6")?.isCritical).toBe(true);
    expect(thirteen.get("t5")?.totalFloat).toBe(5);
    expect(thirteen.get("t7")?.totalFloat).toBe(5);
    const sixteen = byId(schedule(16));
    expect(sixteen.get("t6")?.totalFloat).toBe(0);
    expect(sixteen.get("t5")?.totalFloat).toBe(9);
    expect(sixteen.get("t7")?.totalFloat).toBe(9);
  });

  test("the reserve is counted exactly once in the float", () => {
    const withoutReserve = byId(schedule(4, 0));
    const withReserve = byId(schedule(4, 50));
    // 4 d work + 2 d reserve is a six day slot: the slack drops by exactly the
    // two days the reserve occupies, not by four.
    expect(withoutReserve.get("t6")?.marginDaysOriginal).toBe(0);
    expect(withReserve.get("t6")?.marginDaysOriginal).toBe(2);
    expect(withoutReserve.get("t6")?.totalFloat).toBe(10);
    expect(withReserve.get("t6")?.totalFloat).toBe(8);
  });

  test("zero margins reproduce the classic schedule with no gaps", () => {
    const noMargins = { t2: { marginPct: 0 }, t5: { marginPct: 0 }, t6: { marginPct: 0 } };
    const tasks = byId(schedule(4, 0, noMargins));
    expect(tasks.get("t2")?.marginDaysOriginal).toBe(0);
    expect(tasks.get("t5")?.marginDaysOriginal).toBe(0);
    expect(tasks.get("t3")?.start).toBe("2026-10-02");
    expect(tasks.get("t5")?.start).toBe("2026-10-06");
    expect(tasks.get("t6")?.start).toBe("2026-10-06");
    expect(tasks.get("t7")?.start).toBe("2026-10-20");
    expect(tasks.get("t8")?.start).toBe("2026-10-23");
  });

  test("the driving chain stays critical with and without reserves", () => {
    // 1.1 → 1.2 → 2.1 → 2.3 → milestone drives the plan either way; 2.2 floats.
    for (const marginPct of [0, 50, 90]) {
      expect(criticalIds(schedule(4, marginPct))).toBe("t1,t2,t3,t4,t5,t7,t8");
    }
  });
});

describe("replan — fresh reserve for the remaining work", () => {
  const system = systemWith([]);
  const plan = (overrides: Record<string, Partial<PlannerTask>> = {}): PlannerTask[] => {
    const seeded = tpR2(4, 50).map((task) => ({ ...task, ...(overrides[task.id] ?? {}) }));
    const recalculated = recalculateTasks(withCalculatedPlanningFields(seeded, system, "base"), {
      direction: "forward",
      calendarSystem: system,
      projectCalendarId: "base",
    });
    expect(recalculated.error).toBeUndefined();
    return withCalculatedPlanningFields(recalculated.tasks, system, "base");
  };

  test("20% on not-started tasks leaves started tasks untouched", () => {
    const source = plan({ t2: { marginPct: 35, marginDaysConsumed: 1, percent: 40 } });
    const beforeT2 = source.find((task) => task.id === "t2")!;
    expect(beforeT2.marginDaysOriginal).toBe(2); // 5 d work · 35 %

    const replanned = applyReplanMargins(source, { scope: "not-started", marginPct: 20 });
    const afterT2 = replanned.find((task) => task.id === "t2")!;
    const afterT5 = replanned.find((task) => task.id === "t5")!;

    // Started work keeps its own percentage and consumption.
    expect(afterT2.marginPct).toBe(35);
    expect(afterT2.marginDaysOriginal).toBe(2);
    expect(afterT2.marginDaysConsumed).toBe(1);
    // Not-started work gets fresh reserve with nothing consumed.
    expect(afterT5.marginPct).toBe(20);
    expect(afterT5.marginDaysOriginal).toBe(2); // 10 d · 20 %
    expect(afterT5.marginDaysConsumed).toBe(0);
    // The version it was based on is not rewritten.
    expect(source.find((task) => task.id === "t5")!.marginPct).toBe(10);
    expect(source.find((task) => task.id === "t2")!.marginDaysConsumed).toBe(1);
  });

  test("the previous version keeps its own margins and consumption", () => {
    const source = plan({ t2: { marginPct: 35, marginDaysConsumed: 1, percent: 40 } });
    const snapshot = JSON.parse(JSON.stringify(source));
    applyReplanMargins(source, { scope: "all", marginPct: 20 });
    expect(JSON.parse(JSON.stringify(source))).toEqual(snapshot);
  });

  test("scope 'all' refreshes every leaf task and 'selected' only the chosen ones", () => {
    // t6 is finished work: even scope 'all' must not rewrite it.
    const source = plan({ t6: { percent: 100, marginDaysConsumed: 2 } });
    const all = applyReplanMargins(source, { scope: "all", marginPct: 20 });
    for (const id of ["t2", "t3", "t5", "t7"]) {
      const task = all.find((item) => item.id === id)!;
      expect(task.marginPct).toBe(20);
      expect(task.marginDaysConsumed).toBe(0);
    }
    // Completed work keeps its percentage and its consumption.
    expect(all.find((item) => item.id === "t6")!.marginPct).toBe(50);
    expect(all.find((item) => item.id === "t6")!.marginDaysConsumed).toBe(2);
    // Summaries and milestones never carry a reserve of their own.
    expect(all.find((item) => item.id === "t1")!.marginPct).toBe(0);
    expect(all.find((item) => item.id === "t8")!.marginDaysOriginal).toBe(0);

    const selected = applyReplanMargins(source, { scope: "selected", selectedTaskIds: ["t5"], marginPct: 20 });
    expect(selected.find((item) => item.id === "t5")!.marginPct).toBe(20);
    expect(selected.find((item) => item.id === "t6")!.marginPct).toBe(50);
    expect(replanScopeIds(source, { scope: "selected", selectedTaskIds: ["t5"], marginPct: 20 }).size).toBe(1);
  });

  test("the predicted finish is the finish the new version actually plans", () => {
    const source = plan({ t2: { percent: 40, marginDaysConsumed: 1 } });
    const input = { scope: "not-started" as const, marginPct: 20 };
    // What the dialog previews: rewrite the margins, schedule, read the finish.
    const predicted = planFinishDate(
      withCalculatedPlanningFields(
        recalculateTasks(applyReplanMargins(source, input), { direction: "forward", calendarSystem: system, projectCalendarId: "base" }).tasks,
        system,
        "base",
      ),
    );
    // What confirming does: the same margins on a re-keyed copy of the version.
    const idMap = new Map(source.map((task, index) => [task.id, `v2-${index}`]));
    const copied = applyReplanMargins(source, input).map((task) => ({
      ...task,
      id: idMap.get(task.id)!,
      parentId: task.parentId ? idMap.get(task.parentId)! : null,
      predecessors: task.predecessors.split(",").map((part) => {
        const trimmed = part.trim();
        const predecessor = [...source].sort((a, b) => b.id.length - a.id.length).find((item) => trimmed.startsWith(item.id));
        return predecessor ? `${idMap.get(predecessor.id)}${trimmed.slice(predecessor.id.length)}` : trimmed;
      }).filter(Boolean).join(", "),
    }));
    const actual = planFinishDate(
      withCalculatedPlanningFields(
        recalculateTasks(copied, { direction: "forward", calendarSystem: system, projectCalendarId: "base" }).tasks,
        system,
        "base",
      ),
    );
    expect(predicted).toBe(actual);
    // Fresh reserve on the not-started work pushes the finish past the 27 Oct baseline.
    expect(predicted > "2026-10-27").toBe(true);
  });

  test("a margin percentage edit sizes a new reserve and reports restored margin", () => {
    const exhausted = { ...tpR2(4)[1], marginPct: 20, marginDaysOriginal: 1, marginDaysConsumed: 1 };
    // No reserve left, so a same-size percentage stays at zero.
    expect(marginAfterPctChange(exhausted, 20).remaining).toBe(0);
    const restored = marginAfterPctChange(exhausted, 60);
    expect(restored.original).toBe(3); // 5 d · 60 %
    expect(restored.consumed).toBe(1);
    expect(restored.remaining).toBe(2);
    // A smaller percentage can never show a negative remainder.
    expect(marginAfterPctChange(exhausted, 0).remaining).toBe(0);
  });
});

describe("plan modes — planning replans, monitoring tracks reality", () => {
  const system = systemWith([]);
  const seed = (): PlannerTask[] => {
    const seeded = withCalculatedPlanningFields(tpR2(4), system, "base");
    const recalculated = recalculateTasks(seeded, { direction: "forward", calendarSystem: system, projectCalendarId: "base" });
    return withCalculatedPlanningFields(recalculated.tasks, system, "base");
  };
  /** Mirrors a commit in the app: the mode decides the margin bookkeeping. */
  const commit = (previous: PlannerTask[], next: PlannerTask[], mode: "planning" | "monitoring"): PlannerTask[] => {
    const recalculated = recalculateTasks(applyModeCommit(previous, next, mode, { calendarSystem: system, projectCalendarId: "base" }), {
      direction: "forward",
      calendarSystem: system,
      projectCalendarId: "base",
    });
    expect(recalculated.error).toBeUndefined();
    return withCalculatedPlanningFields(recalculated.tasks, system, "base");
  };
  const extendBy = (tasks: PlannerTask[], id: string, days: number): PlannerTask[] =>
    tasks.map((task) => {
      if (task.id !== id) return task;
      const duration = task.duration + days;
      return { ...task, duration, finish: addWorkingDays(task.start, duration - 1, "base", system) };
    });
  const byId = (tasks: PlannerTask[]) => new Map(tasks.map((task) => [task.id, task]));

  test("planning mode: extending 1.1 by a day re-plans and consumes nothing", () => {
    const base = seed();
    const planned = commit(base, extendBy(base, "t2", 1), "planning");
    const t2 = byId(planned).get("t2")!;
    expect(t2.duration).toBe(6);
    // Nothing is consumed while planning, and the reserve follows the percentage.
    expect(t2.marginDaysConsumed).toBe(0);
    expect(t2.marginDaysOriginal).toBe(2); // ceil(6 d · 20 %)
    // The plan moves as a whole: the whole chain shifts later.
    expect(byId(planned).get("t2")!.finish).toBe("2026-10-02");
    expect(byId(planned).get("t3")!.start).toBe("2026-10-07");
    expect(byId(base).get("t3")!.start).toBe("2026-10-05");
  });

  test("monitoring mode: extending 1.1 by a day eats its reserve and moves nothing", () => {
    const base = seed();
    const monitored = commit(base, extendBy(base, "t2", 1), "monitoring");
    const t2 = byId(monitored).get("t2")!;
    expect(t2.duration).toBe(6);
    expect(t2.marginDaysConsumed).toBe(1);
    expect(t2.marginDaysOriginal).toBe(1);
    // The reserve is spent: consumed 1 d, remaining 0 d.
    expect((t2.marginDaysOriginal ?? 0) - (t2.marginDaysConsumed ?? 0)).toBe(0);
    // Same slot as the baseline, so the plan (and its finish) does not move.
    for (const id of ["t3", "t5", "t6", "t7", "t8"]) {
      expect(byId(monitored).get(id)!.start).toBe(byId(base).get(id)!.start);
    }
    expect(planFinishDate(monitored)).toBe(planFinishDate(base));
  });

  test("the same edit moves the plan in planning mode and not in monitoring mode", () => {
    const base = seed();
    const planned = commit(base, extendBy(base, "t2", 1), "planning");
    const monitored = commit(base, extendBy(base, "t2", 1), "monitoring");
    expect(byId(planned).get("t3")!.start).not.toBe(byId(base).get("t3")!.start);
    expect(byId(monitored).get("t3")!.start).toBe(byId(base).get("t3")!.start);
  });

  test("the right fields are read-only in each mode, naming the mode", () => {
    expect(fieldModeReadOnly("margin", "monitoring")).toContain("Monitoring");
    expect(fieldModeReadOnly("margin", "planning")).toBeNull();
    expect(fieldModeReadOnly("percent", "planning")).toContain("Monitoring");
    expect(fieldModeReadOnly("percent", "monitoring")).toBeNull();
    expect(fieldModeReadOnly("actualStart", "planning")).toContain("Monitoring");
    expect(fieldModeReadOnly("actualFinish", "monitoring")).toBeNull();
  });

  test("float stays a pure network calculation in both modes", () => {
    const base = seed();
    const planned = commit(base, extendBy(base, "t2", 1), "planning");
    const monitored = commit(base, extendBy(base, "t2", 1), "monitoring");
    expect(typeof byId(planned).get("t6")!.totalFloat).toBe("number");
    expect(typeof byId(monitored).get("t6")!.totalFloat).toBe("number");
  });

  test("a new version starts in planning with consumed margin reset, leaving the old one intact", () => {
    const base = seed();
    const monitored = commit(base, extendBy(base, "t2", 1), "monitoring");
    const monitoredT2 = byId(monitored).get("t2")!;
    expect(monitoredT2.marginDaysConsumed).toBe(1);

    const nextVersion = applyPlanningModeMargins(monitored);
    const nextT2 = byId(nextVersion).get("t2")!;
    expect(nextT2.marginDaysConsumed).toBe(0);
    expect(nextT2.marginDaysOriginal).toBe(2); // re-derived: ceil(6 d · 20 %)

    // The version the replan was built from keeps its own margins and consumption.
    expect(monitoredT2.marginDaysConsumed).toBe(1);
    expect(byId(monitored).get("t2")).toBe(monitoredT2);
  });
});

describe("start constraints — a manual start survives recalculation", () => {
  const system = systemWith([]);
  const seed = (): PlannerTask[] => {
    const seeded = withCalculatedPlanningFields(tpR2(4), system, "base");
    const recalculated = recalculateTasks(seeded, { direction: "forward", calendarSystem: system, projectCalendarId: "base" });
    return withCalculatedPlanningFields(recalculated.tasks, system, "base");
  };
  const recalc = (tasks: PlannerTask[]): PlannerTask[] => {
    const result = recalculateTasks(tasks, { direction: "forward", calendarSystem: system, projectCalendarId: "base" });
    expect(result.error).toBeUndefined();
    return withCalculatedPlanningFields(result.tasks, system, "base");
  };
  const byId = (tasks: PlannerTask[]) => new Map(tasks.map((task) => [task.id, task]));
  const setConstraint = (tasks: PlannerTask[], id: string, date: string) =>
    recalc(tasks.map((task) => (task.id === id ? { ...task, startConstraint: date } : task)));

  test("a later start on 2.1 is kept and 2.2 does not move", () => {
    const base = seed();
    const t5Base = byId(base).get("t5")!.start;
    const t6Base = byId(base).get("t6")!.start;
    const later = addWorkingDays(t5Base, 4, "base", system);
    const moved = setConstraint(base, "t5", later);
    expect(byId(moved).get("t5")!.start).toBe(later);
    expect(byId(moved).get("t5")!.startConstraintActive).toBe(true);
    // 2.1's constraint must not leak into its sibling 2.2.
    expect(byId(moved).get("t6")!.start).toBe(t6Base);
  });

  test("moving 2.2 later leaves 2.1 where the user put it, and the pass is stable", () => {
    const base = seed();
    const t5Base = byId(base).get("t5")!.start;
    const t6Base = byId(base).get("t6")!.start;
    const movedT5 = setConstraint(base, "t5", addWorkingDays(t5Base, 4, "base", system));
    const movedBoth = setConstraint(movedT5, "t6", addWorkingDays(t6Base, 2, "base", system));
    expect(byId(movedBoth).get("t5")!.start).toBe(addWorkingDays(t5Base, 4, "base", system));
    expect(byId(movedBoth).get("t6")!.start).toBe(addWorkingDays(t6Base, 2, "base", system));
    const stable = recalc(movedBoth);
    expect(byId(stable).get("t5")!.start).toBe(byId(movedBoth).get("t5")!.start);
    expect(byId(stable).get("t6")!.start).toBe(byId(movedBoth).get("t6")!.start);
  });

  test("a predecessor that overtakes the constraint wins, and the constraint turns inactive", () => {
    const base = seed();
    const t5Base = byId(base).get("t5")!.start;
    const constraint = addWorkingDays(t5Base, 2, "base", system);
    const moved = setConstraint(base, "t5", constraint);
    expect(byId(moved).get("t5")!.start).toBe(constraint);
    expect(byId(moved).get("t5")!.startConstraintActive).toBe(true);
    // 1.2 grows until 2.1's earliest dependency start passes the constraint.
    const pushed = recalc(moved.map((task) => task.id === "t3"
      ? { ...task, duration: task.duration + 10, finish: addWorkingDays(task.start, task.duration + 10 - 1, "base", system) }
      : task));
    const t5 = byId(pushed).get("t5")!;
    expect(t5.start > constraint).toBe(true);
    expect(t5.startConstraint).toBe(constraint); // kept, not deleted
    expect(t5.startConstraintActive).toBe(false);
  });

  test("a constraint behind the dependency earliest start is inactive from the start", () => {
    const base = seed();
    const t6Base = byId(base).get("t6")!.start;
    const earlier = addWorkingDays(t6Base, -5, "base", system);
    const withConstraint = setConstraint(base, "t6", earlier);
    expect(byId(withConstraint).get("t6")!.start).toBe(t6Base);
    expect(byId(withConstraint).get("t6")!.startConstraintActive).toBe(false);
  });

  test("clearing the constraint returns the task to its earliest start", () => {
    const base = seed();
    const t5Base = byId(base).get("t5")!.start;
    const moved = setConstraint(base, "t5", addWorkingDays(t5Base, 4, "base", system));
    const cleared = recalc(moved.map((task) => (task.id === "t5" ? { ...task, startConstraint: undefined } : task)));
    expect(byId(cleared).get("t5")!.start).toBe(t5Base);
    expect(byId(cleared).get("t5")!.startConstraint).toBeUndefined();
  });

  test("startConstraintFor only records intent later than the dependency allows", () => {
    const base = seed();
    const t5 = byId(base).get("t5")!;
    const earliest = t5.start;
    expect(startConstraintFor(t5, earliest, base, system, "base")).toBeUndefined();
    const later = addWorkingDays(earliest, 3, "base", system);
    expect(startConstraintFor(t5, later, base, system, "base")).toBe(later);
  });
});

describe("version copy — references are remapped onto the new ids", () => {
  const newIds = (tasks: PlannerTask[]) => new Map(tasks.map((task, index) => [task.id, `task-new-${index}`]));
  const byNew = (tasks: PlannerTask[]) => new Map(tasks.map((task) => [task.id, task]));

  test("TP-R2 keeps every predecessor, its type and its lag", () => {
    const source = tpR2(4);
    const idMap = newIds(source);
    const result = remapCopiedTasks(source, idMap, "version-2");
    expect(result.error).toBeUndefined();
    const copied = result.tasks;
    const get = (id: string) => byNew(copied).get(idMap.get(id)!)!;
    expect(get("t3").predecessors).toBe(`${idMap.get("t2")!}FS`);
    expect(get("t5").predecessors).toBe(`${idMap.get("t3")!}FS`);
    expect(get("t6").predecessors).toBe(`${idMap.get("t3")!}FS`);
    expect(get("t7").predecessors).toBe(`${idMap.get("t5")!}FS`);
    expect(get("t8").predecessors).toBe(`${idMap.get("t7")!}FS`);
    // WBS parents are remapped and the version is stamped on every row.
    expect(get("t3").parentId).toBe(idMap.get("t1")!);
    expect(copied.every((task) => task.versionId === "version-2")).toBe(true);
    // The whole network is intact: same number of links as the source.
    expect(dependenciesForTasks(copied).length).toBe(dependenciesForTasks(source).length);
  });

  test("opaque task-… ids remap too (the old numeric-only rewrite failed here)", () => {
    // Re-key TP-R2 to uuid-style ids, exactly like a version copied before.
    const original = tpR2(4);
    const opaqueMap = new Map(original.map((task) => [task.id, `task-${task.id}`]));
    const source = original.map((task) => ({
      ...task,
      id: opaqueMap.get(task.id)!,
      parentId: task.parentId ? opaqueMap.get(task.parentId)! : null,
      predecessors: task.predecessors.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
        const predecessor = [...original].sort((a, b) => b.id.length - a.id.length).find((candidate) => part.startsWith(candidate.id));
        return predecessor ? `${opaqueMap.get(predecessor.id)}${part.slice(predecessor.id.length)}` : part;
      }).join(", "),
    }));
    const idMap = newIds(source);
    const result = remapCopiedTasks(source, idMap, "version-2");
    expect(result.error).toBeUndefined();
    const get = (id: string) => byNew(result.tasks).get(idMap.get(id)!)!;
    expect(get("task-t3").predecessors).toBe(`${idMap.get("task-t2")!}FS`);
    expect(get("task-t5").predecessors).toBe(`${idMap.get("task-t3")!}FS`);
    expect(get("task-t6").predecessors).toBe(`${idMap.get("task-t3")!}FS`);
  });

  test("dependency type and lag survive the copy", () => {
    const source = tpR2(4).map((task) => task.id === "t3" ? { ...task, predecessors: "t2SS+2d" } : task);
    const idMap = newIds(source);
    const result = remapCopiedTasks(source, idMap, "v");
    expect(result.error).toBeUndefined();
    expect(byNew(result.tasks).get(idMap.get("t3")!)!.predecessors).toBe(`${idMap.get("t2")!}SS+2d`);
  });

  test("an unresolvable reference fails the whole copy instead of dropping it", () => {
    const source = tpR2(4).map((task) => task.id === "t5" ? { ...task, predecessors: "t3FS, t999FS" } : task);
    const idMap = newIds(source);
    const result = remapCopiedTasks(source, idMap, "v");
    expect(result.error).toContain("could not be remapped");
    // Nothing is emitted when validation fails.
    expect(result.tasks).toBe(source);
  });

  test("the start constraint and margin figures travel with the copy", () => {
    const source = tpR2(4).map((task) => task.id === "t5" ? { ...task, startConstraint: "2026-10-20", marginDaysConsumed: 1 } : task);
    const idMap = newIds(source);
    const result = remapCopiedTasks(source, idMap, "v").tasks;
    const t5 = byNew(result).get(idMap.get("t5")!)!;
    expect(t5.startConstraint).toBe("2026-10-20");
    expect(t5.marginDaysConsumed).toBe(1);
    expect(t5.marginPct).toBe(source.find((task) => task.id === "t5")!.marginPct);
  });

  test("display ids renumber 1..n and predecessors read 2FS, 3FS, 3FS, 5FS, 7FS", () => {
    const source = tpR2(4);
    const idMap = newIds(source);
    const copied = remapCopiedTasks(source, idMap, "v").tasks;
    const displayIds = new Map(orderTasksForDisplay(copied).map((task, index) => [task.id, index + 1]));
    const get = (id: string) => byNew(copied).get(idMap.get(id)!)!;
    expect(displayIds.get(idMap.get("t3")!)).toBe(3);
    expect(formatPredecessorsForDisplay(get("t3").predecessors, copied, displayIds)).toBe("2FS");
    expect(formatPredecessorsForDisplay(get("t5").predecessors, copied, displayIds)).toBe("3FS");
    expect(formatPredecessorsForDisplay(get("t6").predecessors, copied, displayIds)).toBe("3FS");
    expect(formatPredecessorsForDisplay(get("t7").predecessors, copied, displayIds)).toBe("5FS");
    expect(formatPredecessorsForDisplay(get("t8").predecessors, copied, displayIds)).toBe("7FS");
  });
});

describe("finish-driven margin consumption — monitoring mode", () => {
  const system = systemWith([]);
  const context = { calendarSystem: system, projectCalendarId: "base" };
  const byId = (tasks: PlannerTask[]) => new Map(tasks.map((task) => [task.id, task]));
  const seed = (): PlannerTask[] => {
    const scheduled = recalculateTasks(withCalculatedPlanningFields(tpR2(4), system, "base"), { direction: "forward", calendarSystem: system, projectCalendarId: "base" });
    return withCalculatedPlanningFields(scheduled.tasks, system, "base");
  };
  /** Mirrors the app: schedule once, absorb each finish move into its own reserve, reschedule. */
  const commit = (previous: PlannerTask[], next: PlannerTask[]) => {
    const settled = settleMonitoringPlan(previous, next, { calendarSystem: system, projectCalendarId: "base" });
    const scheduled = recalculateTasks(settled.tasks, { direction: "forward", calendarSystem: system, projectCalendarId: "base" });
    return { tasks: withCalculatedPlanningFields(scheduled.tasks, system, "base"), changes: settled.changes };
  };
  /** A start edit: the work moves and the finish follows. */
  const moveStart = (tasks: PlannerTask[], id: string, days: number): PlannerTask[] =>
    tasks.map((task) => {
      if (task.id !== id) return task;
      const start = addWorkingDays(task.start, days, "base", system);
      return { ...task, start, finish: addWorkingDays(start, task.duration - 1, "base", system) };
    });
  const setStart = (tasks: PlannerTask[], id: string, start: string): PlannerTask[] =>
    tasks.map((task) => task.id === id ? { ...task, start, finish: addWorkingDays(start, task.duration - 1, "base", system) } : task);
  /** A duration edit: the work grows and the finish follows. */
  const extend = (tasks: PlannerTask[], id: string, days: number): PlannerTask[] =>
    tasks.map((task) => {
      if (task.id !== id) return task;
      const duration = task.duration + days;
      return { ...task, duration, finish: addWorkingDays(task.start, duration - 1, "base", system) };
    });

  test("a dragged start (which anchors the bar) also absorbs margin", () => {
    const base = seed();
    const t3Start = byId(base).get("t3")!.start;
    const settled = settleMonitoringPlan(base, moveStart(base, "t2", 1), { calendarSystem: system, projectCalendarId: "base", anchoredTaskIds: ["t2"] });
    const scheduled = recalculateTasks(settled.tasks, { direction: "forward", calendarSystem: system, projectCalendarId: "base", anchoredTaskIds: ["t2"] });
    const tasks = withCalculatedPlanningFields(scheduled.tasks, system, "base");
    expect(byId(tasks).get("t2")!.marginDaysConsumed).toBe(1);
    expect(byId(tasks).get("t3")!.start).toBe(t3Start);
  });

  test("a calendar change that pushes a finish spends that task's own reserve", () => {
    // A working day removed inside 1.1 moves its finish although nobody edited it.
    // The store re-plans every task after a calendar change, so every task answers
    // for its own move — and 1.2 still does not shift.
    const shutdown = exception({ id: "shutdown", calendarId: "base", startDate: "2026-09-29", endDate: "2026-09-29", label: "Site shutdown" });
    const shifted = systemWith([shutdown]);
    const base = seed();
    const t3Start = byId(base).get("t3")!.start;
    const finish = planFinishDate(base);
    const moved = recalculateTasks(base, { direction: "forward", calendarSystem: shifted, projectCalendarId: "base" });
    expect(byId(moved.tasks).get("t2")!.finish).not.toBe(byId(base).get("t2")!.finish);
    const settled = settleMonitoringPlan(base, moved.tasks, {
      calendarSystem: shifted,
      projectCalendarId: "base",
      changedTaskIds: new Set(base.map((task) => task.id)),
    });
    const rescheduled = recalculateTasks(settled.tasks, { direction: "forward", calendarSystem: shifted, projectCalendarId: "base" });
    const tasks = withCalculatedPlanningFields(rescheduled.tasks, shifted, "base");
    expect(byId(tasks).get("t2")!.marginDaysConsumed).toBe(1);
    expect(byId(tasks).get("t3")!.start).toBe(t3Start);
    expect(planFinishDate(tasks)).toBe(finish);
  });

  test("a later start is absorbed by margin: 1.2 and the finish stay put", () => {
    const base = seed();
    const baseFinish = planFinishDate(base);
    const t3Start = byId(base).get("t3")!.start;
    const result = commit(base, moveStart(base, "t2", 1));
    const t2 = byId(result.tasks).get("t2")!;
    expect(t2.marginDaysOriginal).toBe(1);
    expect(t2.marginDaysConsumed).toBe(1);
    expect((t2.marginDaysOriginal ?? 0) - (t2.marginDaysConsumed ?? 0)).toBe(0);
    expect(byId(result.tasks).get("t3")!.start).toBe(t3Start);
    expect(planFinishDate(result.tasks)).toBe(baseFinish);
    expect(result.changes[0]).toEqual({ taskId: "t2", absorbed: 1, passed: 0, returned: 0 });
  });

  test("a second later day overflows: 1.2 and everything after shift exactly one day", () => {
    const base = seed();
    const step1 = commit(base, moveStart(base, "t2", 1)).tasks;
    const result = commit(step1, moveStart(step1, "t2", 1));
    const t2 = byId(result.tasks).get("t2")!;
    expect(t2.marginDaysConsumed).toBe(1); // never above the original
    for (const id of ["t3", "t5", "t6", "t7", "t8"]) {
      expect(byId(result.tasks).get(id)!.start).toBe(addWorkingDays(byId(step1).get(id)!.start, 1, "base", system));
    }
    expect(result.changes[0]).toEqual({ taskId: "t2", absorbed: 0, passed: 1, returned: 0 });
  });

  test("moving the start back returns the margin and the original plan", () => {
    const base = seed();
    const originalStart = byId(base).get("t2")!.start;
    const step1 = commit(base, moveStart(base, "t2", 1)).tasks;
    const step2 = commit(step1, moveStart(step1, "t2", 1)).tasks;
    const result = commit(step2, setStart(step2, "t2", originalStart));
    const t2 = byId(result.tasks).get("t2")!;
    expect(t2.marginDaysConsumed).toBe(0);
    expect((t2.marginDaysOriginal ?? 0) - (t2.marginDaysConsumed ?? 0)).toBe(1);
    expect(result.changes[0]).toEqual({ taskId: "t2", absorbed: 0, passed: 0, returned: 1 });
    // Back to the plan we started from.
    for (const id of ["t3", "t5", "t6", "t7", "t8"]) {
      expect(byId(result.tasks).get(id)!.start).toBe(byId(base).get(id)!.start);
    }
    expect(planFinishDate(result.tasks)).toBe(planFinishDate(base));
  });

  test("changing the duration gives identical results to moving the start", () => {
    const base = seed();
    const t3Start = byId(base).get("t3")!.start;
    const baseFinish = planFinishDate(base);
    const first = commit(base, extend(base, "t2", 1));
    expect(byId(first.tasks).get("t2")!.marginDaysConsumed).toBe(1);
    expect(byId(first.tasks).get("t3")!.start).toBe(t3Start);
    expect(planFinishDate(first.tasks)).toBe(baseFinish);
    const second = commit(first.tasks, extend(first.tasks, "t2", 1));
    expect(byId(second.tasks).get("t2")!.marginDaysConsumed).toBe(1);
    for (const id of ["t3", "t5", "t6", "t7", "t8"]) {
      expect(byId(second.tasks).get(id)!.start).toBe(addWorkingDays(byId(first.tasks).get(id)!.start, 1, "base", system));
    }
    const back = commit(second.tasks, extend(second.tasks, "t2", -2));
    expect(byId(back.tasks).get("t2")!.marginDaysConsumed).toBe(0);
    expect(planFinishDate(back.tasks)).toBe(baseFinish);
  });

  test("a task whose own predecessor pushes it spends its own reserve", () => {
    const base = seed();
    // 2.1 (t5) depends on 1.2 (t3); adding +2 d lag pushes 2.1 two days later,
    // so 2.1's own 1 d reserve takes one day and only the other passes on.
    const result = commit(base, base.map((task) => task.id === "t5" ? { ...task, predecessors: "t3FS+2d" } : task));
    const by = byId(result.tasks);
    expect(by.get("t5")!.marginDaysConsumed).toBe(1);
    expect(by.get("t7")!.start).toBe(addWorkingDays(byId(base).get("t7")!.start, 1, "base", system));
  });

  test("a task that merely moved with the network keeps its reserve", () => {
    const base = seed();
    // Change 1.2 only: 2.1 and 2.2 are pushed along but must not spend their own
    // reserves, so the delay passes straight through to 2.3.
    const result = commit(base, extend(base, "t3", 1));
    const by = byId(result.tasks);
    expect(by.get("t5")!.marginDaysConsumed).toBe(0);
    expect(by.get("t6")!.marginDaysConsumed).toBe(0);
    expect(by.get("t7")!.start).toBe(addWorkingDays(byId(base).get("t7")!.start, 1, "base", system));
  });
});
