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
 * A pure, deterministic advisor for the Gantt view: it may move the tasks of
 * one project (the open one, active version) so that every employee sits as
 * close as possible to 90% occupancy per week, without ever exceeding 100%
 * because of a task of that project.
 *
 * It calculates nothing of its own. Float and the critical path come from the
 * planner's own `withCalculatedPlanningFields` (CPM), the plan is re-scheduled
 * by the planner's `recalculateTasks`, and the per-employee weekly occupancy is
 * the very picture the Capacity screen shows — `computeResourceLoads` over every
 * project's active version, aggregated into weeks by `aggregatePeriods` — so the
 * advisor and the capacity screen can never disagree. Workload of all other
 * projects is counted but never changed: only the open project's rows are ever
 * touched, and only their start date (with the start intent that keeps it).
 *
 * Durations, resource assignments, dependencies and margin are never edited.
 * A task always stays one block: a move is a whole-start-date shift, snapped to
 * a working day, and it can never place a task before its dependencies allow.
 */

export const OCCUPANCY_TARGET = 0.9;
export const OCCUPANCY_LIMIT = 1;
/** A week counts as "far from the target" once it is this far below 90%. */
export const OFF_TARGET_MARGIN = 0.1;

const EPSILON = 1e-9;

export const OPTIMIZE_DEFAULTS = {
  /** Improving moves applied before the search stops. */
  maxIterations: 12,
  /** Working days a single candidate may shift, either way. */
  maxShiftDays: 10,
  /** Candidate tasks considered per iteration, most float first. */
  maxTasks: 20,
  /**
   * Hard ceiling on scored candidates, so a very large plan still answers
   * quickly. It only ever stops the search early: whatever has been found by
   * then is a valid plan, and the same input still gives the same result.
   */
  maxEvaluations: 4000,
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
  maxEvaluations?: number;
}

export interface OptimizeInput {
  /** The only project whose tasks may move. */
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
  limits?: OptimizeLimits;
}

/* ------------------------------------------------------------------ output */

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
  /** Float the task had before any move. */
  floatAvailable: number;
  /** Whether the task sat on the critical path before any move. */
  critical: boolean;
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
  /** True when at least one task that was on the critical path moved. */
  movedCriticalTasks: boolean;
  oldProjectFinish: string;
  newProjectFinish: string;
  /** Signed change of the project end date, in working days. */
  finishDeltaWorkingDays: number;
  /** Weekly occupancy per employee, before and after, including other projects. */
  occupancy: OptimizeResourceOccupancy[];
  /** Weeks still above 100% or far from 90%, each with a reason. */
  unresolved: OptimizeUnresolved[];
  /** The open project's tasks with the moves applied, same ids, ready to version. */
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

interface WeekRow {
  resourceId: string;
  resourceName: string;
  weekStart: string;
  weekEnd: string;
  allocated: number;
  available: number;
}

interface Score {
  /** Hours over 100% across every employee and week — solved first. */
  excess: number;
  /** Working days the project end date is delayed (never negative) — step 3 only. */
  finishDelta: number;
  /** Total distance from the 90% target across the booked weeks. */
  deviation: number;
}

