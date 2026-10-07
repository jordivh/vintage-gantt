import {
  addWorkingDays,
  isWorkingDay,
  workingDaysBetween,
  type CalendarSystem,
} from "./scheduling-engine";
import {
  dailyAllocation,
  hasAllocationSegments,
  normalizeDistribution,
  planFinishDate,
  recalculateTasks,
  settleMonitoringPlan,
  withCalculatedPlanningFields,
  workingDaysInRange,
  type AllocationSegment,
  type Distribution,
  type MarginAbsorption,
  type PlannerTask,
  type PlanMode,
  type TaskAdjustment,
} from "./planner-model";

/* --------------------------------------------------------------------------
 * Adjust remaining work (Monitoring mode)
 *
 * A running task's future work is re-planned from a chosen date onwards without
 * touching the hours already planned before it: everything up to and including
 * the keep-until date becomes a fixed segment (stored verbatim), and everything
 * after it becomes one new planned segment. This module is pure — it never
 * mutates its inputs and holds no UI or store logic, so the planner, the
 * capacity screen and the reports all read the same figures.
 * ------------------------------------------------------------------------ */

export interface AdjustmentInput {
  /** ISO date; the current plan is kept unchanged up to and including it. */
  keepUntil: string;
  /** Hours for the remainder (0 allowed). */
  remainingWork: number;
  /** ISO date; must be after the keep-until date. */
  newFinish: string;
  /** How the remaining hours are spread across the remaining working days. */
  distribution: Distribution;
  /** Why the plan changed; required. */
  reason: string;
}

export interface AdjustmentContext {
  system: CalendarSystem;
  projectCalendarId?: string;
  /** Whether the assigned resource can work on a date (leave/holiday → false). */
  isAvailable?: (date: string) => boolean;
  /** The hours the resource has on a date, for the preview's overload warnings. */
  availableHours?: (date: string) => number;
  /** Today's date, for the defaults and the started/completed gate. */
  today: string;
}

export interface AdjustmentActor {
  id: string;
  name: string;
}

const calendarIdOf = (task: PlannerTask, ctx: AdjustmentContext) =>
  task.calendarId ?? ctx.projectCalendarId ?? ctx.system.defaultCalendarId;

/** True for a well-formed ISO calendar date (yyyy-mm-dd). */
export const isIsoCalendarDate = (date: string | undefined): boolean => Boolean(date && /^\d{4}-\d{2}-\d{2}$/.test(date));

/**
 * The first working day strictly after `date`, on the task's calendar. Returns ""
 * for a missing or malformed date instead of stepping through dates forever — a
 * half-typed field in the dialog must never hang the planner.
 */
export function nextWorkingDayAfter(date: string, calendarId: string | undefined, system: CalendarSystem): string {
  if (!isIsoCalendarDate(date)) return "";
  return addWorkingDays(date, 1, calendarId, system);
}

/** Compact hour figure for display: rounded to at most 2 decimals. */
export function displayHours(hours: number): string {
  return String(Math.round(hours * 100) / 100);
}

/* ------------------------------------------------------------- availability */

/**
 * Whether the action may be used on a task right now. Planning mode never shows
 * it (workload and duration stay directly editable there), summary rows and
 * milestones have no remaining work, and only a task that has started and is not
 * completed can be adjusted.
 */
export function canAdjustTask(
  task: PlannerTask,
  mode: PlanMode,
  today: string,
  tasks: PlannerTask[] = [],
): string | null {
  if (mode !== "monitoring") return "Adjust remaining work is only available in Monitoring mode.";
  if (tasks.some((item) => item.parentId === task.id)) return "Summary rows roll up their children.";
  if (task.isMilestone || task.duration === 0) return "Milestones have no remaining work.";
  const started = task.actualStart ? task.actualStart <= today : task.start <= today;
  if (!started) return "This task has not started yet.";
  if ((task.percent ?? 0) >= 100 || Boolean(task.actualFinish)) return "This task is already completed.";
  return null;
}

