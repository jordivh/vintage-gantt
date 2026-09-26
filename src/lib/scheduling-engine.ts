export type DependencyType = "FS" | "SS" | "FF" | "SF";
export type DurationUnit = "days" | "weeks";
export type PlanningDirection = "forward" | "backward";

/* --------------------------------------------------------------------------
 * Calendar model — three inheritance levels: base → project → person
 * ------------------------------------------------------------------------ */

export type CalendarType = "base" | "project" | "person";
export type CalendarExceptionType = "holiday" | "shutdown" | "leave" | "extra-working";
/** `source` lets us add leave synchronisation later without a migration. */
export type CalendarExceptionSource = "manual" | "import" | "sync";

/** Weekday numbers follow `Date#getDay()`: 0 = Sunday … 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Monday-first ordering, which is how the working-pattern toggles are shown. */
export const WEEK_ORDER: Weekday[] = [1, 2, 3, 4, 5, 6, 0];

export const EXCEPTION_TYPE_LABELS: Record<CalendarExceptionType, string> = {
  holiday: "Holiday",
  shutdown: "Shutdown",
  leave: "Leave",
  "extra-working": "Extra working day",
};

export interface PlannerCalendar {
  id: string;
  name: string;
  type: CalendarType;
  parentCalendarId: string | null;
  isDefault: boolean;
  /** Weekly working pattern. `undefined` means "inherit the parent's pattern". */
  workingDays?: Weekday[];
}

export interface CalendarException {
  id: string;
  calendarId: string;
  /** ISO date (yyyy-mm-dd), inclusive */
  startDate: string;
  /** ISO date (yyyy-mm-dd), inclusive */
  endDate: string;
  label: string;
  type: CalendarExceptionType;
  isWorkingDay: boolean;
  source: CalendarExceptionSource;
}

export interface CalendarSystem {
  calendars: PlannerCalendar[];
  exceptions: CalendarException[];
  defaultCalendarId: string;
}

/** Why a given date is (not) a working day, and where that decision came from. */
export interface WorkingDayResolution {
  date: string;
  isWorkingDay: boolean;
  reason: string;
  sourceCalendarId: string | null;
  sourceCalendarName: string | null;
  /** True when the decision comes from an ancestor calendar instead of the requested one. */
  inherited: boolean;
  exception: CalendarException | null;
}

/* --------------------------------------------------------------------------
 * Date plumbing (kept private — every calculation in the app goes through the
 * resolver below, never through ad-hoc date logic).
 * ------------------------------------------------------------------------ */

export const isoDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
export const parseIsoDate = (value: string) => new Date(`${value}T12:00:00`);

/** Returns Monday-first date cells for one month, padded with nulls. */
export function monthCells(year: number, month: number): (string | null)[] {
  const first = new Date(year, month, 1, 12);
  const daysInMonth = new Date(year, month + 1, 0, 12).getDate();
  const lead = (first.getDay() + 6) % 7;
  return [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) =>
      `${year}-${String(month + 1).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`,
    ),
  ];
}

const shiftDays = (value: string, amount: number) => {
  const date = parseIsoDate(value);
  date.setDate(date.getDate() + amount);
  return isoDate(date);
};

/* --------------------------------------------------------------------------
 * Resolution
 * ------------------------------------------------------------------------ */

/**
 * Walks from the requested calendar up through its parents (person → project →
 * base). The most specific calendar that has something to say wins.
 */
export function calendarChain(system: CalendarSystem, calendarId?: string): PlannerCalendar[] {
  const byId = new Map(system.calendars.map((calendar) => [calendar.id, calendar]));
  const chain: PlannerCalendar[] = [];
  const seen = new Set<string>();
  let currentId: string | null = calendarId ?? system.defaultCalendarId;
  while (currentId && !seen.has(currentId)) {
    const calendar = byId.get(currentId);
    if (!calendar) break;
    seen.add(currentId);
    chain.push(calendar);
    currentId = calendar.parentCalendarId;
  }
  if (!chain.length) {
    const fallback = byId.get(system.defaultCalendarId);
    if (fallback) chain.push(fallback);
  }
  return chain;
}

