import {
  addWorkingDays,
  durationInWorkingDays,
  findDependencyCycle,
  rollupSummary,
  scheduleTasks,
  type CalendarSystem,
  type DependencyType,
  type PlanningDirection,
  type ScheduleDependency,
  type ScheduleTask,
  workingDaysBetween,
} from "./scheduling-engine";

/** A task row as the planner UI edits it. */
export interface PlannerTask extends ScheduleTask {
  name: string;
  predecessors: string;
  resource: string;
  percent: number;
  notes: string;
  collapsed?: boolean;
  color: string;
  marginPct?: number;
  marginDaysOriginal?: number;
  marginDaysConsumed?: number;
  totalFloat?: number;
  isCritical?: boolean;
  versionId?: string;
  /** Template rows store task dates as working-day offsets from the project start. */
  startOffsetDays?: number;
  finishOffsetDays?: number;
}

/** Returns task order as displayed by the hierarchical grid. */
export function orderTasksForDisplay<T extends { id: string; parentId?: string | null }>(tasks: T[]): T[] {
  const ordered: T[] = [];
  const visited = new Set<string>();
  const walk = (parentId: string | null) => {
    tasks.filter((task) => (task.parentId ?? null) === parentId && !visited.has(task.id)).forEach((task) => {
      visited.add(task.id);
      ordered.push(task);
      walk(task.id);
    });
  };
  walk(null);
  tasks.forEach((task) => { if (!visited.has(task.id)) ordered.push(task); });
  return ordered;
}

const dependencySuffixPattern = /^(FS|SS|FF|SF)?([+-]\d+)?d?$/i;
const displayDependencyPattern = /^(\d+)(FS|SS|FF|SF)?([+-]\d+)?d?$/i;

const parseDependencyPart = (part: string, tasks: { id: string }[]): ScheduleDependency | null => {
  const predecessor = [...tasks].sort((left, right) => right.id.length - left.id.length).find((task) =>
    part.startsWith(task.id) && dependencySuffixPattern.test(part.slice(task.id.length)),
  );
  if (!predecessor) return null;
  const match = part.slice(predecessor.id.length).match(dependencySuffixPattern);
  if (!match) return null;
  return {
    predecessorId: predecessor.id,
    successorId: "",
    type: (match[1]?.toUpperCase() ?? "FS") as DependencyType,
    lagDays: Number(match[2] ?? 0),
  };
};

/** Parses stored predecessor strings into dependencies referencing internal task IDs. */
export function parseDependency(value: string, tasks: { id: string }[]): ScheduleDependency[] {
  return value.split(",").map((part) => parseDependencyPart(part.trim(), tasks)).filter((dependency): dependency is ScheduleDependency => Boolean(dependency));
}

/** Converts stored internal task references into the current sequential display IDs. */
export function formatPredecessorsForDisplay(
  value: string,
  tasks: PlannerTask[],
  displayIds: ReadonlyMap<string, number>,
): string {
  const ordered = orderTasksForDisplay(tasks);
  return value.split(",").map((rawPart) => {
    const part = rawPart.trim();
    if (!part) return "";
    const internal = parseDependencyPart(part, tasks);
    const legacy = !internal ? part.match(displayDependencyPattern) : null;
    const dependency = internal ?? (legacy ? {
      predecessorId: ordered[Number(legacy[1]) - 1]?.id ?? "",
      successorId: "",
      type: (legacy[2]?.toUpperCase() ?? "FS") as DependencyType,
      lagDays: Number(legacy[3] ?? 0),
    } : null);
    if (!dependency?.predecessorId) return "";
    const displayId = displayIds.get(dependency.predecessorId);
    if (displayId === undefined) return "";
    const lag = dependency.lagDays === 0 ? "" : `${dependency.lagDays > 0 ? "+" : ""}${dependency.lagDays}d`;
    return `${displayId}${dependency.type}${lag}`;
  }).filter(Boolean).join(", ");
}

