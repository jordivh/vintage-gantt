export type DependencyType = "FS" | "SS" | "FF" | "SF";
export type DurationUnit = "days" | "weeks";
export type PlanningDirection = "forward" | "backward";

export interface WorkingCalendar {
  id?: string;
  name?: string;
  holidays?: string[];
  organizationClosures?: string[];
  employeeLeave?: Record<string, string[]>;
}

export interface ScheduleTask {
  id: string;
  parentId: string | null;
  duration: number;
  durationUnit: DurationUnit;
  start: string;
  finish: string;
  calendarId?: string;
  resourceId?: string;
  isMilestone?: boolean;
}

export interface ScheduleDependency {
  predecessorId: string;
  successorId: string;
  type: DependencyType;
  lagDays: number;
}

export interface ScheduleOptions {
  direction?: PlanningDirection;
  projectStart?: string;
  projectFinish?: string;
  calendars?: Record<string, WorkingCalendar>;
  defaultCalendar?: WorkingCalendar;
  resetDates?: boolean;
  lockedTaskIds?: string[];
}

const parseDate = (value: string) => new Date(`${value}T12:00:00`);
const toIso = (value: Date) => value.toISOString().slice(0, 10);
const unique = (values: string[]) => [...new Set(values)];

export function calendarForTask(task: ScheduleTask, options: ScheduleOptions = {}) {
  return task.calendarId && options.calendars?.[task.calendarId]
    ? options.calendars[task.calendarId]
    : options.defaultCalendar ?? {};
}

export function isWorkingDay(date: Date, calendar: WorkingCalendar = {}, resourceId?: string) {
  const unavailable = unique([
    ...(calendar.holidays ?? []),
    ...(calendar.organizationClosures ?? []),
    ...(resourceId ? calendar.employeeLeave?.[resourceId] ?? [] : []),
  ]);
  return date.getDay() !== 0 && date.getDay() !== 6 && !unavailable.includes(toIso(date));
}

export function addWorkingDays(value: string, amount: number, calendar: WorkingCalendar = {}, resourceId?: string) {
  const date = parseDate(value);
  const direction = amount < 0 ? -1 : 1;
  let remaining = Math.abs(amount);
  while (remaining > 0) {
    date.setDate(date.getDate() + direction);
    if (isWorkingDay(date, calendar, resourceId)) remaining -= 1;
  }
  return toIso(date);
}

export function workingDaysBetween(start: string, finish: string, calendar: WorkingCalendar = {}, resourceId?: string) {
  const from = parseDate(start);
  const to = parseDate(finish);
  if (from > to) return 0;
  let count = 0;
  for (const cursor = new Date(from); cursor <= to; cursor.setDate(cursor.getDate() + 1)) {
    if (isWorkingDay(cursor, calendar, resourceId)) count += 1;
  }
  return Math.max(1, count);
}

export function durationInWorkingDays(task: ScheduleTask) {
  return task.isMilestone ? 1 : task.durationUnit === "weeks" ? task.duration * 5 : task.duration;
}

function finishFromStart(task: ScheduleTask, options: ScheduleOptions) {
  if (task.isMilestone || durationInWorkingDays(task) <= 1) return task.start;
  return addWorkingDays(task.start, durationInWorkingDays(task) - 1, calendarForTask(task, options), task.resourceId);
}

function startFromFinish(task: ScheduleTask, options: ScheduleOptions) {
  if (task.isMilestone || durationInWorkingDays(task) <= 1) return task.finish;
  return addWorkingDays(task.finish, -(durationInWorkingDays(task) - 1), calendarForTask(task, options), task.resourceId);
}

function dependencyConstraintStart(predecessor: ScheduleTask, successor: ScheduleTask, dependency: ScheduleDependency, options: ScheduleOptions) {
  const calendar = calendarForTask(successor, options);
  const duration = durationInWorkingDays(successor);
  const lag = dependency.lagDays;
  if (dependency.type === "SS") return addWorkingDays(predecessor.start, lag, calendar, successor.resourceId);
  if (dependency.type === "FF") return addWorkingDays(finishFromStart(predecessor, options), lag - duration + 1, calendar, successor.resourceId);
  if (dependency.type === "SF") return addWorkingDays(predecessor.start, lag - duration + 1, calendar, successor.resourceId);
  return addWorkingDays(finishFromStart(predecessor, options), lag === 0 ? 1 : lag, calendar, successor.resourceId);
}

