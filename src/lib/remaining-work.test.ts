import { describe, expect, test } from "bun:test";
import { createDefaultCalendarSystem, type CalendarException, type CalendarSystem } from "./scheduling-engine";
import { dailyAllocation, hasAllocationSegments, recalculateTasks, remapCopiedTasks, settleMonitoringPlan, withCalculatedPlanningFields, type PlannerTask } from "./planner-model";
import { aggregatePeriods, computeResourceLoads } from "./capacity-engine";
import {
  adjustmentDefaults,
  applyAdjustment,
  canAdjustTask,
  editLastAdjustment,
  fixedDaysOnNonWorkingDays,
  fixedUntil,
  lastActiveAdjustment,
  planAdjustment,
  previewAdjustment,
  previewRemoval,
  removeAllAdjustments,
  removeLastAdjustment,
  undoLastAdjustment,
  validateAdjustment,
  withoutSnapshotLog,
  type AdjustmentContext,
  type AdjustmentInput,
} from "./remaining-work";

const system = (exceptions: CalendarException[] = []): CalendarSystem => {
  const base = createDefaultCalendarSystem();
  return { calendars: base.calendars.filter((calendar) => calendar.type === "base"), exceptions, defaultCalendarId: "base" };
};

const holiday = (date: string): CalendarException => ({
  id: `holiday-${date}`,
  calendarId: "base",
  startDate: date,
  endDate: date,
  label: "Holiday",
  type: "holiday",
  isWorkingDay: false,
  source: "manual",
});

/**
 * The mandatory verification case: 1–14 September 2026, 40 h, Even, 20 % margin,
 * one resource on a 40 h/week schedule, project in Monitoring with a baseline.
 */
const scenarioTask = (overrides: Partial<PlannerTask> = {}): PlannerTask => ({
  id: "t1",
  parentId: null,
  name: "Running task",
  duration: 10,
  durationUnit: "days",
  start: "2026-09-01", // Tuesday
  finish: "2026-09-14", // Monday
  isMilestone: false,
  predecessors: "",
  resource: "",
  percent: 0,
  notes: "",
  color: "sage",
  work: 40,
  distribution: "even",
  marginPct: 20,
  marginDaysOriginal: 2,
  marginDaysConsumed: 0,
  ...overrides,
});

const context = (overrides: Partial<AdjustmentContext> = {}): AdjustmentContext => ({
  system: system(),
  projectCalendarId: "base",
  today: "2026-09-12",
  ...overrides,
});

const input = (overrides: Partial<AdjustmentInput> = {}): AdjustmentInput => ({
  keepUntil: "2026-09-14",
  remainingWork: 40,
  newFinish: "2026-09-21",
  distribution: "even",
  reason: "Re-planned the remaining work",
  ...overrides,
});

const hoursOn = (task: PlannerTask, date: string, ctx: AdjustmentContext = context()) =>
  dailyAllocation(task, ctx.system, ctx.projectCalendarId, ctx.isAvailable).find((entry) => entry.date === date)?.hours ?? 0;

const totalHours = (task: PlannerTask, ctx: AdjustmentContext = context()) =>
  dailyAllocation(task, ctx.system, ctx.projectCalendarId, ctx.isAvailable).reduce((sum, entry) => sum + entry.hours, 0);

const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

