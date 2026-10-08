import {
  addWorkingDays,
  durationInWorkingDays,
  earliestDependencyStart,
  ensureWorkingDay,
  workingDaysBetween,
  type CalendarSystem,
} from "./scheduling-engine";
import {
  dailyAllocation,
  dependenciesForTasks,
  planFinishDate,
  recalculateTasks,
  taskWorkingDates,
  withCalculatedPlanningFields,
  type PlannerTask,
  type PlanMode,
} from "./planner-model";
import { availableHours } from "./resource-capacity";
import {
  aggregatePeriods,
  computeResourceLoads,
  type CapacityProjectInput,
} from "./capacity-engine";
import { shiftDays, weekEnd, weekStart } from "./capacity-period";

/* --------------------------------------------------------------------------
 * Resource optimization (BES-009)
 *
 * A pure, deterministic advisor for the Gantt view. It may move the tasks of one
 * project (the open one, active version) and extend their duration, so that every
 * employee sits as close as possible to 90% occupancy per week, never above 100%
 * because of a task of that project.
 *
 * It calculates nothing of its own. Float and the critical path come from the
 * planner's own `withCalculatedPlanningFields` (CPM), the plan is re-scheduled by
 * the planner's `recalculateTasks`, and the per-employee weekly occupancy is the
 * very picture the Capacity screen shows — `computeResourceLoads` over every
 * project's active version, aggregated into weeks by `aggregatePeriods` — so the
 * advisor and the capacity screen can never disagree. Workload of all other
 * projects is counted but never changed: only the open project's rows are ever
 * touched.
 *
 * WHAT MAY CHANGE — and nothing else:
 *  - a task's start date, with the start intent (`startConstraint`) that keeps a
 *    deliberately later start — the same field a manual drag writes;
 *  - a task's duration, and only upwards, never above +50% of the duration it had
 *    before this run. Work hours are stored separately from duration (`work`,
 *    spread over the task's working days by `dailyAllocation`), so extending a
 *    duration re-spreads exactly the same hours over more days and can never
 *    change the task's total work. `workHoursPreserved` reports that check.
 *
 * WHAT MAY NEVER CHANGE:
 *  - durations downwards, resource assignments, dependencies, margin;
 *  - a task a user marked "Fixed date": a fixed milestone keeps its exact date,
 *    not even a critical-path move may shift it;
 *  - in Monitoring mode, a task that has started (or therefore lies in the past).
 *
 * SCOPE — what a run looks at, and nothing else:
 *  - employees: only those assigned to at least one task of the open project;
 *  - weeks: only whole weeks a task of the open project could actually be placed
 *    in — from the earliest allowed start to the latest allowed end of its
 *    movable tasks — plus the weeks the project already books work in;
 *  - other projects: counted for exactly those employees and weeks, and loaded
 *    once at the start because nothing this run does can change them.
 *
 * A task always stays one continuous block: a change is a whole-start-date shift
 * and/or a duration extension, snapped to a working day, and a task can never
 * start before its dependencies allow.
 *
 * PRIORITIES, in this order (the score is compared lexicographically):
 *  1. no employee above 100% in any week (hours over capacity);
 *  2. fixed milestones keep their date;
 *  3. float before the critical path — the project end may only move later when
 *     the 100% limit cannot be met otherwise, and then as little as possible;
 *  4. weekly occupancy per employee as close to 90% as possible;
 *  5. as few changes as possible — fewer tasks changed, smaller moves and
 *     smaller extensions.
 * The same input always gives the same result: the search is ordered, bounded and
 * free of any clock or random value.
 *
 * HOW IT CALCULATES — a step-by-step walk, never all combinations:
 *  - everything is prepared once: the dependency order, each task's earliest and
 *    latest allowed start, and the weekly hours per relevant employee as plain
 *    numbers (including every other project's share);
 *  - the movable tasks are then walked one at a time in dependency order, the
 *    tasks sitting in a week above 100 % first. For each task only its own
 *    allowed window is tried — every working day as a start and the duration
 *    steps up to +50 % — and only that one task's hours are swapped, never the
 *    whole plan;
 *  - per task the best-scoring option wins; equal scores lose to the smaller
 *    change, and a tie is still broken by task id, so the result is stable;
 *  - a window is refreshed only for the tasks that depend on one that moved;
 *  - after the walk, at most three improvement rounds per phase, and a round that
 *    brings no improvement ends its phase;
 *  - the whole run is bounded: a hard option ceiling and a 10-second wall clock,
 *    after which the best valid plan so far is returned and marked as such.
 * The page never waits for it: the run is a background worker job.
 */

export const OCCUPANCY_TARGET = 0.9;
export const OCCUPANCY_LIMIT = 1;
/** A week counts as "far from the target" once it is this far below 90%. */
export const OFF_TARGET_MARGIN = 0.1;
/** A duration may grow by at most this factor of what it was before the run. */
export const EXTENSION_LIMIT = 1.5;

/**
 * The duration steps one option may try, as a share of the duration a task had
 * before the run: 100 %, 110 %, 120 %, 130 %, 140 %, 150 %. Rounded to the task's
 * own unit, never shorter and never past the +50 % cap.
 */
export const DURATION_STEPS = [1, 1.1, 1.2, 1.3, 1.4, 1.5] as const;

const EPSILON = 1e-9;

/**
 * Where a run spends its time. Reported so a slow project can be diagnosed, and
 * so a slow phase can be measured instead of guessed at.
 */
export interface OptimizeTimings {
  /** Window, weekly numbers and task order — everything a search needs up front. */
  prepareMs: number;
  /** The whole search for improvements. */
  optimizeMs: number;
  /** Turning the result into the preview payload (rows, warnings, checks). */
  reportMs: number;
  totalMs: number;
  /**
   * How many options were scored. Each one only swaps that task's own weekly
   * hours, so this stays small and grows with the tasks, not with their
   * combinations.
   */
  evaluations: number;
}

/** A progress message of a running optimization, for a background worker. */
export interface OptimizeProgress {
  phase: "preparing" | "optimizing" | "reporting";
  /** How far the phase is, 0…1. */
  ratio: number;
  message: string;
}

/** Wall-clock reading. Never decides anything unless a limit explicitly allows it. */
const clock = (): number => (typeof performance === "undefined" ? Date.now() : performance.now());

export const OPTIMIZE_DEFAULTS = {
  /**
   * The walk over all movable tasks, then at most this many improvement rounds
   * per phase. A round that changes nothing better is rolled back and ends its
   * phase, so the search stops on its own — every loop here has a maximum.
   */
  maxIterations: 3,
  /** Working days a single candidate may shift, either way. */
  maxShiftDays: 10,
  /**
   * Duration steps considered per task (the +50% cap is always considered too),
   * so a long task does not explode the option set. 0 turns duration
   * extension off and leaves the optimizer to moving tasks only.
   */
  maxExtensionDays: 8,
  /**
   * Hard ceiling on scored options, so a very large plan still answers quickly.
   * It only ever stops the search early: whatever has been found by then is a
   * valid plan, reported as possibly not optimal, and the same input still gives
   * the same result.
   */
  maxEvaluations: 8000,
  /**
   * Wall-clock budget for one run. When it is used up the search stops and the
   * best valid plan found so far is returned, marked as not necessarily optimal.
   */
  timeLimitMs: 10000,
};

/* ------------------------------------------------------------------- input */

export interface OptimizeProjectInput {
  projectId: string;
  projectName: string;
  projectCalendarId?: string;
  /** The project's active plan version only — never more than one version. */
  tasks: PlannerTask[];
}

export interface OptimizeResource {
  id: string;
  name: string;
  hoursPerWeek: number;
  calendarId: string;
}

export interface OptimizeAssignment {
  taskId: string;
  resourceId: string;
}

export interface OptimizeLimits {
  maxIterations?: number;
  maxShiftDays?: number;
  maxExtensionDays?: number;
  maxEvaluations?: number;
  /** Wall-clock budget of one run; the search stops when it is used up. */
  timeLimitMs?: number;
}

export interface OptimizeInput {
  /** The only project whose tasks may move or grow. */
  projectId: string;
  /** Every regular project of the company, each with its active-version tasks. */
  projects: OptimizeProjectInput[];
  resources: OptimizeResource[];
  assignments: OptimizeAssignment[];
  system: CalendarSystem;
  /** The open version's mode decides which tasks are fixed. */
  mode: PlanMode;
  /** ISO date of "now": in Monitoring, a task that started is fixed. */
  today: string;
  /** The milestones the user marked "Fixed date" in the settings dialog. */
  fixedMilestoneIds?: string[];
  limits?: OptimizeLimits;
  /**
   * Progress of a running optimization. Called a bounded number of times, so a
   * background worker can show "Optimizing…" and how far the run has come.
   */
  onProgress?: (progress: OptimizeProgress) => void;
}

