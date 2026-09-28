import { isoDate, parseIsoDate, type CalendarSystem } from "./scheduling-engine";
import { dailyAllocation, taskWorkingDates, type DailyAllocation, type PlannerTask } from "./planner-model";
import { availableHours } from "./resource-capacity";

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

export interface ResourceCapacityReport {
  resourceId: string;
  resourceName: string;
  hoursPerWeek: number;
  days: CapacityDay[];
  conflicts: CapacityConflict[];
  /** Tasks whose whole span falls on days this resource cannot work. */
  unavailableTasks: UnavailableTask[];
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
  available: number;
  allocated: number;
  remaining: number;
  /** allocated / available, or null when there is no availability at all. */
  utilisation: number | null;
  overload: boolean;
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

const shiftDays = (date: string, amount: number): string => {
  const value = parseIsoDate(date);
  value.setDate(value.getDate() + amount);
  return isoDate(value);
};

const mondayOf = (date: string): string => {
  const weekday = parseIsoDate(date).getDay(); // 0 Sun … 6 Sat
  return shiftDays(date, -((weekday + 6) % 7));
};

const lastDayOfMonth = (monthKey: string): string => {
  const [year, month] = monthKey.split("-").map(Number);
  return `${monthKey}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;
};

const nlDay = new Intl.DateTimeFormat("nl-BE", { day: "numeric", month: "short" });
const nlMonth = new Intl.DateTimeFormat("nl-BE", { month: "long", year: "numeric" });

const periodOf = (date: string, granularity: CapacityGranularity): { key: string; label: string; start: string; end: string } => {
  if (granularity === "month") {
    const key = date.slice(0, 7);
    const start = `${key}-01`;
    const end = lastDayOfMonth(key);
    return { key, label: nlMonth.format(parseIsoDate(start)), start, end };
  }
  const start = mondayOf(date);
  const end = shiftDays(start, 6);
  const label = `${nlDay.format(parseIsoDate(start))} – ${nlDay.format(parseIsoDate(end))} ${end.slice(0, 4)}`;
  return { key: start, label, start, end };
};

/* --------------------------------------------------------------- compute */

/**
 * Per resource, the allocated and available hours on each calendar day across the
 * whole span of the active plan, plus the conflicting-assignment pairs. Only the
 * tasks handed in (one active version per project) are counted, so a resource is
 * never charged twice for two versions of the same project.
 */
export function computeResourceLoads(input: CapacityInput): ResourceCapacityReport[] {
  const { system, resources, assignments, projects } = input;

  const resourceById = new Map(resources.map((resource) => [resource.id, resource]));
  const taskIndex = new Map<string, { task: PlannerTask; projectId: string; projectName: string; calendarId?: string }>();
  let rangeStart = "";
  let rangeEnd = "";
  for (const project of projects) {
    for (const task of project.tasks) {
      taskIndex.set(task.id, { task, projectId: project.projectId, projectName: project.projectName, calendarId: project.projectCalendarId });
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
  for (const assignment of assignments) {
    const entry = taskIndex.get(assignment.taskId);
    if (!entry) continue;
    let days = loadByResource.get(assignment.resourceId);
    if (!days) { days = new Map(); loadByResource.set(assignment.resourceId, days); }
    for (const allocationEntry of allocationFor(assignment.taskId, assignment.resourceId)) {
      if (allocationEntry.hours <= 0) continue;
      const list = days.get(allocationEntry.date) ?? [];
      list.push({ projectId: entry.projectId, projectName: entry.projectName, taskId: assignment.taskId, taskName: entry.task.name, hours: allocationEntry.hours });
      days.set(allocationEntry.date, list);
    }
  }

  const dates = rangeStart && rangeEnd ? eachDate(rangeStart, rangeEnd) : [];

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
    return {
      resourceId: resource.id,
      resourceName: resource.name,
      hoursPerWeek: resource.hoursPerWeek,
      days,
      conflicts: conflictsFromDays(days),
      unavailableTasks: unavailableByResource.get(resource.id) ?? [],
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
 * Groups a resource's daily load into weeks (Monday–Sunday) or calendar months.
 * Both are pure sums over the same daily figures, so a month always equals the
 * sum of its days — even for a week that straddles two months.
 */
export function aggregatePeriods(report: ResourceCapacityReport, granularity: CapacityGranularity): CapacityPeriod[] {
  const groups = new Map<string, { key: string; label: string; start: string; end: string; days: CapacityDay[] }>();
  for (const day of report.days) {
    const info = periodOf(day.date, granularity);
    const group = groups.get(info.key) ?? { ...info, days: [] };
    group.days.push(day);
    groups.set(info.key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const available = sum(group.days.map((day) => day.available));
      const allocated = sum(group.days.map((day) => day.allocated));
      return {
        key: group.key,
        label: group.label,
        start: group.start,
        end: group.end,
        available,
        allocated,
        remaining: available - allocated,
        utilisation: available > 0 ? allocated / available : null,
        overload: isOverloaded(allocated, available),
        breakdown: breakdownFor(group.days),
        conflicts: report.conflicts.filter((conflict) => conflict.date >= group.start && conflict.date <= group.end),
      };
    })
    .sort((left, right) => left.start.localeCompare(right.start));
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
 * The explicit Dutch overload warning — naming the resource, the period, the
 * available hours and the requested hours. Colour is never the only signal.
 */
export function overloadWarning(resourceName: string, period: CapacityPeriod): string | null {
  if (!period.overload) return null;
  return `Overbelasting: ${resourceName} heeft in ${period.label} ${formatCapacityHours(period.available)} u beschikbaar maar ${formatCapacityHours(period.allocated)} u toegewezen.`;
}

/**
 * The explicit Dutch warning for a task whose whole span falls on days the
 * person cannot work: the hours have nowhere to land, so the tool says so rather
 * than moving the task or dropping the work (BES-008).
 */
export function unavailableWarning(resourceName: string, work: number): string {
  return `${resourceName} is niet beschikbaar tijdens deze taak: ${formatCapacityHours(work)} u kan niet verdeeld worden.`;
}

/** Compact hour figure: whole hours as-is, otherwise one decimal. */
export function formatCapacityHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
