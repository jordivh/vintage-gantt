import { describe, expect, test } from "bun:test";
import { createDefaultCalendarSystem, isWorkingDay, type CalendarException, type CalendarSystem } from "./scheduling-engine";
import { dailyAllocation, distributionWeights, normalizeDistribution, type PlannerTask } from "./planner-model";

const exception = (overrides: Partial<CalendarException> = {}): CalendarException => ({
  id: "exception",
  calendarId: "base",
  startDate: "2026-01-07",
  endDate: "2026-01-07",
  label: "Holiday",
  type: "holiday",
  isWorkingDay: false,
  source: "manual",
  ...overrides,
});

const systemWith = (exceptions: CalendarException[]): CalendarSystem => {
  const base = createDefaultCalendarSystem();
  return { ...base, calendars: base.calendars.filter((calendar) => calendar.type === "base"), exceptions };
};

const task = (overrides: Partial<PlannerTask> = {}): PlannerTask => ({
  id: "t1",
  parentId: null,
  name: "Task",
  duration: 5,
  durationUnit: "days",
  start: "2026-01-05", // Monday
  finish: "2026-01-09",
  isMilestone: false,
  predecessors: "",
  resource: "",
  percent: 0,
  notes: "",
  color: "sage",
  marginPct: 0,
  ...overrides,
});

const sum = (rows: { hours: number }[]) => rows.reduce((total, row) => total + row.hours, 0);

describe("distribution — weighting profiles", () => {
  const system = systemWith([]);

  test("even splits the work equally and stays exact", () => {
    const rows = dailyAllocation(task({ work: 40 }), system, "base");
    expect(rows.map((row) => row.date)).toEqual(["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"]);
    expect(rows.every((row) => row.hours === 8)).toBe(true);
    expect(sum(rows)).toBe(40);
  });

  test("front-loaded decreases linearly, first day heaviest", () => {
    const rows = dailyAllocation(task({ work: 40, distribution: "front" }), system, "base");
    expect(rows.map((row) => row.hours)).toEqual([13.25, 10.75, 8, 5.25, 2.75]);
    expect(sum(rows)).toBe(40);
    expect(rows[0].hours).toBeGreaterThan(rows[rows.length - 1].hours);
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index].hours <= rows[index - 1].hours).toBe(true);
    }
  });

  test("back-loaded is the exact mirror of front-loaded", () => {
    const front = dailyAllocation(task({ work: 40, distribution: "front" }), system, "base").map((row) => row.hours);
    const back = dailyAllocation(task({ work: 40, distribution: "back" }), system, "base").map((row) => row.hours);
    expect(back).toEqual([...front].reverse());
    expect(sum(back.map((hours) => ({ hours })))).toBe(40);
  });

  test("center-loaded peaks in the middle and tapers to both ends", () => {
    const rows = dailyAllocation(task({ work: 40, distribution: "center" }), system, "base");
    const hours = rows.map((row) => row.hours);
    expect(sum(rows)).toBe(40);
    const peak = Math.max(...hours);
    expect(hours.indexOf(peak)).toBe(2); // the middle of five working days
    expect(hours[0]).toBeLessThan(peak);
    expect(hours[hours.length - 1]).toBeLessThan(peak);
    expect(hours[0] <= hours[1]).toBe(true);
    expect(hours[hours.length - 1] <= hours[hours.length - 2]).toBe(true);
  });

  test("the default profile is Gelijk (even)", () => {
    expect(normalizeDistribution(undefined)).toBe("even");
    expect(normalizeDistribution("nonsense")).toBe("even");
    expect(normalizeDistribution("front")).toBe("front");
    expect(distributionWeights("even", 0)).toEqual([]);
  });
});

describe("distribution — working days, margin and exactness", () => {
  test("only working days receive hours; non-working days are skipped", () => {
    const system = systemWith([exception()]); // Wed 2026-01-07 is a holiday
    const rows = dailyAllocation(task({ work: 40 }), system, "base");
    expect(rows.length).toBe(5);
    expect(rows.some((row) => row.date === "2026-01-07")).toBe(false);
    for (const row of rows) expect(isWorkingDay(row.date, "base", system)).toBe(true);
    expect(sum(rows)).toBe(40);
  });

  test("the span is the work duration only — margin days are never worked", () => {
    const system = systemWith([]);
    // 3 working days of work, followed by a 5-day margin reserve. The allocation
    // must stop at the work finish (Jan 7), never reaching into the reserve.
    const rows = dailyAllocation(task({ duration: 3, finish: "2026-01-07", work: 12, marginPct: 100, marginDaysOriginal: 5 }), system, "base");
    expect(rows.map((row) => row.date)).toEqual(["2026-01-05", "2026-01-06", "2026-01-07"]);
    expect(sum(rows)).toBe(12);
  });

  test("rounds to a quarter hour and puts the remainder on the last working day", () => {
    const system = systemWith([]);
    const rows = dailyAllocation(task({ duration: 3, finish: "2026-01-07", work: 10 }), system, "base");
    expect(rows.map((row) => row.hours)).toEqual([3.25, 3.25, 3.5]);
    expect(sum(rows)).toBe(10);
    expect(rows.slice(0, -1).every((row) => row.hours * 4 === Math.round(row.hours * 4))).toBe(true);
  });

  test("the total is exact for every profile over an awkward duration", () => {
    const system = systemWith([]);
    for (const distribution of ["even", "front", "back", "center"] as const) {
      for (const days of [1, 2, 3, 4, 7, 20]) {
        const rows = dailyAllocation(task({ duration: days, work: 37.5, distribution }), system, "base");
        expect(rows.length).toBe(days);
        expect(sum(rows)).toBe(37.5);
      }
    }
  });

  test("a long duration with little work is valid and adds up", () => {
    const system = systemWith([]);
    const rows = dailyAllocation(task({ duration: 20, work: 40 }), system, "base");
    expect(rows.length).toBe(20);
    expect(rows.every((row) => row.hours === 2)).toBe(true);
    expect(sum(rows)).toBe(40);
  });

  test("milestones have no allocation at all", () => {
    const system = systemWith([]);
    expect(dailyAllocation(task({ duration: 0, isMilestone: true, work: 5 }), system, "base")).toEqual([]);
  });
});
