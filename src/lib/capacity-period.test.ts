import { describe, expect, test } from "bun:test";
import {
  createDefaultCalendarSystem,
  type CalendarException,
  type CalendarSystem,
  type PlannerCalendar,
} from "./scheduling-engine";
import type { PlannerTask } from "./planner-model";
import {
  PARTIAL_WEEK,
  dayLabel,
  isCurrentPeriod,
  isIsoDate,
  isoWeekNumber,
  monthEnd,
  monthLabel,
  monthStart,
  periodKey,
  periodLabel,
  periodRows,
  periodWindow,
  shiftPeriod,
  weekEnd,
  weekStart,
} from "./capacity-period";
import {
  aggregateSpans,
  computeResourceLoads,
  dayOverloadWarning,
  isOverloaded,
  overlapsRange,
  overloadWarning,
  reportAssignmentCount,
  reportUtilisation,
  utilisationOf,
  type ResourceCapacityReport,
} from "./capacity-engine";

/* ------------------------------------------------------------------ fixtures */

const FULL = { id: "res-full", name: "Full time", hoursPerWeek: 40, calendarId: "cal-full" };
const PART = { id: "res-part", name: "Part time", hoursPerWeek: 20, calendarId: "cal-part" };
type Person = typeof FULL;

const personCalendar = (id: string, name: string): PlannerCalendar =>
  ({ id, name, type: "person", parentCalendarId: "base", isDefault: false, workingDays: [1, 2, 3, 4, 5] });

const systemWith = (exceptions: CalendarException[] = []): CalendarSystem => ({
  calendars: [
    ...createDefaultCalendarSystem().calendars,
    personCalendar("cal-full", "Full time"),
    personCalendar("cal-part", "Part time"),
  ],
  exceptions,
  defaultCalendarId: "base",
});

const leave = (calendarId: string, startDate: string, endDate: string): CalendarException =>
  ({ id: `leave-${calendarId}-${startDate}`, calendarId, startDate, endDate, label: "Leave", type: "leave", isWorkingDay: false, source: "manual" });

const holiday = (calendarId: string, startDate: string, endDate: string = startDate): CalendarException =>
  ({ id: `holiday-${calendarId}-${startDate}`, calendarId, startDate, endDate, label: "Public holiday", type: "holiday", isWorkingDay: false, source: "manual" });

/**
 * A task's span comes from its `start` and `duration` in working days (never
 * from `finish`), so the fixtures only ever set those two plus the work.
 */
const task = (overrides: Partial<PlannerTask> & { id: string; start: string; duration: number }): PlannerTask => ({
  parentId: null,
  name: overrides.id,
  durationUnit: "days",
  finish: overrides.start,
  isMilestone: false,
  predecessors: "",
  resource: "",
  percent: 0,
  notes: "",
  color: "sage",
  marginPct: 0,
  ...overrides,
});

interface LoadConfig {
  system?: CalendarSystem;
  person?: Person;
  projects: { projectId: string; projectName: string; tasks: PlannerTask[] }[];
  /** Defaults to every task of every project assigned to the person. */
  assigned?: { taskId: string; resourceId: string }[];
  /** The window to report on — the shown period. */
  range?: { start: string; end: string };
}

const load = (config: LoadConfig): ResourceCapacityReport => {
  const person = config.person ?? FULL;
  return computeResourceLoads({
    system: config.system ?? systemWith(),
    resources: [person],
    assignments: config.assigned ?? config.projects.flatMap((project) => project.tasks.map((item) => ({ taskId: item.id, resourceId: person.id }))),
    projects: config.projects.map((project) => ({ ...project, projectCalendarId: "base" })),
    range: config.range,
  }).find((report) => report.resourceId === person.id)!;
};

const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const rowsOf = (report: ResourceCapacityReport, view: "week" | "month", date: string) =>
  aggregateSpans(report, periodRows(view, date));
const day = (report: ResourceCapacityReport, view: "week" | "month", date: string, dateOfDay: string) =>
  rowsOf(report, view, date).find((row) => row.start === dateOfDay)!;

/* ------------------------------------------- 1. a normal five-day working week */

