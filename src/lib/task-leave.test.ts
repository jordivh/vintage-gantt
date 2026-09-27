import { describe, expect, test } from "bun:test";
import {
  createDefaultCalendarSystem,
  type CalendarException,
  type CalendarSystem,
  type PlannerCalendar,
} from "./scheduling-engine";
import { taskLeaveInfo, leaveLabels, type LeaveRecord } from "./task-leave";

const calendar = (overrides: Partial<PlannerCalendar>): PlannerCalendar => ({
  id: "x",
  name: "x",
  type: "base",
  parentCalendarId: null,
  isDefault: false,
  ...overrides,
});

const personCalendar = (id: string): PlannerCalendar =>
  calendar({ id, name: id, type: "person", parentCalendarId: "base", workingDays: [1, 2, 3, 4, 5] });

const leave = (overrides: Partial<CalendarException> = {}): CalendarException => ({
  id: "leave",
  calendarId: "person-anna",
  startDate: "2026-10-12",
  endDate: "2026-10-16",
  label: "Verlof",
  type: "leave",
  isWorkingDay: false,
  source: "manual",
  ...overrides,
});

const systemWith = (exceptions: CalendarException[] = []): CalendarSystem => {
  const base = createDefaultCalendarSystem();
  return {
    calendars: [...base.calendars, personCalendar("person-anna"), personCalendar("person-bram")],
    exceptions,
    defaultCalendarId: base.defaultCalendarId,
  };
};

const resources = [
  { id: "anna", name: "Anna", hoursPerWeek: 40, calendarId: "person-anna" },
  { id: "bram", name: "Bram", hoursPerWeek: 20, calendarId: "person-bram" },
];

/* 2026-10-05 Mon … 2026-10-23 Fri = 15 working days, 19 calendar days. */
const task = { id: "t1", parentId: null, start: "2026-10-05", finish: "2026-10-23" };

describe("task leave — informational overlap of leave and availability", () => {
  test("counts the leave days inside the task span and subtracts them from availability", () => {
    const system = systemWith([leave()]);
    const info = taskLeaveInfo([task], resources, [{ taskId: "t1", resourceId: "anna" }], system.exceptions as LeaveRecord[], system);
    const result = info.get("t1")!;
    expect(result.leaveDays).toBe(5); // 12–16 October
    expect(result.availableHours).toBe(80); // 15 working days × 8 h − 5 leave days × 8 h
  });

  test("no leave gives full availability and zero leave days", () => {
    const system = systemWith([]);
    const info = taskLeaveInfo([task], resources, [{ taskId: "t1", resourceId: "anna" }], system.exceptions as LeaveRecord[], system);
    expect(info.get("t1")!.leaveDays).toBe(0);
    expect(info.get("t1")!.availableHours).toBe(120);
  });

  test("leave outside the span is ignored", () => {
    const system = systemWith([leave({ startDate: "2026-11-02", endDate: "2026-11-06" })]);
    const info = taskLeaveInfo([task], resources, [{ taskId: "t1", resourceId: "anna" }], system.exceptions as LeaveRecord[], system);
    expect(info.get("t1")!.leaveDays).toBe(0);
  });

  test("a holiday (non-leave exception) never counts as leave", () => {
    const system = systemWith([leave({ type: "holiday", startDate: "2026-10-07", endDate: "2026-10-07" })]);
    const info = taskLeaveInfo([task], resources, [{ taskId: "t1", resourceId: "anna" }], system.exceptions as LeaveRecord[], system);
    expect(info.get("t1")!.leaveDays).toBe(0);
    expect(info.get("t1")!.availableHours).toBe(112); // the holiday removes one day's availability
  });

  test("the leave label is available for hover", () => {
    const system = systemWith([leave({ label: "Jaarlijks verlof" })]);
    const info = taskLeaveInfo([task], resources, [{ taskId: "t1", resourceId: "anna" }], system.exceptions as LeaveRecord[], system);
    expect(leaveLabels(info.get("t1"))).toEqual(["Jaarlijks verlof"]);
  });

  test("summary rows roll up their children's leave days and availability", () => {
    const childA = { id: "c1", parentId: "s1", start: "2026-10-05", finish: "2026-10-09" };
    const childB = { id: "c2", parentId: "s1", start: "2026-10-12", finish: "2026-10-16" };
    const summary = { id: "s1", parentId: null, start: childA.start, finish: childB.finish };
    const system = systemWith([leave()]);
    const info = taskLeaveInfo(
      [summary, childA, childB],
      resources,
      [{ taskId: "c1", resourceId: "anna" }, { taskId: "c2", resourceId: "anna" }],
      system.exceptions as LeaveRecord[],
      system,
    );
    expect(info.get("c1")!.leaveDays).toBe(0);
    expect(info.get("c2")!.leaveDays).toBe(5);
    expect(info.get("s1")!.leaveDays).toBe(5); // total of the children
    expect(info.get("s1")!.availableHours).toBe(40); // child A 5 × 8 h, child B is the leave week (0)
  });

  test("a task with no assignment is inert", () => {
    const system = systemWith([leave()]);
    const info = taskLeaveInfo([task], resources, [], system.exceptions as LeaveRecord[], system);
    expect(info.get("t1")!.leaveDays).toBe(0);
    expect(info.get("t1")!.availableHours).toBe(0);
  });

  test("multiple assigned resources sum their leave days and hours", () => {
    const system = systemWith([]);
    const info = taskLeaveInfo(
      [task],
      resources,
      [{ taskId: "t1", resourceId: "anna" }, { taskId: "t1", resourceId: "bram" }],
      system.exceptions as LeaveRecord[],
      system,
    );
    // Anna 15 × 8 = 120; Bram 20 h over Mon–Fri = 4 h/day × 15 = 60.
    expect(info.get("t1")!.availableHours).toBe(180);
  });
});
