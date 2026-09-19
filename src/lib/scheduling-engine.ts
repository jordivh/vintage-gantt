export type DependencyType = "FS" | "SS" | "FF" | "SF";
export type DurationUnit = "days" | "weeks";

export interface ScheduleTask {
  id: string;
  parentId: string | null;
  duration: number;
  durationUnit: DurationUnit;
  start: string;
  finish: string;
  isMilestone?: boolean;
}

export interface ScheduleDependency {
  predecessorId: string;
  successorId: string;
  type: DependencyType;
  lagDays: number;
}

export interface WorkingCalendar {
  holidays?: string[];
}

const iso = (date: Date) => date.toISOString().slice(0, 10);
const parse = (value: string) => new Date(`${value}T12:00:00`);

export function isWorkingDay(date: Date, calendar: WorkingCalendar = {}) {
  const day = date.getDay();
  return day !== 0 && day !== 6 && !calendar.holidays?.includes(iso(date));
}

export function addWorkingDays(value: string, amount: number, calendar: WorkingCalendar = {}) {
  const date = parse(value);
  const direction = amount < 0 ? -1 : 1;
  let remaining = Math.abs(amount);
  while (remaining > 0) {
    date.setDate(date.getDate() + direction);
    if (isWorkingDay(date, calendar)) remaining -= 1;
  }
  return iso(date);
}

export function workingDaysBetween(start: string, finish: string, calendar: WorkingCalendar = {}) {
  const from = parse(start);
  const to = parse(finish);
  let count = 0;
  for (const cursor = new Date(from); cursor <= to; cursor.setDate(cursor.getDate() + 1)) {
    if (isWorkingDay(cursor, calendar)) count += 1;
  }
  return Math.max(1, count);
}

function taskFinish(task: ScheduleTask, calendar: WorkingCalendar) {
  if (task.isMilestone || task.duration <= 1) return task.start;
  return addWorkingDays(task.start, task.durationUnit === "weeks" ? task.duration * 5 - 1 : task.duration - 1, calendar);
}

function dependencyStart(predecessor: ScheduleTask, successor: ScheduleTask, dependency: ScheduleDependency, calendar: WorkingCalendar) {
  const lag = dependency.lagDays;
  if (dependency.type === "SS") return addWorkingDays(predecessor.start, lag, calendar);
  if (dependency.type === "FF") return addWorkingDays(taskFinish(predecessor, calendar), lag - Math.max(0, successor.duration - 1), calendar);
  if (dependency.type === "SF") return addWorkingDays(taskFinish(predecessor, calendar), lag - Math.max(0, successor.duration - 1), calendar);
  return addWorkingDays(taskFinish(predecessor, calendar), lag + 1, calendar);
}

export function hasCircularDependency(tasks: ScheduleTask[], dependencies: ScheduleDependency[]) {
  const edges = new Map<string, string[]>();
  dependencies.forEach((dependency) => edges.set(dependency.predecessorId, [...(edges.get(dependency.predecessorId) ?? []), dependency.successorId]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if ((edges.get(id) ?? []).some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return tasks.some((task) => visit(task.id));
}

export function scheduleTasks(tasks: ScheduleTask[], dependencies: ScheduleDependency[], calendar: WorkingCalendar = {}) {
  if (hasCircularDependency(tasks, dependencies)) throw new Error("Circular dependency detected. Please remove one of the links and try again.");
  const result = tasks.map((task) => ({ ...task }));
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
      const earliest = dependencyStart(predecessor, task, dependency, calendar);
      if (earliest > task.start) task.start = earliest;
    }
    task.finish = taskFinish(task, calendar);
    visiting.delete(task.id);
  };
  result.forEach(visit);
  return result;
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
    parent.duration = workingDaysBetween(parent.start, parent.finish, calendar);
    parent.durationUnit = "days";
  });
  return result;
}