describe("case 1 — a normal five-day working week", () => {
  const report = load({
    projects: [{ projectId: "proj-a", projectName: "TP-A", tasks: [task({ id: "t1", start: "2026-10-05", duration: 5, work: 40 })] }],
    range: periodWindow("week", "2026-10-07"),
  });
  const rows = rowsOf(report, "week", "2026-10-07");

  test("shows exactly one Monday–Sunday week, one row per day", () => {
    expect(rows.map((row) => row.key)).toEqual([
      "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11",
    ]);
    expect(rows.map((row) => row.label)).toEqual([
      "Mon 5 Oct 2026", "Tue 6 Oct 2026", "Wed 7 Oct 2026", "Thu 8 Oct 2026", "Fri 9 Oct 2026", "Sat 10 Oct 2026", "Sun 11 Oct 2026",
    ]);
    expect(periodLabel("week", "2026-10-07")).toBe("Week 41 · 5 – 11 Oct 2026");
    expect(isoWeekNumber("2026-10-07")).toBe(41);
  });

  test("keeps weekends visible with zero hours instead of hiding them", () => {
    expect(rows.slice(0, 5).map((row) => [row.available, row.allocated, row.remaining])).toEqual([
      [8, 8, 0], [8, 8, 0], [8, 8, 0], [8, 8, 0], [8, 8, 0],
    ]);
    expect(rows.slice(5).map((row) => [row.available, row.allocated, row.remaining, row.utilisation])).toEqual([
      [0, 0, 0, null], [0, 0, 0, null],
    ]);
    expect(rows.slice(0, 5).map((row) => row.utilisation)).toEqual([1, 1, 1, 1, 1]);
  });

  test("breaks each day down by the hours allocated on that day", () => {
    expect(day(report, "week", "2026-10-07", "2026-10-05").breakdown).toEqual([{ projectId: "proj-a", projectName: "TP-A", allocated: 8 }]);
    expect(day(report, "week", "2026-10-07", "2026-10-10").breakdown).toEqual([]);
  });

  test("week totals follow the same days: no overload, one assignment", () => {
    expect(report.totalAvailable).toBe(40);
    expect(report.totalAllocated).toBe(40);
    expect(report.overloadedDays).toBe(0);
    expect(reportAssignmentCount(report)).toBe(1);
    expect(reportUtilisation(report)).toBe(1);
  });
});

/* -------------------------------------------------- 2. a part-time resource */

describe("case 2 — a part-time resource", () => {
  const report = load({
    person: PART,
    projects: [{ projectId: "proj-a", projectName: "TP-A", tasks: [task({ id: "p1", start: "2026-10-05", duration: 5, work: 20 })] }],
    range: periodWindow("week", "2026-10-07"),
  });
  const rows = rowsOf(report, "week", "2026-10-07");

  test("spreads the contracted hours over the person's own working days, never /5 blindly", () => {
    // 20 h a week over Mon–Fri is 4 h a day, not 8 h for two and a half days.
    expect(rows.slice(0, 5).map((row) => [row.available, row.allocated])).toEqual([[4, 4], [4, 4], [4, 4], [4, 4], [4, 4]]);
    expect(rows.slice(0, 5).map((row) => row.utilisation)).toEqual([1, 1, 1, 1, 1]);
    expect(report.totalAvailable).toBe(20);
    expect(report.totalAllocated).toBe(20);
    expect(report.overloadedDays).toBe(0);
  });
});

/* -------------------------------------------- 3. a week with leave or a holiday */

describe("case 3 — a week with leave", () => {
  const report = load({
    system: systemWith([leave("cal-full", "2026-10-07", "2026-10-09")]),
    projects: [{ projectId: "proj-a", projectName: "TP-A", tasks: [task({ id: "l1", start: "2026-10-05", duration: 5, work: 40 })] }],
    range: periodWindow("week", "2026-10-07"),
  });
  const rows = rowsOf(report, "week", "2026-10-07");

  test("leave days show 0 available and hold no hours", () => {
    expect(rows.map((row) => [row.available, row.allocated])).toEqual([
      [8, 20], [8, 20], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0],
    ]);
    expect(day(report, "week", "2026-10-07", "2026-10-07").utilisation).toBeNull();
  });

  test("the work lands on the remaining days and the overload stays visible", () => {
    expect(report.totalAvailable).toBe(16);
    expect(report.totalAllocated).toBe(40);
    expect(report.overloadedDays).toBe(2);
    expect(day(report, "week", "2026-10-07", "2026-10-05").overload).toBe(true);
    expect(overloadWarning("Full time", day(report, "week", "2026-10-07", "2026-10-09"))).toBeNull();
  });
});