function exceptionPriority(exception: CalendarException) {
  // An "extra working day" deliberately overrides an inherited shutdown/holiday.
  return exception.type === "extra-working" && exception.isWorkingDay ? 2 : 1;
}

/** Every exception on a single calendar that covers a date, most specific first. */
export function exceptionsOnDate(system: CalendarSystem, calendarId: string, date: string) {
  return system.exceptions
    .filter(
      (exception) =>
        exception.calendarId === calendarId &&
        exception.startDate <= date &&
        exception.endDate >= date,
    )
    .sort(
      (a, b) =>
        exceptionPriority(b) - exceptionPriority(a) ||
        b.startDate.localeCompare(a.startDate) ||
        a.endDate.localeCompare(b.endDate),
    );
}

/**
 * THE working-day resolver. Every date calculation in the app resolves through
 * this function. Order: person exception > project exception > base exception >
 * weekly pattern.
 */
export function resolveWorkingDay(
  date: string,
  calendarId: string | undefined,
  system: CalendarSystem,
): WorkingDayResolution {
  const chain = calendarChain(system, calendarId);
  const leafId = chain[0]?.id ?? null;

  for (const calendar of chain) {
    const [hit] = exceptionsOnDate(system, calendar.id, date);
    if (hit) {
      return {
        date,
        isWorkingDay: hit.isWorkingDay,
        reason: hit.label || EXCEPTION_TYPE_LABELS[hit.type],
        sourceCalendarId: calendar.id,
        sourceCalendarName: calendar.name,
        inherited: calendar.id !== leafId,
        exception: hit,
      };
    }
  }

  const weekday = parseIsoDate(date).getDay() as Weekday;
  const patternCalendar = chain.find((calendar) => calendar.workingDays && calendar.workingDays.length);
  const workingDays = patternCalendar?.workingDays ?? ([1, 2, 3, 4, 5] as Weekday[]);
  const isWorkingDay = workingDays.includes(weekday);
  return {
    date,
    isWorkingDay,
    reason: isWorkingDay
      ? `Working ${WEEKDAY_LABELS[weekday]} (weekly pattern)`
      : `${WEEKDAY_LABELS[weekday]} is not a working day (weekly pattern)`,
    sourceCalendarId: patternCalendar?.id ?? null,
    sourceCalendarName: patternCalendar?.name ?? null,
    inherited: Boolean(patternCalendar && patternCalendar.id !== leafId),
    exception: null,
  };
}

export function isWorkingDay(date: string, calendarId: string | undefined, system: CalendarSystem) {
  return resolveWorkingDay(date, calendarId, system).isWorkingDay;
}

/** Steps `amount` working days from `value` (negative steps backwards). */
export function addWorkingDays(
  value: string,
  amount: number,
  calendarId: string | undefined,
  system: CalendarSystem,
) {
  let cursor = value;
  const direction = amount < 0 ? -1 : 1;
  let remaining = Math.abs(amount);
  while (remaining > 0) {
    cursor = shiftDays(cursor, direction);
    if (isWorkingDay(cursor, calendarId, system)) remaining -= 1;
  }
  return cursor;
}

/** Snap a date onto a working day, moving forwards (or backwards) until it is one. */
export function ensureWorkingDay(
  value: string,
  calendarId: string | undefined,
  system: CalendarSystem,
  direction: 1 | -1 = 1,
) {
  return isWorkingDay(value, calendarId, system)
    ? value
    : addWorkingDays(value, direction, calendarId, system);
}

/** Inclusive count of working days between two dates (at least 1). */
export function workingDaysBetween(
  start: string,
  finish: string,
  calendarId: string | undefined,
  system: CalendarSystem,
) {
  if (parseIsoDate(start) > parseIsoDate(finish)) return 0;
  let count = 0;
  let cursor = start;
  while (parseIsoDate(cursor) <= parseIsoDate(finish)) {
    if (isWorkingDay(cursor, calendarId, system)) count += 1;
    cursor = shiftDays(cursor, 1);
  }
  return Math.max(1, count);
}

/* --------------------------------------------------------------------------
 * Scheduling
 * ------------------------------------------------------------------------ */

