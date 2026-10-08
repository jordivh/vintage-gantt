/**
 * Duplicating a task must copy the task and every subtask below it, at all
 * levels, and nothing else. These cases drive the pure copy that the planner
 * uses, and check every rule: the subtree, its order, the parent links, the
 * dependencies inside the group (re-pointed) and outside it (left out), the
 * assignments, and — just as importantly — that the originals do not change and
 * that the copy stays inside the same project and active version.
 */
import { describe, expect, test } from "bun:test";
import {
  applyPlanningModeMargins,
  dependenciesForTasks,
  duplicateTaskAssignments,
  duplicateTaskGroup,
  orderTasksForDisplay,
  recalculateTasks,
  withCalculatedPlanningFields,
  type PlannerTask,
} from "./planner-model";
import type { CalendarSystem } from "./scheduling-engine";

/* ------------------------------------------------------------------ helpers */

const task = (over: Partial<PlannerTask> & { id: string }): PlannerTask => ({
  parentId: null,
  duration: 3,
  durationUnit: "days",
  start: "2026-01-05",
  finish: "2026-01-07",
  isMilestone: false,
  name: over.id,
  predecessors: "",
  resource: "",
  percent: 0,
  notes: "",
  color: "sage",
  versionId: "version-1",
  marginPct: 10,
  marginDaysOriginal: 1,
  marginDaysConsumed: 0,
  ...over,
});

/** A fresh-id generator that never collides with the source ids in a case. */
const copyIds = () => {
  let n = 0;
  return () => `copy-${++n}`;
};

/** Everything the original tasks looked like, so "unchanged" can be checked. */
const snapshot = (tasks: PlannerTask[]) => JSON.parse(JSON.stringify(tasks));

const ids = (tasks: PlannerTask[]) => tasks.map((item) => item.id);

/* ------------------------------------------------------------------- cases */

describe("duplicate a task — the whole subtree, nothing else", () => {
  test("a task without subtasks copies just itself, with every field intact", () => {
    const source = task({ id: "a", name: "Kickoff", duration: 5, start: "2026-02-02", finish: "2026-02-06", percent: 40 });
    const tasks = [source, task({ id: "b", name: "Other" })];
    const before = snapshot(tasks);

    const result = duplicateTaskGroup(tasks, "a", copyIds());
    expect(result.error).toBeUndefined();
    const copies = result.group!.tasks;

    expect(ids(copies)).toEqual(["copy-1"]);
    expect(copies[0]).toEqual({ ...source, id: "copy-1", parentId: null, predecessors: "" });
    expect(copies[0].name).toBe("Kickoff");
    expect(copies[0].duration).toBe(5);
    expect(copies[0].start).toBe("2026-02-02");
    expect(copies[0].finish).toBe("2026-02-06");
    expect(copies[0].percent).toBe(40);
    // The original and the rest of the plan are untouched.
    expect(tasks).toEqual(before);
  });

  test("a task with subtasks copies them all, in order, one level down", () => {
    const tasks = [
      task({ id: "root", name: "Phase" }),
      task({ id: "c1", parentId: "root", name: "Draft" }),
      task({ id: "c2", parentId: "root", name: "Review" }),
      task({ id: "other", name: "Elsewhere" }),
    ];
    const before = snapshot(tasks);

    const result = duplicateTaskGroup(tasks, "root", copyIds());
    expect(result.error).toBeUndefined();
    const copies = result.group!.tasks;
    const idMap = result.group!.idMap;

    // The copied task first, then its subtasks in their original order.
    expect(ids(copies)).toEqual(["copy-1", "copy-2", "copy-3"]);
    expect(copies[0].name).toBe("Phase");
    expect(copies[1].name).toBe("Draft");
    expect(copies[2].name).toBe("Review");
    // The subtasks belong to the new copied task, never the original.
    expect(copies[0].parentId).toBeNull();
    expect(copies[1].parentId).toBe(idMap.get("root")!);
    expect(copies[2].parentId).toBe(idMap.get("root")!);
    expect(idMap.get("root")).not.toBe("root");
    expect(tasks).toEqual(before);
  });

  test("subtasks of subtasks copy too, at every level", () => {
    const tasks = [
      task({ id: "root" }),
      task({ id: "l1", parentId: "root" }),
      task({ id: "l2", parentId: "l1" }),
      task({ id: "l3", parentId: "l2" }),
    ];
    const before = snapshot(tasks);

    const result = duplicateTaskGroup(tasks, "root", copyIds());
    const copies = result.group!.tasks;
    const idMap = result.group!.idMap;

    expect(ids(copies)).toEqual(["copy-1", "copy-2", "copy-3", "copy-4"]);
    expect(copies[1].parentId).toBe(idMap.get("root")!);
    expect(copies[2].parentId).toBe(idMap.get("l1")!);
    expect(copies[3].parentId).toBe(idMap.get("l2")!);
    // Every copied parent link points at a copy, never an original.
    for (const copy of copies) {
      expect(copy.parentId === null || copy.id.startsWith("copy-")).toBe(true);
      expect(copy.parentId === null || copies.some((item) => item.id === copy.parentId)).toBe(true);
    }
    expect(tasks).toEqual(before);
  });

  test("duplicating a subtask keeps it at its level under its original parent", () => {
    const tasks = [
      task({ id: "root" }),
      task({ id: "c1", parentId: "root" }),
      task({ id: "gc", parentId: "c1" }),
    ];
    const result = duplicateTaskGroup(tasks, "c1", copyIds());
    const copies = result.group!.tasks;
    const idMap = result.group!.idMap;

    expect(copies.find((item) => item.id === idMap.get("c1"))!.parentId).toBe("root");
    expect(copies.find((item) => item.id === idMap.get("gc"))!.parentId).toBe(idMap.get("c1")!);
  });
});

