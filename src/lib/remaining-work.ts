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

/**
 * The finish the adjustment will actually use. A later new finish wins; an empty
 * one, or one that is not after the keep-until date, means the task ends on the
 * keep-until date itself — which is exactly what a 0 h remainder does.
 */
export function normalizedFinish(input: AdjustmentInput): string {
  return isIsoCalendarDate(input.newFinish) && input.newFinish >= input.keepUntil ? input.newFinish : input.keepUntil;
}

/**
 * The reason an adjustment is refused, or null when it may proceed. A 0 h
 * remainder is valid and needs no working day after the keep-until date; only a
 * positive remainder has to have somewhere to put its hours.
 */
export function validateAdjustment(task: PlannerTask, input: AdjustmentInput, ctx: AdjustmentContext): string | null {
  const calendarId = calendarIdOf(task, ctx);
  if (!isIsoCalendarDate(input.keepUntil)) return "Choose a keep-until date.";
  if (!input.reason.trim()) return "Enter a reason for this adjustment.";
  if (input.keepUntil < task.start) return `Keep current plan until must be on or after the task start (${task.start}).`;
  if (input.keepUntil > task.finish) return `Keep current plan until must not be later than the current finish (${task.finish}).`;
  if (!Number.isFinite(input.remainingWork) || input.remainingWork < 0) return "Remaining work cannot be negative.";
  const finish = normalizedFinish(input);
  if (input.remainingWork > 0) {
    if (!(finish > input.keepUntil)) return "New finish must be after the keep-until date.";
    const from = nextWorkingDayAfter(input.keepUntil, calendarId, ctx.system);
    if (!from || from > finish) return "New finish must be after the keep-until date.";
    if (!workingDaysInRange(from, finish, calendarId, ctx.system).length) {
      return "There are no working days between the keep-until date and the new finish.";
    }
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
  const finish = normalizedFinish(input);
  const remainingStart = nextWorkingDayAfter(input.keepUntil, calendarId, ctx.system);
  const remainingDays = workingDaysInRange(remainingStart, finish, calendarId, ctx.system).length;
  const remainingHours = Math.max(0, input.remainingWork);
  // With no remaining work the planned segment is empty: it carries no hours and
  // the task simply ends on the keep-until date (or on the later new finish).
  const segments: AllocationSegment[] = [
    { kind: "fixed", days: fixedDays },
    { kind: "planned", hours: remainingHours, start: remainingStart, finish, distribution: input.distribution },
  ];
  const newWork = fixedHours + remainingHours;
  const duration = Math.max(1, workingDaysBetween(task.start, finish, calendarId, ctx.system));
  const adjusted: PlannerTask = {
    ...task,
    duration,
    durationUnit: "days",
    finish,
    work: newWork,
    distribution: input.distribution,
    allocations: segments,
  };
  return {
    task: adjusted,
    fixedHours,
    fixedDays: fixedDays.length,
    remainingHours,
    remainingStart,
    remainingDays,
    oldWork: current.reduce((sum, entry) => sum + entry.hours, 0),
    newWork,
    oldFinish: task.finish,
    newFinish: finish,
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
    newFinish: outcome.newFinish,
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

/**
 * Merges the settled task into the planned one: the new segments, workload and
 * finish come from the plan, while the margin bookkeeping comes from the settled
 * result — so the returned task list and the returned task can never disagree.
 */
function withLogAndMargin(scheduled: PlannerTask[], planned: PlannerTask, taskId: string, log: TaskAdjustment[]): PlannerTask {
  const settled = scheduled.find((item) => item.id === taskId);
  return {
    ...planned,
    ...(settled ? { marginDaysOriginal: settled.marginDaysOriginal, marginDaysConsumed: settled.marginDaysConsumed } : {}),
    adjustments: log,
  };
}

function beforeSnapshot(task: PlannerTask): TaskAdjustment["before"] {
  return {
    allocations: task.allocations,
    work: task.work,
    duration: task.duration,
    durationUnit: task.durationUnit,
    finish: task.finish,
    distribution: task.distribution,
    marginPct: task.marginPct,
    marginDaysOriginal: task.marginDaysOriginal,
    marginDaysConsumed: task.marginDaysConsumed,
  };
}

/**
 * Drops a copy of the log that an earlier version stored inside every entry's
 * `before` snapshot.
 *
 * The snapshot only has to put task fields back; the log itself lives in
 * `PlannerTask.adjustments`. Storing it per entry nested a copy of every
 * earlier entry (and its snapshot) in each new one, so the stored task doubled
 * with every adjustment until the workspace save grew past what the database
 * accepts and the whole save was refused. Nothing reads the nested copy, so it
 * is removed on the way in and on the way out.
 */
export function withoutSnapshotLog(task: PlannerTask): PlannerTask {
  const log = task.adjustments;
  if (!log?.length) return task;
  const carriesLog = (entry: TaskAdjustment) => (entry.before as { adjustments?: unknown }).adjustments !== undefined;
  if (!log.some(carriesLog)) return task;
  const withoutNestedLog = (before: TaskAdjustment["before"]): TaskAdjustment["before"] => {
    const copy: Record<string, unknown> = { ...before };
    delete copy.adjustments;
    return copy as unknown as TaskAdjustment["before"];
  };
  return {
    ...task,
    adjustments: log.map((entry) => (carriesLog(entry) ? { ...entry, before: withoutNestedLog(entry.before) } : entry)),
  };
}

/** Puts back everything a removal has to restore, and nothing else. */
function restoreFrom(task: PlannerTask, before: TaskAdjustment["before"]): PlannerTask {
  const restored: PlannerTask = {
    ...task,
    work: before.work,
    duration: before.duration,
    durationUnit: before.durationUnit,
    finish: before.finish,
    distribution: before.distribution,
    marginPct: before.marginPct,
    marginDaysOriginal: before.marginDaysOriginal,
    marginDaysConsumed: before.marginDaysConsumed,
  };
  if (before.allocations === undefined) delete restored.allocations;
  else restored.allocations = before.allocations;
  return restored;
}

/** The index of the newest adjustment that has not been removed, or -1. */
function lastActiveIndex(log: TaskAdjustment[]): number {
  for (let index = log.length - 1; index >= 0; index -= 1) if (!log[index].removedAt) return index;
  return -1;
}

/** The newest adjustment that has not been removed, or null. */
export function lastActiveAdjustment(task: PlannerTask): TaskAdjustment | null {
  const log = task.adjustments ?? [];
  const index = lastActiveIndex(log);
  return index < 0 ? null : log[index];
}

/** The removal record written onto an entry: who removed it, and when. */
function removalRecord(entry: TaskAdjustment, actor: AdjustmentActor, at: string): TaskAdjustment {
  return { ...entry, removedAt: at, removedByUserId: actor.id, removedByName: actor.name };
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
    newFinish: outcome.newFinish,
    oldWork: outcome.oldWork,
    newWork: outcome.newWork,
    marginConsumed: change?.absorbed ?? 0,
    daysPushed: change?.passed ?? 0,
    reason: input.reason.trim(),
    before: beforeSnapshot(task),
  };
  const adjusted = withLogAndMargin(scheduled, outcome.task, taskId, [...(task.adjustments ?? []), entry]);
  return {
    task: adjusted,
    scheduled: scheduled.map((item) => (item.id === taskId ? adjusted : item)),
    preview,
    entry,
  };
}

/* ------------------------------------------------ removal and editing */

/**
 * Restores the task to exactly the state before an adjustment without recording
 * anything. Used by the edit path, which immediately writes a fresh adjustment;
 * removal goes through `removeLastAdjustment` so the history is kept.
 */
export function undoLastAdjustment(task: PlannerTask): PlannerTask | null {
  const log = task.adjustments ?? [];
  const index = lastActiveIndex(log);
  if (index < 0) return null;
  const restored = restoreFrom(task, log[index].before);
  const remaining = log.filter((_, position) => position !== index);
  if (remaining.length === 0) delete restored.adjustments;
  else restored.adjustments = remaining;
  return restored;
}

/**
 * Removes the most recent adjustment: the task goes back to exactly the state it
 * had before that one (segments, daily hours, workload, finish, distribution,
 * margin figures). The entry itself stays in the log, marked as removed by whom
 * and when, so nothing is silently lost. Returns null when there is no active
 * adjustment to remove.
 */
export function removeLastAdjustment(task: PlannerTask, actor: AdjustmentActor, at: string): PlannerTask | null {
  const log = task.adjustments ?? [];
  const index = lastActiveIndex(log);
  if (index < 0) return null;
  const restored = restoreFrom(task, log[index].before);
  return { ...restored, adjustments: log.map((entry, position) => (position === index ? removalRecord(entry, actor, at) : entry)) };
}

/**
 * Removes every adjustment: the task goes back to its state before the first
 * one — a single planned segment, the original workload (editable again) and no
 * fixed part. Every entry stays in the log, marked as removed.
 */
export function removeAllAdjustments(task: PlannerTask, actor: AdjustmentActor, at: string): PlannerTask | null {
  const log = task.adjustments ?? [];
  const active = log.filter((entry) => !entry.removedAt);
  if (!active.length) return null;
  const restored = restoreFrom(task, active[0].before);
  return { ...restored, adjustments: log.map((entry) => (entry.removedAt ? entry : removalRecord(entry, actor, at))) };
}

/**
 * Re-opens the most recent adjustment: the task returns to the state before it,
 * and a fresh adjustment is planned in its place with the same keep-until date.
 * The entry is replaced (its `before` snapshot is identical), so the log stays a
 * faithful record of what the task looked like beforehand.
 */
export function editLastAdjustment(
  tasks: PlannerTask[],
  taskId: string,
  input: AdjustmentInput,
  ctx: AdjustmentContext,
  options: PlanAdjustmentOptions,
): AdjustmentPlan | { error: string } {
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return { error: "Task not found." };
  const log = task.adjustments ?? [];
  const index = lastActiveIndex(log);
  if (index < 0) return { error: "There is no adjustment to edit." };
  // The keep-until date belongs to the adjustment; changing it is a new one.
  const edited: AdjustmentInput = { ...input, keepUntil: log[index].keepUntil };
  const base: PlannerTask = { ...restoreFrom(task, log[index].before), adjustments: log.filter((_, position) => position !== index) };
  if (!base.adjustments?.length) delete base.adjustments;
  const invalid = validateAdjustment(base, edited, ctx);
  if (invalid) return { error: invalid };
  const outcome = applyAdjustment(base, edited, ctx);
  const { change, scheduled } = settleAdjustment(tasks, outcome.task, ctx, taskId);
  const preview = buildPreview(tasks, base, edited, ctx, outcome, change, scheduled, options.baselineWork);
  const entry: TaskAdjustment = {
    id: log[index].id,
    at: options.at,
    userId: options.actor.id,
    userName: options.actor.name,
    keepUntil: edited.keepUntil,
    oldFinish: base.finish,
    newFinish: outcome.newFinish,
    oldWork: outcome.oldWork,
    newWork: outcome.newWork,
    marginConsumed: change?.absorbed ?? 0,
    daysPushed: change?.passed ?? 0,
    reason: edited.reason.trim(),
    before: beforeSnapshot(base),
  };
  const adjusted = withLogAndMargin(scheduled, outcome.task, taskId, [...(base.adjustments ?? []), entry]);
  return {
    task: adjusted,
    scheduled: scheduled.map((item) => (item.id === taskId ? adjusted : item)),
    preview,
    entry,
  };
}

/* ------------------------------------------------------ removal preview */

export interface RemovalSuccessor {
  taskId: string;
  name: string;
  oldStart: string;
  oldFinish: string;
  newStart: string;
  newFinish: string;
}

export interface RemovalPreview {
  mode: "last" | "all";
  /** How many log entries the removal marks. */
  removed: number;
  finish: string;
  work: number;
  /** Working days given back to the task's own reserve. */
  marginReturned: number;
  /** Successors whose dates move back, with both dates. */
  successors: RemovalSuccessor[];
  projectFinishBefore: string;
  projectFinishAfter: string;
}

/**
 * What a removal would restore, before it is confirmed: the earlier finish and
 * workload, the margin the task gets back and the successors that move back.
 */
export function previewRemoval(
  tasks: PlannerTask[],
  taskId: string,
  ctx: AdjustmentContext,
  mode: "last" | "all",
): RemovalPreview | null {
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return null;
  const log = task.adjustments ?? [];
  const restored = mode === "all"
    ? removeAllAdjustments(task, { id: "preview", name: "preview" }, "")
    : removeLastAdjustment(task, { id: "preview", name: "preview" }, "");
  if (!restored) return null;
  const { change, scheduled } = settleAdjustment(tasks, restored, ctx, taskId);
  const successors: RemovalSuccessor[] = tasks
    .filter((item) => item.id !== taskId)
    .map((item) => {
      const after = scheduled.find((candidate) => candidate.id === item.id);
      if (!after || (after.start === item.start && after.finish === item.finish)) return null;
      return { taskId: item.id, name: item.name, oldStart: item.start, oldFinish: item.finish, newStart: after.start, newFinish: after.finish };
    })
    .filter((item): item is RemovalSuccessor => item !== null);
  return {
    mode,
    removed: mode === "all" ? log.filter((entry) => !entry.removedAt).length : 1,
    finish: restored.finish,
    work: restored.work ?? 0,
    marginReturned: change?.returned ?? 0,
    successors,
    projectFinishBefore: planFinishDate(tasks),
    projectFinishAfter: planFinishDate(scheduled),
  };
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