const hours = (value: number) => {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** The candidate shifts of one task, ordered deterministically. */
function shiftOffsets(laterUpTo: number, earlierUpTo: number): number[] {
  const offsets: number[] = [];
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

  // Who works on what — assignments never change, they only decide which task
  // can influence an employee's occupancy at all.
  const assignedByTask = new Map<string, string[]>();
  for (const assignment of input.assignments) {
    assignedByTask.set(assignment.taskId, [...(assignedByTask.get(assignment.taskId) ?? []), assignment.resourceId]);
  }

  const projectInput = (tasks: PlannerTask[]): CapacityProjectInput => ({
    projectId: openProject.projectId,
    projectName: openProject.projectName,
    projectCalendarId: calendarId,
    tasks,
  });

  /**
   * Whole calendar weeks (Monday–Sunday) around the whole plan, so a week at the
   * edge of the span is never clipped to two days and mistaken for a full one.
   * A clipped week would give a false high occupancy and lure the search into
   * moving work off the front of the plan instead of balancing the weeks.
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
    const projects = [projectInput(tasks), ...others];
    const reports = computeResourceLoads({
      system,
      resources: input.resources,
      assignments: input.assignments,
      projects,
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
    return { excess, finishDelta: 0, deviation };
  };

  /**
   * Ranking of two candidate plans: overload first, then the smallest project
   * delay, then the closest to the 90% target. Two plans that rank the same are
   * separated by `breaksTie`, so the result stays stable.
   */
  const ranksBetter = (candidate: Score, incumbent: Score): boolean => {
    if (candidate.excess !== incumbent.excess) return candidate.excess < incumbent.excess;
    if (candidate.finishDelta !== incumbent.finishDelta) return candidate.finishDelta < incumbent.finishDelta;
    return candidate.deviation < incumbent.deviation;
  };
  const isEqualScore = (candidate: Score, incumbent: Score): boolean =>
    candidate.excess === incumbent.excess
    && candidate.finishDelta === incumbent.finishDelta
    && candidate.deviation === incumbent.deviation;
  /**
   * Which of two equally good moves to take: the smallest shift first ("move as
   * little as possible"), then the task with the most float, then the task that
   * already starts latest — so an earlier task stays where it is and a later one
   * gives way — and finally a stable id order.
   */
  const breaksTie = (candidate: Candidate, incumbent: Candidate): boolean => {
    if (Math.abs(candidate.shift) !== Math.abs(incumbent.shift)) return Math.abs(candidate.shift) < Math.abs(incumbent.shift);
    if (candidate.float !== incumbent.float) return candidate.float > incumbent.float;
    if (candidate.start !== incumbent.start) return candidate.start > incumbent.start;
    if (candidate.shift !== incumbent.shift) return candidate.shift > incumbent.shift;
    return candidate.taskId < incumbent.taskId;
  };

  const baselineComputed = withCalculatedPlanningFields(source, system, calendarId);
  const baselineById = new Map(baselineComputed.map((task) => [task.id, task]));
  const oldFinish = planFinishDate(source);

  /** Moves a task's whole block to `newStart`, then re-plans the network. */
  const applyTaskMove = (tasks: PlannerTask[], taskId: string, newStart: string): PlannerTask[] | null => {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) return null;
    const target = ensureWorkingDay(newStart, task.calendarId ?? calendarId, system);
    if (target === task.start) return null;
    // A task may never start before its dependencies permit, whatever the shift.
    const earliest = earliestDependencyStart(task, tasks, dependenciesForTasks(tasks), {
      calendarSystem: system,
      projectCalendarId: calendarId,
    })?.date ?? null;
    if (earliest && target < earliest) return null;
    const next = tasks.map((candidate) => (candidate.id === taskId
      ? {
          ...candidate,
          // The dependency network is the floor, the explicit start intent keeps
          // the later start — the same way a manual move is stored in the grid.
          start: target,
          startConstraint: earliest && target > earliest ? target : undefined,
          startConstraintActive: false,
        }
      : candidate));
    const recalculated = recalculateTasks(next, { direction: "forward", calendarSystem: system, projectCalendarId: calendarId });
    return recalculated.error ? null : recalculated.tasks;
  };

  const summaryIds = new Set(source.filter((task) => source.some((child) => child.parentId === task.id)).map((task) => task.id));

  /** Tasks that carry occupancy of the open project and may move in this mode. */
  const movableTasks = (computed: PlannerTask[]): PlannerTask[] =>
    computed.filter((task) => {
      if (summaryIds.has(task.id) || task.isMilestone || task.duration <= 0) return false;
      if ((task.work ?? 0) <= 0) return false;
      if (!(assignedByTask.get(task.id)?.length)) return false;
      // Monitoring tracks reality: a task that has started (and therefore any task
      // lying in the past) is fixed. Planning may move every task of the project.
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
    float: number;
    /** The task's start before the move, used only to break a tie. */
    start: string;
  }

  /** Scored candidates so far — the search stops once the ceiling is reached. */
  let evaluations = 0;

  /**
   * One greedy round: every movable task, every allowed shift, and the single
   * best improving move. Tasks are considered most-float first (step 2's order)
   * and equally good moves are separated by `breaksTie`, so the same input
   * always produces the same plan.
   */
  const searchRound = (criticalOnly: boolean): Candidate | null => {
    const floating = movableTasks(computed)
      .map((task) => ({ task, float: baselineById.get(task.id)?.totalFloat ?? 0, critical: baselineById.get(task.id)?.isCritical ?? false }))
      .filter((entry) => (criticalOnly ? entry.critical : !entry.critical && entry.float > 0))
      .sort((left, right) => right.float - left.float || left.task.id.localeCompare(right.task.id))
      .slice(0, limits.maxTasks);

    let best: Candidate | null = null;
    for (const entry of floating) {
      // Within float a later move may use at most the reserve that is left;
      // without float (critical path) the search may slip the plan.
      const laterUpTo = criticalOnly ? limits.maxShiftDays : Math.min(limits.maxShiftDays, Math.floor(entry.float));
      const earlierUpTo = limits.maxShiftDays;
      for (const shift of shiftOffsets(laterUpTo, earlierUpTo)) {
        if (evaluations >= limits.maxEvaluations) break;
        const moved = applyTaskMove(current, entry.task.id, addWorkingDays(entry.task.start, shift, entry.task.calendarId ?? calendarId, system));
        if (!moved) continue;
        evaluations += 1;
        const candidateScore = score(moved);
        // Step 2 may never change the project end date; step 3 accepts a delay
        // but measures it as a delay only — finishing earlier is never a reason
        // to keep moving the plan backwards.
        if (criticalOnly) {
          candidateScore.finishDelta = Math.max(0, workingDayGap(oldFinish, planFinishDate(moved), calendarId, system));
        } else if (planFinishDate(moved) !== oldFinish) {
          continue;
        }
        // A round only ever applies a move that makes the plan strictly better,
        // so the search cannot wander between equally good plans.
        if (!ranksBetter(candidateScore, currentScore)) continue;
        const candidate: Candidate = { tasks: moved, score: candidateScore, taskId: entry.task.id, shift, float: entry.float, start: entry.task.start };
        if (best) {
          const improves = ranksBetter(candidateScore, best.score);
          const equal = isEqualScore(candidateScore, best.score);
          if (!improves && !(equal && breaksTie(candidate, best))) continue;
        }
        best = candidate;
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
  }

  // Step 3 — only when a task of the open project still overloads someone, the
  // critical path may be moved too, delaying the project as little as possible.
  for (let iteration = 0; currentScore.excess > EPSILON && iteration < limits.maxIterations; iteration += 1) {
    const round = searchRound(true);
    if (!round) break;
    current = round.tasks;
    computed = withCalculatedPlanningFields(current, system, calendarId);
    currentScore = score(current);
  }

  /* ------------------------------------------------------------- reporting */

  const afterById = new Map(current.map((task) => [task.id, task]));
  const moves: OptimizeMove[] = source
    .filter((task) => {
      const after = afterById.get(task.id);
      return after && (after.start !== task.start || after.finish !== task.finish);
    })
    .map((task) => {
      const after = afterById.get(task.id)!;
      const shiftDays = workingDayGap(task.start, after.start, calendarId, system);
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
      };
    })
    .sort((left, right) => left.oldStart.localeCompare(right.oldStart) || left.taskId.localeCompare(right.taskId));

  const newFinish = planFinishDate(current);
  const beforeRows = loadRows(source);
  const afterRows = loadRows(current);

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
        reason: `${row.resourceName} is still over 100% in the week of ${row.weekStart}: ${hours(row.allocated)} h planned against ${hours(row.available)} h available.${other > 0 ? ` Other projects already plan ${hours(other)} h of that week.` : ""} No task of this project could be moved without breaking a rule.`,
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
        reason: `${row.resourceName} is only ${percent(ratio)} booked in the week of ${row.weekStart} (${hours(row.allocated)} h of ${hours(row.available)} h). No task could be moved closer to the 90% target without breaking a rule.`,
      });
    }
  }

  return {
    ok: true,
    moves,
    movedCriticalTasks: moves.some((move) => move.critical),
    oldProjectFinish: oldFinish,
    newProjectFinish: newFinish,
    finishDeltaWorkingDays: workingDayGap(oldFinish, newFinish, calendarId, system),
    occupancy,
    unresolved,
    tasks: current,
  };
}