export function resolvePredecessorInput(
  value: string,
  successorId: string,
  tasks: PlannerTask[],
  displayIds: ReadonlyMap<string, number>,
): { value: string; error?: never } | { value?: never; error: string } {
  const trimmed = value.trim();
  if (!trimmed) return { value: "" };
  const displayTasks = new Map([...displayIds].map(([id, displayId]) => [String(displayId), id]));
  const dependencies: ScheduleDependency[] = [];
  for (const rawPart of trimmed.split(",")) {
    const part = rawPart.trim();
    const match = part.match(displayDependencyPattern);
    if (!part || !match) return { error: `Invalid predecessor “${part || rawPart}”. Use e.g. 3FS+2d.` };
    const predecessorId = displayTasks.get(match[1]);
    if (!predecessorId) return { error: `Task ID ${match[1]} does not exist.` };
    if (predecessorId === successorId) return { error: "A task cannot depend on itself." };
    dependencies.push({ predecessorId, successorId, type: (match[2]?.toUpperCase() ?? "FS") as DependencyType, lagDays: Number(match[3] ?? 0) });
  }
  const predecessorText = dependencies.map((dependency) => `${dependency.predecessorId}${dependency.type}${dependency.lagDays ? `${dependency.lagDays > 0 ? "+" : ""}${dependency.lagDays}d` : ""}`).join(", ");
  const candidateTasks = tasks.map((task) => task.id === successorId ? { ...task, predecessors: predecessorText } : task);
  const cycle = findDependencyCycle(candidateTasks, dependenciesForTasks(candidateTasks));
  if (cycle) return { error: `Dependency rejected: circular chain ${cycle.join(" → ")}.` };
  return { value: predecessorText };
}

export function dependenciesForTasks(items: PlannerTask[]): ScheduleDependency[] {
  return items.flatMap((task) =>
    parseDependency(task.predecessors, items).map((dependency) => ({
      ...dependency,
      successorId: task.id,
    })),
  );
}

export interface CriticalPathTask {
  earlyStart: string;
  earlyFinish: string;
  lateStart: string;
  lateFinish: string;
  totalFloat: number;
  isCritical: boolean;
}

/**
 * Computes CPM values without changing the scheduling engine. Durations and all
 * date offsets are expressed in working days from the project's calendar.
 */
