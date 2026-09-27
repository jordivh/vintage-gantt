import { describe, expect, test } from "bun:test";
import type { CalendarException, CalendarSystem } from "./scheduling-engine";
import { createDefaultCalendarSystem, addWorkingDays } from "./scheduling-engine";
import {
  applyPlanningModeMargins,
  orderTasksForDisplay,
  planFinishDate,
  recalculateTasks,
  settleMonitoringPlan,
  withCalculatedPlanningFields,
  type PlannerTask,
} from "./planner-model";
import { becameCriticalHeadline, buildMarginReport, leafMarginTotals, marginRowsFor, sortMarginRows } from "./margin-report";

/* ------------------------------------------------------------------ fixture */

const exception = (overrides: Partial<CalendarException> = {}): CalendarException => ({
  id: "exception",
  calendarId: "base",
  startDate: "2026-09-28",
  endDate: "2026-09-28",
  label: "Site shutdown",
  type: "shutdown",
  isWorkingDay: false,
  source: "manual",
  ...overrides,
});

const systemWith = (exceptions: CalendarException[]): CalendarSystem => {
  const base = createDefaultCalendarSystem();
  return { ...base, calendars: base.calendars.filter((calendar) => calendar.type === "base"), exceptions };
};

/**
 * The TP-R2 test project: two summaries (1 and 2), three leaf tasks that carry a
 * reserve (1.1 = 20 %, 2.1 = 10 %, 2.2 = 50 %), one leaf without margin, and a
 * milestone. Weekends off, no holidays.
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
const tpR2 = (documentatieDays = 4, documentatieMarginPct = 50): PlannerTask[] => [
  { id: "t1", parentId: null, name: "Voorbereiding", duration: 7, durationUnit: "days", start: "2026-09-25", finish: "2026-10-05", isMilestone: false, predecessors: "", resource: "", percent: 0, notes: "", color: "sage", marginPct: 0 },
  { id: "t2", parentId: "t1", name: "Concept opstellen", duration: 5, durationUnit: "days", start: "2026-09-25", finish: "2026-10-01", isMilestone: false, predecessors: "", resource: "", percent: 0, notes: "", color: "sage", marginPct: 20 },
  { id: "t3", parentId: "t1", name: "Concept nakijken", duration: 2, durationUnit: "days", start: "2026-10-02", finish: "2026-10-05", isMilestone: false, predecessors: "t2FS", resource: "", percent: 0, notes: "", color: "sage", marginPct: 0 },
  { id: "t4", parentId: null, name: "Uitvoering", duration: 13, durationUnit: "days", start: "2026-10-06", finish: "2026-10-22", isMilestone: false, predecessors: "", resource: "", percent: 0, notes: "", color: "sage", marginPct: 0 },
  { id: "t5", parentId: "t4", name: "Bouwen", duration: 10, durationUnit: "days", start: "2026-10-15", finish: "2026-10-28", isMilestone: false, predecessors: "t3FS", resource: "", percent: 0, notes: "", color: "sage", marginPct: 10 },
  { id: "t6", parentId: "t4", name: "Documentatie", duration: documentatieDays, durationUnit: "days", start: "2026-10-07", finish: "2026-10-23", isMilestone: false, predecessors: "t3FS", resource: "", percent: 0, notes: "", color: "sage", marginPct: documentatieMarginPct },
  { id: "t7", parentId: "t4", name: "Testen", duration: 3, durationUnit: "days", start: "2026-10-29", finish: "2026-11-02", isMilestone: false, predecessors: "t5FS", resource: "", percent: 0, notes: "", color: "sage", marginPct: 0 },
  { id: "t8", parentId: null, name: "Oplevering", duration: 0, durationUnit: "days", start: "2026-11-03", finish: "2026-11-03", isMilestone: true, predecessors: "t7FS", resource: "", percent: 0, notes: "", color: "sage", marginPct: 0 },
];

/* ------------------------------------------------------------------ helpers */