export interface ScheduleTask {
  id: string;
  parentId: string | null;
  duration: number;
  durationUnit: DurationUnit;
  start: string;
  finish: string;
  /** Task-level (person) calendar. Falls back to the project calendar. */
  calendarId?: string;
  resourceId?: string;
  isMilestone?: boolean;
  /** Margin reserve after the work, sized when the margin was set (working days). */
  marginDaysOriginal?: number;
  /** Part of that reserve already eaten by the task's own growth. */
  marginDaysConsumed?: number;
  /**
   * User intent for this task only: "start no earlier than" this date (ISO).
   * The forward pass takes the later of the dependency earliest start and this
   * date, so a manually chosen later start survives every recalculation without
   * ever pulling a sibling around.
   */
  startConstraint?: string;
  /**
   * Whether the constraint is the binding floor. False once a predecessor has
   * moved past it, in which case the dependency simply wins — the constraint is
   * kept but inactive rather than deleted.
   */
  startConstraintActive?: boolean;
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
  calendarSystem?: CalendarSystem;
  projectCalendarId?: string;
  resetDates?: boolean;
  /** Task ids whose manually edited dates must remain fixed during a non-reset pass. */
  anchoredTaskIds?: string[];
}

interface ResolvedScheduleOptions extends ScheduleOptions {
  calendarSystem: CalendarSystem;
  /** Tasks with children: roll-up rows, which never carry a margin of their own. */
  summaryIds?: ReadonlySet<string>;
}

/**
 * The reserve still following a task's work. Margin occupies real time: it sits
 * in the slot after the work period and successors are scheduled from the end of
 * that slot, so an extension first eats the reserve instead of pushing the plan.
 * Milestones have no margin.
 */
export function remainingMarginDays(task: ScheduleTask) {
  if (task.isMilestone || task.duration === 0) return 0;
  return Math.max(0, Math.max(0, task.marginDaysOriginal ?? 0) - Math.max(0, task.marginDaysConsumed ?? 0));
}

/** Margin that belongs to the task itself; a summary only rolls up its children. */
function slotMarginDays(task: ScheduleTask, options: ResolvedScheduleOptions) {
  return options.summaryIds?.has(task.id) ? 0 : remainingMarginDays(task);
}

export function createDefaultCalendarSystem(): CalendarSystem {
  return {
    calendars: [
      {
        id: "base",
        name: "Standard workweek",
        type: "base",
        parentCalendarId: null,
        isDefault: true,
        workingDays: [1, 2, 3, 4, 5],
      },
    ],
    exceptions: [],
    defaultCalendarId: "base",
  };
}

export function durationInWorkingDays(task: ScheduleTask) {
  if (task.isMilestone) return 1;
  return task.durationUnit === "weeks" ? task.duration * 5 : task.duration;
}

/** The calendar a task is planned on: its own, else the project's, else the default. */
export function calendarIdForTask(task: ScheduleTask, options: ResolvedScheduleOptions) {
  return task.calendarId ?? options.projectCalendarId ?? options.calendarSystem.defaultCalendarId;
}

function finishFromStart(task: ScheduleTask, options: ResolvedScheduleOptions) {
  const calendarId = calendarIdForTask(task, options);
  if (task.isMilestone || durationInWorkingDays(task) <= 1) {
    return ensureWorkingDay(task.start, calendarId, options.calendarSystem);
  }
  return addWorkingDays(
    task.start,
    durationInWorkingDays(task) - 1,
    calendarId,
    options.calendarSystem,
  );
}

/** End of a task's slot: its work finish plus the margin zone that follows it. */
function slotFinish(task: ScheduleTask, options: ResolvedScheduleOptions) {
  const work = finishFromStart(task, options);
  const margin = slotMarginDays(task, options);
  if (margin <= 0) return work;
  return addWorkingDays(work, margin, calendarIdForTask(task, options), options.calendarSystem);
}

function startFromFinish(task: ScheduleTask, options: ResolvedScheduleOptions) {
  const calendarId = calendarIdForTask(task, options);
  if (task.isMilestone || durationInWorkingDays(task) <= 1) {
    return ensureWorkingDay(task.finish, calendarId, options.calendarSystem);
  }
  return addWorkingDays(
    task.finish,
    -(durationInWorkingDays(task) - 1),
    calendarId,
    options.calendarSystem,
  );
}