describe("case 3 — a week with a public holiday", () => {
  const report = load({
    system: systemWith([holiday("cal-full", "2026-10-08")]),
    projects: [{ projectId: "proj-a", projectName: "TP-A", tasks: [task({ id: "h1", start: "2026-10-05", duration: 5, work: 40 })] }],
    range: periodWindow("week", "2026-10-07"),
  });
  const rows = rowsOf(report, "week", "2026-10-07");

  test("the holiday closes one day and its hours move onto the remaining ones", () => {
    expect(rows.map((row) => [row.available, row.allocated])).toEqual([
      [8, 10], [8, 10], [8, 10], [0, 0], [8, 10], [0, 0], [0, 0],
    ]);
    expect(report.totalAvailable).toBe(32);
    expect(report.totalAllocated).toBe(40);
    expect(report.overloadedDays).toBe(4);
  });

  test("a holiday on a shared calendar is part of the task's own span as well", () => {
    // Existing behaviour, preserved: a base-calendar closure is a non-working day
    // for the task itself, so the 5-day task reaches Monday of the next week and
    // the closed day can never hold hours.
    const shared = load({
      system: systemWith([holiday("base", "2026-10-08")]),
      projects: [{ projectId: "proj-a", projectName: "TP-A", tasks: [task({ id: "h2", start: "2026-10-05", duration: 5, work: 40 })] }],
      range: periodWindow("week", "2026-10-07"),
    });
    const sharedRows = rowsOf(shared, "week", "2026-10-07");
    expect(sharedRows.map((row) => [row.available, row.allocated])).toEqual([
      [8, 8], [8, 8], [8, 8], [0, 0], [8, 8], [0, 0], [0, 0],
    ]);
    expect(shared.totalAvailable).toBe(32);
    expect(shared.totalAllocated).toBe(32);
    expect(shared.overloadedDays).toBe(0);
  });
});

/* ---------------------- 4. an overloaded day in a week that stays below 100% */

describe("case 4 — an overloaded day inside a lighter week", () => {
  const report = load({
    projects: [
      { projectId: "proj-a", projectName: "TP-A", tasks: [task({ id: "a1", start: "2026-10-05", duration: 1, work: 8 })] },
      { projectId: "proj-b", projectName: "TP-B", tasks: [task({ id: "b1", start: "2026-10-05", duration: 1, work: 8 }), task({ id: "b2", start: "2026-10-07", duration: 1, work: 8 })] },
    ],
    range: periodWindow("month", "2026-10-07"),
  });
  const weekRows = rowsOf(report, "month", "2026-10-07");

  test("the week total stays under 100% while one day is over capacity", () => {
    const monday = day(report, "week", "2026-10-07", "2026-10-05");
    expect([monday.available, monday.allocated, monday.overload, monday.overloadedDays]).toEqual([8, 16, true, 1]);
    expect(monday.breakdown.map((row) => [row.projectName, row.allocated])).toEqual([["TP-A", 8], ["TP-B", 8]]);
    expect(monday.assignments).toBe(2);
    expect(day(report, "week", "2026-10-07", "2026-10-06").overload).toBe(false);
    expect(report.totalAvailable).toBe(176);
    expect(report.totalAllocated).toBe(24);
    expect(reportUtilisation(report)! < 1).toBe(true);
  });

  test("the month row says so by day, so 'no overload' is never claimed", () => {
    const weekRow = weekRows.find((row) => row.start === "2026-10-05")!;
    expect([weekRow.overload, weekRow.overloadedDays]).toEqual([false, 1]);
    expect(weekRows.some((row) => row.overloadedDays > 0)).toBe(true);
    expect(weekRows.every((row) => !row.overload)).toBe(true);
    const warning = overloadWarning("Full time", weekRow) ?? "";
    expect(warning).toContain("1 day inside");
    expect(warning).toContain("5 – 11 Oct 2026");
    expect(warning).toContain("Full time");
    // and the day itself can always be named
    const mondayDay = weekRow.days.find((entry) => entry.date === "2026-10-05")!;
    const mondayWarning = dayOverloadWarning("Full time", mondayDay) ?? "";
    expect(mondayWarning).toContain("Mon 5 Oct 2026");
    expect(mondayWarning).toContain("16 h planned");
    expect(mondayWarning).toContain("only 8 h available");
  });
});

/* --------------------------- 5. a month that begins and ends mid-week */

