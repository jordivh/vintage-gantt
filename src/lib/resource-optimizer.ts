import {
  addWorkingDays,
  earliestDependencyStart,
  ensureWorkingDay,
  workingDaysBetween,
  type CalendarSystem,
} from "./scheduling-engine";
import {
  dependenciesForTasks,
  planFinishDate,
  recalculateTasks,
  taskWorkingDates,
  withCalculatedPlanningFields,
  type PlannerTask,
  type PlanMode,
} from "./planner-model";
import {
  aggregatePeriods,
  computeResourceLoads,
  type CapacityProjectInput,
} from "./capacity-engine";
import { weekEnd, weekStart } from "./capacity-period";

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
 */

export const OCCUPANCY_TARGET = 0.9;
export const OCCUPANCY_LIMIT = 1;
/** A week counts as "far from the target" once it is this far below 90%. */
export const OFF_TARGET_MARGIN = 0.1;
/** A duration may grow by at most this factor of what it was before the run. */
export const EXTENSION_LIMIT = 1.5;

const EPSILON = 1e-9;

export const OPTIMIZE_DEFAULTS = {
  /** Improving rounds applied before the search stops. */
  maxIterations: 12,
  /** Working days a single candidate may shift, either way. */
  maxShiftDays: 10,
  /** Candidate tasks considered per round, most float first. */
  maxTasks: 20,
  /**
   * Duration steps considered per task (the +50% cap is always considered too),
   * so a long task does not explode the candidate set. 0 turns duration
   * extension off and leaves the optimizer to moving tasks only.
   */
  maxExtensionDays: 8,
  /**
   * Hard ceiling on scored candidates, so a very large plan still answers
   * quickly. It only ever stops the search early: whatever has been found by
   * then is a valid plan, and the same input still gives the same result.
   */
  maxEvaluations: 8000,
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
  maxTasks?: number;
  maxExtensionDays?: number;
  maxEvaluations?: number;
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
  /** Weekly occupancy per employee, before and after, including other projects. */
  occupancy: OptimizeResourceOccupancy[];
  /** Weeks still above 100% or far from 90%, each with a reason. */
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
  /** Priority 1 — hours over 100% across every employee and week. */
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
  const resourceNameById = new Map(input.resources.map((resource) => [resource.id, resource.name]));

  const projectInput = (tasks: PlannerTask[]): CapacityProjectInput => ({
    projectId: openProject.projectId,
    projectName: openProject.projectName,
    projectCalendarId: calendarId,
    tasks,
  });

  /**
   * Whole calendar weeks (Monday–Sunday) around the whole plan, so a week at the
   * edge of the span is never clipped to two days and mistaken for a full one.
   */
  const weekWindow = (tasks: PlannerTask[]): { start: string; end: string } | null => {
    let earliest = "";
    let latest = "";
    for (const project of [projectInput(tasks), ...others]) {
      for (const task of project.tasks) {
        for (const date of taskWorkingDates(task, system, project.projectCalendarId)) {
          if (!earliest || date < earliest) earliest = date;
          if (!latest || date > latest) latest = date;
        }
      }
    }
    if (!earliest || !latest) return null;
    return { start: weekStart(earliest), end: weekEnd(weekStart(latest)) };
  };

  /**
   * The weekly occupancy of every employee, exactly as the Capacity screen
   * computes it: the open project's rows follow `tasks`, every other project
   * contributes its own active version untouched.
   */
  const loadRows = (tasks: PlannerTask[]): WeekRow[] => {
    const reports = computeResourceLoads({
      system,
      resources: input.resources,
      assignments: input.assignments,
      projects: [projectInput(tasks), ...others],
      range: weekWindow(tasks) ?? undefined,
    });
    return reports.flatMap((report) =>
      aggregatePeriods(report, "week").map((period) => ({
        resourceId: report.resourceId,
        resourceName: report.resourceName,
        weekStart: period.start,
        weekEnd: period.end,
        allocated: period.allocated,
        available: period.available,
      })));
  };

  /** The weekly occupancy of the other projects alone — the limit on the result. */
  const otherLoad = new Map<string, number>();
  if (others.length) {
    const range = weekWindow(source) ?? undefined;
    for (const report of computeResourceLoads({ system, resources: input.resources, assignments: input.assignments, projects: others, range })) {
      for (const period of aggregatePeriods(report, "week")) {
        otherLoad.set(`${report.resourceId}|${period.start}`, period.allocated);
      }
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
    for (const row of loadRows(tasks)) {
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

  interface ChangeOutcome {
    tasks?: PlannerTask[];
    /** A fixed milestone would have had to move for this candidate. */
    blockedBy?: string;
  }

  /**
   * Applies one candidate — a whole-start-date shift and/or a duration extension
   * — and re-plans the network. Returns no tasks when the change is empty or
   * illegal (before a dependency, no-op), and names the fixed milestone when the
   * candidate could only work by moving one.
   */
  const applyTaskChange = (tasks: PlannerTask[], taskId: string, shiftDays: number, extensionDays: number): ChangeOutcome => {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) return {};
    if (!shiftDays && !extensionDays) return {};
    let target = task.start;
    let constraint = task.startConstraint;
    if (shiftDays) {
      // A task may never start before its dependencies permit, whatever the shift.
      const earliest = earliestDependencyStart(task, tasks, dependenciesForTasks(tasks), {
        calendarSystem: system,
        projectCalendarId: calendarId,
      })?.date ?? null;
      target = ensureWorkingDay(addWorkingDays(task.start, shiftDays, task.calendarId ?? calendarId, system), task.calendarId ?? calendarId, system);
      if (earliest && target < earliest) return {};
      if (target === task.start) return {};
      constraint = earliest && target > earliest ? target : undefined;
    }
    // The +50% cap is a hard limit, applied here as well as in the candidate
    // list, so no path can ever grow a task past it.
    const cap = maxDurationFor(baselineDurations.get(taskId) ?? task.duration, isMilestoneRow(task));
    const next = tasks.map((candidate) => (candidate.id === taskId
      ? {
          ...candidate,
          start: target,
          duration: Math.min(candidate.duration + extensionDays, cap),
          startConstraint: constraint,
          startConstraintActive: false,
        }
      : candidate));
    const recalculated = recalculateTasks(next, { direction: "forward", calendarSystem: system, projectCalendarId: calendarId });
    if (recalculated.error) return {};
    // A fixed milestone that the re-planning would have shifted is a refusal,
    // never a silent move.
    const blockedBy = movedFixedMilestone(recalculated.tasks);
    if (blockedBy) return { blockedBy };
    return { tasks: recalculated.tasks };
  };

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

  let current = source;
  let computed = baselineComputed;
  let currentScore = score(current);

  interface Candidate {
    tasks: PlannerTask[];
    score: Score;
    taskId: string;
    shift: number;
    extension: number;
    float: number;
    /** The task's start before the change, used only to break a tie. */
    start: string;
  }

  /**
   * Which of two equally good changes to take: the smallest change first ("move
   * as little as possible"), then the task with the most float, then the task
   * that already starts latest, then a stable id order.
   */
  const breaksTie = (candidate: Candidate, incumbent: Candidate): boolean => {
    const candidateSize = Math.abs(candidate.shift) + candidate.extension;
    const incumbentSize = Math.abs(incumbent.shift) + incumbent.extension;
    if (candidateSize !== incumbentSize) return candidateSize < incumbentSize;
    if (candidate.float !== incumbent.float) return candidate.float > incumbent.float;
    if (candidate.start !== incumbent.start) return candidate.start > incumbent.start;
    if (candidate.shift !== incumbent.shift) return candidate.shift > incumbent.shift;
    if (candidate.extension !== incumbent.extension) return candidate.extension < incumbent.extension;
    return candidate.taskId < incumbent.taskId;
  };

  /** Scored candidates so far — the search stops once the ceiling is reached. */
  let evaluations = 0;
  /**
   * Fixed milestones a candidate needed to move, with the weeks and employees
   * that were over capacity at that moment. Reported when the problem is still
   * there at the end — that is exactly "only solvable by moving the milestone".
   */
  const blockedByMilestone = new Map<string, { resources: Set<string>; weeks: Set<string> }>();
  let overloadRows: WeekRow[] | null = null;
  const currentOverloads = (): WeekRow[] => {
    overloadRows ??= loadRows(current).filter((row) => row.allocated > row.available + EPSILON);
    return overloadRows;
  };

  /**
   * One greedy round: every movable task, every allowed shift and extension, and
   * the single best improving change. Tasks are considered most-float first
   * (step 2's order) and equally good changes are separated by `breaksTie`, so
   * the same input always produces the same plan.
   */
  const searchRound = (allowFinishChange: boolean): Candidate | null => {
    const entries = movableTasks(computed)
      .map((task) => ({
        task,
        float: baselineById.get(task.id)?.totalFloat ?? 0,
        critical: baselineById.get(task.id)?.isCritical ?? false,
        // The +50% cap is measured against the duration the task had before this
        // run, so the headroom that is left is the cap minus what it has already
        // grown to — never the cap itself again, or a second round could push a
        // task past +50%.
        maxExtension: Math.max(0, maxDurationFor(baselineDurations.get(task.id) ?? task.duration, isMilestoneRow(task)) - task.duration),
      }))
      // Step 2 uses the float only; step 3 may move the critical path too.
      .filter((entry) => (allowFinishChange ? true : (!entry.critical && entry.float > 0)))
      .sort((left, right) => right.float - left.float || left.task.id.localeCompare(right.task.id))
      .slice(0, limits.maxTasks);

    let best: Candidate | null = null;
    for (const entry of entries) {
      const laterUpTo = allowFinishChange ? limits.maxShiftDays : Math.min(limits.maxShiftDays, Math.floor(entry.float));
      for (const shift of shiftOffsets(laterUpTo, limits.maxShiftDays)) {
        for (const extension of extensionSteps(entry.maxExtension, limits.maxExtensionDays)) {
          if (evaluations >= limits.maxEvaluations) break;
          if (!shift && !extension) continue;
          const outcome = applyTaskChange(current, entry.task.id, shift, extension);
          if (outcome.blockedBy) {
            const record = blockedByMilestone.get(outcome.blockedBy) ?? { resources: new Set<string>(), weeks: new Set<string>() };
            for (const row of currentOverloads()) {
              record.resources.add(row.resourceId);
              record.weeks.add(row.weekStart);
            }
            blockedByMilestone.set(outcome.blockedBy, record);
            continue;
          }
          if (!outcome.tasks) continue;
          evaluations += 1;
          const candidateScore = score(outcome.tasks);
          // Step 2 may never change the project end date; step 3 accepts a delay
          // but measures it as a delay only — finishing earlier is never a reason
          // to keep moving the plan backwards.
          if (allowFinishChange) {
            candidateScore.finishDelta = Math.max(0, workingDayGap(oldFinish, planFinishDate(outcome.tasks), calendarId, system));
          } else if (planFinishDate(outcome.tasks) !== oldFinish) {
            continue;
          }
          // A round only ever applies a change that makes the plan strictly
          // better, so the search cannot wander between equally good plans.
          if (!ranksBetter(candidateScore, currentScore)) continue;
          const candidate: Candidate = {
            tasks: outcome.tasks,
            score: candidateScore,
            taskId: entry.task.id,
            shift,
            extension,
            float: entry.float,
            start: entry.task.start,
          };
          if (best) {
            const improves = ranksBetter(candidateScore, best.score);
            const equal = isEqualScore(candidateScore, best.score);
            if (!improves && !(equal && breaksTie(candidate, best))) continue;
          }
          best = candidate;
        }
      }
    }
    return best;
  };

  // Step 2 — use float first, and never change the project end date.
  for (let iteration = 0; iteration < limits.maxIterations; iteration += 1) {
    const round = searchRound(false);
    if (!round) break;
    current = round.tasks;
    computed = withCalculatedPlanningFields(current, system, calendarId);
    currentScore = score(current);
    overloadRows = null;
  }

  // Step 3 — only when a task of the open project still overloads someone, the
  // critical path may change too, delaying the project as little as possible.
  for (let iteration = 0; currentScore.excess > EPSILON && iteration < limits.maxIterations; iteration += 1) {
    const round = searchRound(true);
    if (!round) break;
    current = round.tasks;
    computed = withCalculatedPlanningFields(current, system, calendarId);
    currentScore = score(current);
    overloadRows = null;
  }

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
  const beforeRows = loadRows(source);
  const afterRows = loadRows(current);

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
      resources: input.resources,
      assignments: input.assignments,
      projects: [projectInput(tasks)],
      range: weekWindow(tasks) ?? undefined,
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

  const unresolved: OptimizeUnresolved[] = [];
  for (const row of afterRows) {
    if (row.allocated <= 0 || row.available <= 0) continue;
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
        reason: `${row.resourceName} is still over 100% in the week of ${row.weekStart}: ${hours(row.allocated)} h planned against ${hours(row.available)} h available.${other > 0 ? ` Other projects already plan ${hours(other)} h of that week.` : ""} No task of this project could be moved or extended without breaking a rule.`,
      });
      continue;
    }
    if (ratio < OCCUPANCY_TARGET - OFF_TARGET_MARGIN) {
      unresolved.push({
        kind: "off-target",
        resourceId: row.resourceId,
        resourceName: row.resourceName,
        weekStart: row.weekStart,
        weekEnd: row.weekEnd,
        allocated: row.allocated,
        available: row.available,
        occupancy: ratio,
        reason: `${row.resourceName} is only ${percent(ratio)} booked in the week of ${row.weekStart} (${hours(row.allocated)} h of ${hours(row.available)} h). No task could be moved or extended closer to the 90% target without breaking a rule.`,
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
    for (const report of computeResourceLoads({ system, resources: input.resources, assignments: input.assignments, projects: [projectInput(current)] })) {
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

  return {
    ok: true,
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