export function calculateCriticalPath(
  tasks: PlannerTask[],
  system: CalendarSystem,
  projectCalendarId?: string,
): Map<string, CriticalPathTask> {
  const dependencies = dependenciesForTasks(tasks);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const duration = (task: PlannerTask) => Math.max(1, durationInWorkingDays({ ...task, isMilestone: task.duration === 0 }));
  const projectStart = tasks.reduce((earliest, task) => !earliest || task.start < earliest ? task.start : earliest, "");
  if (!projectStart) return new Map();
  const incoming = new Map<string, ScheduleDependency[]>();
  const outgoing = new Map<string, ScheduleDependency[]>();
  for (const dependency of dependencies) {
    incoming.set(dependency.successorId, [...(incoming.get(dependency.successorId) ?? []), dependency]);
    outgoing.set(dependency.predecessorId, [...(outgoing.get(dependency.predecessorId) ?? []), dependency]);
  }
  const order: PlannerTask[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (task: PlannerTask) => {
    if (visited.has(task.id) || visiting.has(task.id)) return;
    visiting.add(task.id);
    for (const dependency of incoming.get(task.id) ?? []) {
      const predecessor = byId.get(dependency.predecessorId);
      if (predecessor) visit(predecessor);
    }
    visiting.delete(task.id);
    visited.add(task.id);
    order.push(task);
  };
  tasks.forEach(visit);
  const summaryIds = new Set(
    tasks.filter((task) => tasks.some((child) => child.parentId === task.id)).map((task) => task.id),
  );
  const early = new Map<string, { start: number; finish: number }>();
  for (const task of order) {
    // A task that was placed manually (dragged, or planned later than its
    // dependencies allow) is a real constraint: its planned start is the floor
    // of its early start, expressed in working days from the project start.
    let start = Math.max(
      0,
      workingDaysBetween(projectStart, task.start, task.calendarId ?? projectCalendarId, system) - 1,
    );
    for (const dependency of incoming.get(task.id) ?? []) {
      const predecessor = early.get(dependency.predecessorId);
      if (!predecessor) continue;
      const lag = dependency.lagDays;
      const candidate = dependency.type === "SS"
        ? predecessor.start + lag
        : dependency.type === "FF"
          ? predecessor.finish + lag - duration(task) + 1
          : dependency.type === "SF"
            ? predecessor.start + lag - duration(task) + 1
            : predecessor.finish + lag + 1;
      start = Math.max(start, candidate);
    }
    early.set(task.id, { start, finish: start + duration(task) - 1 });
  }
  // Float is measured against the finish of the *work* in the plan. Summary rows
  // and milestones are markers, not work: a terminal milestone is placed one
  // working day after its predecessor, and counting that day would inflate the
  // float of every other task by one day and hide a genuinely critical path.
  const workFinishes = tasks
    .filter((task) => !summaryIds.has(task.id) && task.duration > 0)
    .map((task) => early.get(task.id)?.finish)
    .filter((finish): finish is number => finish !== undefined);
  const projectFinish = workFinishes.length
    ? Math.max(...workFinishes)
    : Math.max(...[...early.values()].map((value) => value.finish));
  const late = new Map<string, { start: number; finish: number }>();
  for (const task of [...order].reverse()) {
    let finish = projectFinish;
    for (const dependency of outgoing.get(task.id) ?? []) {
      const successor = late.get(dependency.successorId);
      if (!successor) continue;
      const successorTask = byId.get(dependency.successorId);
      if (!successorTask) continue;
      const candidate = dependency.type === "SS"
        ? successor.start - dependency.lagDays + duration(task) - 1
        : dependency.type === "FF"
          ? successor.finish - dependency.lagDays
          : dependency.type === "SF"
            ? successor.finish - dependency.lagDays
            : successor.start - dependency.lagDays - 1;
      finish = Math.min(finish, candidate);
    }
    late.set(task.id, { finish, start: finish - duration(task) + 1 });
  }
  const result = new Map<string, CriticalPathTask>();
  for (const task of tasks) {
    const e = early.get(task.id) ?? { start: 0, finish: 0 };
    const l = late.get(task.id) ?? { start: e.start, finish: e.finish };
    const totalFloat = Math.max(0, l.start - e.start);
    result.set(task.id, {
      earlyStart: addWorkingDays(projectStart, e.start, projectCalendarId, system),
      earlyFinish: addWorkingDays(projectStart, e.finish, projectCalendarId, system),
      lateStart: addWorkingDays(projectStart, l.start, projectCalendarId, system),
      lateFinish: addWorkingDays(projectStart, l.finish, projectCalendarId, system),
      totalFloat,
      isCritical: totalFloat === 0,
    });
  }
  for (const task of tasks.filter((item) => summaryIds.has(item.id))) {
    const children = tasks.filter((child) => child.parentId === task.id);
    const critical = children.some((child) => result.get(child.id)?.isCritical);
    const own = result.get(task.id);
    if (!own) continue;
    // A summary is a roll-up of its children, so it floats as far as its most
    // constrained child does.
    const childFloat = Math.min(...children.map((child) => result.get(child.id)?.totalFloat ?? own.totalFloat));
    result.set(task.id, { ...own, isCritical: critical, totalFloat: critical ? 0 : childFloat });
  }
  return result;
}

export function applyMarginAbsorption(
  previous: PlannerTask[],
  next: PlannerTask[],
  system: CalendarSystem,
  projectCalendarId: string | undefined,
  changedTaskId?: string,
): PlannerTask[] {
  if (!changedTaskId) return next;
  const before = previous.find((task) => task.id === changedTaskId);
  const after = next.find((task) => task.id === changedTaskId);
  if (!before || !after || before.parentId !== after.parentId) return next;
  const calendarId = after.calendarId ?? projectCalendarId;
  const delay = after.finish > before.finish
    ? Math.max(0, workingDayDistance(before.finish, after.finish, calendarId, system))
    : 0;
  const original = Math.ceil(Math.max(0, durationInWorkingDays({ ...after, isMilestone: after.duration === 0 })) * Math.max(0, after.marginPct ?? before.marginPct ?? 0) / 100);
  const previousConsumed = Math.max(0, before.marginDaysConsumed ?? 0);
  const consumed = after.finish < before.finish
    ? Math.max(0, Math.min(original, previousConsumed - workingDayDistance(after.finish, before.finish, calendarId, system)))
    : Math.min(original, previousConsumed + delay);
  // Margin records how much of a task's buffer a delay consumed, but it is
  // bookkeeping only: it never moves a task and never delays a successor.
  return next.map((task) => task.id === changedTaskId
    ? { ...task, marginDaysOriginal: original, marginDaysConsumed: consumed }
    : task);
}

function workingDayDistance(from: string, to: string, calendarId: string | undefined, system: CalendarSystem) {
  if (from === to) return 0;
  if (from < to) return Math.max(0, workingDaysBetween(from, to, calendarId, system) - 1);
  return Math.max(0, workingDaysBetween(to, from, calendarId, system) - 1);
}

export function withCalculatedPlanningFields(
  tasks: PlannerTask[],
  system: CalendarSystem,
  projectCalendarId?: string,
): PlannerTask[] {
  const critical = calculateCriticalPath(tasks, system, projectCalendarId);
  const childrenByParent = new Map<string, PlannerTask[]>();
  tasks.forEach((task) => task.parentId && childrenByParent.set(task.parentId, [...(childrenByParent.get(task.parentId) ?? []), task]));
  return tasks.map((task) => {
    const children = childrenByParent.get(task.id);
    const marginPct = Math.max(0, task.marginPct ?? 0);
    const marginDaysOriginal = children
      ? children.reduce((sum, child) => sum + (child.marginDaysOriginal ?? Math.ceil(Math.max(0, durationInWorkingDays(child)) * (child.marginPct ?? 0) / 100)), 0)
      : task.duration === 0 ? 0 : Math.ceil(Math.max(0, durationInWorkingDays(task)) * marginPct / 100);
    const marginDaysConsumed = Math.min(marginDaysOriginal, Math.max(0, task.marginDaysConsumed ?? 0));
    const cpm = critical.get(task.id);
    return {
      ...task,
      marginPct: children ? 0 : marginPct,
      marginDaysOriginal,
      marginDaysConsumed,
      totalFloat: cpm?.totalFloat ?? 0,
      isCritical: cpm?.isCritical ?? false,
    };
  });
}

export interface RecalculateOptions {
  direction?: PlanningDirection;
  projectStart?: string;
  projectFinish?: string;
  projectCalendarId?: string;
  calendarSystem: CalendarSystem;
  resetDates?: boolean;
  anchoredTaskIds?: string[];
}

export interface RecalculateResult {
  tasks: PlannerTask[];
  moved: number;
  error?: string;
}

/**
 * Pure recalculation used by both the planner and the calendar screen, so a
 * calendar change can move every affected project's tasks immediately.
 */
export function recalculateTasks(
  tasks: PlannerTask[],
  options: RecalculateOptions,
): RecalculateResult {
  const dependencies = dependenciesForTasks(tasks);
  const cycle = findDependencyCycle(tasks, dependencies);
  if (cycle) {
    return { tasks, moved: 0, error: `Circular dependency: ${cycle.join(" → ")}` };
  }
  const scheduled = scheduleTasks(tasks, dependencies, {
    direction: options.direction,
    projectStart: options.projectStart,
    projectFinish: options.projectFinish,
    projectCalendarId: options.projectCalendarId,
    calendarSystem: options.calendarSystem,
    resetDates: options.resetDates,
    anchoredTaskIds: options.anchoredTaskIds,
  });
  const rolled = rollupSummary(scheduled, options.calendarSystem, options.projectCalendarId);
  const rolledById = new Map(rolled.map((task) => [task.id, task]));
  const next = tasks.map((task) => ({ ...task, ...(rolledById.get(task.id) ?? {}) }));
  const moved = next.filter(
    (task, index) => task.start !== tasks[index].start || task.finish !== tasks[index].finish,
  ).length;
  return { tasks: next, moved };
}
