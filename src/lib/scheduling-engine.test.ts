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
  orderTasksForDisplay,
  recalculateTasks,
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
  const schedule = (
    documentatieDays: number,
    marginPct = 50,
    overrides: Record<string, Partial<PlannerTask>> = {},
    anchoredTaskIds: string[] = [],
  ): PlannerTask[] => {
    const tasks = tpR2(documentatieDays, marginPct).map((task) => ({ ...task, ...(overrides[task.id] ?? {}) }));
    const recalculated = recalculateTasks(tasks, {
      direction: "forward",
      calendarSystem: system,
      projectCalendarId: "base",
      anchoredTaskIds,
    });
    expect(recalculated.error).toBeUndefined();
    return withCalculatedPlanningFields(recalculated.tasks, system, "base");
  };
  const byId = (tasks: PlannerTask[]) => new Map(tasks.map((task) => [task.id, task]));
  const criticalIds = (tasks: PlannerTask[]) => tasks.filter((task) => task.isCritical).map((task) => task.id).sort().join(",");
  const floats = (tasks: PlannerTask[]) => tasks.map((task) => `${task.id}=${task.totalFloat}`).join(" ");

  test("dependent tasks start the first working day after their predecessor", () => {
    const tasks = byId(schedule(13));
    expect(tasks.get("t3")?.start).toBe("2026-10-02");
    // Both successors of 1.2 start 2026-10-06: a stale later start must not survive.
    expect(tasks.get("t5")?.start).toBe("2026-10-06");
    expect(tasks.get("t5")?.finish).toBe("2026-10-19");
    expect(tasks.get("t6")?.start).toBe("2026-10-06");
    expect(tasks.get("t7")?.start).toBe("2026-10-20");
    expect(tasks.get("t8")?.start).toBe("2026-10-23");
  });

  test("Documentatie at 4d has 9 working days of float and is not critical", () => {
    const tasks = byId(schedule(4));
    expect(tasks.get("t6")?.finish).toBe("2026-10-09");
    expect(tasks.get("t6")?.totalFloat).toBe(9);
    expect(tasks.get("t6")?.isCritical).toBe(false);
  });

  test("Documentatie at 13d ties the Bouwen → Testen path: float 0, critical", () => {
    const tasks = byId(schedule(13));
    expect(tasks.get("t6")?.finish).toBe("2026-10-22");
    expect(tasks.get("t6")?.totalFloat).toBe(0);
    expect(tasks.get("t6")?.isCritical).toBe(true);
    expect(tasks.get("t7")?.isCritical).toBe(true);
  });

  test("Documentatie at 16d drives the plan: it is critical, 2.1 and 2.3 are not", () => {
    const tasks = byId(schedule(16));
    expect(tasks.get("t6")?.finish).toBe("2026-10-27");
    expect(tasks.get("t6")?.totalFloat).toBe(0);
    expect(tasks.get("t6")?.isCritical).toBe(true);
    expect(tasks.get("t5")?.isCritical).toBe(false);
    expect(tasks.get("t7")?.isCritical).toBe(false);
  });

  test("a start date before the predecessor's finish is refused, not corrected", () => {
    const tasks = schedule(13);
    const displayIds = new Map(orderTasksForDisplay(tasks).map((task, index) => [task.id, index + 1]));
    const documentatie = tasks.find((task) => task.id === "t6")!;
    expect(documentatie.start).toBe("2026-10-06");
    expect(startEditRestriction(documentatie, "2026-09-28", tasks, system, "base", displayIds))
      .toBe("Cannot start before 2026-10-06: task 3 (Concept nakijken) must finish first (3FS).");
    expect(startEditRestriction(documentatie, "2026-10-06", tasks, system, "base", displayIds)).toBeNull();
    expect(startEditRestriction(documentatie, "2026-10-09", tasks, system, "base", displayIds)).toBeNull();
  });

  test("an anchored drag can never start before the predecessors allow", () => {
    const tasks = byId(schedule(13, 50, { t6: { start: "2026-09-28", finish: "2026-10-28" } }, ["t6"]));
    expect(tasks.get("t6")?.start).toBe("2026-10-06");
  });

  test("extending Bouwen moves Testen and the milestone automatically", () => {
    const tasks = byId(schedule(13, 50, { t5: { duration: 15, finish: "2026-10-26" } }));
    expect(tasks.get("t5")?.finish).toBe("2026-10-26");
    expect(tasks.get("t7")?.start).toBe("2026-10-27");
    expect(tasks.get("t8")?.start).toBe("2026-10-30");
  });

  test("without predecessors the start date is free to edit", () => {
    const tasks = schedule(13, 50, { t6: { predecessors: "" } });
    const displayIds = new Map(orderTasksForDisplay(tasks).map((task, index) => [task.id, index + 1]));
    const documentatie = tasks.find((task) => task.id === "t6")!;
    expect(startEditRestriction(documentatie, "2026-09-28", tasks, system, "base", displayIds)).toBeNull();
    expect(startEditRestriction(documentatie, "2026-08-03", tasks, system, "base", displayIds)).toBeNull();
  });

  test("a hand-dragged Documentatie that reaches the last date is critical", () => {
    const dragged = byId(schedule(13)).get("t6")!;
    const moved = {
      start: addWorkingDays(dragged.start, 4, "base", system),
      finish: addWorkingDays(dragged.finish, 4, "base", system),
    };
    // Dragging anchors the task, so its own dates survive the recalculation.
    const tasks = byId(schedule(13, 50, { t6: moved }, ["t6"]));
    expect(tasks.get("t6")?.start).toBe("2026-10-12");
    expect(tasks.get("t6")?.finish).toBe("2026-10-28");
    expect(tasks.get("t6")?.isCritical).toBe(true);
    expect(tasks.get("t5")?.isCritical).toBe(false);
    expect(tasks.get("t7")?.isCritical).toBe(false);
  });

  test("float — 2.2 at 4d has 9 d while the driving tasks have 0 d", () => {
    const tasks = byId(schedule(4));
    expect(tasks.get("t6")?.totalFloat).toBe(9);
    for (const id of ["t2", "t3", "t5", "t7", "t8"]) expect(tasks.get(id)?.totalFloat).toBe(0);
  });

  test("float — 2.2 at 13d has 0 d; at 16d 2.1 and 2.3 gain positive float", () => {
    expect(byId(schedule(13)).get("t6")?.totalFloat).toBe(0);
    const sixteen = byId(schedule(16));
    expect(sixteen.get("t6")?.totalFloat).toBe(0);
    expect(sixteen.get("t5")?.totalFloat).toBe(2);
    expect(sixteen.get("t7")?.totalFloat).toBe(2);
  });

  test("float never depends on margin", () => {
    for (const duration of [4, 13, 16]) {
      expect(floats(schedule(duration, 0))).toBe(floats(schedule(duration, 50)));
      expect(floats(schedule(duration, 90))).toBe(floats(schedule(duration, 50)));
    }
  });

  test("changing a margin never changes which tasks are critical", () => {
    for (const duration of [4, 13, 16]) {
      expect(criticalIds(schedule(duration, 0))).toBe(criticalIds(schedule(duration, 50)));
      expect(criticalIds(schedule(duration, 90))).toBe(criticalIds(schedule(duration, 50)));
    }
  });
});