function dependencyStart(
  predecessor: ScheduleTask,
  successor: ScheduleTask,
  dependency: ScheduleDependency,
  options: ResolvedScheduleOptions,
) {
  const calendarId = calendarIdForTask(successor, options);
  const { calendarSystem } = options;
  const lag = dependency.lagDays;
  if (dependency.type === "SS") {
    return addWorkingDays(predecessor.start, lag, calendarId, calendarSystem);
  }
  if (dependency.type === "FF") {
    return addWorkingDays(
      slotFinish(predecessor, options),
      lag - (durationInWorkingDays(successor) - 1),
      calendarId,
      calendarSystem,
    );
  }
  if (dependency.type === "SF") {
    return addWorkingDays(
      predecessor.start,
      lag - (durationInWorkingDays(successor) - 1),
      calendarId,
      calendarSystem,
    );
  }
  // FS: the successor starts the first working day after the predecessor's slot,
  // so it lands after the predecessor's margin zone rather than after its work.
  return addWorkingDays(slotFinish(predecessor, options), lag + 1, calendarId, calendarSystem);
}

export interface EarliestDependencyStart {
  /** Earliest date the task may start given this dependency. */
  date: string;
  predecessor: ScheduleTask;
  type: DependencyType;
  lagDays: number;
}

/**
 * The binding incoming dependency of a task, i.e. the predecessor that fixes its
 * earliest start. Returns `null` when the task has no predecessors, in which case
 * its start date is free. Uses the same FS/SS/FF/SF + lag rules as the schedule.
 */
export function earliestDependencyStart(
  task: ScheduleTask,
  tasks: ScheduleTask[],
  dependencies: ScheduleDependency[],
  options: ScheduleOptions = {},
): EarliestDependencyStart | null {
  const resolved: ResolvedScheduleOptions = {
    ...options,
    calendarSystem: options.calendarSystem ?? createDefaultCalendarSystem(),
    summaryIds: new Set(
      tasks.filter((task) => tasks.some((child) => child.parentId === task.id)).map((task) => task.id),
    ),
  };
  const byId = new Map(tasks.map((item) => [item.id, item]));
  let binding: EarliestDependencyStart | null = null;
  for (const dependency of dependencies) {
    if (dependency.successorId !== task.id) continue;
    const predecessor = byId.get(dependency.predecessorId);
    if (!predecessor) continue;
    const date = dependencyStart(predecessor, task, dependency, resolved);
    if (!binding || date > binding.date) {
      binding = { date, predecessor, type: dependency.type, lagDays: dependency.lagDays };
    }
  }
  return binding;
}

