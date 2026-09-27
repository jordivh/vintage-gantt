import { describe, expect, test } from "bun:test";
import {
  createDefaultCalendarSystem,
  type CalendarException,
  type CalendarSystem,
  type PlannerCalendar,
} from "./scheduling-engine";
import {
  availableHours,
  resourceDayAvailability,
  resourceWorkingWeekdays,
  type CapacityResource,
} from "./resource-capacity";

/* Mondays: 2026-01-05 Mon, 06 Tue, 07 Wed, 08 Thu, 09 Fri, 10 Sat. */

const calendar = (overrides: Partial<PlannerCalendar>): PlannerCalendar => ({
  id: "x",
  name: "x",
  type: "base",
  parentCalendarId: null,
  isDefault: false,
  ...overrides,
});

const personCalendar = (overrides: Partial<PlannerCalendar> = {}): PlannerCalendar =>
  calendar({ id: "person-1", name: "Person", type: "person", parentCalendarId: "base", workingDays: [1, 2, 3, 4, 5], ...overrides });

const exception = (overrides: Partial<CalendarException> = {}): CalendarException => ({
  id: "e",
  calendarId: "base",
  startDate: "2026-01-05",
  endDate: "2026-01-05",
  label: "Holiday",
  type: "holiday",
  isWorkingDay: false,
  source: "manual",
  ...overrides,
});

const systemWith = ({
  calendars = [],
  exceptions = [],
}: { calendars?: PlannerCalendar[]; exceptions?: CalendarException[] } = {}): CalendarSystem => {
  const base = createDefaultCalendarSystem();
  return { calendars: [...base.calendars, ...calendars], exceptions, defaultCalendarId: base.defaultCalendarId };
};

const resource = (overrides: Partial<CapacityResource> = {}): CapacityResource => ({
  hoursPerWeek: 40,
  calendarId: "person-1",
  ...overrides,
});

describe("available hours — capacity spread over the resource's own week", () => {
  test("40 h over Mon–Fri is 8 h a day, never a hardcoded 8 h", () => {
    const system = systemWith({ calendars: [personCalendar()] });
    expect(availableHours(resource(), "2026-01-05", system)).toBe(8);
    expect(availableHours(resource(), "2026-01-09", system)).toBe(8);
    expect(availableHours(resource(), "2026-01-10", system)).toBe(0); // Saturday
  });

  test("20 h over Mon–Thu is 5 h a day", () => {
    const system = systemWith({ calendars: [personCalendar({ workingDays: [1, 2, 3, 4] })] });
    const person = resource({ hoursPerWeek: 20 });
    expect(availableHours(person, "2026-01-05", system)).toBe(5);
    expect(availableHours(person, "2026-01-08", system)).toBe(5);
    expect(availableHours(person, "2026-01-09", system)).toBe(0); // Friday is off
  });

  test("a weekday off only affects that resource", () => {
    const system = systemWith({
      calendars: [
        personCalendar({ id: "person-a", workingDays: [1, 2, 3, 4] }),
        personCalendar({ id: "person-b", workingDays: [1, 2, 3, 4, 5] }),
      ],
    });
    const a = resource({ calendarId: "person-a", hoursPerWeek: 20 });
    const b = resource({ calendarId: "person-b", hoursPerWeek: 40 });
    expect(availableHours(a, "2026-01-09", system)).toBe(0);
    expect(availableHours(b, "2026-01-09", system)).toBe(8);
  });

  test("changing the capacity changes the daily hours", () => {
    const system = systemWith({ calendars: [personCalendar()] });
    expect(availableHours(resource({ hoursPerWeek: 36 }), "2026-01-05", system)).toBe(7.2);
    expect(resourceWorkingWeekdays(resource(), system)).toEqual([1, 2, 3, 4, 5]);
  });

  test("with no person pattern, the base pattern is used", () => {
    const system = systemWith({ calendars: [personCalendar({ workingDays: undefined })] });
    expect(resourceWorkingWeekdays(resource(), system)).toEqual([1, 2, 3, 4, 5]);
    expect(availableHours(resource({ hoursPerWeek: 20 }), "2026-01-05", system)).toBe(4);
  });
});

describe("available hours — calendar hierarchy, leave and the rule's level", () => {
  test("a base-calendar holiday gives 0 h and reports the base level", () => {
    const system = systemWith({ calendars: [personCalendar()], exceptions: [exception()] });
    const day = resourceDayAvailability(resource(), "2026-01-05", system);
    expect(day.hours).toBe(0);
    expect(day.level).toBe("base");
    // The rest of the week is untouched.
    expect(availableHours(resource(), "2026-01-06", system)).toBe(8);
  });

  test("a project-level exception wins over base and reports the project level", () => {
    const project = calendar({ id: "project-1", name: "Project", type: "project", parentCalendarId: "base" });
    const system = systemWith({
      calendars: [
        project,
        personCalendar({ parentCalendarId: "project-1", workingDays: undefined }),
      ],
      exceptions: [exception({ calendarId: "project-1", startDate: "2026-01-06", endDate: "2026-01-06" })],
    });
    const day = resourceDayAvailability(resource(), "2026-01-06", system);
    expect(day.hours).toBe(0);
    expect(day.level).toBe("project");
  });

  test("leave gives 0 h, reports the leave level, and does not touch other days", () => {
    const system = systemWith({
      calendars: [personCalendar()],
      exceptions: [exception({ calendarId: "person-1", startDate: "2026-01-07", endDate: "2026-01-07", label: "holiday leave · family", type: "leave" })],
    });
    const day = resourceDayAvailability(resource(), "2026-01-07", system);
    expect(day.hours).toBe(0);
    expect(day.level).toBe("leave");
    expect(availableHours(resource(), "2026-01-08", system)).toBe(8);
  });

  test("a person extra-working day grants the daily rate and reports the person level", () => {
    const system = systemWith({
      calendars: [personCalendar()],
      // Saturday 2026-01-10 made a working day for this person only.
      exceptions: [exception({ calendarId: "person-1", startDate: "2026-01-10", endDate: "2026-01-10", type: "extra-working", isWorkingDay: true, label: "Catch-up day" })],
    });
    const day = resourceDayAvailability(resource(), "2026-01-10", system);
    expect(day.hours).toBe(8);
    expect(day.level).toBe("person");
  });
});
