import { describe, expect, test } from "bun:test";
import {
  createDefaultCalendarSystem,
  type CalendarException,
  type CalendarSystem,
  type PlannerCalendar,
  type Weekday,
} from "./scheduling-engine";
import type { PlannerTask } from "./planner-model";
import { R3_CHRIS_LEAVE, R3_RESOURCES, r3AssignmentsA, r3AssignmentsB, r3TasksA, r3TasksB } from "./r3-fixture";
import { aggregatePeriods, computeResourceLoads, overloadWarning, type CapacityInput } from "./capacity-engine";

const r3System = (): CalendarSystem => {
  const base = createDefaultCalendarSystem();
  const people: PlannerCalendar[] = R3_RESOURCES.map((resource) => ({
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
  return { calendars: [...base.calendars, ...people], exceptions: [leave], defaultCalendarId: base.defaultCalendarId };
};

const people = () => R3_RESOURCES.map((resource) => ({ id: resource.id, name: resource.name, hoursPerWeek: resource.hoursPerWeek, calendarId: resource.calendarId }));

const projectA = (tasks: PlannerTask[] = r3TasksA("proj-a", "ver-a", "r3a") as PlannerTask[]) =>
  ({ projectId: "proj-a", projectName: "TP-R3-A", projectCalendarId: "base", tasks });
const projectB = () =>
  ({ projectId: "proj-b", projectName: "TP-R3-B", projectCalendarId: "base", tasks: r3TasksB("proj-b", "ver-b", "r3b") as PlannerTask[] });

const fullInput = (): CapacityInput => ({
  system: r3System(),
  resources: people(),
  assignments: [...r3AssignmentsA("r3a"), ...r3AssignmentsB("r3b")],
  projects: [projectA(), projectB()],
});

const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

const task = (overrides: Partial<PlannerTask>): PlannerTask => ({
  id: "t",
  parentId: null,
  name: "Task",
  duration: 1,
  durationUnit: "days",
  start: "2026-10-12",
  finish: "2026-10-12",
  isMilestone: false,
  predecessors: "",
  resource: "",
  percent: 0,
  notes: "",
  color: "sage",
  marginPct: 0,
  ...overrides,
});

describe("capacity — load, availability and overload", () => {
  test("Anna is overloaded by working both projects at once", () => {
    const anna = computeResourceLoads(fullInput()).find((report) => report.resourceId === "res-r3-anna")!;
    expect(anna.overloadedDays).toBeGreaterThan(0);
    // 5 working days × (2 h Ontwerp + 20 h Analyse) = 110 h requested, 40 h available.
    const week = aggregatePeriods(anna, "week").find((period) => period.start === "2026-10-05")!;
    expect(week.allocated).toBe(110);
    expect(week.available).toBe(40);
    expect(week.remaining).toBe(-70);
    expect(week.overload).toBe(true);
    expect(close(week.utilisation ?? 0, 2.75)).toBe(true);
  });

  test("the Dutch warning names the resource, period, available and requested hours", () => {
    const anna = computeResourceLoads(fullInput()).find((report) => report.resourceId === "res-r3-anna")!;
    const week = aggregatePeriods(anna, "week").find((period) => period.start === "2026-10-05")!;
    const warning = overloadWarning("Anna", week) ?? "";
    expect(warning).toContain("Overbelasting: Anna");
    expect(warning).toContain("okt");
    expect(warning).toContain("40 u beschikbaar");
    expect(warning).toContain("110 u toegewezen");
  });

  test("no false overload: a long task with little work stays under capacity", () => {
    const input: CapacityInput = {
      system: r3System(),
      resources: people(),
      assignments: r3AssignmentsA("r3a"),
      projects: [projectA()], // only Ontwerp (Anna), 40 h over 20 days = 2 h/day
    };
    const anna = computeResourceLoads(input).find((report) => report.resourceId === "res-r3-anna")!;
    expect(anna.overloadedDays).toBe(0);
    expect(aggregatePeriods(anna, "week").some((period) => period.overload)).toBe(false);
  });

  test("zero available hours with load is an overload, not silently dropped", () => {
    const input: CapacityInput = {
      system: r3System(),
      resources: people(),
      assignments: [{ taskId: "c1", resourceId: "res-r3-chris" }],
      // Chris is on leave 12–16 Oct, so availability is 0 that week.
      projects: [projectA([task({ id: "c1", name: "Chris werkt", duration: 5, finish: "2026-10-16", work: 20 })])],
    };
    const chris = computeResourceLoads(input).find((report) => report.resourceId === "res-r3-chris")!;
    const week = aggregatePeriods(chris, "week").find((period) => period.start === "2026-10-12")!;
    expect(week.available).toBe(0);
    expect(week.allocated).toBe(20);
    expect(week.overload).toBe(true);
    expect(week.utilisation).toBeNull();
    expect(overloadWarning("Chris", week)).toContain("0 u beschikbaar maar 20 u toegewezen");
  });

  test("Bram's Friday off gives a short week: 20 h over Mon–Thu", () => {
    const bram = computeResourceLoads(fullInput()).find((report) => report.resourceId === "res-r3-bram")!;
    // Opbouw runs 2–6 Nov: 40 h front-loaded over 5 days, but Friday has 0 available.
    const week = aggregatePeriods(bram, "week").find((period) => period.start === "2026-11-02")!;
    expect(week.available).toBe(20); // Mon–Thu only
    expect(week.allocated).toBe(40);
    expect(week.overload).toBe(true);
  });
});

describe("capacity — breakdown, conflicts and aggregation", () => {
  test("the breakdown shows which project each part comes from", () => {
    const anna = computeResourceLoads(fullInput()).find((report) => report.resourceId === "res-r3-anna")!;
    const week = aggregatePeriods(anna, "week").find((period) => period.start === "2026-10-05")!;
    expect(week.breakdown.map((row) => [row.projectName, row.allocated])).toEqual([["TP-R3-B", 100], ["TP-R3-A", 10]]);
  });

  test("conflicting assignments name the other task and its project", () => {
    const anna = computeResourceLoads(fullInput()).find((report) => report.resourceId === "res-r3-anna")!;
    const ontwerp = anna.conflicts.find((conflict) => conflict.taskName === "Ontwerp");
    expect(ontwerp).toBeDefined();
    expect(ontwerp?.otherTaskName).toBe("Analyse");
    expect(ontwerp?.otherProjectName).toBe("TP-R3-B");
    const analyse = anna.conflicts.find((conflict) => conflict.taskName === "Analyse");
    expect(analyse?.otherTaskName).toBe("Ontwerp");
    expect(analyse?.otherProjectName).toBe("TP-R3-A");
  });

  test("month totals equal the sum of their days, including weeks that span two months", () => {
    const anna = computeResourceLoads(fullInput()).find((report) => report.resourceId === "res-r3-anna")!;
    const months = aggregatePeriods(anna, "month");
    for (const month of months) {
      const days = anna.days.filter((day) => day.date.startsWith(month.key));
      expect(close(month.allocated, days.reduce((total, day) => total + day.allocated, 0))).toBe(true);
      expect(close(month.available, days.reduce((total, day) => total + day.available, 0))).toBe(true);
    }
    // 26 Oct–1 Nov is a week that straddles October and November.
    const straddle = aggregatePeriods(anna, "week").find((period) => period.start === "2026-10-26")!;
    expect(straddle.start).toBe("2026-10-26");
    expect(straddle.end).toBe("2026-11-01");
    const october = months.find((month) => month.key === "2026-10")!;
    const november = months.find((month) => month.key === "2026-11")!;
    const straddleDays = anna.days.filter((day) => day.date >= "2026-10-26" && day.date <= "2026-11-01");
    // The straddling week is the sum of its days, split across the two months.
    expect(close(straddle.allocated, straddleDays.reduce((total, day) => total + day.allocated, 0))).toBe(true);
    expect(close(october.allocated + november.allocated, anna.totalAllocated)).toBe(true);
  });

  test("a resource with no assignments shows availability and zero load", () => {
    const input: CapacityInput = { ...fullInput(), assignments: [], projects: [projectA(), projectB()] };
    const reports = computeResourceLoads(input);
    for (const report of reports) {
      expect(report.totalAllocated).toBe(0);
      expect(report.overloadedDays).toBe(0);
    }
    const anna = reports.find((report) => report.resourceId === "res-r3-anna")!;
    const week = aggregatePeriods(anna, "week").find((period) => period.start === "2026-10-05")!;
    expect(week.available).toBe(40);
    expect(week.allocated).toBe(0);
    expect(week.utilisation).toBe(0);
  });
});