describe("adjust remaining work — mandatory verification", () => {
  test("1–14 September keeps exactly its hours; 15–21 September carries the 40 h remainder", () => {
    const task = scenarioTask();
    const ctx = context();
    const outcome = applyAdjustment(task, input(), ctx);

    // Fixed part: unchanged, 4 h on each of the ten working days up to 14 September.
    for (const date of ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-14"]) {
      expect(hoursOn(outcome.task, date, ctx)).toBe(4);
    }
    // The weekend is skipped.
    expect(hoursOn(outcome.task, "2026-09-12", ctx)).toBe(0);
    expect(hoursOn(outcome.task, "2026-09-13", ctx)).toBe(0);

    // Remainder: 40 h over the five working days from 15 to 21 September.
    for (const date of ["2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-21"]) {
      expect(hoursOn(outcome.task, date, ctx)).toBe(8);
    }
    expect(close(totalHours(outcome.task, ctx), 80)).toBe(true);
    expect(outcome.task.finish).toBe("2026-09-21");
    expect(outcome.task.start).toBe("2026-09-01");
    expect(close(outcome.task.work ?? 0, 80)).toBe(true);
  });

  test("total workload 80 h, baseline deviation +40 h, finish 14 → 21 September, margin consumed first", () => {
    const task = scenarioTask();
    const preview = previewAdjustment([task], task.id, input(), context(), 40)!;
    expect(close(preview.fixedHours, 40)).toBe(true);
    expect(close(preview.remainingHours, 40)).toBe(true);
    expect(close(preview.newWork, 80)).toBe(true);
    expect(close(preview.workDeviation ?? 0, 40)).toBe(true);
    expect(preview.oldFinish).toBe("2026-09-14");
    expect(preview.newFinish).toBe("2026-09-21");
    expect(close(preview.hoursPerDay, 8)).toBe(true);
    // Five working days later, the task's own two reserve days absorb first.
    expect(preview.marginConsumed).toBe(2);
    expect(preview.daysPushed).toBe(3);
    expect(preview.projectFinishBefore).toBe("2026-09-14");
    expect(preview.projectFinishAfter).toBe("2026-09-21");
  });

  test("the excess is pushed to successors through the existing margin logic", () => {
    const task = scenarioTask();
    const successor: PlannerTask = {
      ...scenarioTask({ id: "t2", start: "2026-09-17", finish: "2026-09-21", duration: 3, work: 24, marginPct: 0, marginDaysOriginal: 0, predecessors: "t1FS" }),
      name: "Successor",
    };
    const tasks = [task, successor];
    const plan = planAdjustment(tasks, task.id, input(), context(), { baselineWork: 40, actor: { id: "u1", name: "Ada" }, at: "2026-09-12T09:00:00.000Z" });
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.entry.marginConsumed).toBe(2);
    expect(plan.entry.daysPushed).toBe(3);
    const before = tasks.find((item) => item.id === "t2")!;
    const after = plan.scheduled.find((item) => item.id === "t2")!;
    expect(after.start > before.start).toBe(true);
  });

  test("the adjustment log carries the actor, reason and the pre-adjustment snapshot", () => {
    const task = scenarioTask();
    const plan = planAdjustment([task], task.id, input({ reason: "Supplier delayed" }), context(), { baselineWork: 40, actor: { id: "u7", name: "Ravi" }, at: "2026-09-12T09:00:00.000Z" });
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.entry.userId).toBe("u7");
    expect(plan.entry.userName).toBe("Ravi");
    expect(plan.entry.reason).toBe("Supplier delayed");
    expect(plan.entry.keepUntil).toBe("2026-09-14");
    expect(plan.entry.oldFinish).toBe("2026-09-14");
    expect(plan.entry.newFinish).toBe("2026-09-21");
    expect(close(plan.entry.oldWork, 40)).toBe(true);
    expect(close(plan.entry.newWork, 80)).toBe(true);
    expect(plan.entry.before.finish).toBe("2026-09-14");
    expect(plan.entry.before.work).toBe(40);
    expect(plan.entry.before.allocations).toBeUndefined();
    expect(plan.task.adjustments?.length).toBe(1);
  });
});

