import { describe, expect, test } from "bun:test";
import { createDefaultCalendarSystem } from "./scheduling-engine";
import { leafMarginTotals, marginRowsFor } from "./margin-report";
import { withCalculatedPlanningFields, type PlannerTask } from "./planner-model";
import {
  buildMarginConsumption,
  marginConsumptionBand,
  MARGIN_CONSUMPTION_DASH,
} from "./margin-consumption";

/* ------------------------------------------------------------------ fixture */

const system = createDefaultCalendarSystem();

const task = (overrides: Partial<PlannerTask> = {}): PlannerTask => ({
  id: "t1",
  parentId: null,
  name: "Taak",
  duration: 10,
  durationUnit: "days",
  start: "2026-09-28",
  finish: "2026-10-09",
  isMilestone: false,
  predecessors: "",
  resource: "",
  percent: 0,
  notes: "",
  color: "sage",
  marginPct: 0,
  ...overrides,
});

/** The planner's own expression, so the column can be compared against it. */
const plannerTotals = (tasks: PlannerTask[]) =>
  leafMarginTotals(marginRowsFor(withCalculatedPlanningFields([...tasks], system)));

const build = (tasks: PlannerTask[], hasBaseline = true) =>
  buildMarginConsumption({ tasks, system, hasBaseline });

/* --------------------------------------------------------------------- bands */

describe("marginConsumptionBand", () => {
  test("is neutral below 75%", () => {
    expect(marginConsumptionBand(0)).toBe("neutral");
    expect(marginConsumptionBand(74)).toBe("neutral");
  });

  test("is orange from 75% up to and including 100%", () => {
    expect(marginConsumptionBand(75)).toBe("warning");
    expect(marginConsumptionBand(99)).toBe("warning");
    expect(marginConsumptionBand(100)).toBe("warning");
  });

  test("is red once the reserve is exceeded", () => {
    expect(marginConsumptionBand(101)).toBe("exceeded");
    expect(marginConsumptionBand(250)).toBe("exceeded");
  });

  test("has no band without a percentage", () => {
    expect(marginConsumptionBand(null)).toBe("none");
    expect(marginConsumptionBand(undefined)).toBe("none");
    expect(marginConsumptionBand(Number.NaN)).toBe("none");
  });
});

/* ----------------------------------------------------------------- dash cases */

describe("buildMarginConsumption — nothing to report", () => {
  test("shows a dash, never 0%, when no margin is defined", () => {
    const result = build([task({ marginPct: 0, marginDaysOriginal: 0, marginDaysConsumed: 0 })]);
    expect(result.label).toBe(MARGIN_CONSUMPTION_DASH);
    expect(result.reported).toBe(false);
    expect(result.band).toBe("none");
    expect(result.consumedPct).toBeNull();
    expect(result.tooltip).toContain("Geen marge");
  });

  test("shows a dash when the reserve only exists on a milestone", () => {
    const result = build([task({ isMilestone: true, duration: 0, marginPct: 20, marginDaysOriginal: 5 })]);
    expect(result.label).toBe(MARGIN_CONSUMPTION_DASH);
    expect(result.reported).toBe(false);
  });

  test("shows a dash while the version has no baseline", () => {
    const result = build([task({ marginPct: 20, marginDaysOriginal: 20, marginDaysConsumed: 7 })], false);
    expect(result.label).toBe(MARGIN_CONSUMPTION_DASH);
    expect(result.reported).toBe(false);
    expect(result.band).toBe("none");
    expect(result.tooltip).toContain("baseline");
    // the figures are still carried, but they are not reported as a value
    expect(result.planned).toBe(20);
  });

  test("survives an empty plan", () => {
    const result = build([], true);
    expect(result.label).toBe(MARGIN_CONSUMPTION_DASH);
    expect(result.planned).toBe(0);
    expect(result.reported).toBe(false);
  });
});

/* ---------------------------------------------------------------- reporting */

describe("buildMarginConsumption — reported value", () => {
  test("formats the consumed margin as a percentage plus the figures", () => {
    const result = build([task({ marginPct: 20, marginDaysOriginal: 20, marginDaysConsumed: 7 })]);
    expect(result.label).toBe("35% (7 van 20 dagen)");
    expect(result.consumedPct).toBe(35);
    expect(result.planned).toBe(20);
    expect(result.consumed).toBe(7);
    expect(result.remaining).toBe(13);
    expect(result.band).toBe("neutral");
    expect(result.reported).toBe(true);
  });

  test("names totale, verbruikte and resterende marge in the tooltip", () => {
    const result = build([task({ marginPct: 20, marginDaysOriginal: 20, marginDaysConsumed: 7 })]);
    expect(result.tooltip).toBe([
      "Totale marge: 20 dagen",
      "Verbruikte marge: 7 dagen (35%)",
      "Resterende marge: 13 dagen",
    ].join("\n"));
  });

  test("turns orange once three quarters of the reserve is spent", () => {
    const result = build([task({ marginPct: 20, marginDaysOriginal: 20, marginDaysConsumed: 15 })]);
    expect(result.label).toBe("75% (15 van 20 dagen)");
    expect(result.band).toBe("warning");
  });

  test("stays orange when the whole reserve is spent", () => {
    const result = build([task({ marginPct: 20, marginDaysOriginal: 20, marginDaysConsumed: 20 })]);
    expect(result.label).toBe("100% (20 van 20 dagen)");
    expect(result.band).toBe("warning");
    expect(result.remaining).toBe(0);
  });

  test("matches the planner's own leaf totals, summarised rows included", () => {
    const tasks = [
      task({ id: "s1", parentId: null, name: "Fase", duration: 15 }),
      task({ id: "t1", parentId: "s1", marginPct: 20, marginDaysOriginal: 20, marginDaysConsumed: 7 }),
      task({ id: "t2", parentId: "s1", marginPct: 50, marginDaysOriginal: 8, marginDaysConsumed: 0 }),
      task({ id: "t3", parentId: null, marginPct: 0 }),
    ];
    const totals = plannerTotals(tasks);
    const result = build(tasks);
    expect([result.planned, result.consumed, result.remaining, result.consumedPct])
      .toEqual([totals.planned, totals.consumed, totals.remaining, totals.consumedPct]);
    expect(result.label).toBe("25% (7 van 28 dagen)");
  });

  test("never reports a percentage above 100 for a capped reserve", () => {
    const result = build([task({ marginPct: 20, marginDaysOriginal: 20, marginDaysConsumed: 999 })]);
    expect(result.consumed).toBe(20);
    expect(result.consumedPct).toBe(100);
    expect(result.band).toBe("warning");
  });
});

/* ------------------------------------------------------------------ safety */

describe("buildMarginConsumption — read only", () => {
  test("leaves the planning data untouched", () => {
    const tasks = [
      task({ id: "s1", parentId: null, name: "Fase", duration: 15 }),
      task({ id: "t1", parentId: "s1", marginPct: 20, marginDaysOriginal: 20, marginDaysConsumed: 7 }),
    ];
    const before = JSON.stringify(tasks);
    build(tasks, true);
    build(tasks, false);
    expect(JSON.stringify(tasks)).toBe(before);
  });

  test("does not crash on a missing system or task list", () => {
    expect(buildMarginConsumption({ tasks: [], system: undefined as never, hasBaseline: true }).label).toBe(MARGIN_CONSUMPTION_DASH);
    expect(buildMarginConsumption({ tasks: undefined as never, system, hasBaseline: true }).label).toBe(MARGIN_CONSUMPTION_DASH);
  });
});
