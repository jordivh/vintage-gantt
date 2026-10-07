import { isoDate, parseIsoDate, type CalendarSystem } from "./scheduling-engine";
import { dailyAllocation, taskWorkingDates, type DailyAllocation, type PlannerTask } from "./planner-model";
import { availableHours } from "./resource-capacity";
import {
  dayLabel,
  monthEnd,
  monthLabel,
  monthStart,
  weekEnd,
  weekRangeLabel,
  weekStart,
  type CapacityPeriodRow,
} from "./capacity-period";

/**
 * The capacity engine: it turns each active task's daily work allocation (step 2)
 * and each resource's available hours (step 3) into a per-resource load picture,
 * and detects overloads and conflicting assignments.
 *
 * Load is work only — a task contributes its Distribution-driven allocated hours
 * on each of its working days, never its duration, and never anything inside a
 * margin zone. Availability is the resource's own calendar capacity, so leave,
 * off-days and hierarchy holidays give 0 h.
 */

const EPSILON = 1e-9;

/* ----------------------------------------------------------------- inputs */

export interface CapacityPerson {
  id: string;
  name: string;
  hoursPerWeek: number;
  calendarId: string;
}

export interface CapacityProjectInput {
  projectId: string;
  projectName: string;
  projectCalendarId?: string;
  /** Only the project's active plan version — never more than one version. */
  tasks: PlannerTask[];
}

export interface CapacityAssignment {
  taskId: string;
  resourceId: string;
}

export interface CapacityInput {
  system: CalendarSystem;
  resources: CapacityPerson[];
  assignments: CapacityAssignment[];
  projects: CapacityProjectInput[];
  /**
   * The window to report on: the day series covers exactly these days, and the
   * report's own totals therefore cover exactly them too. Leaving it out keeps
   * the whole span of the plan — the period a screen shows is the caller's
   * choice, the per-day figures never change either way.
   */
  range?: { start: string; end: string };
}

/* --------------------------------------------------------------- filters */

/** The project facts the overview filters need. */
export interface CapacityProjectRef {
  id: string;
  name: string;
  status: string;
  kind?: "project" | "template";
  client?: string;
}

export interface CapacityFilter {
  resourceId?: string;
  projectId?: string;
  client?: string;
}

/**
 * The projects that may contribute load: regular projects only (never a
 * template) and never an archived one, narrowable by project and client. This is
 * what keeps archived or deleted work from leaving ghost load behind. The
 * resource filter does not change the project set.
 */
export function selectCapacityProjects<T extends CapacityProjectRef>(projects: T[], filter: CapacityFilter = {}): T[] {
  return projects.filter((project) =>
    (project.kind ?? (project.status === "template" ? "template" : "project")) === "project"
    && project.status !== "archived"
    && (!filter.projectId || project.id === filter.projectId)
    && (!filter.client || project.client === filter.client));
}

/** The clients available to filter by: distinct, non-empty, sorted. */
export function capacityClients(projects: CapacityProjectRef[]): string[] {
  return [...new Set(selectCapacityProjects(projects).map((project) => project.client).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b));
}

/** True when a resource passes the resource filter (an unset filter passes all). */
export function matchesResourceFilter(resourceId: string, filter: CapacityFilter): boolean {
  return !filter.resourceId || filter.resourceId === resourceId;
}

/* ---------------------------------------------------------------- output */

export interface CapacityContribution {
  projectId: string;
  projectName: string;
  taskId: string;
  taskName: string;
  hours: number;
}

export interface CapacityDay {
  date: string;
  allocated: number;
  available: number;
  contributions: CapacityContribution[];
}

/** One task that shares an overloaded day with another task of the same resource. */
export interface CapacityConflict {
  date: string;
  taskId: string;
  taskName: string;
  projectId: string;
  projectName: string;
  otherTaskId: string;
  otherTaskName: string;
  otherProjectId: string;
  otherProjectName: string;
}

export interface CapacityBreakdownRow {
  projectId: string;
  projectName: string;
  allocated: number;
}