/* ---------------------------------------------------------------- defaults */

export interface AdjustmentDefaults {
  keepUntil: string;
  remainingWork: number;
  newFinish: string;
  distribution: Distribution;
  remainingDays: number;
  totalWork: number;
  fixedHours: number;
}

/**
 * The dialog's starting values: keep until today (clamped into the task's own
 * span), the hours the current plan still has after that date, the task's current
 * finish and its current distribution profile.
 */
export function adjustmentDefaults(task: PlannerTask, ctx: AdjustmentContext): AdjustmentDefaults {
  const calendarId = calendarIdOf(task, ctx);
  const allocation = dailyAllocation(task, ctx.system, ctx.projectCalendarId, ctx.isAvailable);
  const today = ctx.today && ctx.today >= task.start && ctx.today <= task.finish ? ctx.today : task.start;
  const fixedHours = allocation.filter((entry) => entry.date <= today).reduce((sum, entry) => sum + entry.hours, 0);
  const totalWork = allocation.reduce((sum, entry) => sum + entry.hours, 0);
  const from = nextWorkingDayAfter(today, calendarId, ctx.system);
  return {
    keepUntil: today,
    remainingWork: Math.max(0, totalWork - fixedHours),
    newFinish: task.finish,
    distribution: normalizeDistribution(task.distribution),
    remainingDays: workingDaysInRange(from, task.finish, calendarId, ctx.system).length,
    totalWork,
    fixedHours,
  };
}

/* -------------------------------------------------------------- validation */

/** The reason an adjustment is refused, or null when it may proceed. */
export function validateAdjustment(task: PlannerTask, input: AdjustmentInput, ctx: AdjustmentContext): string | null {
  const calendarId = calendarIdOf(task, ctx);
  if (!input.reason.trim()) return "Enter a reason for this adjustment.";
  if (!input.keepUntil || input.keepUntil < task.start) return `Keep current plan until must be on or after the task start (${task.start}).`;
  if (input.keepUntil > task.finish) return `Keep current plan until must not be later than the current finish (${task.finish}).`;
  if (!input.newFinish || !(input.newFinish > input.keepUntil)) return "New finish must be after the keep-until date.";
  if (input.remainingWork < 0) return "Remaining work cannot be negative.";
  const from = nextWorkingDayAfter(input.keepUntil, calendarId, ctx.system);
  if (from > input.newFinish) return "New finish must be after the keep-until date.";
  if (!workingDaysInRange(from, input.newFinish, calendarId, ctx.system).length) {
    return "There are no working days between the keep-until date and the new finish.";
  }
  return null;
}

/* ------------------------------------------------------------------- apply */

export interface AdjustmentOutcome {
  /** The adjusted task: fixed + planned segments, new finish, summed workload. */
  task: PlannerTask;
  fixedHours: number;
  fixedDays: number;
  remainingHours: number;
  remainingStart: string;
  remainingDays: number;
  oldWork: number;
  newWork: number;
  oldFinish: string;
  newFinish: string;
}

/**
 * Converts the task's current daily allocation up to and including the keep-until
 * date into a fixed segment (using the hours as they stand now) and replaces
 * everything after it with one new planned segment. The task's start is kept; its
 * finish becomes the new finish and its workload becomes fixed + remaining. The
 * input is never mutated.
 */