export function findDependencyCycle(tasks: ScheduleTask[], dependencies: ScheduleDependency[]) {
  const taskIds = new Set(tasks.map((task) => task.id));
  const edges = new Map<string, string[]>();
  dependencies.forEach((dependency) => {
    if (!taskIds.has(dependency.predecessorId) || !taskIds.has(dependency.successorId)) return;
    edges.set(dependency.predecessorId, [
      ...(edges.get(dependency.predecessorId) ?? []),
      dependency.successorId,
    ]);
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

function scheduleForward(
  tasks: ScheduleTask[],
  dependencies: ScheduleDependency[],
  options: ResolvedScheduleOptions,
) {
  const result = tasks.map((task) => {
    if (options.resetDates && options.projectStart) {
      return { ...task, start: ensureWorkingDay(options.projectStart, calendarIdForTask(task, options), options.calendarSystem) };
    }
    return { ...task };
  });
  const byId = new Map(result.map((task) => [task.id, task]));
  const incoming = new Map<string, ScheduleDependency[]>();
  dependencies.forEach((dependency) =>
    incoming.set(dependency.successorId, [...(incoming.get(dependency.successorId) ?? []), dependency]),
  );
  const visiting = new Set<string>();
  const visit = (task: ScheduleTask) => {
    if (visiting.has(task.id)) return;
    visiting.add(task.id);
    const constraintStarts: string[] = [];
    for (const dependency of incoming.get(task.id) ?? []) {
      const predecessor = byId.get(dependency.predecessorId);
      if (!predecessor) continue;
      visit(predecessor);
      constraintStarts.push(dependencyStart(predecessor, task, dependency, options));
    }
    // The dependency network is authoritative for the lower bound: a stale later
    // start left over from an earlier edit is pulled back, and nothing (not even a
    // manual drag) may place a task before its predecessors allow. Anchoring only
    // keeps an edited task *later* than its dependencies allow. Margins are
    // bookkeeping only and never move a task.
    const isAnchored = options.anchoredTaskIds?.includes(task.id) ?? false;
    // A start constraint is user intent for this one task: the start is the later
    // of what the dependencies allow and the constrained date. It never leaks to
    // siblings, and it is only inactive (not removed) when a dependency overtakes it.
    const constraint = task.startConstraint;
    let constraintActive = false;
    if (constraintStarts.length) {
      const earliest = constraintStarts.reduce((latest, date) => (date > latest ? date : latest));
      let next = isAnchored && task.start > earliest ? task.start : earliest;
      if (constraint && constraint > next) next = constraint;
      task.start = next;
      constraintActive = Boolean(constraint) && (constraint as string) >= earliest;
    } else if (constraint) {
      // Free task: the constrained date is the plan.
      task.start = constraint;
      constraintActive = true;
    }
    task.startConstraintActive = constraintActive;
    const { projectStart } = options;
    if (projectStart && !task.parentId && task.start < projectStart) task.start = projectStart;
    task.start = ensureWorkingDay(task.start, calendarIdForTask(task, options), options.calendarSystem);
    task.finish = finishFromStart(task, options);
    visiting.delete(task.id);
  };
  result.forEach(visit);
  return result;
}

function scheduleBackward(
  tasks: ScheduleTask[],
  dependencies: ScheduleDependency[],
  options: ResolvedScheduleOptions,
) {
  const result = tasks.map((task) => {
    if (options.resetDates && options.projectFinish) {
      return { ...task, finish: ensureWorkingDay(options.projectFinish, calendarIdForTask(task, options), options.calendarSystem, -1) };
    }
    return { ...task };
  });
  const byId = new Map(result.map((task) => [task.id, task]));
  const outgoing = new Map<string, ScheduleDependency[]>();
  dependencies.forEach((dependency) =>
    outgoing.set(dependency.predecessorId, [
      ...(outgoing.get(dependency.predecessorId) ?? []),
      dependency,
    ]),
  );
  const visiting = new Set<string>();
  const visit = (task: ScheduleTask) => {
    if (visiting.has(task.id)) return;
    visiting.add(task.id);
    const successorConstraints: string[] = [];
    for (const dependency of outgoing.get(task.id) ?? []) {
      const successor = byId.get(dependency.successorId);
      if (!successor) continue;
      visit(successor);
      const successorCalendar = calendarIdForTask(successor, options);
      const { calendarSystem } = options;
      const lag = dependency.lagDays;
      if (dependency.type === "FS") {
        successorConstraints.push(
          addWorkingDays(successor.start, -lag - 1, successorCalendar, calendarSystem),
        );
      }
      if (dependency.type === "SS") {
        successorConstraints.push(
          addWorkingDays(
            successor.start,
            -lag + durationInWorkingDays(task) - 1 + slotMarginDays(task, options),
            successorCalendar,
            calendarSystem,
          ),
        );
      }
      if (dependency.type === "FF") {
        successorConstraints.push(
          addWorkingDays(successor.finish, -lag, successorCalendar, calendarSystem),
        );
      }
      if (dependency.type === "SF") {
        successorConstraints.push(
          addWorkingDays(
            successor.finish,
            -lag + durationInWorkingDays(task) - 1 + slotMarginDays(task, options),
            successorCalendar,
            calendarSystem,
          ),
        );
      }
    }
    const isAnchored = options.anchoredTaskIds?.includes(task.id) ?? false;
    if (!isAnchored) {
      const calendarId = calendarIdForTask(task, options);
      const latest = successorConstraints.length
        ? successorConstraints.reduce((min, date) => (date < min ? date : min))
        : options.projectFinish ?? task.finish;
      // The constraints bound the end of the slot; the reserve sits at its end, so
      // the work itself has to finish before it.
      const slotEnd = ensureWorkingDay(latest, calendarId, options.calendarSystem, -1);
      const margin = slotMarginDays(task, options);
      task.finish = margin > 0 ? addWorkingDays(slotEnd, -margin, calendarId, options.calendarSystem) : slotEnd;
      task.start = startFromFinish(task, options);
    }
    visiting.delete(task.id);
  };
  result.forEach(visit);
  return result;
}

export function scheduleTasks(
  tasks: ScheduleTask[],
  dependencies: ScheduleDependency[],
  options: ScheduleOptions = {},
) {
  const cycle = findDependencyCycle(tasks, dependencies);
  if (cycle) {
    throw new Error(
      `Circular dependency detected: ${cycle.join(" → ")}. Please remove one of the links and try again.`,
    );
  }
  const resolved: ResolvedScheduleOptions = {
    ...options,
    calendarSystem: options.calendarSystem ?? createDefaultCalendarSystem(),
    summaryIds: new Set(
      tasks.filter((task) => tasks.some((child) => child.parentId === task.id)).map((task) => task.id),
    ),
  };
  return resolved.direction === "backward"
    ? scheduleBackward(tasks, dependencies, resolved)
    : scheduleForward(tasks, dependencies, resolved);
}

/** Rolls summary-task dates up from their children (inclusively, in working days). */
export function rollupSummary(
  tasks: ScheduleTask[],
  system: CalendarSystem,
  projectCalendarId?: string,
) {
  const result = tasks.map((task) => ({ ...task }));
  const byId = new Map(result.map((task) => [task.id, task]));
  [...result].reverse().forEach((task) => {
    if (!task.parentId) return;
    const parent = byId.get(task.parentId);
    if (!parent) return;
    const children = result.filter((candidate) => candidate.parentId === parent.id);
    if (!children.length) return;
    // The bracket covers each child's full slot, so a trailing margin zone is
    // inside the roll-up instead of dangling past it.
    const slotEnd = (child: ScheduleTask) => {
      const margin = remainingMarginDays(child);
      const childCalendar = child.calendarId ?? projectCalendarId ?? system.defaultCalendarId;
      return margin > 0 ? addWorkingDays(child.finish, margin, childCalendar, system) : child.finish;
    };
    parent.start = children.reduce((min, child) => (child.start < min ? child.start : min), children[0].start);
    parent.finish = children.reduce((max, child) => {
      const end = slotEnd(child);
      return end > max ? end : max;
    }, slotEnd(children[0]));
    const calendarId = parent.calendarId ?? projectCalendarId ?? system.defaultCalendarId;
    parent.duration = workingDaysBetween(parent.start, parent.finish, calendarId, system);
    parent.durationUnit = "days";
  });
  return result;
}

/* --------------------------------------------------------------------------
 * Belgian public holidays (used by "Import Belgian public holidays for year X")
 * ------------------------------------------------------------------------ */

const addDaysToDate = (date: Date, amount: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
};

/** Anonymous Gregorian algorithm (Meeus/Jones/Butcher). */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day, 12);
}

export function belgianPublicHolidays(year: number): { date: string; label: string }[] {
  const easter = easterSunday(year);
  return [
    { date: `${year}-01-01`, label: "New Year's Day" },
    { date: isoDate(addDaysToDate(easter, 1)), label: "Easter Monday" },
    { date: `${year}-05-01`, label: "Labour Day" },
    { date: isoDate(addDaysToDate(easter, 39)), label: "Ascension Day" },
    { date: isoDate(addDaysToDate(easter, 50)), label: "Whit Monday" },
    { date: `${year}-07-21`, label: "Belgian National Day" },
    { date: `${year}-08-15`, label: "Assumption of Mary" },
    { date: `${year}-11-01`, label: "All Saints' Day" },
    { date: `${year}-11-11`, label: "Armistice Day" },
    { date: `${year}-12-25`, label: "Christmas Day" },
  ];
}
