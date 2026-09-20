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