export function applyAdjustment(task: PlannerTask, input: AdjustmentInput, ctx: AdjustmentContext): AdjustmentOutcome {
  const calendarId = calendarIdOf(task, ctx);
  const current = dailyAllocation(task, ctx.system, ctx.projectCalendarId, ctx.isAvailable);
  const fixedDays = current
    .filter((entry) => entry.date <= input.keepUntil && entry.hours > 0)
    .map((entry) => ({ date: entry.date, hours: entry.hours }));
  const fixedHours = fixedDays.reduce((sum, day) => sum + day.hours, 0);
  const remainingStart = nextWorkingDayAfter(input.keepUntil, calendarId, ctx.system);
  const remainingDays = workingDaysInRange(remainingStart, input.newFinish, calendarId, ctx.system).length;
  const segments: AllocationSegment[] = [
    { kind: "fixed", days: fixedDays },
    { kind: "planned", hours: input.remainingWork, start: remainingStart, finish: input.newFinish, distribution: input.distribution },
  ];
  const newWork = fixedHours + Math.max(0, input.remainingWork);
  const duration = Math.max(1, workingDaysBetween(task.start, input.newFinish, calendarId, ctx.system));
  const adjusted: PlannerTask = {
    ...task,
    duration,
    durationUnit: "days",
    finish: input.newFinish,
    work: newWork,
    distribution: input.distribution,
    allocations: segments,
  };
  return {
    task: adjusted,
    fixedHours,
    fixedDays: fixedDays.length,
    remainingHours: Math.max(0, input.remainingWork),
    remainingStart,
    remainingDays,
    oldWork: current.reduce((sum, entry) => sum + entry.hours, 0),
    newWork,
    oldFinish: task.finish,
    newFinish: input.newFinish,
  };
}

/**
 * Schedules the candidate plan through the existing monitoring logic: the
 * adjusted task's finish move is absorbed by its own reserve first and only the
 * excess passes to its successors. Returns the whole task list, recalculated and
 * with planning fields filled in.
 */
export function settleAdjustment(
  tasks: PlannerTask[],
  adjustedTask: PlannerTask,
  ctx: AdjustmentContext,
  taskId: string,
): { change: MarginAbsorption | null; scheduled: PlannerTask[] } {
  const candidate = tasks.map((item) => (item.id === taskId ? adjustedTask : item));
  const settled = settleMonitoringPlan(tasks, candidate, {
    calendarSystem: ctx.system,
    projectCalendarId: ctx.projectCalendarId,
    anchoredTaskIds: [taskId],
  });
  const change = settled.changes.find((entry) => entry.taskId === taskId) ?? null;
  const result = recalculateTasks(settled.tasks, {
    direction: "forward",
    calendarSystem: ctx.system,
    projectCalendarId: ctx.projectCalendarId,
  });
  const scheduled = result.error
    ? settled.tasks
    : withCalculatedPlanningFields(result.tasks, ctx.system, ctx.projectCalendarId);
  return { change, scheduled };
}

/* ---------------------------------------------------------------- preview */

export interface OverloadedDay {
  date: string;
  hours: number;
  available: number;
}

export interface AdjustmentPreview {
  keepUntil: string;
  fixedHours: number;
  fixedDays: number;
  remainingHours: number;
  remainingStart: string;
  remainingDays: number;
  hoursPerDay: number;
  oldFinish: string;
  newFinish: string;
  oldWork: number;
  newWork: number;
  baselineWork: number | null;
  workDeviation: number | null;
  marginConsumed: number;
  marginReturned: number;
  daysPushed: number;
  projectFinishBefore: string;
  projectFinishAfter: string;
  overloadedDays: OverloadedDay[];
}