describe("adjust remaining work — rules", () => {
  test("an invalid draft is refused with a reason", () => {
    const task = scenarioTask();
    expect(validateAdjustment(task, input({ reason: "  " }), context())).toBeTruthy();
    expect(validateAdjustment(task, input({ keepUntil: "2026-08-31" }), context())).toBeTruthy();
    expect(validateAdjustment(task, input({ keepUntil: "2026-09-20" }), context())).toBeTruthy();
    expect(validateAdjustment(task, input({ newFinish: "2026-09-14" }), context())).toBeTruthy();
    expect(validateAdjustment(task, input({ keepUntil: "2026-09-11", newFinish: "2026-09-12" }), context())).toBeTruthy();
    expect(validateAdjustment(task, input(), context())).toBeNull();
  });

  test("keep-until = today is the default and the plan before it is kept", () => {
    const task = scenarioTask({ start: "2026-09-01", finish: "2026-09-23", duration: 17, work: 68 });
    const ctx = context({ today: "2026-09-10" });
    const defaults = adjustmentDefaults(task, ctx);
    expect(defaults.keepUntil).toBe("2026-09-10");
    const outcome = applyAdjustment(task, input({ keepUntil: defaults.keepUntil, remainingWork: defaults.remainingWork, newFinish: "2026-09-30" }), ctx);
    // Everything up to today keeps its current hours.
    expect(close(outcome.fixedHours, dailyAllocation(task, ctx.system, ctx.projectCalendarId).filter((entry) => entry.date <= "2026-09-10").reduce((sum, entry) => sum + entry.hours, 0))).toBe(true);
  });

  test("remaining work 0 h is allowed and leaves only the fixed hours", () => {
    const task = scenarioTask();
    const outcome = applyAdjustment(task, input({ remainingWork: 0 }), context());
    expect(close(outcome.fixedHours, 40)).toBe(true);
    expect(close(outcome.task.work ?? 0, 40)).toBe(true);
    expect(close(totalHours(outcome.task), 40)).toBe(true);
    expect(hoursOn(outcome.task, "2026-09-21", context())).toBe(0);
  });

  test("leave inside the remaining range redistributes over the available days", () => {
    const task = scenarioTask();
    const ctx = context({ isAvailable: (date) => date !== "2026-09-17" });
    const outcome = applyAdjustment(task, input(), ctx);
    const allocation = dailyAllocation(outcome.task, ctx.system, ctx.projectCalendarId, ctx.isAvailable);
    const remainder = allocation.filter((entry) => entry.date >= "2026-09-15");
    expect(close(remainder.reduce((sum, entry) => sum + entry.hours, 0), 40)).toBe(true);
    expect(hoursOn(outcome.task, "2026-09-17", ctx)).toBe(0);
    expect(close(hoursOn(outcome.task, "2026-09-15", ctx), 10)).toBe(true);
  });

  test("a change to a fixed day keeps the hours and raises a warning", () => {
    const task = scenarioTask();
    const outcome = applyAdjustment(task, input(), context());
    const afterHoliday = system([holiday("2026-09-02")]);
    // The stored fixed hours stay put…
    expect(hoursOn(outcome.task, "2026-09-02", context({ system: afterHoliday }))).toBe(4);
    // …and the planner warns that the day is no longer a working day.
    const warning = fixedDaysOnNonWorkingDays(outcome.task, afterHoliday, "base");
    expect(warning).toContain("2026-09-02");
    expect(fixedUntil(outcome.task)).toBe("2026-09-14");
  });

  test("two adjustments stack; undo restores exactly the state before the last one", () => {
    const task = scenarioTask();
    const ctx = context();
    const first = planAdjustment([task], task.id, input({ keepUntil: "2026-09-07", remainingWork: 32, newFinish: "2026-09-18", reason: "First" }), ctx, { actor: { id: "u1", name: "Ada" }, at: "2026-09-08T09:00:00.000Z" });
    if ("error" in first) throw new Error(first.error);
    const afterFirst = first.task;

    const second = planAdjustment([afterFirst], afterFirst.id, input({ keepUntil: "2026-09-14", remainingWork: 20, newFinish: "2026-09-25", reason: "Second" }), ctx, { actor: { id: "u1", name: "Ada" }, at: "2026-09-15T09:00:00.000Z" });
    if ("error" in second) throw new Error(second.error);
    expect(second.task.adjustments?.length).toBe(2);
    // The new adjustment fixes everything up to its own keep-until, including the earlier fixed segment.
    const keptThrough14 = dailyAllocation(afterFirst, ctx.system, ctx.projectCalendarId)
      .filter((entry) => entry.date <= "2026-09-14")
      .reduce((sum, entry) => sum + entry.hours, 0);
    expect(close(second.preview.fixedHours, keptThrough14)).toBe(true);
    expect(second.preview.fixedHours > 20).toBe(true);

    const undone = undoLastAdjustment(second.task)!;
    expect(undone.adjustments?.length).toBe(1);
    expect(undone.finish).toBe(afterFirst.finish);
    expect(undone.work).toBe(afterFirst.work);
    expect(undone.duration).toBe(afterFirst.duration);
    expect(undone.marginDaysConsumed).toBe(afterFirst.marginDaysConsumed);
    expect(undone.allocations).toEqual(afterFirst.allocations);
  });

  test("a half-typed date is refused instead of hanging the planner", () => {
    const task = scenarioTask();
    expect(validateAdjustment(task, input({ keepUntil: "" }), context())).toBeTruthy();
    expect(validateAdjustment(task, input({ newFinish: "" }), context())).toBeTruthy();
    expect(previewAdjustment([task], task.id, input({ keepUntil: "" }), context(), 40)).toBeTruthy();
  });

  test("there is nothing to undo on a task that was never adjusted", () => {
    expect(undoLastAdjustment(scenarioTask())).toBeNull();
  });

  test("the action is only available for started, unfinished tasks in Monitoring", () => {
    const task = scenarioTask();
    expect(canAdjustTask(task, "planning", "2026-09-12", [task])).toBeTruthy();
    expect(canAdjustTask(task, "monitoring", "2026-08-20", [task])).toBeTruthy();
    expect(canAdjustTask(task, "monitoring", "2026-09-12", [task])).toBeNull();
    expect(canAdjustTask(scenarioTask({ percent: 100 }), "monitoring", "2026-09-12", [task])).toBeTruthy();
    expect(canAdjustTask(scenarioTask({ isMilestone: true, duration: 0 }), "monitoring", "2026-09-12", [task])).toBeTruthy();
    const summary = scenarioTask({ id: "s1" });
    expect(canAdjustTask(summary, "monitoring", "2026-09-12", [summary, scenarioTask({ parentId: "s1" })])).toBeTruthy();
  });

  test("a task without adjustments is allocated exactly as before", () => {
    const task = scenarioTask();
    const allocation = dailyAllocation(task, context().system, "base");
    expect(allocation.length).toBe(10);
    expect(allocation.every((entry) => entry.hours === 4)).toBe(true);
  });

  test("a replan copy carries the segments and the adjustment log unchanged", () => {
    const plan = planAdjustment([scenarioTask()], "t1", input(), context(), { actor: { id: "u1", name: "Ada" }, at: "2026-09-12T09:00:00.000Z" });
    if ("error" in plan) throw new Error(plan.error);
    const copy = remapCopiedTasks([plan.task], new Map([[plan.task.id, "copy-1"]]), "ver-2");
    if (copy.error) throw new Error(copy.error);
    expect(copy.tasks[0].allocations).toEqual(plan.task.allocations);
    expect(copy.tasks[0].adjustments).toEqual(plan.task.adjustments);
    expect(copy.tasks[0].finish).toBe("2026-09-21");
    expect(close(copy.tasks[0].work ?? 0, 80)).toBe(true);
  });

  test("the preview warns when the resource becomes overloaded on a day", () => {
    const task = scenarioTask();
    const ctx = context({ availableHours: () => 6 });
    const preview = previewAdjustment([task], task.id, input(), ctx, 40)!;
    // The five remainder days carry 8 h against 6 h available.
    expect(preview.overloadedDays.length).toBe(5);
    expect(preview.overloadedDays.every((day) => day.hours === 8 && day.available === 6)).toBe(true);
  });
});