describe("margin report — totals, rows and the critical-path link", () => {
  const system = systemWith([]);
  const byId = (tasks: PlannerTask[]) => new Map(tasks.map((task) => [task.id, task]));
  const seed = (documentatieDays = 4, marginPct = 50): PlannerTask[] => {
    const scheduled = recalculateTasks(withCalculatedPlanningFields(tpR2(documentatieDays, marginPct), system, "base"), {
      direction: "forward",
      calendarSystem: system,
      projectCalendarId: "base",
    });
    return withCalculatedPlanningFields(scheduled.tasks, system, "base");
  };
  /** Mirrors a Monitoring commit: absorb each finish move into its own reserve. */
  const commit = (previous: PlannerTask[], next: PlannerTask[]): PlannerTask[] => {
    const settled = settleMonitoringPlan(previous, next, { calendarSystem: system, projectCalendarId: "base" });
    const scheduled = recalculateTasks(settled.tasks, { direction: "forward", calendarSystem: system, projectCalendarId: "base" });
    return withCalculatedPlanningFields(scheduled.tasks, system, "base");
  };
  const moveStart = (tasks: PlannerTask[], id: string, days: number): PlannerTask[] =>
    tasks.map((task) => {
      if (task.id !== id) return task;
      const start = addWorkingDays(task.start, days, "base", system);
      return { ...task, start, finish: addWorkingDays(start, task.duration - 1, "base", system) };
    });
  const extend = (tasks: PlannerTask[], id: string, days: number): PlannerTask[] =>
    tasks.map((task) => {
      if (task.id !== id) return task;
      const duration = task.duration + days;
      return { ...task, duration, finish: addWorkingDays(task.start, duration - 1, "base", system) };
    });
  const reportFor = (tasks: PlannerTask[], baselineFloats?: Map<string, number>) =>
    buildMarginReport({
      tasks,
      system,
      projectCalendarId: "base",
      projectId: "p",
      versionId: "v",
      versionName: "Version 7",
      mode: "monitoring",
      baseline: baselineFloats
        ? { id: "b", name: "Baseline 1", captureDate: "2026-09-25", floats: [...baselineFloats].map(([taskId, totalFloat]) => ({ taskId, totalFloat })) }
        : null,
    });
  /** 1.1 (t2) and 2.1 (t5) each grow by a day, which their reserve absorbs. */
  const spent = (): PlannerTask[] => {
    const start = seed();
    const first = commit(start, extend(start, "t2", 1));
    return commit(first, extend(first, "t5", 1));
  };

  test("TC-42: totals are the sum of the leaf rows and never count a summary", () => {
    const report = reportFor(spent());
    // Leaf reserves: 1.1 = 1 d, 2.1 = 1 d, 2.2 = 2 d. Summaries 1 and 2 would add
    // the same 1 d + 3 d again, which is exactly the double count to avoid.
    expect(report.totals.planned).toBe(4);
    expect(report.totals.consumed).toBe(2);
    expect(report.totals.remaining).toBe(2);
    expect(report.totals.consumedPct).toBe(50);
    expect(report.rows.reduce((sum, row) => sum + row.planned, 0)).toBe(report.totals.planned);
    expect(report.rows.reduce((sum, row) => sum + row.consumed, 0)).toBe(report.totals.consumed);
    expect(report.rows.reduce((sum, row) => sum + row.remaining, 0)).toBe(report.totals.remaining);
    expect(report.rows.map((row) => row.id)).toEqual(["t2", "t5", "t6", "t3", "t7", "t8"]);
    expect(report.rows.some((row) => row.id === "t1" || row.id === "t4")).toBe(false);
    // The planner shows the same project-level figures.
    expect(leafMarginTotals(marginRowsFor(spent()))).toEqual(report.totals);
  });

  test("TC-43: 1.1 and 2.1 lead the list with their consumption; margin-less tasks close it", () => {
    const report = reportFor(spent());
    const [first, second, third] = report.rows;
    expect([first.id, second.id, third.id]).toEqual(["t2", "t5", "t6"]);
    expect([first.name, second.name]).toEqual(["Concept opstellen", "Bouwen"]);
    expect([first.planned, first.consumed, first.remaining, first.consumedPct]).toEqual([1, 1, 0, 100]);
    expect([second.planned, second.consumed, second.remaining, second.consumedPct]).toEqual([1, 1, 0, 100]);
    expect([third.planned, third.consumed, third.consumedPct, third.hasMargin]).toEqual([2, 0, 0, true]);
    expect(report.rows.filter((row) => !row.hasMargin).map((row) => row.id)).toEqual(["t3", "t7", "t8"]);
    expect(report.rows.slice(0, 3).every((row) => row.hasMargin)).toBe(true);
    // A milestone has no reserve, so its share is unknown rather than 0 %.
    expect(report.rows.find((row) => row.id === "t8")!.consumedPct).toBeNull();
  });

  test("TC-43: display ids match the planner grid's numbering", () => {
    const tasks = seed();
    const ids = new Map(orderTasksForDisplay(tasks).map((task, index) => [task.id, index + 1]));
    const report = reportFor(tasks);
    // 1..8 count every displayed row, summaries included, exactly like the grid.
    expect(ids.get("t2")).toBe(2);
    expect(ids.get("t8")).toBe(8);
    report.rows.forEach((row) => expect(row.displayId).toBe(ids.get(row.id)!));
    expect(report.rows.map((row) => row.id).sort()).toEqual(["t2", "t3", "t5", "t6", "t7", "t8"]);
  });

  test("TC-44: 2.2 growing past the 2.1 path is flagged as newly critical", () => {
    const before = seed(4);
    const floats = new Map(before.map((task) => [task.id, task.totalFloat ?? 0]));
    expect(floats.get("t6")).toBeGreaterThan(0);
    expect(floats.get("t2")).toBe(0);
    const extended = seed(14);
    expect(byId(extended).get("t6")!.isCritical).toBe(true);
    const report = reportFor(extended, floats);
    const t6 = report.rows.find((row) => row.id === "t6")!;
    expect(t6.isCritical).toBe(true);
    expect(t6.baselineFloat).toBe(floats.get("t6")!);
    expect(t6.becameCritical).toBe(true);
    expect(report.becameCriticalCount).toBe(1);
    expect(report.criticalCount).toBeGreaterThan(1);
    // A task that was already critical at capture time did not *become* critical.
    expect(report.rows.find((row) => row.id === "t2")!.becameCritical).toBe(false);
    expect(report.rows.find((row) => row.id === "t2")!.baselineFloat).toBe(0);
    expect(becameCriticalHeadline(report.becameCriticalCount)).toBe("1 task became critical through margin consumption.");
    expect(becameCriticalHeadline(2)).toBe("2 tasks became critical through margin consumption.");
    expect(becameCriticalHeadline(0)).toBe("No task became critical through margin consumption.");
    // Without a baseline nothing is claimed, and the headline says so.
    const noBaseline = reportFor(extended);
    expect(noBaseline.becameCriticalCount).toBe(0);
    expect(noBaseline.rows.every((row) => row.baselineFloat === null)).toBe(true);
  });

  test("TC-44: exhausting a reserve passes the rest of the move on to the successors", () => {
    const before = seed(4);
    const floats = new Map(before.map((task) => [task.id, task.totalFloat ?? 0]));
    // 1.1 (t2) grows by two days: its 1 d reserve absorbs the first, and the second
    // day lands on 1.2 and everything behind it.
    const once = commit(before, extend(before, "t2", 1));
    const twice = commit(once, extend(once, "t2", 1));
    const report = reportFor(twice, floats);
    expect(byId(twice).get("t2")!.marginDaysConsumed).toBe(1); // never more than the original
    expect(byId(twice).get("t2")!.finish).toBe(addWorkingDays(byId(once).get("t2")!.finish, 1, "base", system));
    expect(byId(twice).get("t3")!.start).toBe(addWorkingDays(byId(once).get("t3")!.start, 1, "base", system));
    expect(planFinishDate(twice)).toBe(addWorkingDays(planFinishDate(once), 1, "base", system));
    const row = report.rows.find((item) => item.id === "t2")!;
    expect([row.consumed, row.remaining, row.consumedPct]).toEqual([1, 0, 100]);
    expect(report.totals.consumed).toBe(1);
    expect(report.totals.remaining).toBe(report.totals.planned - 1);
    // 1.1 was already critical when the baseline was captured, so it did not
    // "become" critical — it simply stayed on the critical path.
    expect(row.becameCritical).toBe(false);
  });

  test("rows with no reserve, no duration or no margin fields never break the report", () => {
    const stale = tpR2(4).map((task) => {
      if (task.id === "t1") return { ...task, marginPct: 50, marginDaysOriginal: 9, marginDaysConsumed: 4 };
      if (task.id === "t8") return { ...task, marginPct: 40, marginDaysOriginal: 3, marginDaysConsumed: 2 };
      if (task.id === "t6") return { ...task, marginDaysOriginal: Number.NaN, marginDaysConsumed: -5 };
      return task;
    });
    const report = reportFor(stale);
    // The milestone has no work, so its reserve is 0 d and its share is a dash.
    const milestone = report.rows.find((row) => row.id === "t8")!;
    expect([milestone.planned, milestone.consumed, milestone.consumedPct, milestone.hasMargin]).toEqual([0, 0, null, false]);
    // A non-finite reserve reads as 0 d instead of NaN.
    const broken = report.rows.find((row) => row.id === "t6")!;
    expect(broken.planned).toBe(0);
    expect(broken.consumedPct).toBeNull();
    // The summary's stale 9 d / 4 d bookkeeping stays out of the totals.
    expect(report.rows.some((row) => row.id === "t1")).toBe(false);
    expect(report.totals.planned).toBe(2);
    report.rows.forEach((row) => {
      expect(Number.isFinite(row.planned)).toBe(true);
      expect(Number.isFinite(row.consumed)).toBe(true);
      expect(Number.isFinite(row.remaining)).toBe(true);
      expect(Number.isFinite(row.totalFloat)).toBe(true);
      expect(row.consumedPct === null || Number.isFinite(row.consumedPct)).toBe(true);
      expect(row.consumed <= row.planned).toBe(true);
    });
  });

  test("an empty, undated or unfinished plan yields an empty report instead of throwing", () => {
    const empty = reportFor([]);
    expect(empty.rows).toEqual([]);
    expect(empty.totals).toEqual({ planned: 0, consumed: 0, remaining: 0, consumedPct: null });
    expect(empty.criticalCount).toBe(0);
    expect(empty.becameCriticalCount).toBe(0);
    expect(becameCriticalHeadline(empty.becameCriticalCount)).toBe("No task became critical through margin consumption.");
    const undated = reportFor([{ ...tpR2()[0], start: "", finish: "" }]);
    expect(undated.totals.planned).toBe(0);
    expect(undated.totals.consumedPct).toBeNull();
    // A predecessor token that resolves to nothing is ignored, not fatal.
    const dangling = reportFor([{ ...tpR2()[1], predecessors: "9.9FS" }]);
    expect(dangling.rows.length).toBe(1);
    expect(dangling.rows[0].planned).toBe(1);
    // Zero-duration work keeps its dates but never carries a reserve.
    const zeroDuration = reportFor([{ ...tpR2()[1], duration: 0, isMilestone: false }]);
    expect(zeroDuration.rows[0].planned).toBe(0);
    expect(zeroDuration.totals.planned).toBe(0);
  });

  test("the report belongs to one project version and one mode", () => {
    const planning = buildMarginReport({
      tasks: applyPlanningModeMargins(tpR2(4)),
      system,
      projectCalendarId: "base",
      projectId: "proj-1",
      versionId: "version-1",
      versionName: "Version 1",
      mode: "planning",
    });
    expect(planning.projectId).toBe("proj-1");
    expect(planning.versionId).toBe("version-1");
    expect(planning.versionName).toBe("Version 1");
    expect(planning.mode).toBe("planning");
    // Planning never consumes, so the report is only meaningful in Monitoring.
    expect(planning.totals.consumed).toBe(0);
    expect(planning.totals.planned).toBe(4);
  });

  test("sorting is stable: consumption first, then the biggest reserve, then display order", () => {
    // Untouched plan: nothing consumed, so the larger reserve (2.2) leads and the
    // tasks without margin close the list in display order.
    const rows = marginRowsFor(seed());
    expect(sortMarginRows(rows).map((row) => row.id)).toEqual(["t6", "t2", "t5", "t3", "t7", "t8"]);
    expect(sortMarginRows([...rows].reverse()).map((row) => row.id)).toEqual(["t6", "t2", "t5", "t3", "t7", "t8"]);
    // With consumption the order flips to the spent reserve first.
    expect(sortMarginRows(marginRowsFor(spent())).map((row) => row.id)).toEqual(["t2", "t5", "t6", "t3", "t7", "t8"]);
  });

  test("a consumed reserve is never reported as more than what was planned", () => {
    const over = tpR2(4).map((task) => task.id === "t6" ? { ...task, marginDaysConsumed: 99 } : task);
    const report = reportFor(over);
    const row = report.rows.find((item) => item.id === "t6")!;
    expect(row.planned).toBe(2);
    expect(row.consumed).toBe(2);
    expect(row.remaining).toBe(0);
    expect(row.consumedPct).toBe(100);
  });

  test("a shutdown that pushes a finish spends reserve and shows up in the totals", () => {
    const shifted = systemWith([exception({ calendarId: "base", startDate: "2026-09-29", endDate: "2026-09-29" })]);
    const before = seed();
    // The calendar loses a working day inside 1.1, so 1.1 finishes a day later. A
    // calendar change moves every task, so every task answers for its own move.
    const moved = recalculateTasks(before, { direction: "forward", calendarSystem: shifted, projectCalendarId: "base" });
    const settled = settleMonitoringPlan(before, moved.tasks, {
      calendarSystem: shifted,
      projectCalendarId: "base",
      changedTaskIds: new Set(before.map((task) => task.id)),
    });
    const rescheduled = recalculateTasks(settled.tasks, { direction: "forward", calendarSystem: shifted, projectCalendarId: "base" });
    const tasks = withCalculatedPlanningFields(rescheduled.tasks, shifted, "base");
    const report = buildMarginReport({
      tasks,
      system: shifted,
      projectCalendarId: "base",
      projectId: "p",
      versionId: "v",
      mode: "monitoring",
    });
    expect(byId(tasks).get("t2")!.marginDaysConsumed).toBe(1);
    expect(report.totals.consumed).toBe(1);
    expect(report.rows.find((row) => row.id === "t2")!.consumedPct).toBe(100);
  });
});
