import { isoDate, parseIsoDate } from "./scheduling-engine";
import {
  aggregatePeriods,
  computeResourceLoads,
  formatCapacityHours,
  type CapacityAssignment,
  type CapacityBreakdownRow,
  type CapacityInput,
} from "./capacity-engine";

/**
 * Overload visibility for the Planner (BES-008): this module never moves a date,
 * a duration or the timeline — it only reports where a resource is asked for
 * more hours than it has.
 *
 * The load picture is the exact one the Capacity screen shows: it reuses
 * `computeResourceLoads` (work × distribution over the schedule, crossed with
 * the resource's own capacity and leave) and `aggregatePeriods`, so the two
 * screens can never disagree. Allocation is summed across every active version
 * of every project, never per project in isolation, and margin zones carry no
 * work, so they never count as load.
 */

export interface OverloadWeek {
  resourceId: string;
  resourceName: string;
  /** ISO date of the Monday that starts the week. */
  weekStart: string;
  /** ISO date of the Sunday that ends the week. */
  weekEnd: string;
  /** Dutch label, e.g. `week van 12 okt 2026`. */
  label: string;
  allocated: number;
  available: number;
  /** Allocated hours per project in that week, biggest first. */
  breakdown: CapacityBreakdownRow[];
}

/** A task that falls entirely on days one of its assigned resources cannot work. */
export interface TaskUnavailable {
  resourceId: string;
  resourceName: string;
  /** The task's work that cannot be distributed at all. */
  work: number;
}

export interface OverloadIndex {
  /** resourceId → its overloaded weeks, sorted by week start. */
  byResource: Map<string, OverloadWeek[]>;
  /** Resources with at least one overloaded week anywhere in the plan. */
  overloadedResourceIds: string[];
  /** taskId → the resources that cannot work at all during the task's span. */
  unavailableByTask: Map<string, TaskUnavailable[]>;
}

const plusDays = (date: string, amount: number): string => {
  const value = parseIsoDate(date);
  value.setDate(value.getDate() + amount);
  return isoDate(value);
};

const nlWeekDay = new Intl.DateTimeFormat("nl-BE", { day: "numeric", month: "short", year: "numeric" });
/** `week van 12 okt 2026` — the phrasing the overload tooltips use. */
export const overloadWeekLabel = (weekStart: string): string =>
  `week van ${nlWeekDay.format(parseIsoDate(weekStart)).replace(/\./g, "")}`;

/**
 * Build the overload index once: every resource's overloaded weeks, computed
 * from the same cross-project load the Capacity screen renders.
 */
export function buildOverloadIndex(input: CapacityInput): OverloadIndex {
  const byResource = new Map<string, OverloadWeek[]>();
  const overloadedResourceIds: string[] = [];
  const unavailableByTask = new Map<string, TaskUnavailable[]>();
  for (const report of computeResourceLoads(input)) {
    const weeks = aggregatePeriods(report, "week")
      .filter((period) => period.overload)
      .map((period) => ({
        resourceId: report.resourceId,
        resourceName: report.resourceName,
        weekStart: period.start,
        weekEnd: period.end,
        label: overloadWeekLabel(period.start),
        allocated: period.allocated,
        available: period.available,
        breakdown: period.breakdown,
      }));
    byResource.set(report.resourceId, weeks);
    if (weeks.length) overloadedResourceIds.push(report.resourceId);
    for (const task of report.unavailableTasks) {
      unavailableByTask.set(task.taskId, [...(unavailableByTask.get(task.taskId) ?? []), { resourceId: report.resourceId, resourceName: report.resourceName, work: task.work }]);
    }
  }
  return { byResource, overloadedResourceIds, unavailableByTask };
}

/**
 * The weeks inside `fromDate`…`toDate` in which the resource is overloaded. A
 * week counts when any of its days falls inside the range, so a task that only
 * touches part of a heavy week still reports it.
 */
export function getOverloadForResource(index: OverloadIndex, resourceId: string, fromDate: string, toDate: string): OverloadWeek[] {
  const weeks = index.byResource.get(resourceId) ?? [];
  if (!fromDate || !toDate) return weeks;
  return weeks.filter((week) => week.weekStart <= toDate && week.weekEnd >= fromDate);
}

/** The task fields the roll-up reads. */
export interface OverloadTask {
  id: string;
  parentId: string | null;
  start: string;
  finish: string;
  isMilestone?: boolean;
  work?: number;
}

export interface TaskOverload {
  /** The overloaded weeks behind the icon (leaves only; summaries union theirs). */
  weeks: OverloadWeek[];
  /** Overviews: how many descendant tasks carry an overload (a leaf is 0 or 1). */
  count: number;
}