describe("adjust remaining work — capacity and work in period", () => {
  const adjustedWithAssignment = () => {
    const ctx = context();
    const outcome = applyAdjustment(scenarioTask(), input(), ctx);
    return { task: outcome.task, ctx };
  };

  test("capacity totals count fixed and planned hours together", () => {
    const { task, ctx } = adjustedWithAssignment();
    const report = computeResourceLoads({
      system: ctx.system,
      resources: [{ id: "res1", name: "Chris", hoursPerWeek: 40, calendarId: "base" }],
      assignments: [{ taskId: task.id, resourceId: "res1" }],
      projects: [{ projectId: "p1", projectName: "Project", projectCalendarId: "base", tasks: [task] }],
    })[0];
    expect(close(report.totalAllocated, 80)).toBe(true);
    const weeks = aggregatePeriods(report, "week");
    expect(close(weeks.reduce((sum, week) => sum + week.allocated, 0), 80)).toBe(true);
    // The week of 14–20 September holds the fixed 14th (4 h) plus four 8 h days.
    const week = weeks.find((row) => row.start === "2026-09-14")!;
    expect(close(week.allocated, 36)).toBe(true);
  });

  test("Work in period includes fixed and planned hours", () => {
    const { task, ctx } = adjustedWithAssignment();
    const report = computeResourceLoads({
      system: ctx.system,
      resources: [{ id: "res1", name: "Chris", hoursPerWeek: 40, calendarId: "base" }],
      assignments: [{ taskId: task.id, resourceId: "res1" }],
      projects: [{ projectId: "p1", projectName: "Project", projectCalendarId: "base", tasks: [task] }],
      range: { start: "2026-09-15", end: "2026-09-21" },
    })[0];
    expect(close(report.assignedWork[0].total, 80)).toBe(true);
    expect(close(report.assignedWork[0].inPeriod, 40)).toBe(true);
  });
});