function buildPreview(
  tasks: PlannerTask[],
  task: PlannerTask,
  input: AdjustmentInput,
  ctx: AdjustmentContext,
  outcome: AdjustmentOutcome,
  change: MarginAbsorption | null,
  scheduled: PlannerTask[],
  baselineWork: number | undefined,
): AdjustmentPreview {
  const allocation = dailyAllocation(outcome.task, ctx.system, ctx.projectCalendarId, ctx.isAvailable);
  const available = ctx.availableHours;
  const overloadedDays = available
    ? allocation
        .filter((entry) => entry.hours > 0 && entry.hours > available(entry.date) + 1e-9)
        .map((entry) => ({ date: entry.date, hours: entry.hours, available: available(entry.date) }))
    : [];
  return {
    keepUntil: input.keepUntil,
    fixedHours: outcome.fixedHours,
    fixedDays: outcome.fixedDays,
    remainingHours: outcome.remainingHours,
    remainingStart: outcome.remainingStart,
    remainingDays: outcome.remainingDays,
    hoursPerDay: outcome.remainingDays > 0 ? outcome.remainingHours / outcome.remainingDays : 0,
    oldFinish: task.finish,
    newFinish: input.newFinish,
    oldWork: outcome.oldWork,
    newWork: outcome.newWork,
    baselineWork: baselineWork ?? null,
    workDeviation: baselineWork === undefined ? null : outcome.newWork - baselineWork,
    marginConsumed: change?.absorbed ?? 0,
    marginReturned: change?.returned ?? 0,
    daysPushed: change?.passed ?? 0,
    projectFinishBefore: planFinishDate(tasks),
    projectFinishAfter: planFinishDate(scheduled),
    overloadedDays,
  };
}

/**
 * The live figures the dialog shows before confirming. Works even while the
 * draft is still invalid, so the numbers update as the user types; the caller
 * disables Apply until `validateAdjustment` returns null.
 */
export function previewAdjustment(
  tasks: PlannerTask[],
  taskId: string,
  input: AdjustmentInput,
  ctx: AdjustmentContext,
  baselineWork?: number,
): AdjustmentPreview | null {
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return null;
  const outcome = applyAdjustment(task, input, ctx);
  const { change, scheduled } = settleAdjustment(tasks, outcome.task, ctx, taskId);
  return buildPreview(tasks, task, input, ctx, outcome, change, scheduled, baselineWork);
}

/* ------------------------------------------------------------------- plan */

function beforeSnapshot(task: PlannerTask): TaskAdjustment["before"] {
  return {
    allocations: task.allocations,
    adjustments: task.adjustments,
    work: task.work,
    duration: task.duration,
    durationUnit: task.durationUnit,
    finish: task.finish,
    marginPct: task.marginPct,
    marginDaysOriginal: task.marginDaysOriginal,
    marginDaysConsumed: task.marginDaysConsumed,
  };
}

export interface AdjustmentPlan {
  /** The adjusted task, its log entry already attached. */
  task: PlannerTask;
  /** The whole version, settled, with the adjusted task carrying its log entry. */
  scheduled: PlannerTask[];
  preview: AdjustmentPreview;
  entry: TaskAdjustment;
}

export interface PlanAdjustmentOptions {
  baselineWork?: number;
  actor: AdjustmentActor;
  /** ISO timestamp; supplied by the caller so a test can be deterministic. */
  at: string;
}

/**
 * The full result of confirming the dialog: the adjusted task, the settled task
 * list and the log entry (with the margin absorbed and the days passed on). It
 * refuses an invalid draft with the same message the dialog shows.
 */
export function planAdjustment(
  tasks: PlannerTask[],
  taskId: string,
  input: AdjustmentInput,
  ctx: AdjustmentContext,
  options: PlanAdjustmentOptions,
): AdjustmentPlan | { error: string } {
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return { error: "Task not found." };
  const invalid = validateAdjustment(task, input, ctx);
  if (invalid) return { error: invalid };
  const outcome = applyAdjustment(task, input, ctx);
  const { change, scheduled } = settleAdjustment(tasks, outcome.task, ctx, taskId);
  const preview = buildPreview(tasks, task, input, ctx, outcome, change, scheduled, options.baselineWork);
  const entry: TaskAdjustment = {
    id: `adj-${taskId}-${options.at}`,
    at: options.at,
    userId: options.actor.id,
    userName: options.actor.name,
    keepUntil: input.keepUntil,
    oldFinish: task.finish,
    newFinish: input.newFinish,
    oldWork: outcome.oldWork,
    newWork: outcome.newWork,
    marginConsumed: change?.absorbed ?? 0,
    daysPushed: change?.passed ?? 0,
    reason: input.reason.trim(),
    before: beforeSnapshot(task),
  };
  const adjusted: PlannerTask = { ...outcome.task, adjustments: [...(task.adjustments ?? []), entry] };
  return {
    task: adjusted,
    scheduled: scheduled.map((item) => (item.id === taskId ? adjusted : item)),
    preview,
    entry,
  };
}