describe("duplicate a task — dependencies", () => {
  test("a dependency between copies inside the group moves onto the new copies", () => {
    const tasks = [
      task({ id: "root" }),
      task({ id: "c1", parentId: "root", predecessors: "" }),
      task({ id: "c2", parentId: "root", predecessors: "c1FS+2d" }),
    ];
    const before = snapshot(tasks);

    const result = duplicateTaskGroup(tasks, "root", copyIds());
    const copies = result.group!.tasks;
    const idMap = result.group!.idMap;
    const byId = new Map(copies.map((item) => [item.id, item]));

    expect(byId.get(idMap.get("c2")!)!.predecessors).toBe(`${idMap.get("c1")}FS+2d`);
    // Both ends of the link are copies, and the network has the same shape.
    const links = dependenciesForTasks(copies);
    expect(links.length).toBe(1);
    expect(links[0].predecessorId).toBe(idMap.get("c1")!);
    expect(links[0].successorId).toBe(idMap.get("c2")!);
    // No copied dependency points back at an original.
    for (const part of copies.flatMap((item) => item.predecessors.split(",").map((value) => value.trim()).filter(Boolean))) {
      expect(part.startsWith("c1") || part.startsWith("c2") || part.startsWith("root")).toBe(false);
    }
    expect(tasks).toEqual(before);
  });

  test("a dependency that leaves the group is not copied, and the original keeps it", () => {
    const tasks = [
      task({ id: "ext", name: "External" }),
      task({ id: "root" }),
      task({ id: "c1", parentId: "root", predecessors: "extFS" }),
    ];
    const before = snapshot(tasks);

    const result = duplicateTaskGroup(tasks, "root", copyIds());
    const copies = result.group!.tasks;
    const idMap = result.group!.idMap;
    const byId = new Map(copies.map((item) => [item.id, item]));

    expect(byId.get(idMap.get("c1")!)!.predecessors).toBe("");
    expect(result.group!.droppedDependencies).toEqual([
      { sourceTaskId: "c1", sourceTaskName: "c1", token: "extFS" },
    ]);
    // The link outside the group is left exactly where it was.
    expect(tasks.find((item) => item.id === "c1")!.predecessors).toBe("extFS");
    expect(tasks).toEqual(before);
  });

  test("a mixed predecessor keeps the inside link and drops only the outside one", () => {
    const tasks = [
      task({ id: "ext" }),
      task({ id: "root" }),
      task({ id: "c1", parentId: "root" }),
      task({ id: "c2", parentId: "root", predecessors: "c1FS, extFS" }),
    ];
    const before = snapshot(tasks);

    const result = duplicateTaskGroup(tasks, "root", copyIds());
    const copies = result.group!.tasks;
    const idMap = result.group!.idMap;
    const byId = new Map(copies.map((item) => [item.id, item]));

    expect(byId.get(idMap.get("c2")!)!.predecessors).toBe(`${idMap.get("c1")}FS`);
    expect(result.group!.droppedDependencies.map((item) => item.token)).toEqual(["extFS"]);
    expect(tasks).toEqual(before);
  });
});

describe("duplicate a task — assignments", () => {
  test("resource assignments are copied onto the new copies only", () => {
    const tasks = [
      task({ id: "root" }),
      task({ id: "c1", parentId: "root" }),
    ];
    const result = duplicateTaskGroup(tasks, "root", copyIds());
    const idMap = result.group!.idMap;
    const assignments = [
      { id: "as-1", taskId: "c1", resourceId: "res-x" },
      { id: "as-2", taskId: "c1", resourceId: "res-y" },
      { id: "as-3", taskId: "ext", resourceId: "res-z" },
      { id: "as-4", taskId: "root", resourceId: "res-x" },
    ];
    const before = JSON.parse(JSON.stringify(assignments));

    const copied = duplicateTaskAssignments(assignments, idMap);

    expect(copied.get(idMap.get("c1")!)).toEqual(["res-x", "res-y"]);
    expect(copied.get(idMap.get("root")!)).toEqual(["res-x"]);
    // A task outside the group contributes nothing.
    expect(copied.size).toBe(2);
    expect(assignments).toEqual(before);
  });
});