describe("adjust remaining work — zero remainder", () => {
  test("0 h with the finish on the keep-until date is accepted and ends the task there", () => {
    const task = scenarioTask();
    const draft = input({ remainingWork: 0, newFinish: "2026-09-14" });
    expect(validateAdjustment(task, draft, context())).toBeNull();
    const outcome = applyAdjustment(task, draft, context());
    expect(outcome.newFinish).toBe("2026-09-14");
    expect(outcome.task.finish).toBe("2026-09-14");
    expect(outcome.task.duration).toBe(10);
    expect(close(outcome.task.work ?? 0, 40)).toBe(true);
    expect(outcome.task.allocations?.find((segment) => segment.kind === "planned")?.hours).toBe(0);
    // No planned hours at all: nothing after 14 September.
    expect(dailyAllocation(outcome.task, context().system, "base").filter((entry) => entry.date > "2026-09-14").length).toBe(0);
  });

  test("0 h with an empty finish falls back to the keep-until date", () => {
    const task = scenarioTask();
    const outcome = applyAdjustment(task, input({ remainingWork: 0, newFinish: "" }), context());
    expect(outcome.newFinish).toBe("2026-09-14");
    expect(close(totalHours(outcome.task), 40)).toBe(true);
  });

  test("Capacity shows no hours after the keep-until date", () => {
    const task = scenarioTask();
    const outcome = applyAdjustment(task, input({ remainingWork: 0, newFinish: "2026-09-14" }), context());
    const report = computeResourceLoads({
      system: context().system,
      resources: [{ id: "res1", name: "Chris", hoursPerWeek: 40, calendarId: "base" }],
      assignments: [{ taskId: outcome.task.id, resourceId: "res1" }],
      projects: [{ projectId: "p1", projectName: "Project", projectCalendarId: "base", tasks: [outcome.task] }],
      range: { start: "2026-09-15", end: "2026-09-30" },
    })[0];
    expect(close(report.totalAllocated, 0)).toBe(true);
    expect(close(report.assignedWork[0].total, 40)).toBe(true);
    expect(close(report.assignedWork[0].inPeriod, 0)).toBe(true);
  });

  test("negative remaining work stays blocked", () => {
    expect(validateAdjustment(scenarioTask(), input({ remainingWork: -1 }), context())).toBeTruthy();
  });

  test("editing an adjustment can set the remainder to 0", () => {
    const task = scenarioTask();
    const first = planAdjustment([task], task.id, input(), context(), { actor: { id: "u1", name: "Ada" }, at: "2026-09-12T09:00:00.000Z" });
    if ("error" in first) throw new Error(first.error);
    const edited = editLastAdjustment([first.task], task.id, input({ remainingWork: 0, newFinish: "2026-09-14" }), context(), { actor: { id: "u1", name: "Ada" }, at: "2026-09-13T09:00:00.000Z" });
    if ("error" in edited) throw new Error(edited.error);
    expect(edited.task.allocations?.find((segment) => segment.kind === "planned")?.hours).toBe(0);
    expect(edited.task.finish).toBe("2026-09-14");
    expect(close(edited.task.work ?? 0, 40)).toBe(true);
  });
});

