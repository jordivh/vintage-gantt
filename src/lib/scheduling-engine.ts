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
  /** Task ids whose manually edited dates must remain fixed during a non-reset pass. */
  anchoredTaskIds?: string[];
}

const iso = (date: Date) => date.toISOString().slice(0, 10);
const parse = (value: string) => new Date(`${value}T12:00:00`);
const unique = (values: string[]) => [...new Set(values)];

export function calendarForTask(task: ScheduleTask, options: ScheduleOptions = {}) {
  return task.calendarId && options.calendars?.[task.calendarId]
    ? options.calendars[task.calendarId]
    : options.defaultCalendar ?? {};
}

export function isWorkingDay(date: Date, calendar: WorkingCalendar = {}, resourceId?: string) {
  const day = date.getDay();
  const unavailable = unique([
    ...(calendar.holidays ?? []),
    ...(calendar.organizationClosures ?? []),
    ...(resourceId ? calendar.employeeLeave?.[resourceId] ?? [] : []),
  ]);
  return day !== 0 && day !== 6 && !unavailable.includes(iso(date));
}

export function addWorkingDays(value: string, amount: number, calendar: WorkingCalendar = {}, resourceId?: string) {
  const date = parse(value);
  const direction = amount < 0 ? -1 : 1;
  let remaining = Math.abs(amount);
  while (remaining > 0) {
    date.setDate(date.getDate() + direction);
    if (isWorkingDay(date, calendar, resourceId)) remaining -= 1;
  }
  return iso(date);
}

export function workingDaysBetween(start: string, finish: string, calendar: WorkingCalendar = {}, resourceId?: string) {
  const from = parse(start);
  const to = parse(finish);
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

function finishFromStart(task: ScheduleTask, calendar: WorkingCalendar) {
  if (task.isMilestone || task.duration <= 1) return task.start;
  return addWorkingDays(task.start, durationInWorkingDays(task) - 1, calendar, task.resourceId);
}

function startFromFinish(task: ScheduleTask, calendar: WorkingCalendar) {
  if (task.isMilestone || task.duration <= 1) return task.finish;
  return addWorkingDays(task.finish, -(durationInWorkingDays(task) - 1), calendar, task.resourceId);
}

function dependencyStart(predecessor: ScheduleTask, successor: ScheduleTask, dependency: ScheduleDependency, options: ScheduleOptions) {
  const calendar = calendarForTask(successor, options);
  const lag = dependency.lagDays;
  if (dependency.type === "SS") return addWorkingDays(predecessor.start, lag, calendar, successor.resourceId);
  if (dependency.type === "FF") return addWorkingDays(finishFromStart(predecessor, calendar), lag - (durationInWorkingDays(successor) - 1), calendar, successor.resourceId);
  if (dependency.type === "SF") return addWorkingDays(predecessor.start, lag - (durationInWorkingDays(successor) - 1), calendar, successor.resourceId);
  return addWorkingDays(finishFromStart(predecessor, calendar), lag + 1, calendar, successor.resourceId);
}

export function findDependencyCycle(tasks: ScheduleTask[], dependencies: ScheduleDependency[]) {
  const taskIds = new Set(tasks.map((task) => task.id));
  const edges = new Map<string, string[]>();
  dependencies.forEach((dependency) => {
    if (!taskIds.has(dependency.predecessorId) || !taskIds.has(dependency.successorId)) return;
    edges.set(dependency.predecessorId, [...(edges.get(dependency.predecessorId) ?? []), dependency.successorId]);
  });
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) {
      const cycleStart = stack.indexOf(id);
      return [...stack.slice(cycleStart), id];
    }
    if (visited.has(id)) return null;
    visiting.add(id);
    stack.push(id);
    for (const nextId of edges.get(id) ?? []) {
      const cycle = visit(nextId);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle) return cycle;
  }
  return null;
}

export function hasCircularDependency(tasks: ScheduleTask[], dependencies: ScheduleDependency[]) {
  return Boolean(findDependencyCycle(tasks, dependencies));
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
    for (const dependency of incoming.get(task.id) ?? []) {
      const predecessor = byId.get(dependency.predecessorId);
      if (!predecessor) continue;
      visit(predecessor);
      const earliest = dependencyStart(predecessor, task, dependency, options);
      if (earliest > task.start) task.start = earliest;
    }
    const projectStart = options.projectStart;
    if (projectStart && !task.parentId && task.start < projectStart) task.start = projectStart;
    task.finish = finishFromStart(task, calendarForTask(task, options));
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
    const successorConstraints: string[] = [];
    for (const dependency of outgoing.get(task.id) ?? []) {
      const successor = byId.get(dependency.successorId);
      if (!successor) continue;
      visit(successor);
      const successorCalendar = calendarForTask(successor, options);
      const lag = dependency.lagDays;
      if (dependency.type === "FS") successorConstraints.push(addWorkingDays(successor.start, -lag - 1, successorCalendar, task.resourceId));
      if (dependency.type === "SS") successorConstraints.push(addWorkingDays(successor.start, -lag + durationInWorkingDays(task) - 1, successorCalendar, task.resourceId));
      if (dependency.type === "FF") successorConstraints.push(addWorkingDays(successor.finish, -lag, successorCalendar, task.resourceId));
      if (dependency.type === "SF") successorConstraints.push(addWorkingDays(successor.finish, -lag + durationInWorkingDays(task) - 1, successorCalendar, task.resourceId));
    }
    const isAnchored = options.anchoredTaskIds?.includes(task.id) ?? false;
    if (!isAnchored) {
      task.finish = successorConstraints.length ? successorConstraints.reduce((latest, date) => date < latest ? date : latest) : options.projectFinish ?? task.finish;
      task.start = startFromFinish(task, calendarForTask(task, options));
    }
    visiting.delete(task.id);
  };
  result.forEach(visit);
  return result;
}

export function scheduleTasks(tasks: ScheduleTask[], dependencies: ScheduleDependency[], options: ScheduleOptions | WorkingCalendar = {}) {
  const cycle = findDependencyCycle(tasks, dependencies);
  if (cycle) throw new Error(`Circular dependency detected: ${cycle.join(" → ")}. Please remove one of the links and try again.`);
  const normalized: ScheduleOptions = "holidays" in options || "organizationClosures" in options || "employeeLeave" in options ? { defaultCalendar: options as WorkingCalendar } : options as ScheduleOptions;
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