export function hasCircularDependency(tasks: ScheduleTask[], dependencies: ScheduleDependency[]) {
  const graph = new Map<string, string[]>();
  dependencies.forEach((dependency) => graph.set(dependency.predecessorId, [...(graph.get(dependency.predecessorId) ?? []), dependency.successorId]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if ((graph.get(id) ?? []).some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return tasks.some((task) => visit(task.id));
}

function scheduleForward(tasks: ScheduleTask[], dependencies: ScheduleDependency[], options: ScheduleOptions) {
  const result = tasks.map((task) => ({ ...task, ...(options.resetDates && options.projectStart ? { start: options.projectStart } : {}) }));
  const byId = new Map(result.map((task) => [task.id, task]));
  const incoming = new Map<string, ScheduleDependency[]>();
  dependencies.forEach((dependency) => incoming.set(dependency.successorId, [...(incoming.get(dependency.successorId) ?? []), dependency]));
  const visiting = new Set<string>();
  const visit = (task: ScheduleTask) => {
    if (visiting.has(task.id)) return;
    visiting.add(task.id);
    const constraints = (incoming.get(task.id) ?? []).map((dependency) => {
      const predecessor = byId.get(dependency.predecessorId);
      if (!predecessor) return undefined;
      visit(predecessor);
      return dependencyConstraintStart(predecessor, task, dependency, options);
    }).filter((value): value is string => Boolean(value));
    const earliest = constraints.length ? constraints.reduce((latest, value) => value > latest ? value : latest) : undefined;
    if (earliest && (!options.lockedTaskIds?.includes(task.id) || task.start < earliest)) task.start = earliest;
    if (options.projectStart && !task.parentId && task.start < options.projectStart) task.start = options.projectStart;
    task.finish = finishFromStart(task, options);
    visiting.delete(task.id);
  };
  result.forEach(visit);
  return result;
}

function scheduleBackward(tasks: ScheduleTask[], dependencies: ScheduleDependency[], options: ScheduleOptions) {
  const result = tasks.map((task) => ({ ...task, ...(options.resetDates && options.projectFinish ? { finish: options.projectFinish } : {}) }));
  const byId = new Map(result.map((task) => [task.id, task]));
  const outgoing = new Map<string, ScheduleDependency[]>();
  dependencies.forEach((dependency) => outgoing.set(dependency.predecessorId, [...(outgoing.get(dependency.predecessorId) ?? []), dependency]));
  const visiting = new Set<string>();
  const visit = (task: ScheduleTask) => {
    if (visiting.has(task.id)) return;
    visiting.add(task.id);
    const constraints: string[] = [];
    for (const dependency of outgoing.get(task.id) ?? []) {
      const successor = byId.get(dependency.successorId);
      if (!successor) continue;
      visit(successor);
      const lag = dependency.lagDays;
      const calendar = calendarForTask(successor, options);
      if (dependency.type === "FS") constraints.push(addWorkingDays(successor.start, lag === 0 ? -1 : -lag, calendar, task.resourceId));
      if (dependency.type === "SS") constraints.push(addWorkingDays(successor.start, -lag + durationInWorkingDays(task) - 1, calendar, task.resourceId));
      if (dependency.type === "FF") constraints.push(addWorkingDays(successor.finish, -lag, calendar, task.resourceId));
      if (dependency.type === "SF") constraints.push(addWorkingDays(successor.finish, -lag + durationInWorkingDays(task) - 1, calendar, task.resourceId));
    }
    task.finish = constraints.length ? constraints.reduce((earliest, value) => value < earliest ? value : earliest) : options.projectFinish ?? task.finish;
    task.start = startFromFinish(task, options);
    visiting.delete(task.id);
  };
  result.forEach(visit);
  return result;
}

export function scheduleTasks(tasks: ScheduleTask[], dependencies: ScheduleDependency[], options: ScheduleOptions | WorkingCalendar = {}) {
  if (hasCircularDependency(tasks, dependencies)) throw new Error("Circular dependency detected. Please remove one of the links and try again.");
  const normalized = "holidays" in options || "organizationClosures" in options || "employeeLeave" in options
    ? { defaultCalendar: options as WorkingCalendar }
    : options as ScheduleOptions;
  return normalized.direction === "backward" ? scheduleBackward(tasks, dependencies, normalized) : scheduleForward(tasks, dependencies, normalized);
}

export function rollupSummary(tasks: ScheduleTask[], calendar: WorkingCalendar = {}) {
  const result = tasks.map((task) => ({ ...task }));
  const byId = new Map(result.map((task) => [task.id, task]));
  [...result].reverse().forEach((task) => {
    if (!task.parentId) return;
    const parent = byId.get(task.parentId);
    if (!parent) return;
    const children = result.filter((candidate) => candidate.parentId === parent.id);
    if (!children.length) return;
    parent.start = children.reduce((min, child) => child.start < min ? child.start : min, children[0].start);
    parent.finish = children.reduce((max, child) => child.finish > max ? child.finish : max, children[0].finish);
    parent.duration = workingDaysBetween(parent.start, parent.finish, calendar, parent.resourceId);
    parent.durationUnit = "days";
  });
  return result;
}