describe("adjust remaining work — removal and edit", () => {
  const actor = { id: "u1", name: "Ada" };
  const twoAdjustments = () => {
    const task = scenarioTask();
    const first = planAdjustment([task], task.id, input({ keepUntil: "2026-09-07", remainingWork: 32, newFinish: "2026-09-18", reason: "First" }), context(), { actor, at: "2026-09-08T09:00:00.000Z" });
    if ("error" in first) throw new Error(first.error);
    const second = planAdjustment([first.task], task.id, input({ keepUntil: "2026-09-14", remainingWork: 20, newFinish: "2026-09-25", reason: "Second" }), context(), { actor, at: "2026-09-15T09:00:00.000Z" });
    if ("error" in second) throw new Error(second.error);
    return { task, afterFirst: first.task, afterSecond: second.task };
  };

  test("removing the newest adjustment restores the previous state and keeps the history", () => {
    const { afterFirst, afterSecond } = twoAdjustments();
    const removed = removeLastAdjustment(afterSecond, actor, "2026-09-16T09:00:00.000Z")!;
    expect(removed.adjustments?.length).toBe(2);
    expect(removed.adjustments?.filter((entry) => entry.removedAt).length).toBe(1);
    const mark = removed.adjustments!.find((entry) => entry.removedAt)!;
    expect(mark.removedByUserId).toBe("u1");
    expect(mark.removedByName).toBe("Ada");
    expect(mark.removedAt).toBe("2026-09-16T09:00:00.000Z");
    // Exact restore of the state before that adjustment.
    expect(removed.finish).toBe(afterFirst.finish);
    expect(removed.work).toBe(afterFirst.work);
    expect(removed.duration).toBe(afterFirst.duration);
    expect(removed.distribution).toBe(afterFirst.distribution);
    expect(removed.marginDaysConsumed).toBe(afterFirst.marginDaysConsumed);
    expect(removed.allocations).toEqual(afterFirst.allocations);
    // The newest ACTIVE entry is the first adjustment again.
    expect(lastActiveAdjustment(removed)?.id).toBe(afterFirst.adjustments?.[0]?.id);
  });

  test("removing all adjustments restores the state before the first one", () => {
    const { task, afterSecond } = twoAdjustments();
    const all = removeAllAdjustments(afterSecond, actor, "2026-09-16T09:00:00.000Z")!;
    // One planned segment again, the original workload, no fixed part.
    expect(all.allocations).toBeUndefined();
    expect(hasAllocationSegments(all)).toBe(false);
    expect(fixedUntil(all)).toBeNull();
    expect(all.finish).toBe(task.finish);
    expect(all.work).toBe(40);
    expect(all.duration).toBe(10);
    expect(all.adjustments?.length).toBe(2);
    expect(all.adjustments?.every((entry) => Boolean(entry.removedAt))).toBe(true);
    expect(lastActiveAdjustment(all)).toBeNull();
  });

  test("removing twice empties the adjustments even though the log keeps every entry", () => {
    const { afterFirst, afterSecond } = twoAdjustments();
    const once = removeLastAdjustment(afterSecond, actor, "2026-09-16T09:00:00.000Z")!;
    const twice = removeLastAdjustment(once, actor, "2026-09-17T09:00:00.000Z")!;
    const firstBefore = afterFirst.adjustments![0].before;
    expect(twice.allocations).toBeUndefined();
    expect(twice.work).toBe(firstBefore.work);
    expect(twice.finish).toBe(firstBefore.finish);
    expect(twice.adjustments?.length).toBe(2);
    expect(twice.adjustments?.every((entry) => Boolean(entry.removedAt))).toBe(true);
    expect(removeLastAdjustment(twice, actor, "2026-09-18T09:00:00.000Z")).toBeNull();
    expect(removeAllAdjustments(twice, actor, "2026-09-18T09:00:00.000Z")).toBeNull();
  });

  test("the removal preview names the restored finish, workload, margin and successors", () => {
    const task = scenarioTask();
    const successor: PlannerTask = { ...scenarioTask({ id: "t2", start: "2026-09-22", finish: "2026-09-23", duration: 2, work: 16, marginPct: 0, marginDaysOriginal: 0, predecessors: "t1FS" }), name: "Successor" };
    const plan = planAdjustment([task, successor], task.id, input(), context(), { baselineWork: 40, actor, at: "2026-09-12T09:00:00.000Z" });
    if ("error" in plan) throw new Error(plan.error);
    const current = plan.scheduled as PlannerTask[];
    const preview = previewRemoval(current, task.id, context(), "last")!;
    expect(preview.mode).toBe("last");
    expect(preview.removed).toBe(1);
    expect(preview.finish).toBe("2026-09-14");
    expect(close(preview.work, 40)).toBe(true);
    expect(preview.marginReturned).toBeGreaterThan(0);
    // The successor moves back to where it was before the adjustment.
    const currentSuccessor = current.find((item) => item.id === "t2")!;
    const restoredSuccessor = preview.successors.find((item) => item.taskId === "t2")!;
    expect(restoredSuccessor.oldStart).toBe(currentSuccessor.start);
    expect(restoredSuccessor.newStart < currentSuccessor.start).toBe(true);
  });

  test("editing the newest adjustment keeps the keep-until date and replaces the entry", () => {
    const task = scenarioTask();
    const first = planAdjustment([task], task.id, input(), context(), { actor, at: "2026-09-12T09:00:00.000Z" });
    if ("error" in first) throw new Error(first.error);
    const edited = editLastAdjustment([first.task], task.id, input({ keepUntil: "2030-01-01", remainingWork: 10, newFinish: "2026-09-25", distribution: "back", reason: "Changed" }), context(), { actor, at: "2026-09-13T09:00:00.000Z" });
    if ("error" in edited) throw new Error(edited.error);
    expect(edited.entry.keepUntil).toBe("2026-09-14");
    expect(edited.entry.reason).toBe("Changed");
    expect(edited.entry.userName).toBe("Ada");
    expect(edited.task.adjustments?.length).toBe(1);
    expect(edited.task.finish).toBe("2026-09-25");
    const planned = (edited.task.allocations ?? []).find((segment) => segment.kind === "planned");
    expect(planned).toBeDefined();
    expect(close(planned?.hours ?? 0, 10)).toBe(true);
    expect(planned?.distribution).toBe("back");
    expect(edited.task.allocations?.[0].days?.length).toBe(10);
  });

  test("apply then remove: the task, its margin and its successors are exactly as before", () => {
    const ctx = context();
    const commitPipeline = (previous: PlannerTask[], edited: PlannerTask[], taskId: string): PlannerTask[] => {
      const settled = settleMonitoringPlan(previous, edited, { calendarSystem: ctx.system, projectCalendarId: "base", anchoredTaskIds: [taskId] });
      const result = recalculateTasks(settled.tasks, { direction: "forward", calendarSystem: ctx.system, projectCalendarId: "base" });
      return withCalculatedPlanningFields(result.error ? settled.tasks : result.tasks, ctx.system, "base");
    };
    const successor: PlannerTask = { ...scenarioTask({ id: "t2", start: "2026-09-17", finish: "2026-09-21", duration: 3, work: 24, marginPct: 0, marginDaysOriginal: 0, predecessors: "t1FS" }), name: "Successor" };
    const original = commitPipeline([scenarioTask(), successor], [scenarioTask(), successor], "t1");
    const plan = planAdjustment(original, "t1", input(), ctx, { baselineWork: 40, actor, at: "2026-09-12T09:00:00.000Z" });
    if ("error" in plan) throw new Error(plan.error);
    const afterApply = commitPipeline(original, original.map((item) => (item.id === "t1" ? plan.task : item)), "t1");
    const adjusted = afterApply.find((item) => item.id === "t1")!;
    expect(adjusted.marginDaysConsumed).toBe(2);
    expect(afterApply.find((item) => item.id === "t2")!.start > original.find((item) => item.id === "t2")!.start).toBe(true);

    const removed = removeLastAdjustment(adjusted, actor, "2026-09-16T09:00:00.000Z")!;
    const afterRemove = commitPipeline(afterApply, afterApply.map((item) => (item.id === "t1" ? removed : item)), "t1");
    const t1 = afterRemove.find((item) => item.id === "t1")!;
    const t2 = afterRemove.find((item) => item.id === "t2")!;
    expect(t1.finish).toBe("2026-09-14");
    expect(t1.work).toBe(40);
    expect(t1.marginDaysConsumed).toBe(0);
    expect(t1.allocations).toBeUndefined();
    expect(dailyAllocation(t1, ctx.system, "base").every((entry) => entry.hours === 4)).toBe(true);
    expect(t2.start).toBe(original.find((item) => item.id === "t2")!.start);
    expect(t2.finish).toBe(original.find((item) => item.id === "t2")!.finish);
  });

  test("removing after a replan leaves the old version untouched", () => {
    const { afterSecond } = twoAdjustments();
    const copy = remapCopiedTasks([afterSecond], new Map([[afterSecond.id, "copy-1"]]), "ver-2");
    if (copy.error) throw new Error(copy.error);
    const copyRemoved = removeAllAdjustments(copy.tasks[0], actor, "2026-09-20T09:00:00.000Z")!;
    expect(copyRemoved.allocations).toBeUndefined();
    // The source version still holds its two segments and its two live entries.
    expect(afterSecond.allocations?.length).toBe(2);
    expect(afterSecond.adjustments?.length).toBe(2);
    expect(afterSecond.adjustments?.every((entry) => !entry.removedAt)).toBe(true);
  });
});