/* ------------------------------------------------------------------ output */

/** How a changed task changed. */
export type OptimizeChangeKind = "moved" | "extended" | "both";

export interface OptimizeMove {
  taskId: string;
  taskName: string;
  oldStart: string;
  oldFinish: string;
  newStart: string;
  newFinish: string;
  /** Working days the task moved: positive is later, negative is earlier. */
  shiftDays: number;
  /** Working days of float the move used (later moves only). */
  floatUsed: number;
  /** Float the task had before any change. */
  floatAvailable: number;
  /** Whether the task sat on the critical path before any change. */
  critical: boolean;
  oldDuration: number;
  newDuration: number;
  /** Extra duration, in the task's own unit (working days for a day task). */
  extensionDays: number;
  /** Extension as a whole percentage of the duration before this run. */
  extensionPct: number;
  /** The task's total work hours before and after — equal for every extension. */
  oldWork: number;
  newWork: number;
  changeKind: OptimizeChangeKind;
  /** True when the changed row is a milestone. */
  milestone: boolean;
}

/** One milestone of the open project, and what this run did to it. */
export interface OptimizeMilestone {
  taskId: string;
  name: string;
  oldDate: string;
  newDate: string;
  /** Marked "Fixed date" for this run; its date is untouched by definition. */
  fixed: boolean;
  moved: boolean;
}

/** A problem the rules could not solve, naming the rule that stood in the way. */
export interface OptimizeBlocker {
  kind: "fixed-milestone" | "extension-limit";
  /** The fixed milestone that had to stay put, when `kind` is fixed-milestone. */
  milestoneId?: string;
  milestoneName?: string;
  milestoneDate?: string;
  /** Tasks that already use the whole +50% extension, for the limit warning. */
  taskIds: string[];
  taskNames: string[];
  resourceIds: string[];
  resourceNames: string[];
  /** Monday ISO dates of the weeks involved. */
  weeks: string[];
  reason: string;
}

export interface OptimizeWeekOccupancy {
  weekStart: string;
  weekEnd: string;
  available: number;
  before: number;
  after: number;
}

export interface OptimizeResourceOccupancy {
  resourceId: string;
  resourceName: string;
  weeks: OptimizeWeekOccupancy[];
}

export type OptimizeIssueKind = "over-capacity" | "off-target";

export interface OptimizeUnresolved {
  kind: OptimizeIssueKind;
  resourceId: string;
  resourceName: string;
  weekStart: string;
  weekEnd: string;
  allocated: number;
  available: number;
  /** allocated ÷ available, or null when the week has no availability at all. */
  occupancy: number | null;
  reason: string;
}

/**
 * The leftover warnings of one employee. The preview shows one entry per
 * employee instead of one per week, so a long run stays readable.
 */
export interface OptimizeWarningGroup {
  resourceId: string;
  resourceName: string;
  /** Weeks of this employee that are still above the 100% limit. */
  overCapacity: number;
  /** The weeks that still need attention, in date order. */
  weeks: OptimizeUnresolved[];
}

/**
 * The unresolved weeks grouped per employee: the most overloaded employee first,
 * then by name. Grouping is presentation only — every week keeps its own figures
 * and its own reason.
 */
export function groupUnresolvedWeeks(problems: OptimizeUnresolved[]): OptimizeWarningGroup[] {
  const groups = new Map<string, OptimizeWarningGroup>();
  for (const problem of problems) {
    const group = groups.get(problem.resourceId) ?? {
      resourceId: problem.resourceId,
      resourceName: problem.resourceName,
      overCapacity: 0,
      weeks: [],
    };
    if (problem.kind === "over-capacity") group.overCapacity += 1;
    group.weeks.push(problem);
    groups.set(problem.resourceId, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, weeks: [...group.weeks].sort((left, right) => left.weekStart.localeCompare(right.weekStart)) }))
    .sort((left, right) => right.overCapacity - left.overCapacity || left.resourceName.localeCompare(right.resourceName) || left.resourceId.localeCompare(right.resourceId));
}

export interface OptimizationPlan {
  ok: true;
  moves: OptimizeMove[];
  /** True when at least one task that was on the critical path changed. */
  movedCriticalTasks: boolean;
  /** Every milestone of the open project, fixed or not, and its date. */
  milestones: OptimizeMilestone[];
  /** The milestones that were fixed for this run. */
  fixedMilestoneIds: string[];
  oldProjectFinish: string;
  newProjectFinish: string;
  /** Signed change of the project end date, in working days. */
  finishDeltaWorkingDays: number;
  /**
   * Weekly occupancy per employee, before and after, including other projects —
   * only the employees of this project and only the weeks it could use.
   */
  occupancy: OptimizeResourceOccupancy[];
  /**
   * Weeks still above 100% or far from 90% that are relevant to this project,
   * each with a reason. Only weeks it has work in or could place work in.
   */
  unresolved: OptimizeUnresolved[];
  /** Warnings caused by fixed milestones or by the +50% extension limit. */
  blockers: OptimizeBlocker[];
  /**
   * True when every extended task still holds exactly its work hours — the
   * guarantee that extending spreads the same work over more days.
   */
  workHoursPreserved: boolean;
  /** The open project's tasks with the changes applied, same ids, ready to version. */
  tasks: PlannerTask[];
  /** Where the run spent its time. */
  timings: OptimizeTimings;
  /**
   * True when a limit stopped the search early — the 10-second wall clock or the
   * hard option ceiling. The plan is valid and follows every rule, but it may not
   * be optimal — the preview says so.
   */
  timeLimited: boolean;
}

export interface OptimizeFailure {
  ok: false;
  error: string;
}

export type OptimizeResult = OptimizationPlan | OptimizeFailure;

/* ----------------------------------------------------------------- helpers */

/** Signed working days from `from` to `to` (0 when they are the same day). */
export function workingDayGap(from: string, to: string, calendarId: string | undefined, system: CalendarSystem): number {
  if (!from || !to || from === to) return 0;
  return to > from
    ? workingDaysBetween(from, to, calendarId, system) - 1
    : -(workingDaysBetween(to, from, calendarId, system) - 1);
}

/**
 * The longest duration a task may end up with: its duration before this run, at
 * most +50%. Milestones and zero-duration rows never grow. The unit is the task's
 * own duration unit, so a 2-week task may become 3 weeks and a 5-day task 7 days.
 */
export function maxDurationFor(duration: number, isMilestone: boolean): number {
  if (isMilestone || duration <= 0) return duration;
  return Math.max(duration, Math.floor(duration * EXTENSION_LIMIT));
}

/**
 * The duration steps to try for a task: every single step up to a small bound,
 * plus the +50% cap itself, so the cap is always considered and a long task never
 * explodes the candidate set. A bound of 0 (or no headroom at all) means "no
 * extension", which is how a caller turns the extension off entirely.
 */
function extensionSteps(maxExtension: number, stepBound: number): number[] {
  if (maxExtension <= 0 || stepBound <= 0) return [0];
  const values = new Set<number>([0]);
  for (let steps = 1; steps <= Math.min(maxExtension, stepBound); steps += 1) values.add(steps);
  values.add(maxExtension);
  return [...values].sort((left, right) => left - right);
}

interface WeekRow {
  resourceId: string;
  resourceName: string;
  weekStart: string;
  weekEnd: string;
  allocated: number;
  available: number;
}

interface Score {
  /** Priority 1 — hours over 100%, across the project's own employees and weeks. */
  excess: number;
  /** Priority 2 — fixed milestones that left their date (must always be 0). */
  violations: number;
  /** Priority 3 — working days the project end date is delayed (never negative). */
  finishDelta: number;
  /** Priority 4 — total distance from the 90% target across the booked weeks. */
  deviation: number;
  /** Priority 5 — tasks changed, then the size of the moves and extensions. */
  changeCost: number;
}

