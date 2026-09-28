import {
  addWorkingDays,
  durationInWorkingDays,
  earliestDependencyStart,
  ensureWorkingDay,
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
  /**
   * Work expressed in hours, independent of duration: a task can span 20
   * working days with only 40 h of work. Data only for now — the capacity
   * engine that consumes it comes later, so it never moves a date.
   */
  work?: number;
  /** How the task's work is spread across its working days. Defaults to even. */
  distribution?: Distribution;
  /** Reported reality, entered in Monitoring mode. */
  actualStart?: string;
  actualFinish?: string;
  marginPct?: number;
  marginDaysOriginal?: number;
  marginDaysConsumed?: number;
  /** Start no earlier than this date (ISO) — this task's own user intent. */
  startConstraint?: string;
  /** Whether the constraint currently binds (false once a predecessor overtakes it). */
  startConstraintActive?: boolean;
  /** Template rows store the constraint as a working-day offset like the dates. */
  constraintOffsetDays?: number;
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

/** Serializes a dependency back to storage form: internal predecessor id + type + lag. */
export function serializeDependency(dependency: ScheduleDependency): string {
  const lag = dependency.lagDays === 0 ? "" : `${dependency.lagDays > 0 ? "+" : ""}${dependency.lagDays}d`;
  return `${dependency.predecessorId}${dependency.type}${lag}`;
}

/**
 * Resolves one stored predecessor token. Internal task ids are matched directly;
 * a legacy token that only carries a sequential display id is resolved through
 * the task order, so older data keeps working.
 */
function resolvePredecessorReference(
  part: string,
  tasks: { id: string }[],
  ordered: { id: string }[],
): ScheduleDependency | null {
  const internal = parseDependencyPart(part, tasks);
  if (internal) return internal;
  const legacy = part.match(displayDependencyPattern);
  if (!legacy) return null;
  const predecessor = ordered[Number(legacy[1]) - 1];
  if (!predecessor) return null;
  return { predecessorId: predecessor.id, successorId: "", type: (legacy[2]?.toUpperCase() ?? "FS") as DependencyType, lagDays: Number(legacy[3] ?? 0) };
}

/** Converts stored internal task references into the current sequential display IDs. */
export function formatPredecessorsForDisplay(
  value: string,
  tasks: PlannerTask[],
  displayIds: ReadonlyMap<string, number>,
): string {
  const ordered = orderTasksForDisplay(tasks);
  return value.split(",").map((rawPart) => {
    const dependency = resolvePredecessorReference(rawPart.trim(), tasks, ordered);
    if (!dependency?.predecessorId) return "";
    const displayId = displayIds.get(dependency.predecessorId);
    if (displayId === undefined) return "";
    return `${displayId}${dependency.type}${dependency.lagDays === 0 ? "" : `${dependency.lagDays > 0 ? "+" : ""}${dependency.lagDays}d`}`;
  }).filter(Boolean).join(", ");
}

/** Anything a copy needs from a task to remap its references. */
export interface RemapTaskShape {
  id: string;
  parentId?: string | null;
  predecessors: string;
  name?: string;
}

export interface PredecessorRemap {
  value: string;
  /** Tokens that could not be resolved to a source task, reported, never dropped silently. */
  unmapped: string[];
}

/**
 * Rewrites a stored predecessor string through `idMap`, keeping the dependency
 * type and lag. A token that cannot be resolved to a source task is reported in
 * `unmapped` instead of being silently removed.
 */
export function remapPredecessorText(
  text: string,
  idMap: ReadonlyMap<string, string>,
  tasks: RemapTaskShape[],
  ordered: { id: string }[] = orderTasksForDisplay(tasks),
): PredecessorRemap {
  const unmapped: string[] = [];
  const value = text.split(",").map((rawPart) => rawPart.trim()).filter(Boolean).map((part) => {
    const dependency = resolvePredecessorReference(part, tasks, ordered);
    const mapped = dependency ? idMap.get(dependency.predecessorId) : undefined;
    if (!dependency || !mapped) { unmapped.push(part); return ""; }
    return serializeDependency({ ...dependency, predecessorId: mapped });
  }).filter(Boolean).join(", ");
  return { value, unmapped };
}

export interface RemapCopiedTasksResult<T> {
  tasks: T[];
  error?: string;
}

/**
 * Copies tasks into a new version, remapping every reference through `idMap`:
 * the parent chain, each predecessor (with its type and lag) and the start
 * constraint. If even one reference cannot be remapped the whole copy fails with
 * a clear message instead of producing a version with missing links.
 *
 * Margin figures, the start constraint (an absolute date) and all other fields
 * travel along untouched, so the caller can apply its own mode-specific resets.
 */
export function remapCopiedTasks<T extends RemapTaskShape>(
  tasks: T[],
  idMap: ReadonlyMap<string, string>,
  versionId?: string,
): RemapCopiedTasksResult<T> {
  const ordered = orderTasksForDisplay(tasks);
  const missing: string[] = [];
  const copied = tasks.map((task) => {
    const newId = idMap.get(task.id);
    if (!newId) missing.push(`task “${task.name ?? task.id}”`);
    let parentId: string | null = null;
    if (task.parentId) {
      const mapped = idMap.get(task.parentId);
      if (!mapped) missing.push(`parent of “${task.name ?? task.id}”`); else parentId = mapped;
    }
    const remapped = remapPredecessorText(task.predecessors, idMap, tasks, ordered);
    for (const part of remapped.unmapped) missing.push(`predecessor ${part} on “${task.name ?? task.id}”`);
    return { ...task, id: newId ?? task.id, parentId, predecessors: remapped.value, ...(versionId ? { versionId } : {}) } as T;
  });
  if (missing.length) {
    return { tasks, error: `Could not copy: ${missing.length} reference${missing.length === 1 ? "" : "s"} could not be remapped (${missing.slice(0, 3).join("; ")}${missing.length > 3 ? "; …" : ""}).` };
  }
  return { tasks: copied };
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

/**
 * The constraint a start-date edit should store. The user's chosen date is kept
 * as intent only when it is strictly later than the earliest the dependencies
 * allow; an earlier date is rejected elsewhere, and a date equal to the earliest
 * (or a free task's own start) needs no constraint.
 */
export function startConstraintFor(
  task: PlannerTask,
  requestedStart: string,
  tasks: PlannerTask[],
  system: CalendarSystem,
  projectCalendarId?: string,
  displayIds?: ReadonlyMap<string, number>,
): string | undefined {
  const restriction = startRestrictionFor(task, tasks, system, projectCalendarId, displayIds);
  if (!restriction) return requestedStart;
  return requestedStart > restriction.earliestStart ? requestedStart : undefined;
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

/**
 * A task's margin reserve: the stored value when it has one, else sized from its
 * work. Milestones and zero-duration rows never carry a reserve, whatever a stale
 * stored value says — the scheduling engine ignores theirs, and so must the grid,
 * the summaries that roll them up and the margin report.
 */
function marginReserveDays(task: PlannerTask) {
  if (task.isMilestone || task.duration === 0) return 0;
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

/**
 * Normalizes a Work entry: whole or half hours, minimum 0. Empty or unparsable
 * input is 0, and a negative value is clamped to 0. Work is deliberately kept
 * separate from duration, so this never touches any date.
 */
export function normalizeWorkHours(value: string | number): number {
  const parsed = typeof value === "number"
    ? value
    : Number(value.trim().replace(",", ".").replace(/\s*h(ours?)?$/i, ""));
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(parsed * 2) / 2;
}

/** How a task's work is spread across its working days. */
export type Distribution = "even" | "front" | "back" | "center";

export const DISTRIBUTION_OPTIONS: { value: Distribution; label: string }[] = [
  { value: "even", label: "Gelijk (even)" },
  { value: "front", label: "Front-loaded" },
  { value: "back", label: "Back-loaded" },
  { value: "center", label: "Center-loaded" },
];

const DISTRIBUTION_VALUES = new Set<Distribution>(["even", "front", "back", "center"]);

/** Falls back to the default profile (Gelijk/even) for anything unrecognized. */
export function normalizeDistribution(value: string | null | undefined): Distribution {
  return value && DISTRIBUTION_VALUES.has(value as Distribution) ? (value as Distribution) : "even";
}

/** One calendar day's share of a task's work. `date` is ISO (yyyy-mm-dd). */
export interface DailyAllocation {
  date: string;
  hours: number;
}

/**
 * The weighting rule behind each profile, applied over the task's working days
 * (`i` runs 0…n-1, `n` is the number of working days, `c = (n-1)/2` the centre):
 *
 *   even   : w = 1                     — flat; every working day the same weight.
 *   front  : w = n - i                 — a straight fall from n to 1, so the
 *                                        first day is heaviest and the last lightest.
 *   back   : w = i + 1                 — the exact mirror image of front-loaded.
 *   center : w = 1 + (c - |i - c|)     — a triangle that peaks at the centre and
 *                                        tapers symmetrically to 1 at both ends.
 *
 * Hours are the task's Work split in proportion to these weights.
 */
export function distributionWeights(profile: Distribution, count: number): number[] {
  if (count <= 0) return [];
  const centre = (count - 1) / 2;
  return Array.from({ length: count }, (_, index) => {
    if (profile === "front") return count - index;
    if (profile === "back") return index + 1;
    if (profile === "center") return 1 + (centre - Math.abs(index - centre));
    return 1;
  });
}

/** The `count` working days starting at `start`; non-working days are skipped. */
function workingDaysFrom(start: string, count: number, calendarId: string, system: CalendarSystem): string[] {
  const dates: string[] = [];
  let cursor = start;
  for (let index = 0; index < count; index += 1) {
    dates.push(cursor);
    cursor = addWorkingDays(cursor, 1, calendarId, system);
  }
  return dates;
}

/**
 * The task's own working days: its work duration on the project calendar, with
 * margin days excluded. These are the days a task could put hours on before any
 * availability is considered.
 */
export function taskWorkingDates(
  task: PlannerTask,
  system: CalendarSystem,
  projectCalendarId?: string,
): string[] {
  // A milestone has no work at all, so there is nothing to distribute.
  if (task.isMilestone || task.duration === 0) return [];
  const calendarId = task.calendarId ?? projectCalendarId ?? system.defaultCalendarId;
  const start = ensureWorkingDay(task.start, calendarId, system);
  // The engine's work finish: the task's working days only, before any reserve.
  const span = durationInWorkingDays(task);
  const finish = span <= 1 ? start : addWorkingDays(start, span - 1, calendarId, system);
  const count = workingDaysBetween(start, finish, calendarId, system);
  return workingDaysFrom(start, count, calendarId, system);
}

/**
 * The hours a task puts on each of its own working days.
 *
 * The span is the task's work duration only, so margin days — which occupy real
 * time after the work but are never worked — receive no hours and are never
 * reached. Non-working days are skipped, never padded. Daily hours are rounded
 * to a quarter hour and any rounding remainder rides on the last working day, so
 * the allocated total always equals the task's Work exactly.
 *
 * When `isAvailable` is given, the work is spread only over the task's working
 * days on which the assigned resource can actually work: a day that is a
 * weekend, a holiday, a project closure, a personal day off or leave gives 0 h,
 * and its hours are redistributed over the remaining available days with the
 * profile's shape preserved. When nothing in the span is available the plain
 * calendar split is kept, so no hour is ever dropped — the caller reports the
 * shortfall instead (BES-008).
 *
 * Everything is derived from the task and the availability rule, so a change to
 * Duration, Work, Distribution, the calendar or a person's leave is reflected the
 * next time this is called. Exposed for the capacity engine; no charts or reports
 * are built from it here.
 */
export function dailyAllocation(
  task: PlannerTask,
  system: CalendarSystem,
  projectCalendarId?: string,
  isAvailable?: (date: string) => boolean,
): DailyAllocation[] {
  const dates = taskWorkingDates(task, system, projectCalendarId);
  if (dates.length === 0) return [];
  const work = Math.max(0, task.work ?? 0);
  // Distribute in quarter-hour units so the split stays exact and integer.
  const totalQuarters = Math.round(work * 4);
  if (totalQuarters <= 0) return dates.map((date) => ({ date, hours: 0 }));

  const available = isAvailable ? dates.filter((date) => isAvailable(date)) : dates;
  // No available day at all: keep the calendar split rather than dropping hours.
  const target = available.length ? available : dates;
  const weights = distributionWeights(normalizeDistribution(task.distribution), target.length);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const quarters = weights.map((weight) => Math.round((totalQuarters * weight) / totalWeight));
  const distributed = quarters.reduce((sum, value) => sum + value, 0);
  // Keep the total exact: the rounding remainder rides on the last target day.
  quarters[quarters.length - 1] += totalQuarters - distributed;

  const hoursByDate = new Map<string, number>();
  target.forEach((date, index) => hoursByDate.set(date, quarters[index] / 4));
  return dates.map((date) => ({ date, hours: hoursByDate.get(date) ?? 0 }));
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
export function applyModeCommit(previous: PlannerTask[], next: PlannerTask[], mode: PlanMode, context?: MarginContext): PlannerTask[] {
  return mode === "planning" ? applyPlanningModeMargins(next) : applyMarginConsumption(previous, next, context);
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

/** The calendar needed to measure how far a finish moved, in working days. */
export interface MarginContext {
  calendarSystem: CalendarSystem;
  projectCalendarId?: string;
}

/**
 * How far a task's work finish moved, in working days of its own calendar.
 * Positive means later (the plan slipped), negative means earlier.
 */
function finishShiftDays(before: PlannerTask, after: PlannerTask, context?: MarginContext): number {
  if (!context || before.finish === after.finish) return 0;
  const calendarId = after.calendarId ?? context.projectCalendarId ?? context.calendarSystem.defaultCalendarId;
  const system = context.calendarSystem;
  return after.finish > before.finish
    ? workingDaysBetween(before.finish, after.finish, calendarId, system) - 1
    : -(workingDaysBetween(after.finish, before.finish, calendarId, system) - 1);
}

/** What a single task's margin did when its finish moved. */
export interface MarginAbsorption {
  taskId: string;
  /** Working days the task's own remaining reserve soaked up. */
  absorbed: number;
  /** Working days that had to pass on to the successors. */
  passed: number;
  /** Working days given back to the reserve because the finish moved earlier. */
  returned: number;
}

/**
 * Margin consumption is driven by the FINISH date, whatever caused it — a longer
 * duration, a later start, a later actual start, a calendar change, or a
 * predecessor that pushed the task further than its own reserve could absorb.
 * The task's own remaining reserve takes the movement first and only the excess
 * passes on to successors; a task never borrows a successor's reserve.
 *
 * Compare `previous` (the plan before the change) with `next` (already scheduled
 * with the old reserves) to learn how far each finish moved.
 */
/** The fields whose change makes a task responsible for its own finish move. */
const SCHEDULING_FIELDS = ["duration", "durationUnit", "start", "finish", "isMilestone", "actualStart", "actualFinish", "predecessors", "calendarId"] as const;

/**
 * The tasks the user actually changed in this commit. Only these may spend their
 * reserve: a task that merely moved because a predecessor slipped does not, so an
 * upstream reserve that absorbs the delay also stops it eating a downstream one.
 */
export function changedTaskIds(previous: PlannerTask[], edited: PlannerTask[]): Set<string> {
  const previousById = new Map(previous.map((task) => [task.id, task]));
  const changed = new Set<string>();
  for (const task of edited) {
    const before = previousById.get(task.id);
    if (!before) { changed.add(task.id); continue; }
    const record = task as unknown as Record<string, unknown>;
    const previousRecord = before as unknown as Record<string, unknown>;
    if (SCHEDULING_FIELDS.some((field) => record[field] !== previousRecord[field])) changed.add(task.id);
  }
  return changed;
}

export function absorbFinishShifts(
  previous: PlannerTask[],
  next: PlannerTask[],
  context?: MarginContext,
  /** When given, only these tasks may consume reserve (see `changedTaskIds`). */
  eligible?: ReadonlySet<string>,
): { tasks: PlannerTask[]; changes: MarginAbsorption[] } {
  const previousById = new Map(previous.map((task) => [task.id, task]));
  const changes: MarginAbsorption[] = [];
  const tasks = next.map((task) => {
    const before = previousById.get(task.id);
    if (!before) return task;
    // Summaries roll up their children and never carry a reserve of their own.
    if (next.some((child) => child.parentId === task.id)) return task;
    // A task that only moved with the network keeps its reserve untouched.
    if (eligible && !eligible.has(task.id)) return task;
    const marginPct = Math.max(0, task.marginPct ?? 0);
    const resized = marginPct !== Math.max(0, before.marginPct ?? 0);
    const original = resized
      ? marginOriginalDaysFor(task, marginPct)
      : Math.max(0, before.marginDaysOriginal ?? marginOriginalDaysFor(task, marginPct));
    const priorConsumed = Math.max(0, before.marginDaysConsumed ?? 0);
    if (resized) return { ...task, marginDaysOriginal: original, marginDaysConsumed: Math.min(original, priorConsumed) };
    const shift = finishShiftDays(before, task, context);
    const remainingBefore = Math.max(0, original - priorConsumed);
    const absorbed = shift > 0 ? Math.min(shift, remainingBefore) : 0;
    const consumed = Math.max(0, Math.min(original, priorConsumed + shift));
    const returned = Math.max(0, priorConsumed - consumed);
    const passed = shift > 0 ? shift - absorbed : 0;
    if (shift !== 0) changes.push({ taskId: task.id, absorbed, passed, returned });
    return { ...task, marginDaysOriginal: original, marginDaysConsumed: consumed };
  });
  return { tasks, changes };
}

/**
 * Keeps each task's reserve in step with its finish. Margin occupies real time
 * (see `remainingMarginDays`), so this only maintains the bookkeeping; the
 * reserve is re-sized from the current work only when the margin percentage
 * itself changes.
 */
export function applyMarginConsumption(previous: PlannerTask[], next: PlannerTask[], context?: MarginContext): PlannerTask[] {
  return absorbFinishShifts(previous, next, context).tasks;
}

const sameConsumption = (a: PlannerTask[], b: PlannerTask[]): boolean => {
  const byId = new Map(b.map((task) => [task.id, task]));
  return a.every((task) => {
    const other = byId.get(task.id);
    if (!other) return true;
    return (task.marginDaysConsumed ?? 0) === (other.marginDaysConsumed ?? 0)
      && (task.marginDaysOriginal ?? 0) === (other.marginDaysOriginal ?? 0);
  });
};

export interface MonitoringPlanOptions {
  calendarSystem: CalendarSystem;
  projectCalendarId?: string;
  anchoredTaskIds?: string[];
  maxIterations?: number;
  /** Defaults to the tasks whose scheduling fields differ from `previous`. */
  changedTaskIds?: ReadonlySet<string>;
}

export interface MonitoringPlan {
  tasks: PlannerTask[];
  /** Net effect of each task's own finish move versus the previous plan. */
  changes: MarginAbsorption[];
}

/**
 * Settles a Monitoring-mode commit. Reserves are consumed by finish movement,
 * and consuming one task's reserve cancels the delay it would otherwise pass on —
 * which can change whether a later task ever moved. So we schedule, absorb the
 * movement against the previous plan, and repeat until the reserves stop
 * changing; only then do the dates reflect the final consumption.
 */
export function settleMonitoringPlan(
  previous: PlannerTask[],
  edited: PlannerTask[],
  options: MonitoringPlanOptions,
): MonitoringPlan {
  const context: MarginContext = { calendarSystem: options.calendarSystem, projectCalendarId: options.projectCalendarId };
  // Only the tasks the user changed may spend reserve; everything else follows.
  const eligible = options.changedTaskIds ?? changedTaskIds(previous, edited);
  const schedule = (tasks: PlannerTask[]): PlannerTask[] => {
    const result = recalculateTasks(tasks, {
      direction: "forward",
      calendarSystem: options.calendarSystem,
      projectCalendarId: options.projectCalendarId,
      anchoredTaskIds: options.anchoredTaskIds,
    });
    return result.error ? tasks : result.tasks;
  };
  const maxIterations = options.maxIterations ?? 10;
  let candidate = edited;
  let changes: MarginAbsorption[] = [];
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const absorbed = absorbFinishShifts(previous, schedule(candidate), context, eligible);
    changes = absorbed.changes;
    if (sameConsumption(candidate, absorbed.tasks)) return { tasks: absorbed.tasks, changes };
    candidate = absorbed.tasks;
  }
  return { tasks: candidate, changes };
}

export function withCalculatedPlanningFields(
  tasks: PlannerTask[],
  system: CalendarSystem,
  projectCalendarId?: string,
): PlannerTask[] {
  const critical = calculateCriticalPath(tasks, system, projectCalendarId);
  const childrenByParent = new Map<string, PlannerTask[]>();
  tasks.forEach((task) => task.parentId && childrenByParent.set(task.parentId, [...(childrenByParent.get(task.parentId) ?? []), task]));
  // A summary shows the sum of its children's work, evaluated leaf-first so
  // nested summaries add up. Milestones carry no work at all.
  const workCache = new Map<string, number>();
  const workVisiting = new Set<string>();
  const workOf = (task: PlannerTask): number => {
    const cached = workCache.get(task.id);
    if (cached !== undefined) return cached;
    if (workVisiting.has(task.id)) return 0;
    workVisiting.add(task.id);
    const children = childrenByParent.get(task.id);
    const value = children
      ? children.reduce((sum, child) => sum + workOf(child), 0)
      : task.isMilestone
        ? 0
        : Math.max(0, task.work ?? 0);
    workVisiting.delete(task.id);
    workCache.set(task.id, value);
    return value;
  };
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
      // A summary shows the sum of its children's work; milestones have none.
      work: workOf(task),
      // A summary rolls up its children; start intent belongs to leaves only.
      startConstraintActive: children ? false : task.startConstraintActive,
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

/** The baseline fields a delete needs: who it belongs to and when it was made. */
export interface BaselineRecord {
  id: string;
  versionId: string;
  createdAt: string;
}

/** A baseline snapshot row belongs to exactly one baseline. */
export interface BaselineSnapshotRecord {
  baselineId: string;
}

export interface BaselineRemoval<TBaseline extends BaselineRecord, TSnapshot extends BaselineSnapshotRecord> {
  baselines: TBaseline[];
  snapshots: TSnapshot[];
  /** Snapshot rows dropped, including ones that were already orphaned. */
  snapshotsRemoved: number;
  /** What the comparison falls back to, or "" when nothing is left. */
  fallbackBaselineId: string;
}

/**
 * Removes a baseline and every snapshot row stored for it, and reports what the
 * comparison falls back to: the most recent baseline left on the same plan
 * version, or nothing at all. Snapshot rows without a baseline are swept too, so
 * a deletion can never leave orphaned start/finish/duration/margin rows behind.
 * Returns null when the baseline is not in the list, so the caller can say why.
 * Planning data and the version's mode are not touched at all.
 */
export function removeBaselineAndSnapshots<TBaseline extends BaselineRecord, TSnapshot extends BaselineSnapshotRecord>(
  baselines: TBaseline[],
  snapshots: TSnapshot[],
  baselineId: string,
): BaselineRemoval<TBaseline, TSnapshot> | null {
  const target = baselines.find((baseline) => baseline.id === baselineId);
  if (!target) return null;
  const remaining = baselines.filter((baseline) => baseline.id !== baselineId);
  const remainingIds = new Set(remaining.map((baseline) => baseline.id));
  const kept = snapshots.filter((snapshot) => snapshot.baselineId !== baselineId && remainingIds.has(snapshot.baselineId));
  const fallback = remaining
    .filter((baseline) => baseline.versionId === target.versionId)
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .pop();
  return {
    baselines: remaining,
    snapshots: kept,
    snapshotsRemoved: snapshots.length - kept.length,
    fallbackBaselineId: fallback?.id ?? "",
  };
}