/**
 * The stored task has to stay small: a save rewrites the whole workspace, so a
 * log entry that carried a copy of the log grew the document for every
 * adjustment until the save was refused as a server error.
 */
describe("adjustment log stays compact", () => {
  const actor = { id: "u1", name: "Ada" };
  const chain = (rounds: number): PlannerTask => {
    let task = scenarioTask();
    for (let round = 0; round < rounds; round += 1) {
      const plan = planAdjustment([task], task.id, input({ keepUntil: "2026-09-14", remainingWork: 40, newFinish: "2026-09-21", reason: `round ${round}` }), context(), { actor, at: `2026-09-1${round % 9}T09:00:00.000Z` });
      if ("error" in plan) throw new Error(plan.error);
      task = plan.task;
    }
    return task;
  };

  test("a log entry carries no copy of the log", () => {
    const task = chain(3);
    expect(task.adjustments?.length).toBe(3);
    for (const entry of task.adjustments ?? []) {
      expect("adjustments" in entry.before).toBe(false);
    }
  });

  test("the stored task grows with the number of adjustments, not with their nesting", () => {
    const four = JSON.stringify(chain(4)).length;
    const eight = JSON.stringify(chain(8)).length;
    // Twice the adjustments, roughly twice the size. A snapshot that nested the
    // log made the eighth round around sixteen times the fourth.
    expect(eight).toBeLessThan(four * 3);
  });

  test("a log written by the earlier version is trimmed without losing an entry", () => {
    const task = chain(2);
    const legacy: PlannerTask = {
      ...task,
      adjustments: task.adjustments!.map((entry) => ({ ...entry, before: { ...entry.before, adjustments: task.adjustments! } })),
    };
    expect(JSON.stringify(legacy).length).toBeGreaterThan(JSON.stringify(task).length * 2);
    const trimmed = withoutSnapshotLog(legacy);
    expect(trimmed.adjustments?.length).toBe(2);
    expect(trimmed.adjustments?.map((entry) => entry.id)).toEqual(task.adjustments!.map((entry) => entry.id));
    expect(trimmed.adjustments?.map((entry) => entry.reason)).toEqual(task.adjustments!.map((entry) => entry.reason));
    expect(trimmed.adjustments?.every((entry) => !("adjustments" in entry.before))).toBe(true);
    expect(trimmed.adjustments?.[1].before.finish).toBe(task.adjustments![1].before.finish);
    // Nothing to trim: the task is handed back untouched.
    expect(withoutSnapshotLog(trimmed)).toBe(trimmed);
    // And the history still behaves: the newest entry can be removed and edited.
    const removed = removeLastAdjustment(legacy, actor, "2026-09-20T09:00:00.000Z")!;
    expect(removed.finish).toBe(task.adjustments![1].before.finish);
    expect(removed.adjustments?.filter((entry) => entry.removedAt).length).toBe(1);
    const edited = editLastAdjustment([legacy], legacy.id, input({ reason: "Edited after a refresh" }), context(), { actor, at: "2026-09-21T09:00:00.000Z" });
    if ("error" in edited) throw new Error(edited.error);
    expect(edited.entry.reason).toBe("Edited after a refresh");
    // What the save writes is the trimmed log: the edited entry replaces the
    // newest one, the earlier round stays, and no entry nests the log.
    const stored = withoutSnapshotLog(edited.task);
    expect(stored.adjustments?.length).toBe(2);
    expect(stored.adjustments?.[0].reason).toBe(task.adjustments![0].reason);
    expect(stored.adjustments?.[1].reason).toBe("Edited after a refresh");
    expect(stored.adjustments?.every((entry) => !("adjustments" in entry.before))).toBe(true);
  });
});
