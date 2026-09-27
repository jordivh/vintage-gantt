import { describe, expect, test } from "bun:test";
import { createDefaultCalendarSystem, type CalendarException, type CalendarSystem, type PlannerCalendar, type Weekday } from "./scheduling-engine";
import { orderTasksForDisplay, recalculateTasks, withCalculatedPlanningFields, type PlannerTask } from "./planner-model";
import { R3_CHRIS_LEAVE, R3_RESOURCES, r3TasksA, r3TasksB } from "./r3-fixture";
import { availableHours } from "./resource-capacity";

/** The R3 calendar system: the default base plus the three person calendars. */
const r3System = (): CalendarSystem => {
  const base = createDefaultCalendarSystem();
  const personCalendars: PlannerCalendar[] = R3_RESOURCES.map((resource) => ({
    id: resource.calendarId,
    name: `${resource.name} — leave`,
    type: "person",
    parentCalendarId: "base",
    isDefault: false,
    workingDays: resource.workingDays as Weekday[],
  }));
  const leave: CalendarException = {
    id: R3_CHRIS_LEAVE.id,
    calendarId: R3_CHRIS_LEAVE.calendarId,
    startDate: R3_CHRIS_LEAVE.startDate,
    endDate: R3_CHRIS_LEAVE.endDate,
    label: R3_CHRIS_LEAVE.label,
    type: "leave",
    isWorkingDay: false,
    source: "manual",
  };
  return { calendars: [...base.calendars, ...personCalendars], exceptions: [leave], defaultCalendarId: base.defaultCalendarId };
};

const schedule = (tasks: PlannerTask[], system: CalendarSystem) =>
  recalculateTasks(tasks, { direction: "forward", calendarSystem: system, projectCalendarId: "base" }).tasks;

describe("R3 fixture — TP-R3-A", () => {
  const system = r3System();
  const tasks = r3TasksA("proj-a", "ver-a", "r3a") as PlannerTask[];
  const scheduled = schedule(tasks, system);
  const byId = new Map(scheduled.map((task) => [task.id, task]));

  test("dependencies schedule to 5 Oct–30 Oct, 2–6 Nov, 9–12 Nov", () => {
    expect([byId.get("r3a1")?.start, byId.get("r3a1")?.finish]).toEqual(["2026-10-05", "2026-10-30"]);
    expect([byId.get("r3a2")?.start, byId.get("r3a2")?.finish]).toEqual(["2026-11-02", "2026-11-06"]);
    expect([byId.get("r3a3")?.start, byId.get("r3a3")?.finish]).toEqual(["2026-11-09", "2026-11-12"]);
  });

  test("the summary rolls the dates up and stays above its children", () => {
    expect(byId.get("r3as")?.start).toBe("2026-10-05");
    expect(byId.get("r3as")?.finish).toBe("2026-11-12");
  });

  test("the display order is Uitvoering, Ontwerp, Opbouw, Nazicht (WBS 1, 1.1, 1.2, 1.3)", () => {
    expect(orderTasksForDisplay(tasks).map((task) => task.name)).toEqual(["Uitvoering", "Ontwerp", "Opbouw", "Nazicht"]);
  });

  test("the summary shows the sum of its children's work", () => {
    const calculated = withCalculatedPlanningFields(scheduled, system, "base");
    const summary = calculated.find((task) => task.id === "r3as");
    expect(summary?.work).toBe(112); // 40 + 40 + 32
  });

  test("work and distribution are stored per task", () => {
    expect(byId.get("r3a1")?.work).toBe(40);
    expect(byId.get("r3a1")?.distribution).toBe("even");
    expect(byId.get("r3a2")?.work).toBe(40);
    expect(byId.get("r3a2")?.distribution).toBe("front");
    expect(byId.get("r3a3")?.work).toBe(32);
  });
});

describe("R3 fixture — TP-R3-B", () => {
  const system = r3System();
  const tasks = r3TasksB("proj-b", "ver-b", "r3b") as PlannerTask[];
  const scheduled = schedule(tasks, system);
  const byId = new Map(scheduled.map((task) => [task.id, task]));

  test("Analyse is 15 working days: 5–23 October 2026", () => {
    expect([byId.get("r3b1")?.start, byId.get("r3b1")?.finish]).toEqual(["2026-10-05", "2026-10-23"]);
    expect(orderTasksForDisplay(tasks).map((task) => task.name)).toEqual(["Analysefase", "Analyse"]);
  });

  test("Analyse carries 300 h and the summary rolls it up", () => {
    const calculated = withCalculatedPlanningFields(scheduled, system, "base");
    expect(calculated.find((task) => task.id === "r3b1")?.work).toBe(300);
    expect(calculated.find((task) => task.id === "r3bs")?.work).toBe(300);
  });
});

describe("R3 fixture — resources", () => {
  const system = r3System();
  const [anna, bram, chris] = R3_RESOURCES;
  const person = (resource: (typeof R3_RESOURCES)[number]) => ({ hoursPerWeek: resource.hoursPerWeek, calendarId: resource.calendarId });

  test("Anna: 40 h over Mon–Fri is 8 h a day", () => {
    expect(availableHours(person(anna), "2026-10-05", system)).toBe(8);
    expect(availableHours(person(anna), "2026-10-09", system)).toBe(8);
  });

  test("Bram: 20 h over Mon–Thu is 5 h a day, Friday off", () => {
    expect(availableHours(person(bram), "2026-10-05", system)).toBe(5);
    expect(availableHours(person(bram), "2026-10-08", system)).toBe(5);
    expect(availableHours(person(bram), "2026-10-09", system)).toBe(0); // Friday
  });

  test("Chris: leave 12–16 October gives 0 h that week only", () => {
    expect(availableHours(person(chris), "2026-10-13", system)).toBe(0);
    expect(availableHours(person(chris), "2026-10-12", system)).toBe(0);
    expect(availableHours(person(chris), "2026-10-16", system)).toBe(0);
    expect(availableHours(person(chris), "2026-10-19", system)).toBe(8);
  });
});