/** A task assigned to a resource that cannot work on any day of its span. */
export interface UnavailableTask {
  taskId: string;
  taskName: string;
  projectId: string;
  projectName: string;
  /** The task's work that cannot be spread on any available day. */
  work: number;
}

/**
 * The hours one resource has on one task, from the daily distribution itself:
 * `total` over the task's whole span, `inPeriod` only the part that falls inside
 * the report's window (the period a screen shows). The two figures come from the
 * same allocation, so neither is ever an estimate from overlapping calendar days,
 * and the sum of `inPeriod` is the report's allocated total by construction.
 */
export interface ResourceTaskWork {
  taskId: string;
  projectId: string;
  total: number;
  inPeriod: number;
}

/**
 * True when a task's own dates overlap a period, inclusive on both ends: a task
 * that starts before it or finishes after it still counts, one that lies wholly
 * outside it does not. Missing dates fall back to the other end, so a task with
 * only a start is still placed.
 */
export function overlapsRange(start: string, finish: string, range: { start: string; end: string }): boolean {
  const from = start || finish;
  const to = finish || start;
  if (!from || !to) return false;
  return from <= range.end && to >= range.start;
}

export interface ResourceCapacityReport {
  resourceId: string;
  resourceName: string;
  hoursPerWeek: number;
  days: CapacityDay[];
  conflicts: CapacityConflict[];
  /** Tasks whose whole span falls on days this resource cannot work. */
  unavailableTasks: UnavailableTask[];
  /** Per task: the whole-task hours and the part inside the report's window. */
  assignedWork: ResourceTaskWork[];
  totalAllocated: number;
  totalAvailable: number;
  overloadedDays: number;
}

export type CapacityGranularity = "week" | "month";

export interface CapacityPeriod {
  key: string;
  label: string;
  start: string;
  end: string;
  /** True on a month view's first and last week: the row is not a whole week. */
  partial?: boolean;
  /** The daily figures this row is the exact sum of, in date order. */
  days: CapacityDay[];
  available: number;
  allocated: number;
  remaining: number;
  /** allocated / available, or null when there is no availability at all. */
  utilisation: number | null;
  /** The row itself is over capacity: its allocated hours exceed its available hours. */
  overload: boolean;
  /** Days inside the row that are over capacity, even when the row's own total is not. */
  overloadedDays: number;
  /** Distinct tasks that put hours on this row. */
  assignments: number;
  breakdown: CapacityBreakdownRow[];
  conflicts: CapacityConflict[];
}

/* ---------------------------------------------------------------- helpers */

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