const hours = (value: number) => {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** The candidate shifts of one task, smallest first and 0 included. */
function shiftOffsets(laterUpTo: number, earlierUpTo: number): number[] {
  const offsets: number[] = [0];
  for (let distance = 1; distance <= Math.max(laterUpTo, earlierUpTo); distance += 1) {
    if (distance <= earlierUpTo) offsets.push(-distance);
    if (distance <= laterUpTo) offsets.push(distance);
  }
  return offsets;
}

/* ------------------------------------------------------------------ engine */

export function optimizeProject(input: OptimizeInput): OptimizeResult {
  const limits = { ...OPTIMIZE_DEFAULTS, ...(input.limits ?? {}) };
  const startedAt = clock();
  const progress = (phase: OptimizeProgress["phase"], ratio: number, message: string) => {
    input.onProgress?.({ phase, ratio, message });
  };
  progress("preparing", 0, "Preparing the calculation…");
  const openProject = input.projects.find((project) => project.projectId === input.projectId);
  if (!openProject) return { ok: false, error: "That project is not part of this workspace." };
  const source = openProject.tasks;
  if (!source.length) return { ok: false, error: "This project has no tasks to optimize." };

  const calendarId = openProject.projectCalendarId;
  const { system } = input;
  const others = input.projects.filter((project) => project.projectId !== input.projectId);

  const sourceById = new Map(source.map((task) => [task.id, task]));
  // What each task looked like before this run: the +50% cap, the float and the
  // "was anything changed" comparison are all measured against this.
  const baselineDurations = new Map(source.map((task) => [task.id, task.duration]));
  // The app knows a milestone by `isMilestone` or by a zero duration on a row
  // without children (the same rule the Gantt grid uses), so both count here.
  const summaryIds = new Set(source.filter((task) => source.some((child) => child.parentId === task.id)).map((task) => task.id));
  const isMilestoneRow = (task: PlannerTask): boolean => Boolean(task.isMilestone) || (task.duration <= 0 && !summaryIds.has(task.id));
  const sourceMilestoneDates = new Map(source.filter(isMilestoneRow).map((task) => [task.id, task.start]));
  // Only real milestones of this project can be pinned, whatever the dialog sent.
  const fixedMilestoneIds = new Set((input.fixedMilestoneIds ?? []).filter((id) => sourceMilestoneDates.has(id)));

  // Who works on what — assignments never change, they only decide which task
  // can influence an employee's occupancy at all.
  const assignedByTask = new Map<string, string[]>();
  for (const assignment of input.assignments) {
    assignedByTask.set(assignment.taskId, [...(assignedByTask.get(assignment.taskId) ?? []), assignment.resourceId]);
  }

  /* ---- only the employees the open project actually uses ------------------ */

  /**
   * The employees with at least one task of the open project. Everyone else is
   * left out of the calculation and the preview completely — and since this run
   * never changes an assignment, no other employee can be affected either.
   */
  const relevantResourceIds = new Set(
    input.assignments.filter((assignment) => sourceById.has(assignment.taskId)).map((assignment) => assignment.resourceId),
  );
  const resources = input.resources.filter((resource) => relevantResourceIds.has(resource.id));
  const resourceNameById = new Map(resources.map((resource) => [resource.id, resource.name]));

  const projectInput = (tasks: PlannerTask[]): CapacityProjectInput => ({
    projectId: openProject.projectId,
    projectName: openProject.projectName,
    projectCalendarId: calendarId,
    tasks,
  });

  /** Tasks that carry occupancy of the open project and may change in this mode. */
  const movableTasks = (computed: PlannerTask[]): PlannerTask[] =>
    computed.filter((task) => {
      if (summaryIds.has(task.id) || isMilestoneRow(task) || task.duration <= 0) return false;
      if ((task.work ?? 0) <= 0) return false;
      if (!(assignedByTask.get(task.id)?.length)) return false;
      // A fixed milestone is never a candidate — it may not move at all.
      if (fixedMilestoneIds.has(task.id)) return false;
      // Monitoring tracks reality: a task that has started (and therefore any task
      // lying in the past) is fixed — it may be neither moved nor extended.
      if (input.mode === "monitoring" && task.start <= input.today) return false;
      return true;
    });

  /** The working days a task of the open project really books. */
  const bookedDates = (task: PlannerTask): string[] => taskWorkingDates(task, system, task.calendarId ?? calendarId);

  /**
   * The tasks that put hours on an employee. Only these can make a week look
   * different — and only these must therefore stay inside the window, or their
   * hours would fall outside the calculation and the preview.
   */
  const carriedTasks = (tasks: PlannerTask[]): PlannerTask[] =>
    tasks.filter((task) => (task.work ?? 0) > 0 && (assignedByTask.get(task.id)?.length ?? 0) > 0);

  /**
   * The earliest working day a task of the open project may start: as early as its
   * dependencies allow, and never further back than one candidate may look.
   */
  const earliestAllowedStart = (task: PlannerTask, tasks: PlannerTask[]): string => {
    const calendar = task.calendarId ?? calendarId;
    const searchBound = addWorkingDays(task.start, -limits.maxShiftDays, calendar, system);
    const earliest = earliestDependencyStart(task, tasks, dependenciesForTasks(tasks), {
      calendarSystem: system,
      projectCalendarId: calendarId,
    })?.date ?? null;
    const floor = earliest && earliest > searchBound ? earliest : searchBound;
    return ensureWorkingDay(floor, calendar, system);
  };

  /** The latest working day a task may end: as far as a shift and the +50% cap reach. */
  const latestAllowedEnd = (task: PlannerTask): string => {
    const calendar = task.calendarId ?? calendarId;
    const headroom = Math.max(
      0,
      maxDurationFor(baselineDurations.get(task.id) ?? task.duration, isMilestoneRow(task)) - task.duration,
    );
    return ensureWorkingDay(addWorkingDays(task.finish, limits.maxShiftDays + headroom, calendar, system), calendar, system);
  };

  /**
   * The period the whole run works in, as whole Monday–Sunday weeks: every week a
   * task of the open project could actually be placed in — from the earliest
   * allowed start to the latest allowed end of its movable tasks — plus the weeks
   * the project already books work in. `null` when the project has nothing that
   * could be placed at all. Nothing outside this window is calculated, reported
   * or changed.
   */
  const weekWindow = (() => {
    let earliest = "";
    let latest = "";
    const consider = (date: string) => {
      if (!earliest || date < earliest) earliest = date;
      if (!latest || date > latest) latest = date;
    };
    for (const task of movableTasks(source)) {
      consider(earliestAllowedStart(task, source));
      consider(latestAllowedEnd(task));
    }
    for (const task of carriedTasks(source)) {
      consider(task.start);
      consider(task.finish);
      for (const date of bookedDates(task)) consider(date);
    }
    if (!earliest || !latest) return null;
    return { start: weekStart(earliest), end: weekEnd(weekStart(latest)) };
  })();

  /** Every Monday of the window — the only weeks this run looks at. */
  const weekStarts: string[] = [];
  if (weekWindow) {
    for (let cursor = weekWindow.start; cursor <= weekWindow.end; cursor = shiftDays(cursor, 7)) weekStarts.push(cursor);
  }

  /** A candidate plan stays inside the window: a change may never leave it. */
  const insideWindow = (tasks: PlannerTask[]): boolean => {
    if (!weekWindow) return false;
    const { start, end } = weekWindow;
    return carriedTasks(tasks).every((task) => task.start >= start && task.finish <= end);
  };

  /**
   * Availability and the other projects' hours per employee and week. Both are
   * loaded once, up front, because neither depends on what this run does to the
   * open project.
   */
  const availability = new Map<string, number>();
  const otherLoad = new Map<string, number>();
  if (weekWindow && resources.length) {
    const reports = computeResourceLoads({
      system,
      resources,
      assignments: input.assignments,
      projects: others,
      range: weekWindow,
    });
    for (const report of reports) {
      for (const period of aggregatePeriods(report, "week")) {
        availability.set(`${report.resourceId}|${period.start}`, period.available);
        if (period.allocated > 0) otherLoad.set(`${report.resourceId}|${period.start}`, period.allocated);
      }
    }
  }

  /** The open project's own hours per employee and week, for one candidate plan. */
  const ownLoad = (tasks: PlannerTask[]): Map<string, number> => {
    const totals = new Map<string, number>();
    if (!weekWindow || !resources.length) return totals;
    const reports = computeResourceLoads({
      system,
      resources,
      assignments: input.assignments,
      projects: [projectInput(tasks)],
      range: weekWindow,
    });
    for (const report of reports) {
      for (const period of aggregatePeriods(report, "week")) {
        if (period.allocated > 0) totals.set(`${report.resourceId}|${period.start}`, period.allocated);
      }
    }
    return totals;
  };

  /**
   * The weekly occupancy every decision is made on: the open project's hours for
   * one candidate plan plus the other projects' share loaded at the start — for
   * the relevant employees and the relevant weeks only. A week without work
   * carries nothing to spread and is skipped by the score.
   */
  const weekRows = (tasks: PlannerTask[]): WeekRow[] => {
    if (!weekWindow) return [];
    const mine = ownLoad(tasks);
    const rows: WeekRow[] = [];
    for (const resource of resources) {
      for (const week of weekStarts) {
        const key = `${resource.id}|${week}`;
        rows.push({
          resourceId: resource.id,
          resourceName: resource.name,
          weekStart: week,
          weekEnd: weekEnd(week),
          allocated: (mine.get(key) ?? 0) + (otherLoad.get(key) ?? 0),
          available: availability.get(key) ?? 0,
        });
      }
    }
    return rows;
  };

  /**
   * The weeks the open project can reach at all: a movable task could be placed
   * there, or the project already plans work there. Every warning is checked
   * against this, so a week this project can neither touch nor improve is never
   * reported.
   */
  const placeableWeeks = new Set<string>();
  for (const task of movableTasks(source)) {
    for (let cursor = weekStart(earliestAllowedStart(task, source)); cursor <= latestAllowedEnd(task); cursor = shiftDays(cursor, 7)) {
      placeableWeeks.add(cursor);
    }
  }

  /** Priority 5, measured against the plan as it was before this run. */
  const changeCostOf = (tasks: PlannerTask[]): number => {
    let changed = 0;
    let magnitude = 0;
    for (const task of tasks) {
      const before = sourceById.get(task.id);
      if (!before) continue;
      const shift = Math.abs(workingDayGap(before.start, task.start, calendarId, system));
      const extension = Math.max(0, task.duration - before.duration);
      if (shift || extension) {
        changed += 1;
        magnitude += shift + extension;
      }
    }
    return changed * 1000 + magnitude;
  };

  const score = (tasks: PlannerTask[]): Score => {
    let excess = 0;
    let deviation = 0;
    for (const row of weekRows(tasks)) {
      // Empty weeks carry no work to spread, so they cannot be brought closer to
      // the target: only booked weeks take part in the measure.
      if (row.allocated <= 0 || row.available <= 0) continue;
      excess += Math.max(0, row.allocated - row.available);
      deviation += Math.abs(row.allocated - OCCUPANCY_TARGET * row.available);
    }
    const violations = [...fixedMilestoneIds].filter((id) => tasks.find((task) => task.id === id)?.start !== sourceMilestoneDates.get(id)).length;
    return { excess, violations, finishDelta: 0, deviation, changeCost: changeCostOf(tasks) };
  };

  /**
   * Ranking of two candidate plans, in the promised order: overload, then fixed
   * milestones, then the project delay, then the closeness to 90%, and finally
   * how many tasks changed and how much they changed.
   */
  const ranksBetter = (candidate: Score, incumbent: Score): boolean => {
    if (candidate.excess !== incumbent.excess) return candidate.excess < incumbent.excess;
    if (candidate.violations !== incumbent.violations) return candidate.violations < incumbent.violations;
    if (candidate.finishDelta !== incumbent.finishDelta) return candidate.finishDelta < incumbent.finishDelta;
    if (candidate.deviation !== incumbent.deviation) return candidate.deviation < incumbent.deviation;
    return candidate.changeCost < incumbent.changeCost;
  };
  const isEqualScore = (candidate: Score, incumbent: Score): boolean =>
    candidate.excess === incumbent.excess
    && candidate.violations === incumbent.violations
    && candidate.finishDelta === incumbent.finishDelta
    && candidate.deviation === incumbent.deviation
    && candidate.changeCost === incumbent.changeCost;

  const baselineComputed = withCalculatedPlanningFields(source, system, calendarId);
  const baselineById = new Map(baselineComputed.map((task) => [task.id, task]));
  const oldFinish = planFinishDate(source);

  /**
   * The first fixed milestone a re-planned candidate would have shifted.
   *
   * A fixed milestone keeps exactly the date it had before this run, so a
   * candidate that needs it to move is refused outright: the planner's own
   * re-scheduling (`recalculateTasks`) is what would move it — the milestone
   * cannot be "pulled back", because a start constraint is a lower bound only and
   * a milestone that a predecessor now ends too late for has genuinely been
   * pushed. Refusing the candidate is the only honest answer, and it is what
   * makes the pinned date a deadline for the tasks leading into it.
   */
  const movedFixedMilestone = (tasks: PlannerTask[]): string | null => {
    for (const task of tasks) {
      if (fixedMilestoneIds.has(task.id) && task.start !== sourceMilestoneDates.get(task.id)) return task.id;
    }
    return null;
  };

  /* ---- preparation: everything the search needs, calculated once ---------- */

  /**
   * The open project's tasks in dependency order: a predecessor always comes
   * before its successors, so one walk over this order can change a task knowing
   * that everything it depends on is already settled. Ties keep the plan's own row
   * order, which is what makes the walk — and the result — stable.
   */
  const dependencyOrder: PlannerTask[] = (() => {
    const dependencies = dependenciesForTasks(source);
    const placed = new Set<string>();
    const order: PlannerTask[] = [];
    while (order.length < source.length) {
      const ready = source.filter((task) => !placed.has(task.id) && dependencies.every((dependency) =>
        dependency.successorId !== task.id || placed.has(dependency.predecessorId) || !sourceById.has(dependency.predecessorId)));
      // A dependency cycle leaves tasks behind; the planner refuses such a plan
      // anyway, and this keeps the walk bounded instead of looping forever.
      if (!ready.length) break;
      for (const task of ready) {
        placed.add(task.id);
        order.push(task);
      }
    }
    for (const task of source) if (!placed.has(task.id)) order.push(task);
    return order;
  })();
  const orderIndex = new Map(dependencyOrder.map((task, index) => [task.id, index]));
  /** Who follows whom, so a moved task updates exactly the windows it affects. */
  const successorsOf = new Map<string, string[]>();
  for (const dependency of dependenciesForTasks(source)) {
    successorsOf.set(dependency.predecessorId, [...(successorsOf.get(dependency.predecessorId) ?? []), dependency.successorId]);
  }

  /**
   * The weekly hours of the open project, per employee and week, as plain numbers,
   * plus the hours each task contributes to them. Both are built once: an option is
   * then only a swap of that one task's own hours, never a re-calculation of the
   * project and never a reload of its data.
   */
  const movableList = movableTasks(source);
  const resourceById = new Map(resources.map((resource) => [resource.id, resource]));
  const employeeIndexOf = new Map(resources.map((resource, index) => [resource.id, index]));
  const weekIndexOf = new Map(weekStarts.map((week, index) => [week, index]));
  const weekCount = weekStarts.length;
  const slotCount = resources.length * weekCount;
  const slotOf = (employeeIndex: number, weekIndex: number) => employeeIndex * weekCount + weekIndex;

  const otherBySlot = new Array<number>(slotCount).fill(0);
  const availableBySlot = new Array<number>(slotCount).fill(0);
  resources.forEach((resource, employeeIndex) => {
    weekStarts.forEach((week, weekIndex) => {
      const slot = slotOf(employeeIndex, weekIndex);
      availableBySlot[slot] = availability.get(`${resource.id}|${week}`) ?? 0;
      otherBySlot[slot] = otherLoad.get(`${resource.id}|${week}`) ?? 0;
    });
  });
  const load = new Array<number>(slotCount).fill(0);

  /** The work finish a task has for a start and duration, exactly as the planner sets it. */
  const finishOf = (task: PlannerTask, start: string, duration: number): string => {
    const calendar = task.calendarId ?? calendarId;
    const span = isMilestoneRow(task) ? 1 : durationInWorkingDays({ ...task, duration });
    return span <= 1 ? ensureWorkingDay(start, calendar, system) : addWorkingDays(start, span - 1, calendar, system);
  };

  /**
   * The weekly hours one task books per employee for a given start and duration —
   * the same daily split the Capacity screen shows, so the two can never disagree.
   */
  const cellsOf = (task: PlannerTask, start: string, duration: number): { slot: number; hours: number }[] => {
    const totals = new Map<number, number>();
    const virtualTask: PlannerTask = { ...task, start, duration };
    for (const resourceId of assignedByTask.get(task.id) ?? []) {
      const employeeIndex = employeeIndexOf.get(resourceId);
      const resource = resourceById.get(resourceId);
      if (employeeIndex === undefined || !resource) continue;
      const allocation = dailyAllocation(virtualTask, system, task.calendarId ?? calendarId, (date) => availableHours(resource, date, system) > 0);
      for (const day of allocation) {
        if (day.hours <= 0) continue;
        const weekIndex = weekIndexOf.get(weekStart(day.date));
        if (weekIndex === undefined) continue;
        const slot = slotOf(employeeIndex, weekIndex);
        totals.set(slot, (totals.get(slot) ?? 0) + day.hours);
      }
    }
    return [...totals.entries()].map(([slot, hours]) => ({ slot, hours }));
  };

  /** Where each task sits and which weekly hours it books there. */
  interface TaskState {
    start: string;
    duration: number;
    cells: { slot: number; hours: number }[];
  }
  const states = new Map<string, TaskState>();
  for (const task of source) {
    const cells = carriedTasks([task]).length ? cellsOf(task, task.start, task.duration) : [];
    states.set(task.id, { start: task.start, duration: task.duration, cells });
    for (const cell of cells) load[cell.slot] += cell.hours;
  }

  /** Priorities 1 and 4 over the weekly numbers: hours over 100 %, distance from 90 %. */
  const loadScore = (): { excess: number; deviation: number } => {
    let excess = 0;
    let deviation = 0;
    for (let slot = 0; slot < slotCount; slot += 1) {
      const available = availableBySlot[slot];
      const allocated = load[slot] + otherBySlot[slot];
      if (allocated <= 0 || available <= 0) continue;
      excess += Math.max(0, allocated - available);
      deviation += Math.abs(allocated - OCCUPANCY_TARGET * available);
    }
    return { excess, deviation };
  };

  /** Priority 5, tracked per task, so an option only has to adjust one entry. */
  const changedMagnitude = new Map<string, number>();
  const refreshChanged = (taskId: string, start: string, duration: number) => {
    const origin = sourceById.get(taskId);
    const baseline = baselineDurations.get(taskId) ?? duration;
    const magnitude = origin
      ? Math.abs(workingDayGap(origin.start, start, calendarId, system)) + Math.max(0, duration - baseline)
      : 0;
    if (magnitude > 0) changedMagnitude.set(taskId, magnitude);
    else changedMagnitude.delete(taskId);
  };
  const changeCost = (): number => {
    let magnitude = 0;
    for (const value of changedMagnitude.values()) magnitude += value;
    return changedMagnitude.size * 1000 + magnitude;
  };
  for (const task of source) refreshChanged(task.id, task.start, task.duration);

  /** The score of the plan as it stands, built from the weekly numbers alone. */
  const scoreOfLoad = (finishDelta: number): Score => ({ ...loadScore(), violations: 0, finishDelta, changeCost: changeCost() });

  /** The planned finish of every task, kept up to date as tasks move. */
  const finishById = new Map(source.map((task) => [task.id, task.finish]));
  const maxFinishWithout = (taskId: string): string => {
    let latest = "";
    for (const [id, value] of finishById) if (id !== taskId && value > latest) latest = value;
    return latest;
  };

  /**
   * The earliest start a task's dependencies allow in the plan as it stands. Cached
   * and invalidated only for the tasks that depend on one that moved, so no window
   * is ever derived from stale dates and none is derived for the whole project.
   */
  const depEarliestCache = new Map<string, string | null>();
  const depEarliest = (task: PlannerTask): string | null => {
    const cached = depEarliestCache.get(task.id);
    if (cached !== undefined) return cached;
    const scheduled = [...states.entries()].map(([id, state]) => ({
      ...sourceById.get(id)!,
      start: state.start,
      duration: state.duration,
      finish: finishById.get(id) ?? state.start,
    }));
    const value = earliestDependencyStart(task, scheduled, dependenciesForTasks(scheduled), {
      calendarSystem: system,
      projectCalendarId: calendarId,
    })?.date ?? null;
    depEarliestCache.set(task.id, value);
    return value;
  };

  /** Fixed milestones a round needed to move, with the weeks and employees that were over 100 %. */
  const blockedByMilestone = new Map<string, { resources: Set<string>; weeks: Set<string> }>();
  const recordMilestoneBlocker = (milestoneId: string) => {
    const record = blockedByMilestone.get(milestoneId) ?? { resources: new Set<string>(), weeks: new Set<string>() };
    for (let slot = 0; slot < slotCount; slot += 1) {
      if (availableBySlot[slot] <= 0) continue;
      if (load[slot] + otherBySlot[slot] <= availableBySlot[slot] + EPSILON) continue;
      record.resources.add(resources[Math.floor(slot / weekCount)].id);
      record.weeks.add(weekStarts[slot % weekCount]);
    }
    blockedByMilestone.set(milestoneId, record);
  };

  let currentScore: Score = scoreOfLoad(0);
  let current = source;
  /** Options scored so far, over the whole run (a hard ceiling, always ends). */
  let evaluations = 0;
  /** True once the wall-clock limit stopped the search before it was finished. */
  let timeLimited = false;
  /** True once the option ceiling stopped the search — the same honest early stop. */
  let optionLimited = false;

  /* ---- one task at a time, with a bounded set of options ------------------ */

  /** Where one option would put one task: its start and its duration. */
  interface TaskOption {
    start: string;
    duration: number;
    /** Working days against where the task sits now: positive is later. */
    shift: number;
    /** Extra duration against where the task sits now. */
    extension: number;
    /** Working days the project end would move. */
    finishDelta: number;
  }

  /**
   * The options of one task, and nothing else: every working day of its allowed
   * window as a start date, and the promised duration steps. Never a combination
   * of several tasks, and never a duration past the +50 % cap.
   */
  const optionsFor = (task: PlannerTask, allowDelay: boolean, laterLimit: number): TaskOption[] => {
    const state = states.get(task.id)!;
    const calendar = task.calendarId ?? calendarId;
    const baseline = baselineDurations.get(task.id) ?? task.duration;
    const cap = maxDurationFor(baseline, isMilestoneRow(task));
    const durations = new Set<number>([state.duration]);
    if (limits.maxExtensionDays > 0) {
      for (const step of DURATION_STEPS) {
        durations.add(Math.max(state.duration, Math.min(cap, Math.round(baseline * step))));
      }
    }
    // The allowed window: as early as the dependencies permit, never further than
    // one bounded shift back, and never a day outside the weeks this run covers.
    const earliestDependency = depEarliest(task);
    let first = addWorkingDays(state.start, -limits.maxShiftDays, calendar, system);
    if (earliestDependency && earliestDependency > first) first = earliestDependency;
    first = ensureWorkingDay(first, calendar, system);
    const last = ensureWorkingDay(addWorkingDays(state.start, laterLimit, calendar, system), calendar, system);
    const otherFinish = maxFinishWithout(task.id);
    const options: TaskOption[] = [];
    for (let start = first; start <= last; start = addWorkingDays(start, 1, calendar, system)) {
      if (start < state.start && earliestDependency && start < earliestDependency) continue;
      for (const duration of [...durations].sort((left, right) => left - right)) {
        if (start === state.start && duration === state.duration) continue;
        const finish = finishOf(task, start, duration);
        if (weekWindow && (start < weekWindow.start || finish > weekWindow.end)) continue;
        const projectFinish = finish > otherFinish ? finish : otherFinish;
        const finishDelta = Math.max(0, workingDayGap(oldFinish, projectFinish, calendarId, system));
        // Rounds that may not change the project end refuse exactly the options
        // that would; the rounds that may accept the smallest delay measured here.
        if (!allowDelay && projectFinish !== oldFinish) continue;
        options.push({
          start,
          duration,
          shift: workingDayGap(state.start, start, calendar, system),
          extension: duration - state.duration,
          finishDelta,
        });
      }
    }
    return options;
  };

  /**
   * The score an option would produce, without keeping it. Only the slots of the
   * task that changes are touched — the weeks and employees it affects, and no
   * other part of the plan is re-calculated.
   */
  const optionScore = (task: PlannerTask, option: TaskOption): Score => {
    const state = states.get(task.id)!;
    for (const cell of state.cells) load[cell.slot] -= cell.hours;
    const cells = cellsOf(task, option.start, option.duration);
    for (const cell of cells) load[cell.slot] += cell.hours;
    const { excess, deviation } = loadScore();
    for (const cell of cells) load[cell.slot] -= cell.hours;
    for (const cell of state.cells) load[cell.slot] += cell.hours;
    const before = changedMagnitude.get(task.id) ?? 0;
    const origin = sourceById.get(task.id)?.start ?? option.start;
    const magnitude = Math.abs(workingDayGap(origin, option.start, calendarId, system))
      + Math.max(0, option.duration - (baselineDurations.get(task.id) ?? option.duration));
    return {
      excess,
      violations: 0,
      finishDelta: option.finishDelta,
      deviation,
      changeCost: currentScore.changeCost - (before > 0 ? 1000 + before : 0) + (magnitude > 0 ? 1000 + magnitude : 0),
    };
  };

  /**
   * Which of two equally good options of one task to take: the smallest change
   * first, then the later start, then the smaller extension. The option order is
   * fixed, so a full tie keeps the first found — the same input always gives the
   * same plan.
   */
  const breaksTie = (candidate: TaskOption, incumbent: TaskOption): boolean => {
    const candidateSize = Math.abs(candidate.shift) + candidate.extension;
    const incumbentSize = Math.abs(incumbent.shift) + incumbent.extension;
    if (candidateSize !== incumbentSize) return candidateSize < incumbentSize;
    if (candidate.start !== incumbent.start) return candidate.start > incumbent.start;
    if (candidate.shift !== incumbent.shift) return candidate.shift > incumbent.shift;
    if (candidate.extension !== incumbent.extension) return candidate.extension < incumbent.extension;
    return false;
  };

  /** Options that only worked by moving a fixed milestone: never tried again. */
  const refused = new Set<string>();
  const optionKey = (taskId: string, option: TaskOption) => `${taskId}|${option.start}|${option.duration}`;

  /** The best option of one task, ranked by the existing priorities, or none. */
  const bestOption = (task: PlannerTask, allowDelay: boolean, laterLimit: number): TaskOption | null => {
    let best: TaskOption | null = null;
    let bestScore: Score | null = null;
    for (const option of optionsFor(task, allowDelay, laterLimit)) {
      if (refused.has(optionKey(task.id, option))) continue;
      evaluations += 1;
      if (evaluations > limits.maxEvaluations) {
        // A very large plan may not score every option: the ceiling ends the
        // search here and the best plan so far is the answer.
        optionLimited = true;
        break;
      }
      const candidate = optionScore(task, option);
      // A task is only ever changed when the change makes the plan strictly
      // better, exactly as before: no wandering between equally good plans.
      if (!ranksBetter(candidate, currentScore)) continue;
      if (!best || !bestScore || ranksBetter(candidate, bestScore) || (isEqualScore(candidate, bestScore) && breaksTie(option, best))) {
        best = option;
        bestScore = candidate;
      }
    }
    return best;
  };

  /** Applies one option: the task's own hours move, and nothing else is re-calculated. */
  const applyOption = (task: PlannerTask, option: TaskOption) => {
    const state = states.get(task.id)!;
    for (const cell of state.cells) load[cell.slot] -= cell.hours;
    state.start = option.start;
    state.duration = option.duration;
    state.cells = cellsOf(task, option.start, option.duration);
    for (const cell of state.cells) load[cell.slot] += cell.hours;
    finishById.set(task.id, finishOf(task, option.start, option.duration));
    refreshChanged(task.id, option.start, option.duration);
    // Only the windows of the tasks that depend on this one can have changed.
    for (const successorId of successorsOf.get(task.id) ?? []) depEarliestCache.delete(successorId);
    currentScore = scoreOfLoad(0);
  };

  const prepareMs = clock() - startedAt;
  progress("optimizing", 0, "Optimizing…");
  const searchStart = clock();

  /** A point the search can always return to: one whole, valid plan. */
  interface SearchSnapshot {
    states: Map<string, TaskState>;
    load: number[];
    finishById: Map<string, string>;
    changedMagnitude: Map<string, number>;
    score: Score;
    current: PlannerTask[];
  }
  const takeSnapshot = (): SearchSnapshot => ({
    states: new Map([...states].map(([id, state]) => [id, { ...state, cells: [...state.cells] }])),
    load: [...load],
    finishById: new Map(finishById),
    changedMagnitude: new Map(changedMagnitude),
    score: currentScore,
    current,
  });
  const restore = (snapshot: SearchSnapshot) => {
    states.clear();
    for (const [id, state] of snapshot.states) states.set(id, state);
    for (let slot = 0; slot < slotCount; slot += 1) load[slot] = snapshot.load[slot];
    finishById.clear();
    for (const [id, value] of snapshot.finishById) finishById.set(id, value);
    changedMagnitude.clear();
    for (const [id, value] of snapshot.changedMagnitude) changedMagnitude.set(id, value);
    depEarliestCache.clear();
    currentScore = snapshot.score;
    current = snapshot.current;
  };

  /** The plan the walk has built, in the shape the planner expects to receive. */
  const plannedTasks = (): PlannerTask[] => source.map((task) => {
    const state = states.get(task.id)!;
    const dependencyEarliest = depEarliest({ ...task, start: state.start, duration: state.duration });
    const constraint = dependencyEarliest && state.start > dependencyEarliest ? state.start : task.startConstraint;
    return { ...task, start: state.start, duration: state.duration, startConstraint: constraint, startConstraintActive: false };
  });

  /**
   * Takes the planner's own schedule as the truth after a round: it is what
   * "Apply" writes, it can pull a task back to what its dependencies allow and
   * push a successor along, and it is where a fixed milestone would show up as
   * moved. The weekly numbers are rebuilt from it, so the next round starts from
   * the plan as it really is.
   */
  const adoptScheduled = (tasks: PlannerTask[]) => {
    load.fill(0);
    for (const task of tasks) {
      const cells = carriedTasks([task]).length ? cellsOf(task, task.start, task.duration) : [];
      states.set(task.id, { start: task.start, duration: task.duration, cells });
      for (const cell of cells) load[cell.slot] += cell.hours;
      finishById.set(task.id, task.finish);
      refreshChanged(task.id, task.start, task.duration);
    }
    depEarliestCache.clear();
    current = tasks;
    currentScore = scoreOfLoad(0);
  };

  /**
   * One improvement round: every movable task once, in dependency order, with the
   * tasks that sit in a week above 100 % first. Each task contributes its best
   * option, and the options are then applied best score first, smallest change
   * next, task id last — so an equally good but smaller change is never beaten by
   * a bigger one, and the same input always gives the same plan.
   */
  const runRound = (allowDelay: boolean, floatOnly: boolean): string[] => {
    const overloaded = new Set<string>();
    for (const [taskId, state] of states) {
      if (state.cells.some((cell) => load[cell.slot] + otherBySlot[cell.slot] > availableBySlot[cell.slot] + EPSILON)) {
        overloaded.add(taskId);
      }
    }
    const walk = movableList
      // A round that may not change the project end only changes tasks that have
      // float to spend, exactly as before: a task on the critical path is left to
      // the rounds that may accept a delay.
      .filter((task) => !floatOnly || (!(baselineById.get(task.id)?.isCritical ?? false) && (baselineById.get(task.id)?.totalFloat ?? 0) > 0))
      .sort((left, right) => {
        const byOverload = Number(!overloaded.has(left.id)) - Number(!overloaded.has(right.id));
        if (byOverload !== 0) return byOverload;
        return (orderIndex.get(left.id) ?? 0) - (orderIndex.get(right.id) ?? 0);
      });
    const chosen: { task: PlannerTask; option: TaskOption; score: Score }[] = [];
    for (const task of walk) {
      // Every loop is bounded: the option count by a ceiling, the time by the wall clock.
      if (clock() - searchStart > limits.timeLimitMs) {
        timeLimited = true;
        break;
      }
      if (optionLimited) break;
      const float = baselineById.get(task.id)?.totalFloat ?? 0;
      const laterLimit = floatOnly ? Math.min(limits.maxShiftDays, Math.floor(float)) : limits.maxShiftDays;
      const option = bestOption(task, allowDelay, laterLimit);
      if (!option) continue;
      chosen.push({ task, option, score: optionScore(task, option) });
    }
    chosen.sort((left, right) => {
      if (ranksBetter(left.score, right.score)) return -1;
      if (ranksBetter(right.score, left.score)) return 1;
      const leftSize = Math.abs(left.option.shift) + left.option.extension;
      const rightSize = Math.abs(right.option.shift) + right.option.extension;
      if (leftSize !== rightSize) return leftSize - rightSize;
      return left.task.id.localeCompare(right.task.id);
    });
    const applied: string[] = [];
    for (const entry of chosen) {
      // Applying one change can make another one pointless: a change is only kept
      // while it still makes the plan strictly better.
      if (!ranksBetter(optionScore(entry.task, entry.option), currentScore)) continue;
      applyOption(entry.task, entry.option);
      applied.push(optionKey(entry.task.id, entry.option));
    }
    return applied;
  };

  /**
   * The rounds: at most `rounds` of them, each verified against the planner's own
   * schedule. A round that does not make the whole plan better is rolled back —
   * which is also how the search stops early.
   */
  const runPhase = (allowDelay: boolean, floatOnly: boolean, rounds: number) => {
    for (let round = 0; round < rounds; round += 1) {
      if (timeLimited || optionLimited) break;
      if (allowDelay && currentScore.excess <= EPSILON) break;
      if (clock() - searchStart > limits.timeLimitMs) {
        timeLimited = true;
        break;
      }
      const snapshot = takeSnapshot();
      const applied = runRound(allowDelay, floatOnly);
      if (!applied.length) break;
      const scheduled = recalculateTasks(plannedTasks(), {
        direction: "forward",
        calendarSystem: system,
        projectCalendarId: calendarId,
      });
      const blocker = scheduled.error ? null : movedFixedMilestone(scheduled.tasks);
      if (scheduled.error || blocker || !insideWindow(scheduled.tasks)) {
        // A round that could only work by moving a fixed milestone is refused
        // outright — the same answer as ever, and the options that needed it are
        // never tried again.
        for (const key of applied) refused.add(key);
        // Recorded from the plan as it was, so the weeks that are still over 100 %
        // are the ones the pinned milestone is standing in the way of.
        restore(snapshot);
        if (blocker) recordMilestoneBlocker(blocker);
        continue;
      }
      adoptScheduled(scheduled.tasks);
      if (!ranksBetter(currentScore, snapshot.score)) {
        restore(snapshot);
        break;
      }
      progress("optimizing", Math.min(0.95, 0.15 + (0.8 * (round + 1)) / Math.max(1, rounds)), "Optimizing…");
    }
  };

  // Float first: a round may move a task, but never the project end date.
  runPhase(false, true, Math.max(1, limits.maxIterations));
  // Only while a task of the project still overloads someone may the critical
  // path change too, delaying the project as little as possible.
  runPhase(true, false, Math.max(1, limits.maxIterations));



  const optimizeMs = clock() - searchStart;
  progress("reporting", 0, "Building the preview…");
  const reportStart = clock();

  /* ------------------------------------------------------------- reporting */

  const afterById = new Map(current.map((task) => [task.id, task]));
  const changed = (task: PlannerTask): boolean => {
    const after = afterById.get(task.id);
    return Boolean(after && (after.start !== task.start || after.finish !== task.finish || after.duration !== task.duration));
  };

  const moves: OptimizeMove[] = source
    .filter(changed)
    .map((task): OptimizeMove => {
      const after = afterById.get(task.id)!;
      const shiftDays = workingDayGap(task.start, after.start, calendarId, system);
      const extensionDays = Math.max(0, after.duration - task.duration);
      const moved = shiftDays !== 0;
      const extended = extensionDays > 0;
      return {
        taskId: task.id,
        taskName: task.name,
        oldStart: task.start,
        oldFinish: task.finish,
        newStart: after.start,
        newFinish: after.finish,
        shiftDays,
        floatUsed: Math.max(0, shiftDays),
        floatAvailable: baselineById.get(task.id)?.totalFloat ?? 0,
        critical: baselineById.get(task.id)?.isCritical ?? false,
        oldDuration: task.duration,
        newDuration: after.duration,
        extensionDays,
        extensionPct: task.duration > 0 ? Math.round((after.duration / task.duration - 1) * 100) : 0,
        oldWork: Math.max(0, task.work ?? 0),
        newWork: Math.max(0, after.work ?? 0),
        changeKind: moved && extended ? "both" : extended ? "extended" : "moved",
        milestone: isMilestoneRow(task),
      };
    })
    .sort((left, right) => left.oldStart.localeCompare(right.oldStart) || left.taskId.localeCompare(right.taskId));

  const milestones: OptimizeMilestone[] = source
    .filter(isMilestoneRow)
    .map((task) => {
      const after = afterById.get(task.id);
      const newDate = after?.start ?? task.start;
      return {
        taskId: task.id,
        name: task.name,
        oldDate: task.start,
        newDate,
        fixed: fixedMilestoneIds.has(task.id),
        moved: newDate !== task.start,
      };
    })
    .sort((left, right) => left.oldDate.localeCompare(right.oldDate) || left.taskId.localeCompare(right.taskId));

  const newFinish = planFinishDate(current);
  const beforeRows = weekRows(source);
  const afterRows = weekRows(current);

  /**
   * The hours each task really plans, summed from the same daily allocation the
   * capacity screen shows. This is the honest check that extending a task only
   * spreads the same work over more days: `work` (hours) is stored on the task and
   * the daily split is derived from it, so the total must be identical.
   */
  const taskHours = (tasks: PlannerTask[]): Map<string, number> => {
    const totals = new Map<string, number>();
    for (const report of computeResourceLoads({
      system,
      resources,
      assignments: input.assignments,
      projects: [projectInput(tasks)],
      range: weekWindow ?? undefined,
    })) {
      for (const day of report.days) {
        for (const contribution of day.contributions) {
          totals.set(contribution.taskId, (totals.get(contribution.taskId) ?? 0) + contribution.hours);
        }
      }
    }
    return totals;
  };
  const hoursBefore = taskHours(source);
  const hoursAfter = taskHours(current);

  // Per employee, the union of the weeks before and after, so a week that only
  // one side touches is still shown (and never hidden by the comparison).
  const byResource = new Map<string, { resourceName: string; weeks: Map<string, OptimizeWeekOccupancy> }>();
  const addRow = (row: WeekRow, side: "before" | "after") => {
    const entry = byResource.get(row.resourceId) ?? { resourceName: row.resourceName, weeks: new Map<string, OptimizeWeekOccupancy>() };
    const week = entry.weeks.get(row.weekStart) ?? { weekStart: row.weekStart, weekEnd: row.weekEnd, available: row.available, before: 0, after: 0 };
    week.available = Math.max(week.available, row.available);
    week[side] = row.allocated;
    entry.weeks.set(row.weekStart, week);
    byResource.set(row.resourceId, entry);
  };
  for (const row of beforeRows) addRow(row, "before");
  for (const row of afterRows) addRow(row, "after");

  const occupancy: OptimizeResourceOccupancy[] = [...byResource.entries()]
    .map(([resourceId, entry]) => ({
      resourceId,
      resourceName: entry.resourceName,
      weeks: [...entry.weeks.values()].sort((left, right) => left.weekStart.localeCompare(right.weekStart)),
    }))
    .sort((left, right) => left.resourceName.localeCompare(right.resourceName) || left.resourceId.localeCompare(right.resourceId));

  /** Everything that follows a task, so a pinned milestone can be named as the reason. */
  const downstreamOf = (taskId: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [...(successorsOf.get(taskId) ?? [])];
    while (queue.length) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(successorsOf.get(next) ?? []));
    }
    return seen;
  };

  /** The fixed milestones that follow a task, named once each. */
  const pinnedMilestonesOf = new Map<string, string[]>();
  for (const task of source) {
    pinnedMilestonesOf.set(task.id, [...downstreamOf(task.id)].filter((id) => fixedMilestoneIds.has(id)));
  }

  /**
   * How far each task may move or grow, worked out once from the prepared facts
   * instead of re-deriving the dependency network for every week.
   */
  const allowedWindow = new Map<string, { from: string; to: string }>();
  const allowedWindowOf = (task: PlannerTask): { from: string; to: string } => {
    const cached = allowedWindow.get(task.id);
    if (cached) return cached;
    const calendar = task.calendarId ?? calendarId;
    const searchBound = addWorkingDays(task.start, -limits.maxShiftDays, calendar, system);
    const earliest = depEarliest(task);
    const from = ensureWorkingDay(earliest && earliest > searchBound ? earliest : searchBound, calendar, system);
    const duration = states.get(task.id)?.duration ?? task.duration;
    const headroom = Math.max(0, maxDurationFor(baselineDurations.get(task.id) ?? duration, isMilestoneRow(task)) - duration);
    const finish = finishById.get(task.id) ?? task.finish;
    const to = ensureWorkingDay(addWorkingDays(finish, limits.maxShiftDays + headroom, calendar, system), calendar, system);
    const value = { from, to };
    allowedWindow.set(task.id, value);
    return value;
  };

  /**
   * The rule that stopped a task from being placed in one week — the honest answer
   * to "why is this week still far below 90%?". `null` when no rule applies, i.e.
   * the task could have gone there and the search had nothing to gain by it.
   */
  const blockedRule = (task: PlannerTask, week: WeekRow): string | null => {
    if (input.mode === "monitoring" && task.start <= input.today) {
      return `“${task.name}” has already started, and Monitoring keeps started work where it is`;
    }
    const pinned = pinnedMilestonesOf.get(task.id) ?? [];
    if (pinned.length) {
      const names = pinned.map((id) => sourceById.get(id)?.name ?? id);
      return `moving or extending “${task.name}” would shift the fixed milestone${names.length > 1 ? "s" : ""} ${names.join(", ")}`;
    }
    const earliest = depEarliest(task);
    if (earliest && earliest > week.weekEnd) {
      return `“${task.name}” cannot start before ${earliest}, after its predecessor`;
    }
    const duration = states.get(task.id)?.duration ?? task.duration;
    const headroom = maxDurationFor(baselineDurations.get(task.id) ?? duration, isMilestoneRow(task)) - duration;
    if (headroom <= 0) return `the +50% limit leaves “${task.name}” no longer duration to spread over`;
    const float = baselineById.get(task.id)?.totalFloat ?? 0;
    if (float <= 0) return `“${task.name}” has no float, so moving it later would delay the project end`;
    return null;
  };

  /** Every rule that blocks a move or extension able to reach one week. */
  const blockedInWeek = (week: WeekRow): string[] => {
    const rules = new Set<string>();
    for (const task of movableList) {
      const window = allowedWindowOf(task);
      if (window.from > week.weekEnd) continue;
      if (week.weekStart > window.to) continue;
      const rule = blockedRule(task, week);
      if (rule) rules.add(rule);
    }
    return [...rules];
  };

  const unresolved: OptimizeUnresolved[] = [];
  const afterMine = ownLoad(current);
  for (const row of afterRows) {
    if (row.allocated <= 0 || row.available <= 0) continue;
    const mine = afterMine.get(`${row.resourceId}|${row.weekStart}`) ?? 0;
    // Only warnings that are relevant to the open project: a week it plans work
    // in, or one of its movable tasks could be placed in. A week it can neither
    // touch nor improve is not reported at all.
    if (mine <= 0 && !placeableWeeks.has(row.weekStart)) continue;
    const ratio = row.allocated / row.available;
    const other = otherLoad.get(`${row.resourceId}|${row.weekStart}`) ?? 0;
    if (row.allocated > row.available + EPSILON) {
      unresolved.push({
        kind: "over-capacity",
        resourceId: row.resourceId,
        resourceName: row.resourceName,
        weekStart: row.weekStart,
        weekEnd: row.weekEnd,
        allocated: row.allocated,
        available: row.available,
        occupancy: ratio,
        reason: `${row.resourceName} is still over 100% in the week of ${row.weekStart}: ${hours(row.allocated)} h planned against ${hours(row.available)} h available${mine > 0 ? `, ${hours(mine)} h of it from this project` : ", none of it from this project"}.${other > 0 ? ` Other projects already plan ${hours(other)} h of that week.` : ""} No task of this project could be moved or extended without breaking a rule.`,
      });
      continue;
    }
    if (ratio < OCCUPANCY_TARGET - OFF_TARGET_MARGIN) {
      const rules = blockedInWeek(row);
      unresolved.push({
        kind: "off-target",
        resourceId: row.resourceId,
        resourceName: row.resourceName,
        weekStart: row.weekStart,
        weekEnd: row.weekEnd,
        allocated: row.allocated,
        available: row.available,
        occupancy: ratio,
        reason: `${row.resourceName} is only ${percent(ratio)} booked in the week of ${row.weekStart} (${hours(row.allocated)} h of ${hours(row.available)} h), and work of this project could be placed there. ${rules.length ? `Blocked by: ${rules.join("; ")}.` : "No move or extension of its tasks comes closer to the 90% target without breaking a rule."}`,
      });
    }
  }

  const blockers: OptimizeBlocker[] = [];
  const stillOverloads = afterRows.filter((row) => row.allocated > row.available + EPSILON);
  const stillOverloaded = new Set(stillOverloads.map((row) => `${row.resourceId}|${row.weekStart}`));

  // Fixed milestones: only worth reporting while a real overload is still there,
  // because then moving the milestone is the one thing that could lift it.
  for (const [milestoneId, record] of [...blockedByMilestone.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const weeks = [...record.weeks].filter((week) => [...record.resources].some((resourceId) => stillOverloaded.has(`${resourceId}|${week}`))).sort();
    if (!weeks.length) continue;
    const resourceIds = [...record.resources].filter((resourceId) => weeks.some((week) => stillOverloaded.has(`${resourceId}|${week}`))).sort();
    const resourceNames = resourceIds.map((id) => resourceNameById.get(id) ?? id);
    const milestoneName = sourceMilestoneDates.has(milestoneId) ? (sourceById.get(milestoneId)?.name ?? milestoneId) : milestoneId;
    blockers.push({
      kind: "fixed-milestone",
      milestoneId,
      milestoneName,
      milestoneDate: sourceMilestoneDates.get(milestoneId),
      taskIds: [],
      taskNames: [],
      resourceIds,
      resourceNames,
      weeks,
      reason: `Milestone “${milestoneName}” (${sourceMilestoneDates.get(milestoneId)}) is fixed for this run. ${resourceNames.join(", ")} ${resourceNames.length === 1 ? "is" : "are"} still over 100% in ${weeks.map((week) => `the week of ${week}`).join(", ")}; lifting that overload would need the fixed milestone to move, so it is left in place and reported here.`,
    });
  }

  // The +50% limit: an overload survives in a week where every task of the open
  // project feeding it has already grown to the longest duration the limit allows
  // (a one-day task has no headroom at all), so spreading the work over more days
  // — the one lever that would not delay the project — is not allowed.
  if (stillOverloads.length) {
    // Which tasks of the open project put hours on an employee's week, computed
    // once from the same engine the capacity screen uses.
    const contributors = new Map<string, string[]>();
    for (const report of computeResourceLoads({ system, resources, assignments: input.assignments, projects: [projectInput(current)], range: weekWindow ?? undefined })) {
      const byWeek = new Map<string, Set<string>>();
      for (const day of report.days) {
        const week = weekStart(day.date);
        for (const contribution of day.contributions) byWeek.set(week, new Set([...(byWeek.get(week) ?? []), contribution.taskId]));
      }
      for (const [week, ids] of byWeek) contributors.set(`${report.resourceId}|${week}`, [...ids].sort());
    }
    const headroomOf = (taskId: string): number => {
      const before = sourceById.get(taskId);
      if (!before) return 0;
      return maxDurationFor(before.duration, isMilestoneRow(before)) - (afterById.get(taskId)?.duration ?? before.duration);
    };
    for (const row of stillOverloads) {
      if ((afterMine.get(`${row.resourceId}|${row.weekStart}`) ?? 0) <= 0) continue;
      const taskIds = contributors.get(`${row.resourceId}|${row.weekStart}`) ?? [];
      if (!taskIds.length) continue;
      if (taskIds.some((taskId) => headroomOf(taskId) > 0)) continue;
      const taskNames = taskIds.map((id) => sourceById.get(id)?.name ?? id);
      blockers.push({
        kind: "extension-limit",
        taskIds,
        taskNames,
        resourceIds: [row.resourceId],
        resourceNames: [row.resourceName],
        weeks: [row.weekStart],
        reason: `${taskNames.map((name, index) => `“${name}” is at ${afterById.get(taskIds[index])?.duration ?? 0} working day(s), the most the +50% limit allows`).join("; ")}, so the work cannot be spread over more days${taskIds.length > 1 ? " than it already is" : ""} — but ${row.resourceName} is still over 100% in the week of ${row.weekStart} (${hours(row.allocated)} h of ${hours(row.available)} h). Extending further is not allowed.`,
      });
    }
  }

  // Every extended task holds exactly the hours it had: the stored `work` is not
  // touched, and the daily split of those hours over the extra days is derived, so
  // the sum is unchanged. Both are checked, because either one alone could hide a
  // bug in the other.
  const workHoursPreserved = source.every((task) => {
    if (task.duration > 0 && afterById.get(task.id)?.duration !== task.duration) {
      const before = hoursBefore.get(task.id) ?? 0;
      const after = hoursAfter.get(task.id) ?? 0;
      if (Math.abs(before - after) > 0.01) return false;
    }
    const after = afterById.get(task.id);
    return !after || Math.max(0, after.work ?? 0) === Math.max(0, task.work ?? 0);
  });

  const reportMs = clock() - reportStart;
  return {
    ok: true,
    timings: { prepareMs, optimizeMs, reportMs, totalMs: clock() - startedAt, evaluations },
    // True when a limit stopped the search — the 10-second wall clock or the hard
    // option ceiling: the plan is whole and follows every rule, but the preview
    // says it may not be optimal.
    timeLimited: timeLimited || optionLimited,
    moves,
    movedCriticalTasks: moves.some((move) => move.critical),
    milestones,
    fixedMilestoneIds: [...fixedMilestoneIds].sort(),
    oldProjectFinish: oldFinish,
    newProjectFinish: newFinish,
    finishDeltaWorkingDays: workingDayGap(oldFinish, newFinish, calendarId, system),
    occupancy,
    unresolved,
    blockers,
    workHoursPreserved,
    tasks: current,
  };
}
