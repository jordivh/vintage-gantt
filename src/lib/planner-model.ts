import {
  addWorkingDays,
  durationInWorkingDays,
  earliestDependencyStart,
  findDependencyCycle,
  remainingMarginDays,
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
  /** Reported reality, entered in Monitoring mode. */
  actualStart?: string;
  actualFinish?: string;
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

export interface StartRestriction {
  /** Earliest date the task may start, given its predecessors. */
  earliestStart: string;
  predecessorId: string;
  predecessorName: string;
  /** Sequential display ID of the binding predecessor, when known. */
  predecessorDisplayId?: number;
  type: DependencyType;
  lagDays: number;
}

const dependencyConstraintWords: Record<DependencyType, string> = {
  FS: "must finish first",
  SS: "must start first",
  FF: "must finish first",
  SF: "must start first",
};

/**
 * The binding predecessor dependency that fixes a task's earliest start, or null
 * when the task has no predecessors and its start date is free to edit.
 */
export function startRestrictionFor(
  task: PlannerTask,
  tasks: PlannerTask[],
  system: CalendarSystem,
  projectCalendarId?: string,
  displayIds?: ReadonlyMap<string, number>,
): StartRestriction | null {
  const binding = earliestDependencyStart(task, tasks, dependenciesForTasks(tasks), {
    calendarSystem: system,
    projectCalendarId,
  });
  if (!binding) return null;
  return {
    earliestStart: binding.date,
    predecessorId: binding.predecessor.id,
    predecessorName: tasks.find((item) => item.id === binding.predecessor.id)?.name ?? "predecessor",
    predecessorDisplayId: displayIds?.get(binding.predecessor.id),
    type: binding.type,
    lagDays: binding.lagDays,
  };
}

/** The message shown when a date edit breaks a dependency. */
export function formatStartRestrictionError(restriction: StartRestriction): string {
  const lag = restriction.lagDays === 0 ? "" : `${restriction.lagDays > 0 ? "+" : ""}${restriction.lagDays}d`;
  const label = restriction.predecessorDisplayId === undefined
    ? restriction.predecessorName
    : `task ${restriction.predecessorDisplayId} (${restriction.predecessorName})`;
  const code = `${restriction.predecessorDisplayId ?? ""}${restriction.type}${lag}`;
  return `Cannot start before ${restriction.earliestStart}: ${label} ${dependencyConstraintWords[restriction.type]} (${code}).`;
}

/**
 * Validates a start date against the dependency network. Start and finish of a
 * task with predecessors are derived from the network, so an earlier date is
 * refused (with the reason to show inline) instead of being silently corrected.
 * Returns null when the date is acceptable or the task has no predecessors.
 */
export function startEditRestriction(
  task: PlannerTask,
  requestedStart: string,
  tasks: PlannerTask[],
  system: CalendarSystem,
  projectCalendarId?: string,
  displayIds?: ReadonlyMap<string, number>,
): string | null {
  const restriction = startRestrictionFor(task, tasks, system, projectCalendarId, displayIds);
  if (!restriction || requestedStart >= restriction.earliestStart) return null;
  return formatStartRestrictionError(restriction);
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
  // Margin occupies real time: a task's slot is its work plus its remaining
  // reserve, and that slot is what the network schedules. The reserve is counted
  // here and nowhere else, so it is never added twice.
  const slotDuration = (task: PlannerTask) =>
    summaryIds.has(task.id) ? duration(task) : duration(task) + remainingMarginDays(task);
  const projectStart = tasks.reduce((earliest, task) => !earliest || task.start < earliest ? task.start : earliest, "");
  if (!projectStart) return new Map();
  const summaryIds = new Set(
    tasks.filter((task) => tasks.some((child) => child.parentId === task.id)).map((task) => task.id),
  );
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
    early.set(task.id, { start, finish: start + slotDuration(task) - 1 });
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
      // Mirror of the forward rules. FF and SF hang off the successor's work
      // finish, so its own reserve is taken out of its slot end exactly once.
      const successorMargin = summaryIds.has(successorTask.id) ? 0 : remainingMarginDays(successorTask);
      const successorWorkFinish = successor.finish - successorMargin;
      const lag = dependency.lagDays;
      const candidate = dependency.type === "SS"
        ? successor.start - lag + slotDuration(task) - 1
        : dependency.type === "FF"
          ? successorWorkFinish - lag
          : dependency.type === "SF"
            ? successorWorkFinish - lag + slotDuration(task) - 1
            : successor.start - lag - 1;
      finish = Math.min(finish, candidate);
    }
    late.set(task.id, { finish, start: finish - slotDuration(task) + 1 });
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

/** The original reserve a task would carry at a given margin percentage. */
export function marginOriginalDaysFor(task: PlannerTask, marginPct: number): number {
  if (task.isMilestone || task.duration === 0) return 0;
  const pct = Math.max(0, marginPct);
  if (pct === 0) return 0;
  return Math.ceil(Math.max(0, durationInWorkingDays(task)) * pct / 100);
}

/** A task's margin reserve: the stored value when it has one, else sized from its work. */
function marginReserveDays(task: PlannerTask) {
  const marginPct = Math.max(0, task.marginPct ?? 0);
  if (marginPct === 0) return 0;
  return task.marginDaysOriginal ?? marginOriginalDaysFor(task, marginPct);
}

/**
 * The margin bookkeeping after a single task's percentage is edited: the new
 * percentage sets a fresh original reserve sized from the task's work, the
 * consumed days stay put (capped so the remaining reserve never goes negative),
 * and the remaining reserve is what a task that had spent its margin gets back.
 */
export function marginAfterPctChange(task: PlannerTask, marginPct: number) {
  const original = marginOriginalDaysFor(task, marginPct);
  const consumed = Math.min(original, Math.max(0, task.marginDaysConsumed ?? 0));
  return { original, consumed, remaining: Math.max(0, original - consumed) };
}

/** The project finish as the planner shows it: the last task date in the plan. */
export function planFinishDate(tasks: PlannerTask[]): string {
  return tasks.reduce((latest, task) => (task.finish > latest ? task.finish : latest), "");
}

/**
 * A plan version is either being planned or being monitored. Planning edits the
 * plan (durations, dates, dependencies, margin percentages) and never consumes
 * reserve; monitoring tracks reality, where extending work eats the reserve
 * first. The mode belongs to the version, not the project.
 */
export type PlanMode = "planning" | "monitoring";

/**
 * Planning-mode margin bookkeeping: the percentage is the single source of
 * truth, so the reserve in days is recomputed from the work every time and
 * nothing is ever consumed. Used instead of `applyMarginConsumption` while a
 * version is still being planned.
 */
export function applyPlanningModeMargins(tasks: PlannerTask[]): PlannerTask[] {
  const summaryIds = new Set(tasks.filter((task) => tasks.some((child) => child.parentId === task.id)).map((task) => task.id));
  return tasks.map((task) => summaryIds.has(task.id)
    ? { ...task, marginDaysConsumed: 0 }
    : { ...task, marginDaysOriginal: marginOriginalDaysFor(task, task.marginPct ?? 0), marginDaysConsumed: 0 },
  );
}

/**
 * The bookkeeping a commit applies, chosen by the active mode. Planning
 * re-plans: margin is sized from the percentage and consumption stays at zero.
 * Monitoring tracks reality: extending work eats the existing reserve first.
 * Neither branch mutates its inputs.
 */
export function applyModeCommit(previous: PlannerTask[], next: PlannerTask[], mode: PlanMode): PlannerTask[] {
  return mode === "planning" ? applyPlanningModeMargins(next) : applyMarginConsumption(previous, next);
}

/**
 * Why a grid field cannot be edited in the current mode, or null when it can.
 * Planning edits the plan (no progress); monitoring reports reality, so the
 * reserve itself is fixed and rebuilt through a replan.
 */
export function fieldModeReadOnly(field: string, mode: PlanMode): string | null {
  if (mode === "planning") {
    if (field === "percent") return "Progress is entered in Monitoring mode.";
    if (field === "actualStart" || field === "actualFinish") return "Actual dates are entered in Monitoring mode.";
  }
  if (mode === "monitoring" && field === "margin") {
    return "Margin % is fixed in Monitoring mode — use Replan to build fresh reserve.";
  }
  return null;
}

export type ReplanScope = "all" | "not-started" | "selected";

export interface ReplanScopeInput {
  scope: ReplanScope;
  selectedTaskIds?: readonly string[];
  marginPct: number;
}

/**
 * The leaf tasks a replan refreshes its margin for. Summaries roll up their
 * children and milestones carry no reserve, so both are ignored, and completed
 * work (`percent` 100) is never rewritten even when the scope says "all".
 * "Not started" means no reported progress yet (`percent` is still 0), which
 * keeps in-flight and completed work out of scope.
 */
export function replanScopeIds(tasks: PlannerTask[], input: ReplanScopeInput): Set<string> {
  const summaryIds = new Set(tasks.filter((task) => tasks.some((child) => child.parentId === task.id)).map((task) => task.id));
  const selected = new Set(input.selectedTaskIds ?? []);
  return new Set(
    tasks
      .filter((task) => !summaryIds.has(task.id) && !task.isMilestone && task.duration > 0 && (task.percent ?? 0) < 100)
      .filter((task) => {
        if (input.scope === "all") return true;
        if (input.scope === "selected") return selected.has(task.id);
        return (task.percent ?? 0) === 0;
      })
      .map((task) => task.id),
  );
}

/**
 * Rewrites margin bookkeeping for the tasks in scope: the new percentage sets a
 * fresh original reserve sized from the task's work, and consumed margin resets
 * to zero. Tasks outside the scope — started or completed work — keep both their
 * percentage and their consumption. The input is never mutated, so the version a
 * replan is based on stays exactly as it was.
 */
export function applyReplanMargins(tasks: PlannerTask[], input: ReplanScopeInput): PlannerTask[] {
  const scope = replanScopeIds(tasks, input);
  const marginPct = Math.max(0, Math.min(100, input.marginPct));
  return tasks.map((task) =>
    scope.has(task.id)
      ? { ...task, marginPct, marginDaysOriginal: marginOriginalDaysFor(task, marginPct), marginDaysConsumed: 0 }
      : task,
  );
}

/**
 * Keeps each task's reserve in step with its work. Margin occupies real time (see
 * `remainingMarginDays`), so this only maintains the bookkeeping: extending a task
 * eats its reserve first, shortening it gives those days back up to the original
 * amount, and the reserve is re-sized from the current work only when the margin
 * percentage itself changes.
 */
export function applyMarginConsumption(previous: PlannerTask[], next: PlannerTask[]): PlannerTask[] {
  const previousById = new Map(previous.map((task) => [task.id, task]));
  return next.map((task) => {
    const before = previousById.get(task.id);
    if (!before) return task;
    // Summaries roll up their children and never carry a reserve of their own.
    if (next.some((child) => child.parentId === task.id)) return task;
    const workDays = task.isMilestone || task.duration === 0 ? 0 : Math.max(0, durationInWorkingDays(task));
    const beforeWorkDays = before.isMilestone || before.duration === 0 ? 0 : Math.max(0, durationInWorkingDays(before));
    const marginPct = Math.max(0, task.marginPct ?? 0);
    const resized = marginPct !== Math.max(0, before.marginPct ?? 0);
    const original = resized
      ? marginOriginalDaysFor(task, marginPct)
      : Math.max(0, before.marginDaysOriginal ?? marginOriginalDaysFor(task, marginPct));
    const consumed = resized
      ? Math.min(original, Math.max(0, before.marginDaysConsumed ?? 0))
      : Math.max(0, Math.min(original, Math.max(0, before.marginDaysConsumed ?? 0) + (workDays - beforeWorkDays)));
    return { ...task, marginDaysOriginal: original, marginDaysConsumed: consumed };
  });
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
      ? children.reduce((sum, child) => sum + marginReserveDays(child), 0)
      : marginReserveDays({ ...task, marginPct });
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