const eachDate = (start: string, end: string): string[] => {
  const dates: string[] = [];
  const cursor = parseIsoDate(start);
  const last = parseIsoDate(end).getTime();
  while (cursor.getTime() <= last) {
    dates.push(isoDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
};

/** The whole calendar week (Monday–Sunday) or the whole calendar month around a date. */
const periodOf = (date: string, granularity: CapacityGranularity): CapacityPeriodRow => {
  if (granularity === "month") {
    return { key: date.slice(0, 7), label: monthLabel(date), start: monthStart(date), end: monthEnd(date) };
  }
  const start = weekStart(date);
  const end = weekEnd(start);
  return { key: start, label: weekRangeLabel(start, end), start, end };
};

/* --------------------------------------------------------------- compute */

/**
 * Per resource, the allocated and available hours on each calendar day of the
 * report — the whole span of the active plan, or exactly the window the caller
 * asked for — plus the conflicting-assignment pairs. Only the tasks handed in
 * (one active version per project) are counted, so a resource is never charged
 * twice for two versions of the same project. A window only decides which days
 * are reported and summed; each day's own figures are computed the same way
 * either way.
 */
export function computeResourceLoads(input: CapacityInput): ResourceCapacityReport[] {
  const { system, resources, assignments, projects, range } = input;
  const resourceById = new Map(resources.map((resource) => [resource.id, resource]));
  const taskIndex = new Map<string, { task: PlannerTask; projectId: string; projectName: string; calendarId?: string }>();
  let rangeStart = "";
  let rangeEnd = "";
  for (const project of projects) {
    for (const task of project.tasks) {
      taskIndex.set(task.id, { task, projectId: project.projectId, projectName: project.projectName, calendarId: project.projectCalendarId });
      // A caller that hands in a window shows exactly that window, so the plan's
      // own span — and this extra walk over every task — is not needed.
      if (range) continue;
      // The task's own working days (calendar only) define the plan's time span.
      for (const entry of dailyAllocation(task, system, project.projectCalendarId)) {
        if (!rangeStart || entry.date < rangeStart) rangeStart = entry.date;
        if (!rangeEnd || entry.date > rangeEnd) rangeEnd = entry.date;
      }
    }
  }

  // The work is spread only over the days the assigned person can actually work,
  // so leave, holidays and personal days off never hold planned hours. Cached per
  // task+resource because the same task can be assigned to several people.
  const allocationCache = new Map<string, DailyAllocation[]>();
  const allocationFor = (taskId: string, resourceId: string): DailyAllocation[] => {
    const key = `${taskId}|${resourceId}`;
    const cached = allocationCache.get(key);
    if (cached) return cached;
    const entry = taskIndex.get(taskId);
    const resource = resourceById.get(resourceId);
    const allocation = entry && resource
      ? dailyAllocation(entry.task, system, entry.calendarId, (date) => availableHours(resource, date, system) > 0)
      : [];
    allocationCache.set(key, allocation);
    return allocation;
  };

  // A task whose whole span falls on days the person cannot work: the work has
  // nowhere to go, so it is reported rather than silently dropped (BES-008).
  const unavailableByResource = new Map<string, UnavailableTask[]>();
  for (const assignment of assignments) {
    const entry = taskIndex.get(assignment.taskId);
    const resource = resourceById.get(assignment.resourceId);
    if (!entry || !resource) continue;
    const work = Math.max(0, entry.task.work ?? 0);
    if (work <= 0) continue;
    const days = taskWorkingDates(entry.task, system, entry.calendarId);
    if (days.length === 0 || days.some((date) => availableHours(resource, date, system) > 0)) continue;
    const list = unavailableByResource.get(assignment.resourceId) ?? [];
    list.push({ taskId: entry.task.id, taskName: entry.task.name, projectId: entry.projectId, projectName: entry.projectName, work });
    unavailableByResource.set(assignment.resourceId, list);
  }

  // resourceId → date → the tasks (of any project) that put hours on that day.
  const loadByResource = new Map<string, Map<string, CapacityContribution[]>>();
  // resourceId → taskId → the hours this resource has on that task over its whole
  // span. Kept separately from the day map because a window may hold none of a
  // task's hours while the task still overlaps the period.
  const workByResource = new Map<string, Map<string, ResourceTaskWork>>();
  for (const assignment of assignments) {
    const entry = taskIndex.get(assignment.taskId);
    if (!entry) continue;
    let days = loadByResource.get(assignment.resourceId);
    if (!days) { days = new Map(); loadByResource.set(assignment.resourceId, days); }
    const allocation = allocationFor(assignment.taskId, assignment.resourceId);
    let total = 0;
    for (const allocationEntry of allocation) {
      // The whole-task total counts every day of the task's span, the day map only
      // the days the caller's window reports.
      total += allocationEntry.hours;
      if (allocationEntry.hours <= 0) continue;
      const list = days.get(allocationEntry.date) ?? [];
      list.push({ projectId: entry.projectId, projectName: entry.projectName, taskId: assignment.taskId, taskName: entry.task.name, hours: allocationEntry.hours });
      days.set(allocationEntry.date, list);
    }
    let work = workByResource.get(assignment.resourceId);
    if (!work) { work = new Map(); workByResource.set(assignment.resourceId, work); }
    work.set(entry.task.id, { taskId: entry.task.id, projectId: entry.projectId, total, inPeriod: 0 });
  }

  // The shown period, or the whole plan when no window was asked for. Availability
  // and the daily allocation are computed per day either way, so windowing never
  // changes a single day's figure — it only decides which days are summed.
  const dates = range ? eachDate(range.start, range.end) : rangeStart && rangeEnd ? eachDate(rangeStart, rangeEnd) : [];

  return resources.map((resource) => {
    const loadDays = loadByResource.get(resource.id) ?? new Map<string, CapacityContribution[]>();
    const days: CapacityDay[] = dates.map((date) => {
      const contributions = loadDays.get(date) ?? [];
      return {
        date,
        allocated: sum(contributions.map((contribution) => contribution.hours)),
        available: availableHours(resource, date, system),
        contributions,
      };
    });
    // What each task contributes inside the window — a pure sum over the reported
    // days, so these figures add up to the allocated total below to the minute.
    const inPeriodByTask = new Map<string, number>();
    for (const day of days) {
      for (const contribution of day.contributions) {
        inPeriodByTask.set(contribution.taskId, (inPeriodByTask.get(contribution.taskId) ?? 0) + contribution.hours);
      }
    }
    const assignedWork = [...(workByResource.get(resource.id)?.values() ?? [])]
      .map((entry) => ({ ...entry, inPeriod: inPeriodByTask.get(entry.taskId) ?? 0 }))
      .sort((left, right) => left.taskId.localeCompare(right.taskId));
    return {
      resourceId: resource.id,
      resourceName: resource.name,
      hoursPerWeek: resource.hoursPerWeek,
      days,
      conflicts: conflictsFromDays(days),
      unavailableTasks: unavailableByResource.get(resource.id) ?? [],
      assignedWork,
      totalAllocated: sum(days.map((day) => day.allocated)),
      totalAvailable: sum(days.map((day) => day.available)),
      overloadedDays: days.filter((day) => isOverloaded(day.allocated, day.available)).length,
    };
  });
}

/** A day is overloaded when more hours are allocated than the resource has. */
export function isOverloaded(allocated: number, available: number): boolean {
  return allocated > available + EPSILON;
}

/**
 * The conflicting assignments behind the overloaded days: on any day where the
 * resource is over capacity and two or more tasks contribute, each task names
 * the others it overlaps with. Reported once per task pair, with the first day
 * they collide.
 */
function conflictsFromDays(days: CapacityDay[]): CapacityConflict[] {
  const conflicts: CapacityConflict[] = [];
  const seen = new Set<string>();
  for (const day of days) {
    if (!isOverloaded(day.allocated, day.available) || day.contributions.length < 2) continue;
    for (const task of day.contributions) {
      for (const other of day.contributions) {
        if (task.taskId === other.taskId) continue;
        const key = `${task.taskId}|${other.taskId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        conflicts.push({
          date: day.date,
          taskId: task.taskId,
          taskName: task.taskName,
          projectId: task.projectId,
          projectName: task.projectName,
          otherTaskId: other.taskId,
          otherTaskName: other.taskName,
          otherProjectId: other.projectId,
          otherProjectName: other.projectName,
        });
      }
    }
  }
  return conflicts;
}

/**
 * Aggregates a resource's daily load into the given rows — one day of a week, a
 * whole week, or a week clipped to a month. Every figure is a pure sum over the
 * days inside the row, so a row can never disagree with the days it covers, and
 * a clipped week can never count hours that belong to the next month. The rows
 * come back in the order they were given.
 */
export function aggregateSpans(report: ResourceCapacityReport, rows: CapacityPeriodRow[]): CapacityPeriod[] {
  return rows.map((row) => {
    const days = report.days.filter((day) => day.date >= row.start && day.date <= row.end);
    const available = sum(days.map((day) => day.available));
    const allocated = sum(days.map((day) => day.allocated));
    return {
      key: row.key,
      label: row.label,
      start: row.start,
      end: row.end,
      partial: row.partial,
      days,
      available,
      allocated,
      remaining: available - allocated,
      utilisation: utilisationOf(allocated, available),
      overload: isOverloaded(allocated, available),
      overloadedDays: days.filter((day) => isOverloaded(day.allocated, day.available)).length,
      assignments: new Set(days.flatMap((day) => day.contributions.map((contribution) => contribution.taskId))).size,
      breakdown: breakdownFor(days),
      conflicts: report.conflicts.filter((conflict) => conflict.date >= row.start && conflict.date <= row.end),
    };
  });
}

/**
 * Groups a resource's daily load into every week (Monday–Sunday) or calendar
 * month the plan touches, biggest-first order not needed: display order is by
 * start date. Both are pure sums over the same daily figures, so a month always
 * equals the sum of its days — even for a week that straddles two months.
 * A screen that shows one period instead builds its rows from
 * `capacity-period.ts` and hands them to `aggregateSpans`.
 */
export function aggregatePeriods(report: ResourceCapacityReport, granularity: CapacityGranularity): CapacityPeriod[] {
  const rows = new Map<string, CapacityPeriodRow>();
  for (const day of report.days) {
    const row = periodOf(day.date, granularity);
    rows.set(row.key, row);
  }
  const ordered = [...rows.values()].sort((left, right) => left.start.localeCompare(right.start));
  return aggregateSpans(report, ordered);
}

/** allocated / available, or null when there is not a single available hour. */
export function utilisationOf(allocated: number, available: number): number | null {
  return available > 0 ? allocated / available : null;
}

/**
 * The report's own utilisation — total allocated ÷ total available, never an
 * average of daily or weekly percentages. Null when the report has no available
 * hours at all, which the screen shows as a dash rather than as 0%.
 */
export function reportUtilisation(report: ResourceCapacityReport): number | null {
  return utilisationOf(report.totalAllocated, report.totalAvailable);
}

/** The distinct tasks that put hours on the report's days — its assignments. */
export function reportAssignmentCount(report: ResourceCapacityReport): number {
  const tasks = new Set<string>();
  for (const day of report.days) for (const contribution of day.contributions) tasks.add(contribution.taskId);
  return tasks.size;
}

/** Allocated hours per project over the given days, biggest first. */
function breakdownFor(days: CapacityDay[]): CapacityBreakdownRow[] {
  const byProject = new Map<string, CapacityBreakdownRow>();
  for (const day of days) {
    for (const contribution of day.contributions) {
      const row = byProject.get(contribution.projectId) ?? { projectId: contribution.projectId, projectName: contribution.projectName, allocated: 0 };
      row.allocated += contribution.hours;
      byProject.set(contribution.projectId, row);
    }
  }
  return [...byProject.values()].sort((left, right) => right.allocated - left.allocated);
}

/**
 * The explicit English overload warning for one row of the table, naming the
 * resource, the row, the available hours and the allocated hours. Colour is
 * never the only signal.
 *
 * A row whose own total stays under 100% can still hold an overloaded day (a
 * week clipped to a month, or a light week with one heavy day), so that case is
 * reported separately and by day count — a day over capacity is never hidden
 * behind a comfortable average.
 */
export function overloadWarning(resourceName: string, period: CapacityPeriod): string | null {
  if (period.overload) {
    return `Overload: ${resourceName} has ${formatCapacityHours(period.allocated)} h allocated in ${period.label} but only ${formatCapacityHours(period.available)} h available.`;
  }
  if (period.overloadedDays > 0) {
    const days = period.overloadedDays === 1 ? "1 day" : `${period.overloadedDays} days`;
    return `Overload: ${days} inside ${period.label} exceed ${resourceName}’s available hours.`;
  }
  return null;
}

/** The explicit English warning for a single overloaded day. */
export function dayOverloadWarning(resourceName: string, day: CapacityDay): string | null {
  if (!isOverloaded(day.allocated, day.available)) return null;
  return `Overload: ${resourceName} has ${formatCapacityHours(day.allocated)} h planned on ${dayLabel(day.date)} but only ${formatCapacityHours(day.available)} h available.`;
}

/**
 * The explicit English warning for a task whose whole span falls on days the
 * person cannot work: the hours have nowhere to land, so the tool says so rather
 * than moving the task or dropping the work (BES-008).
 */
export function unavailableWarning(resourceName: string, work: number): string {
  return `${resourceName} is unavailable during this task: ${formatCapacityHours(work)} h cannot be distributed.`;
}

/** Compact hour figure: whole hours as-is, otherwise one decimal. */
export function formatCapacityHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