/* -------------------------------------------------------------------- undo */

/**
 * Restores the task to exactly the state it had immediately before its most
 * recent adjustment — including its segments, workload, finish, margin figures
 * and the log without that last entry. Older adjustments are kept. Returns null
 * when there is nothing to undo.
 */
export function undoLastAdjustment(task: PlannerTask): PlannerTask | null {
  const log = task.adjustments ?? [];
  const last = log[log.length - 1];
  if (!last) return null;
  const restored: PlannerTask = {
    ...task,
    work: last.before.work,
    duration: last.before.duration,
    durationUnit: last.before.durationUnit,
    finish: last.before.finish,
    marginPct: last.before.marginPct,
    marginDaysOriginal: last.before.marginDaysOriginal,
    marginDaysConsumed: last.before.marginDaysConsumed,
  };
  if (last.before.allocations === undefined) delete restored.allocations;
  else restored.allocations = last.before.allocations;
  const remainingLog = log.slice(0, -1);
  if (remainingLog.length === 0) delete restored.adjustments;
  else restored.adjustments = remainingLog;
  return restored;
}

/* --------------------------------------------------------------- display */

/** The last fixed date of an adjusted task, or null when it has none. */
export function fixedUntil(task: PlannerTask): string | null {
  let latest = "";
  for (const segment of task.allocations ?? []) {
    if (segment.kind !== "fixed") continue;
    for (const day of segment.days ?? []) if (day.date > latest) latest = day.date;
  }
  return latest || null;
}

/**
 * Fixed days that have since stopped being working days (a calendar change, a
 * holiday or leave added later). The stored hours stay exactly where they are;
 * this is what the planner warns about instead of moving them.
 */
export function fixedDaysOnNonWorkingDays(
  task: PlannerTask,
  system: CalendarSystem,
  projectCalendarId?: string,
): string[] {
  if (!hasAllocationSegments(task)) return [];
  const calendarId = task.calendarId ?? projectCalendarId ?? system.defaultCalendarId;
  const dates = new Set<string>();
  for (const segment of task.allocations ?? []) {
    if (segment.kind !== "fixed") continue;
    for (const day of segment.days ?? []) if (day.hours > 0 && !isWorkingDay(day.date, calendarId, system)) dates.add(day.date);
  }
  return [...dates].sort();
}

export interface SegmentSummary {
  kind: "fixed" | "planned";
  hours: number;
  start: string;
  finish: string;
  days: number;
  distribution?: Distribution;
}

/** One line per stored segment, for the task detail panel. */
export function allocationSegments(
  task: PlannerTask,
  system: CalendarSystem,
  projectCalendarId?: string,
): SegmentSummary[] {
  const calendarId = task.calendarId ?? projectCalendarId ?? system.defaultCalendarId;
  return (task.allocations ?? []).map((segment) => {
    const days = segment.days ?? [];
    const hours = segment.kind === "fixed"
      ? days.reduce((sum, day) => sum + day.hours, 0)
      : Math.max(0, segment.hours ?? 0);
    const start = segment.kind === "fixed"
      ? days.reduce((earliest, day) => (day.date < earliest ? day.date : earliest), days[0]?.date ?? "")
      : segment.start ?? "";
    const finish = segment.kind === "fixed"
      ? days.reduce((latest, day) => (day.date > latest ? day.date : latest), days[0]?.date ?? "")
      : segment.finish ?? "";
    return {
      kind: segment.kind,
      hours,
      start,
      finish,
      days: segment.kind === "fixed"
        ? days.filter((day) => day.hours > 0).length
        : workingDaysInRange(segment.start, segment.finish, calendarId, system).length,
      distribution: segment.distribution,
    };
  });
}