/**
 * Per task, whether an assigned resource is overloaded in any week overlapping
 * the task's span. Milestones and tasks without work are never flagged. Summary
 * rows only aggregate their children's results — they run no calculation of
 * their own — and report how many descendants are affected.
 */
export function overloadByTask(index: OverloadIndex, tasks: OverloadTask[], assignments: CapacityAssignment[]): Map<string, TaskOverload> {
  const assignedByTask = new Map<string, string[]>();
  for (const assignment of assignments) {
    assignedByTask.set(assignment.taskId, [...(assignedByTask.get(assignment.taskId) ?? []), assignment.resourceId]);
  }
  const childrenByParent = new Map<string, OverloadTask[]>();
  for (const task of tasks) {
    if (task.parentId) childrenByParent.set(task.parentId, [...(childrenByParent.get(task.parentId) ?? []), task]);
  }

  const cache = new Map<string, TaskOverload>();
  const visiting = new Set<string>();
  const resolve = (task: OverloadTask): TaskOverload => {
    const cached = cache.get(task.id);
    if (cached) return cached;
    // A malformed parent chain must not loop forever.
    if (visiting.has(task.id)) return { weeks: [], count: 0 };
    visiting.add(task.id);
    const children = childrenByParent.get(task.id);
    let info: TaskOverload;
    if (children && children.length) {
      const seen = new Set<string>();
      const weeks: OverloadWeek[] = [];
      let count = 0;
      for (const child of children) {
        const childInfo = resolve(child);
        count += childInfo.count;
        for (const week of childInfo.weeks) {
          const key = `${week.resourceId}|${week.weekStart}`;
          if (seen.has(key)) continue;
          seen.add(key);
          weeks.push(week);
        }
      }
      weeks.sort((left, right) => left.weekStart.localeCompare(right.weekStart));
      info = { weeks, count };
    } else {
      const eligible = !task.isMilestone && (task.work ?? 0) > 0;
      const resourceIds = eligible ? [...new Set(assignedByTask.get(task.id) ?? [])] : [];
      const weeks = resourceIds
        .flatMap((resourceId) => getOverloadForResource(index, resourceId, task.start, task.finish))
        .sort((left, right) => left.weekStart.localeCompare(right.weekStart));
      info = { weeks, count: weeks.length ? 1 : 0 };
    }
    visiting.delete(task.id);
    cache.set(task.id, info);
    return info;
  };

  for (const task of tasks) resolve(task);
  return cache;
}

export interface ProjectOverload {
  /** The resources of this project that are overloaded in the project's range. */
  resourceIds: string[];
  weeks: OverloadWeek[];
}

/**
 * The overload picture of one project: resources assigned in it that are
 * overloaded in a week overlapping the project's own date range. Each resource
 * is flagged at most once, so the context-bar chip counts people, not weeks.
 */
export function projectOverload(index: OverloadIndex, tasks: OverloadTask[], assignments: CapacityAssignment[]): ProjectOverload {
  const taskIds = new Set(tasks.map((task) => task.id));
  const resourceIds = [...new Set(assignments.filter((assignment) => taskIds.has(assignment.taskId)).map((assignment) => assignment.resourceId))];
  const starts = tasks.map((task) => task.start).filter(Boolean);
  const finishes = tasks.map((task) => task.finish).filter(Boolean);
  if (!starts.length || !finishes.length) return { resourceIds: [], weeks: [] };
  const from = starts.reduce((min, date) => (date < min ? date : min));
  const to = finishes.reduce((max, date) => (date > max ? date : max));

  const overloaded: string[] = [];
  const weeks: OverloadWeek[] = [];
  for (const resourceId of resourceIds) {
    const resourceWeeks = getOverloadForResource(index, resourceId, from, to);
    if (!resourceWeeks.length) continue;
    overloaded.push(resourceId);
    weeks.push(...resourceWeeks);
  }
  weeks.sort((left, right) => left.weekStart.localeCompare(right.weekStart));
  return { resourceIds: overloaded, weeks };
}

/**
 * The Dutch tooltip lines for overloaded weeks: one per week, naming the resource,
 * the week, the planned and available hours, and the per-project split. At most
 * three weeks are listed, then a `+ n weken meer` line.
 */
export function overloadTooltip(weeks: OverloadWeek[], limit = 3): string[] {
  const lines = weeks.slice(0, limit).map((week) => {
    const split = week.breakdown
      .map((row) => `${row.projectName} ${formatCapacityHours(row.allocated)} u`)
      .join(", ");
    return `${week.resourceName} is overbelast in ${week.label}: ${formatCapacityHours(week.allocated)} u gepland, ${formatCapacityHours(week.available)} u beschikbaar${split ? ` (${split})` : ""}`;
  });
  if (weeks.length > limit) lines.push(`+ ${weeks.length - limit} weken meer`);
  return lines;
}
