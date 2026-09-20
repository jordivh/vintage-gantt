import {
  findDependencyCycle,
  rollupSummary,
  scheduleTasks,
  type CalendarSystem,
  type DependencyType,
  type PlanningDirection,
  type ScheduleDependency,
  type ScheduleTask,
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
}

/** Parses strings like `"3FS+2d, 5SS"` into dependency records. */
export function parseDependency(value: string, tasks: { id: string }[]): ScheduleDependency[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^(\d+)(FS|SS|FF|SF)?([+-]\d+)?d?$/i);
      if (!match) return null;
      const predecessor = tasks.find((task) => task.id === match[1]);
      if (!predecessor) return null;
      return {
        predecessorId: predecessor.id,
        successorId: "",
        type: (match[2]?.toUpperCase() ?? "FS") as DependencyType,
        lagDays: Number(match[3] ?? 0),
      };
    })
    .filter((dependency): dependency is ScheduleDependency => Boolean(dependency));
}

export function dependenciesForTasks(items: PlannerTask[]): ScheduleDependency[] {
  return items.flatMap((task) =>
    parseDependency(task.predecessors, items).map((dependency) => ({
      ...dependency,
      successorId: task.id,
    })),
  );
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