describe("case 5 — a month beginning and ending halfway through a week", () => {
  const October = periodWindow("month", "2026-10-15");
  const report = load({
    projects: [
      // Spans the month boundary: 7 working days from Mon 26 Oct into November.
      { projectId: "proj-a", projectName: "TP-A", tasks: [task({ id: "a1", start: "2026-10-26", duration: 7, work: 40 })] },
      // Entirely in September: must never count towards October.
      { projectId: "proj-b", projectName: "TP-B", tasks: [task({ id: "b1", start: "2026-09-28", duration: 3, work: 24 })] },
    ],
    range: October,
  });
  const rows = rowsOf(report, "month", "2026-10-15");

  test("shows one row per overlapping Monday–Sunday week", () => {
    expect(rows.map((row) => row.key)).toEqual(["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
    expect(monthStart("2026-10-15")).toBe("2026-10-01");
    expect(monthEnd("2026-10-15")).toBe("2026-10-31");
    expect(monthLabel("2026-10-15")).toBe("October 2026");
    expect(periodLabel("month", "2026-10-15")).toBe("October 2026");
    expect(periodLabel("week", "2026-10-15")).toBe("Week 42 · 12 – 18 Oct 2026");
    expect(weekStart("2026-10-01")).toBe("2026-09-28");
    expect(weekEnd("2026-10-31")).toBe("2026-11-01");
  });

  test("the first and last week count only the days inside the month", () => {
    expect([rows[0].start, rows[0].end, rows[0].partial, rows[0].label]).toEqual(["2026-10-01", "2026-10-04", true, "1 – 4 Oct 2026"]);
    expect([rows[4].start, rows[4].end, rows[4].partial, rows[4].label]).toEqual(["2026-10-26", "2026-10-31", true, "26 – 31 Oct 2026"]);
    expect(rows.slice(1, 4).map((row) => [row.start, row.end, row.partial, row.label])).toEqual([
      ["2026-10-05", "2026-10-11", false, "5 – 11 Oct 2026"],
      ["2026-10-12", "2026-10-18", false, "12 – 18 Oct 2026"],
      ["2026-10-19", "2026-10-25", false, "19 – 25 Oct 2026"],
    ]);
    expect(rows.filter((row) => row.partial).length).toBe(2);
    expect(PARTIAL_WEEK).toBe("Partial week");
  });

  test("hours outside the month never count, inside the clipped range they do", () => {
    // September's task contributes nothing: the clipped first row holds no hours
    // even though 1–4 October has 16 available hours.
    expect([rows[0].available, rows[0].allocated]).toEqual([16, 0]);
    // The straddling task contributes its 5 October-working-days share only, and
    // nothing of its 2 November days.
    expect(rows[4].available).toBe(40);
    expect(rows[4].allocated > 0).toBe(true);
    expect(rows[4].allocated < 40).toBe(true);
    expect(report.totalAvailable).toBe(176);
    expect(close(report.totalAllocated, sum(rows.map((row) => row.allocated)))).toBe(true);
    // The same week seen day by day holds exactly the same hours: 1 November is
    // a Sunday, so clipping the row to 31 October cannot lose anything.
    const weekDays = rowsOf(report, "week", "2026-10-26");
    expect(weekDays.length).toBe(7);
    expect(close(rows[4].allocated, sum(weekDays.map((row) => row.allocated)))).toBe(true);
    expect(rows.every((row) => row.start.startsWith("2026-10"))).toBe(true);
    expect(rows.every((row) => row.end.startsWith("2026-10"))).toBe(true);
  });
});

/* ------------------------------------------------ 6. a week across December and January */

describe("case 6 — a week crossing December and January", () => {
  const report = load({
    projects: [{ projectId: "proj-a", projectName: "TP-A", tasks: [task({ id: "x1", start: "2026-12-28", duration: 5, work: 40 })] }],
    range: periodWindow("week", "2026-12-30"),
  });
  const rows = rowsOf(report, "week", "2026-12-30");

  test("stays one week, and names both years", () => {
    expect(rows.map((row) => row.key)).toEqual(["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03"]);
    expect(periodLabel("week", "2026-12-30")).toBe("Week 53 · 28 Dec 2026 – 3 Jan 2027");
    expect(rows[3].label).toBe("Thu 31 Dec 2026");
    expect(rows[4].label).toBe("Fri 1 Jan 2027");
    expect(report.totalAllocated).toBe(40);
  });

  test("its totals only cover its own 7 days", () => {
    const nextWeek = load({
      projects: [{ projectId: "proj-a", projectName: "TP-A", tasks: [task({ id: "x1", start: "2026-12-28", duration: 5, work: 40 })] }],
      range: periodWindow("week", shiftPeriod("week", "2026-12-30", 1)),
    });
    expect(periodWindow("week", "2027-01-06")).toEqual({ start: "2027-01-04", end: "2027-01-10" });
    expect(nextWeek.totalAllocated).toBe(0);
    expect(nextWeek.totalAvailable).toBe(40);
    expect(rows[0].breakdown).toEqual([{ projectId: "proj-a", projectName: "TP-A", allocated: 8 }]);
  });
});

/* ------------------------------------------------- 7. previous and next periods */

describe("case 7 — navigation to previous and next periods", () => {
  test("weeks step by seven days and keep the weekday", () => {
    expect(shiftPeriod("week", "2026-10-07", -1)).toBe("2026-09-30");
    expect(shiftPeriod("week", "2026-10-07", 1)).toBe("2026-10-14");
    expect(periodKey("week", "2026-10-07")).toBe("2026-10-05");
    expect(periodKey("week", "2026-09-30")).toBe("2026-09-28");
    expect(periodLabel("week", "2026-09-30")).toBe("Week 40 · 28 Sep – 4 Oct 2026");
  });

  test("months step by one and clamp to the shorter month", () => {
    expect(shiftPeriod("month", "2026-10-15", -1)).toBe("2026-09-15");
    expect(shiftPeriod("month", "2026-10-15", 1)).toBe("2026-11-15");
    expect(shiftPeriod("month", "2026-01-31", 1)).toBe("2026-02-28");
    expect(shiftPeriod("month", "2026-12-15", 1)).toBe("2027-01-15");
    expect(shiftPeriod("month", "2027-01-15", -1)).toBe("2026-12-15");
    expect(periodKey("month", "2026-10-31")).toBe("2026-10");
  });

  test("'this week' and 'this month' know the current period", () => {
    expect(isCurrentPeriod("week", "2026-10-07", "2026-10-09")).toBe(true);
    expect(isCurrentPeriod("week", "2026-10-07", "2026-10-12")).toBe(false);
    expect(isCurrentPeriod("month", "2026-10-07", "2026-10-31")).toBe(true);
    expect(isCurrentPeriod("month", "2026-10-07", "2026-11-01")).toBe(false);
  });

  test("only a real calendar date can move the period", () => {
    expect(isIsoDate("2026-10-07")).toBe(true);
    expect(isIsoDate("2026-10-32")).toBe(false);
    expect(isIsoDate("")).toBe(false);
    expect(isIsoDate(null)).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
    expect(isIsoDate("07-10-2026")).toBe(false);
  });
});

/* ------------------------- 8. switching view without losing the date and filters */

describe("case 8 — switching between Week and Month", () => {
  const reference = "2026-10-07";

  test("keeps the selected date as the reference in both views", () => {
    const weekRows = periodRows("week", reference);
    const monthRows = periodRows("month", reference);
    expect(weekRows.some((row) => row.start <= reference && row.end >= reference)).toBe(true);
    expect(monthRows.some((row) => row.start <= reference && row.end >= reference)).toBe(true);
    // the month row that holds the week is exactly that week
    const weekOfMonth = monthRows.find((row) => row.start <= reference && row.end >= reference)!;
    expect([weekOfMonth.start, weekOfMonth.end]).toEqual([periodWindow("week", reference).start, periodWindow("week", reference).end]);
    // and the period never jumps back to today when the view changes
    expect(periodKey("month", reference)).toBe("2026-10");
    expect(periodKey("week", reference)).toBe("2026-10-05");
  });

  test("the rows depend on the view and the date alone, never on a filter or a person", () => {
    // Two parameters, and nothing else: switching the view cannot reset the
    // resource, project or client filters, because they are not inputs here.
    expect(periodRows.length).toBe(2);
    expect(periodWindow.length).toBe(2);
    expect(periodRows("week", reference)).toEqual(periodRows("week", reference));
    const withFilters = load({
      person: PART,
      assigned: [],
      projects: [],
      range: periodWindow("week", reference),
    });
    expect(withFilters.totalAllocated).toBe(0);
    expect(rowsOf(withFilters, "week", reference).map((row) => row.available)).toEqual([4, 4, 4, 4, 4, 0, 0]);
  });
});

/* ---------------------------------------------------- 9. a period with no work */

describe("case 9 — a period with no assignments", () => {
  test("a week with no work still shows real availability and 0%", () => {
    const report = load({ projects: [], range: periodWindow("week", "2026-10-07") });
    const rows = rowsOf(report, "week", "2026-10-07");
    expect(rows.map((row) => [row.available, row.allocated, row.remaining, row.utilisation])).toEqual([
      [8, 0, 8, 0], [8, 0, 8, 0], [8, 0, 8, 0], [8, 0, 8, 0], [8, 0, 8, 0], [0, 0, 0, null], [0, 0, 0, null],
    ]);
    expect(rows.every((row) => row.breakdown.length === 0)).toBe(true);
    expect(reportAssignmentCount(report)).toBe(0);
    expect(reportUtilisation(report)).toBe(0);
    expect(report.overloadedDays).toBe(0);
    expect(rows.every((row) => overloadWarning(FULL.name, row) === null)).toBe(true);
  });

  test("no availability and no hours is a dash, never 0%", () => {
    const report = load({
      system: systemWith([leave("cal-full", "2026-10-05", "2026-10-11")]),
      projects: [],
      range: periodWindow("week", "2026-10-07"),
    });
    const rows = rowsOf(report, "week", "2026-10-07");
    expect(rows.every((row) => row.available === 0 && row.allocated === 0 && row.utilisation === null)).toBe(true);
    expect(rows.every((row) => row.overload === false && row.overloadedDays === 0)).toBe(true);
    expect(reportUtilisation(report)).toBeNull();
    expect(utilisationOf(0, 0)).toBeNull();
    expect(utilisationOf(0, 10)).toBe(0);
    expect(utilisationOf(10, 0)).toBeNull();
  });

  test("no availability but hours planned is an explicit overload, not 0%", () => {
    const report = load({
      system: systemWith([leave("cal-full", "2026-10-05", "2026-10-11")]),
      projects: [{ projectId: "proj-a", projectName: "TP-A", tasks: [task({ id: "o1", start: "2026-10-05", duration: 5, work: 40 })] }],
      range: periodWindow("week", "2026-10-07"),
    });
    // What month view shows for this week: the same days, summed as one row.
    const [weekRow] = aggregateSpans(report, [{ key: "2026-10-05", label: "Week 41 · 5 – 11 Oct 2026", start: "2026-10-05", end: "2026-10-11" }]);
    expect([weekRow.available, weekRow.allocated, weekRow.utilisation, weekRow.overload]).toEqual([0, 40, null, true]);
    expect(report.totalAvailable).toBe(0);
    expect(report.totalAllocated).toBe(40);
    expect(reportUtilisation(report)).toBeNull();
    expect(report.overloadedDays).toBe(5);
    const warning = overloadWarning("Full time", weekRow) ?? "";
    expect(warning).toContain("40 h allocated");
    expect(warning).toContain("only 0 h available");
    expect(warning).not.toContain("0%");
    // the hours are reported rather than dropped (BES-008)
    expect(report.unavailableTasks.map((entry) => entry.taskId)).toEqual(["o1"]);
  });

  test("a window outside the plan reports availability and no load, never invented hours", () => {
    const report = load({
      projects: [{ projectId: "proj-a", projectName: "TP-A", tasks: [task({ id: "far", start: "2026-10-05", duration: 5, work: 40 })] }],
      range: periodWindow("month", "2030-01-15"),
    });
    const rows = rowsOf(report, "month", "2030-01-15");
    expect(rows.every((row) => row.allocated === 0)).toBe(true);
    expect(rows.every((row) => row.breakdown.length === 0)).toBe(true);
    expect(rows.every((row) => row.days.length > 0)).toBe(true);
    expect(report.totalAllocated).toBe(0);
    expect(report.overloadedDays).toBe(0);
    // that month has real availability, but none of the plan's hours land in it
    expect(report.totalAvailable).toBeGreaterThan(0);
    expect(report.days.some((entry) => entry.allocated > 0)).toBe(false);
  });
});

/* ------------------------------------ 10. every total agrees with every other */

describe("case 10 — rows, week rows and the summary agree", () => {
  const October = periodWindow("month", "2026-10-15");
  const report = load({
    projects: [
      { projectId: "proj-a", projectName: "TP-A", tasks: [task({ id: "a1", start: "2026-10-26", duration: 7, work: 40 })] },
      { projectId: "proj-b", projectName: "TP-B", tasks: [task({ id: "b1", start: "2026-10-05", duration: 5, work: 20 })] },
    ],
    range: October,
  });

  test("the rows add up to the report's own figures", () => {
    const rows = rowsOf(report, "month", "2026-10-15");
    expect(close(sum(rows.map((row) => row.available)), report.totalAvailable)).toBe(true);
    expect(close(sum(rows.map((row) => row.allocated)), report.totalAllocated)).toBe(true);
    expect(sum(rows.map((row) => row.overloadedDays))).toBe(report.overloadedDays);
    expect(close(sum(rows.map((row) => row.remaining)), report.totalAvailable - report.totalAllocated)).toBe(true);
    expect(report.days.length).toBe(31);
  });

  test("a clipped week row equals the sum of the days it claims to cover", () => {
    for (const row of rowsOf(report, "month", "2026-10-15")) {
      const days = report.days.filter((entry) => entry.date >= row.start && entry.date <= row.end);
      expect(close(row.allocated, sum(days.map((entry) => entry.allocated)))).toBe(true);
      expect(close(row.available, sum(days.map((entry) => entry.available)))).toBe(true);
      expect(row.days.map((entry) => entry.date)).toEqual(days.map((entry) => entry.date));
    }
  });

  test("the same days split daily agree to the hour", () => {
    for (const row of rowsOf(report, "month", "2026-10-15")) {
      for (const entry of row.days) {
        const daily = day(report, "week", entry.date, entry.date);
        expect(close(daily.available, entry.available)).toBe(true);
        expect(close(daily.allocated, entry.allocated)).toBe(true);
      }
    }
  });

  test("summary utilisation is allocated ÷ available, never an average of the rows", () => {
    const rows = rowsOf(report, "month", "2026-10-15");
    const summary = reportUtilisation(report)!;
    expect(close(summary, report.totalAllocated / report.totalAvailable)).toBe(true);
    const rowAverage = sum(rows.map((row) => row.utilisation ?? 0)) / rows.length;
    expect(close(summary, rowAverage)).toBe(false);
    // and the day rows would give a wrong answer too, which is why they are not used
    const dayAverage = sum(report.days.map((entry) => (entry.available > 0 ? entry.allocated / entry.available : 0))) / report.days.length;
    expect(close(summary, dayAverage)).toBe(false);
  });

  test("a weekly row can be lighter than one of the days it holds", () => {
    // Two tasks that both land on Monday: the week itself is at 60%, the Monday
    // inside it is over capacity.
    const spiky = load({
      projects: [
        { projectId: "proj-a", projectName: "TP-A", tasks: [task({ id: "s1", start: "2026-10-05", duration: 1, work: 8 })] },
        { projectId: "proj-b", projectName: "TP-B", tasks: [task({ id: "s2", start: "2026-10-05", duration: 1, work: 16 })] },
      ],
      range: periodWindow("month", "2026-10-07"),
    });
    const rows = rowsOf(spiky, "month", "2026-10-07");
    const weekRow = rows.find((row) => row.start === "2026-10-05")!;
    expect([weekRow.available, weekRow.allocated, weekRow.overload, weekRow.overloadedDays]).toEqual([40, 24, false, 1]);
    expect(close(weekRow.utilisation ?? 0, 0.6)).toBe(true);
    expect(overloadWarning("Full time", weekRow)).toContain("1 day inside");
    const monday = weekRow.days.find((entry) => entry.date === "2026-10-05")!;
    expect([monday.available, monday.allocated, isOverloaded(monday.allocated, monday.available)]).toEqual([8, 24, true]);
    expect(dayOverloadWarning("Full time", monday)).toContain("Mon 5 Oct 2026");
    expect(dayLabel("2026-10-05")).toBe("Mon 5 Oct 2026");
  });
});

/*
 * The Assignments list at the bottom of the screen: the tasks that overlap the
 * shown period, each with the hours that fall inside it (which add up to the
 * Allocated total above) and its whole-task hours. The overlap rule is the
 * screen's, inclusive on both ends, applied on top of the resource, project and
 * client filters — the project/client filter is enforced by the projects the
 * engine is handed, so it cannot leak into these figures.
 */
describe("the Assignments list follows the selected period", () => {
  const TASKS: PlannerTask[] = [
    // Entirely December: never part of October or November.
    { ...task({ id: "dec", start: "2026-12-07", duration: 5, work: 40 }), finish: "2026-12-11" },
    // September into October: its 8 working days end on 7 October.
    { ...task({ id: "sept", start: "2026-09-28", duration: 8, work: 32 }), finish: "2026-10-07" },
    // October into November: 5 October days and 2 November days.
    { ...task({ id: "straddle", start: "2026-10-26", duration: 7, work: 40 }), finish: "2026-11-03" },
    // October work whose displayed finish is inside November (a margin tail).
    { ...task({ id: "tail", start: "2026-10-26", duration: 5, work: 40 }), finish: "2026-11-02" },
  ];

  const OCTOBER = periodWindow("month", "2026-10-15");
  const NOVEMBER = periodWindow("month", "2026-11-15");
  const LOADED = ["dec", "sept", "straddle", "tail"];

  const reportFor = (range: { start: string; end: string }) => load({
    projects: [{ projectId: "proj-a", projectName: "P25031", tasks: TASKS }],
    range,
  });

  /** The engine's own day-by-day hours for one task in one range. */
  const allocatedDays = (taskId: string, range: { start: string; end: string }) =>
    reportFor(range).days.map((entry) => sum(entry.contributions.filter((contribution) => contribution.taskId === taskId).map((contribution) => contribution.hours)));

  // Exactly what the screen renders: the tasks overlapping the period, in the
  // engine's own order, with their two figures.
  const listed = (report: ResourceCapacityReport, range: { start: string; end: string }) =>
    TASKS.filter((item) => overlapsRange(item.start, item.finish, range))
      .map((item) => ({ taskId: item.id, work: report.assignedWork.find((entry) => entry.taskId === item.id)! }));

  test("the overlap rule is inclusive on both ends", () => {
    expect(overlapsRange("2026-10-31", "2026-10-31", OCTOBER)).toBe(true);
    expect(overlapsRange("2026-10-01", "2026-10-01", OCTOBER)).toBe(true);
    expect(overlapsRange("2026-09-30", "2026-09-30", OCTOBER)).toBe(false);
    expect(overlapsRange("2026-11-01", "2026-11-01", OCTOBER)).toBe(false);
    expect(overlapsRange("2026-09-28", "2026-12-11", OCTOBER)).toBe(true);
    expect(overlapsRange("", "", OCTOBER)).toBe(false);
    expect(overlapsRange("2026-10-05", "", OCTOBER)).toBe(true);
  });

  test("October never shows a task that only starts in December", () => {
    const report = reportFor(OCTOBER);
    const ids = listed(report, OCTOBER).map((entry) => entry.taskId);
    expect(ids).toEqual(["sept", "straddle", "tail"]);
    expect(ids).not.toContain("dec");
    expect(report.assignedWork.find((entry) => entry.taskId === "dec")!.inPeriod).toBe(0);
  });

  test("a task running from September into October still appears in October", () => {
    const report = reportFor(OCTOBER);
    const september = listed(report, OCTOBER).find((entry) => entry.taskId === "sept")!;
    // 32 h over 8 working days is 4 h a day: three September days, five in October.
    expect(september.work.total).toBe(32);
    expect(september.work.inPeriod).toBe(20);
    expect(reportFor(NOVEMBER).assignedWork.find((entry) => entry.taskId === "sept")!.inPeriod).toBe(0);
    expect(overlapsRange("2026-09-28", "2026-10-07", NOVEMBER)).toBe(false);
  });

  test("a task running from October into November appears in both, with that month's hours", () => {
    const october = reportFor(OCTOBER).assignedWork.find((entry) => entry.taskId === "straddle")!;
    const november = reportFor(NOVEMBER).assignedWork.find((entry) => entry.taskId === "straddle")!;
    expect(november.total).toBe(40);
    // The existing quarter-hour split of 40 h over 7 working days: 5 October
    // weekdays, then Monday 2 and Tuesday 3 November.
    expect(close(october.inPeriod, 28.75)).toBe(true);
    expect(close(november.inPeriod, 11.25)).toBe(true);
    expect(close(october.inPeriod + november.inPeriod, october.total)).toBe(true);
    expect(overlapsRange("2026-10-26", "2026-11-03", NOVEMBER)).toBe(true);
    // and neither month counts a day of the other: November is exactly the two
    // November days, October exactly the five October ones
    const novemberReport = reportFor(NOVEMBER);
    expect(close(october.inPeriod, sum(allocatedDays("straddle", OCTOBER)))).toBe(true);
    expect(close(november.inPeriod, sum(allocatedDays("straddle", NOVEMBER)))).toBe(true);
    const august = reportFor(periodWindow("month", "2026-08-15")).assignedWork.find((entry) => entry.taskId === "straddle")!;
    expect(august.inPeriod).toBe(0);
    expect(overlapsRange("2026-10-26", "2026-11-03", periodWindow("month", "2026-08-15"))).toBe(false);
    expect(close(novemberReport.totalAllocated, november.inPeriod)).toBe(true);
  });

  test("the week view applies the same overlap rule to the selected week", () => {
    const week = periodWindow("week", "2026-10-28");
    const report = reportFor(week);
    expect([week.start, week.end]).toEqual(["2026-10-26", "2026-11-01"]);
    expect(listed(report, week).map((entry) => entry.taskId)).toEqual(["straddle", "tail"]);
    // A week earlier in October holds the September task and neither October one.
    const earlier = periodWindow("week", "2026-10-07");
    expect(listed(reportFor(earlier), earlier).map((entry) => entry.taskId)).toEqual(["sept"]);
    // The last day of a week is inside it; the first day after it is not.
    expect(overlapsRange("2026-11-01", "2026-11-01", week)).toBe(true);
    expect(overlapsRange("2026-11-02", "2026-11-02", week)).toBe(false);
  });

  test("an overlapping task with no hours in the period stays visible at 0 h", () => {
    const report = reportFor(NOVEMBER);
    const ids = listed(report, NOVEMBER).map((entry) => entry.taskId);
    expect(ids).toEqual(["straddle", "tail"]);
    // Its whole task is October work that already finished on 30 October, but its
    // displayed finish reaches into November, so it is listed — at zero.
    const tail = listed(report, NOVEMBER).find((entry) => entry.taskId === "tail")!;
    expect(tail.work.inPeriod).toBe(0);
    expect(tail.work.total).toBe(40);
    // and the same task is at full weight in its own month
    expect(listed(reportFor(OCTOBER), OCTOBER).find((entry) => entry.taskId === "tail")!.work.inPeriod).toBe(40);
  });

  test("the listed hours add up to the Allocated total in the capacity table", () => {
    const windows = [
      { view: "month", date: "2026-10-15" },
      { view: "month", date: "2026-11-15" },
      { view: "week", date: "2026-10-28" },
      { view: "week", date: "2026-10-07" },
    ] as const;
    for (const { view, date } of windows) {
      const range = periodWindow(view, date);
      const report = reportFor(range);
      const entries = listed(report, range);
      // every task that has hours inside the period is necessarily listed
      for (const work of report.assignedWork) {
        if (work.inPeriod > 0) expect(entries.some((entry) => entry.taskId === work.taskId)).toBe(true);
      }
      // the Assignments hours are the Allocated total…
      expect(close(sum(entries.map((entry) => entry.work.inPeriod)), report.totalAllocated)).toBe(true);
      // …and the capacity table above adds its own rows up to that same figure
      expect(close(sum(rowsOf(report, view, date).map((row) => row.allocated)), report.totalAllocated)).toBe(true);
      expect(close(sum(report.days.map((entry) => entry.allocated)), report.totalAllocated)).toBe(true);
    }
    expect(LOADED.length).toBe(4);
  });
});