describe("duplicate a task — the copy stays in this plan", () => {
  test("the copy keeps the source's project/version fields and gains no company id", () => {
    const source = task({ id: "a", versionId: "version-7" });
    const tasks = [source];
    const result = duplicateTaskGroup(tasks, "a", copyIds());
    const copy = result.group!.tasks[0];

    expect(copy.versionId).toBe("version-7");
    // The pure copy never invents or reads a company id.
    expect("companyId" in copy).toBe(false);
    expect("company" in copy).toBe(false);
  });

  test("a missing task creates nothing", () => {
    const tasks = [task({ id: "a" })];
    const result = duplicateTaskGroup(tasks, "nope", copyIds());
    expect(result.error).toBeDefined();
    expect(result.group).toBeUndefined();
  });

  test("a colliding id refuses the whole copy instead of overwriting", () => {
    const tasks = [task({ id: "a" }), task({ id: "taken" })];
    const result = duplicateTaskGroup(tasks, "a", () => "taken");
    expect(result.error).toBeDefined();
    expect(result.group).toBeUndefined();
  });

  test("the copy is re-scheduled by the same recalculation as a manual task", () => {
    const system: CalendarSystem = {
      calendars: [{ id: "base", name: "Base", type: "base", parentCalendarId: null, isDefault: true, workingDays: [1, 2, 3, 4, 5] }],
      exceptions: [],
      defaultCalendarId: "base",
    };
    const tasks = [
      task({ id: "root", start: "2026-01-05", finish: "2026-01-09", duration: 5 }),
      task({ id: "c1", parentId: "root", start: "2026-01-05", finish: "2026-01-07", duration: 3 }),
      task({ id: "c2", parentId: "root", start: "2026-01-08", finish: "2026-01-09", duration: 2, predecessors: "c1FS" }),
    ];
    const before = snapshot(tasks);
    // Settle the plan first, exactly as a live plan is settled by every edit, so
    // the recalculation under test is idempotent for the original rows.
    const plan = (items: PlannerTask[]) => withCalculatedPlanningFields(
      recalculateTasks(withCalculatedPlanningFields(items, system, "base"), { direction: "forward", calendarSystem: system, projectCalendarId: "base" }).tasks,
      system,
      "base",
    );
    const baseline = plan(tasks);

    const result = duplicateTaskGroup(baseline, "root", copyIds());
    const copies = result.group!.tasks;
    const idMap = result.group!.idMap;

    // Exactly what `commit` does for a manual task: size the margins and re-plan.
    const normalised = applyPlanningModeMargins([...baseline, ...copies]);
    const recalced = recalculateTasks(normalised, { direction: "forward", calendarSystem: system, projectCalendarId: "base" });
    expect(recalced.error).toBeUndefined();
    const byId = new Map(withCalculatedPlanningFields(recalced.tasks, system, "base").map((item) => [item.id, item]));

    // Every copy is a real, scheduled row in the re-planned network.
    for (const id of idMap.values()) {
      const row = byId.get(id);
      expect(row).toBeDefined();
      expect(row!.start <= row!.finish).toBe(true);
    }
    // The copied link holds: the copied successor follows the copied predecessor.
    expect(byId.get(idMap.get("c2")!)!.start >= byId.get(idMap.get("c1")!)!.finish).toBe(true);
    // The originals keep their planned dates and durations through the duplication.
    for (const original of baseline) {
      expect(byId.get(original.id)!.start).toBe(original.start);
      expect(byId.get(original.id)!.finish).toBe(original.finish);
      expect(byId.get(original.id)!.duration).toBe(original.duration);
    }
    // The array handed to the copy was never mutated.
    expect(tasks).toEqual(before);
  });

  test("the copy is emitted in display order, original subtree contiguous", () => {
    const tasks = [
      task({ id: "root" }),
      task({ id: "c1", parentId: "root" }),
      task({ id: "c2", parentId: "c1" }),
    ];
    const before = snapshot(tasks);
    const result = duplicateTaskGroup(tasks, "root", copyIds());
    // The copies read exactly like the subtree they came from.
    const originalOrder = orderTasksForDisplay(tasks).map((item) => item.name);
    const copyOrder = orderTasksForDisplay(result.group!.tasks).map((item) => item.name);
    expect(copyOrder).toEqual(originalOrder);
    expect(tasks).toEqual(before);
  });
});
