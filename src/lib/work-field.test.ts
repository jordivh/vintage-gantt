import { describe, expect, test } from "bun:test";
import { createDefaultCalendarSystem } from "./scheduling-engine";
import { normalizeWorkHours, withCalculatedPlanningFields, type PlannerTask } from "./planner-model";

const system = createDefaultCalendarSystem();

/** A leaf row with sensible defaults; override what a test cares about. */
const leaf = (id: string, parentId: string | null, overrides: Partial<PlannerTask> = {}): PlannerTask => ({
  id,
  parentId,
  name: id,
  duration: 1,
  durationUnit: "days",
  start: "2026-01-05",
  finish: "2026-01-05",
  isMilestone: false,
  predecessors: "",
  resource: "",
  percent: 0,
  notes: "",
  color: "sage",
  marginPct: 0,
  ...overrides,
});

describe("work — entry normalization", () => {
  test("accepts whole and half hours, empty means 0", () => {
    expect(normalizeWorkHours("")).toBe(0);
    expect(normalizeWorkHours("   ")).toBe(0);
    expect(normalizeWorkHours("0")).toBe(0);
    expect(normalizeWorkHours("4")).toBe(4);
    expect(normalizeWorkHours("7,5")).toBe(7.5);
    expect(normalizeWorkHours("40.5")).toBe(40.5);
  });

  test("rounds to the nearest half hour", () => {
    expect(normalizeWorkHours("7.2")).toBe(7);
    expect(normalizeWorkHours("7.3")).toBe(7.5);
    expect(normalizeWorkHours("7.26")).toBe(7.5);
  });

  test("clamps negatives and unparsable input to 0", () => {
    expect(normalizeWorkHours("-4")).toBe(0);
    expect(normalizeWorkHours("abc")).toBe(0);
    expect(normalizeWorkHours(Number.NaN)).toBe(0);
  });

  test("tolerates a trailing hour unit", () => {
    expect(normalizeWorkHours("8 h")).toBe(8);
    expect(normalizeWorkHours("8h")).toBe(8);
    expect(normalizeWorkHours("8 hours")).toBe(8);
  });
});

describe("work — roll-up and independence from duration", () => {
  test("a summary shows the sum of its children, nested summaries included", () => {
    const tasks = [
      leaf("s1", null, { duration: 20, work: 999 }),
      leaf("a", "s1", { work: 40 }),
      leaf("b", "s1", { work: 12.5 }),
      leaf("nested", "s1", { work: 500 }),
      leaf("c", "nested", { work: 7.5 }),
    ];
    const byId = new Map(withCalculatedPlanningFields(tasks, system, "base").map((task) => [task.id, task]));
    expect(byId.get("a")?.work).toBe(40);
    expect(byId.get("c")?.work).toBe(7.5);
    expect(byId.get("nested")?.work).toBe(7.5);
    // 40 + 12.5 + 7.5, not the stale values stored on the summaries.
    expect(byId.get("s1")?.work).toBe(60);
  });

  test("milestones have no work", () => {
    const tasks = [
      leaf("s1", null, { work: 0 }),
      leaf("a", "s1", { work: 12 }),
      leaf("m", null, { duration: 0, isMilestone: true, work: 5 }),
    ];
    const byId = new Map(withCalculatedPlanningFields(tasks, system, "base").map((task) => [task.id, task]));
    expect(byId.get("m")?.work).toBe(0);
    expect(byId.get("s1")?.work).toBe(12);
  });

  test("changing work never moves a date, and a long duration with little work is valid", () => {
    const before = [
      leaf("s1", null, { duration: 20, start: "2026-01-05", finish: "2026-01-30" }),
      leaf("a", "s1", { duration: 20, start: "2026-01-05", finish: "2026-01-30", work: 0 }),
    ];
    const calculated = withCalculatedPlanningFields(before, system, "base");
    const after = withCalculatedPlanningFields(
      before.map((task) => (task.id === "a" ? { ...task, work: 40 } : task)),
      system,
      "base",
    );
    const rows = new Map(calculated.map((task) => [task.id, task]));
    const changed = new Map(after.map((task) => [task.id, task]));
    // 20 working days with only 40 h of work is legitimate: dates stay put.
    expect(changed.get("a")?.work).toBe(40);
    expect(changed.get("a")?.start).toBe(rows.get("a")?.start);
    expect(changed.get("a")?.finish).toBe(rows.get("a")?.finish);
    expect(changed.get("a")?.duration).toBe(rows.get("a")?.duration);
  });
});
