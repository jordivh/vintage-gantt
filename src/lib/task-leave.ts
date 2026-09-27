import { isoDate, parseIsoDate, type CalendarSystem } from "./scheduling-engine";
import { availableHours } from "./resource-capacity";

/**
 * Leave visibility: informational only (BES-004). It never colours a row, blocks
 * an edit or moves a date — it just reports how much of a resource's leave falls
 * inside a task's span, and how many hours that resource is available across it.
 */

export interface LeaveResource {
  id: string;
  name: string;
  hoursPerWeek: number;
  calendarId: string;
}

export interface LeaveAssignment {
  taskId: string;
  resourceId: string;
}

export interface LeaveRecord {
  id: string;
  calendarId: string;
  startDate: string;
  endDate: string;
  label: string;
  /** Non-leave exceptions (holidays, closures) are ignored. */
  type?: string;
}

/** The task fields this module reads. */
export interface LeaveTask {
  id: string;
  parentId: string | null;
  start: string;
  finish: string;
}

export interface LeaveEntryDetail {
  date: string;
  label: string;
  resourceId: string;
  resourceName: string;
}

export interface TaskLeaveInfo {
  /** Calendar days of leave (any assigned resource) inside the task's span. */
  leaveDays: number;
  /** Available hours of the assigned resources across the task's span. */
  availableHours: number;
  entries: LeaveEntryDetail[];
}

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

/**
 * For every task: the days of its assigned resources' leave that overlap the
 * task's span (with the leave label, so the type is available on hover) and the
 * total available hours of those resources within the span. Summary rows roll up
 * their children. Purely derived — nothing here changes scheduling.
 */
export function taskLeaveInfo(
  tasks: LeaveTask[],
  resources: LeaveResource[],
  assignments: LeaveAssignment[],
  exceptions: LeaveRecord[],
  system: CalendarSystem,
): Map<string, TaskLeaveInfo> {
  const resourceById = new Map(resources.map((resource) => [resource.id, resource]));
  const leaveByCalendar = new Map<string, LeaveRecord[]>();
  for (const exception of exceptions) {
    if (exception.type && exception.type !== "leave") continue;
    leaveByCalendar.set(exception.calendarId, [...(leaveByCalendar.get(exception.calendarId) ?? []), exception]);
  }
  const assignedByTask = new Map<string, string[]>();
  for (const assignment of assignments) {
    assignedByTask.set(assignment.taskId, [...(assignedByTask.get(assignment.taskId) ?? []), assignment.resourceId]);
  }
  const childrenByParent = new Map<string, LeaveTask[]>();
  for (const task of tasks) {
    if (task.parentId) childrenByParent.set(task.parentId, [...(childrenByParent.get(task.parentId) ?? []), task]);
  }

  const own = (task: LeaveTask): TaskLeaveInfo => {
    const resourceIds = [...new Set(assignedByTask.get(task.id) ?? [])];
    const span = eachDate(task.start, task.finish);
    let leaveDays = 0;
    let availableTotal = 0;
    const entries: LeaveEntryDetail[] = [];
    for (const resourceId of resourceIds) {
      const resource = resourceById.get(resourceId);
      if (!resource) continue;
      for (const date of span) availableTotal += availableHours(resource, date, system);
      for (const leave of leaveByCalendar.get(resource.calendarId) ?? []) {
        const start = leave.startDate > task.start ? leave.startDate : task.start;
        const end = leave.endDate < task.finish ? leave.endDate : task.finish;
        if (start > end) continue;
        for (const date of eachDate(start, end)) {
          leaveDays += 1;
          entries.push({ date, label: leave.label, resourceId, resourceName: resource.name });
        }
      }
    }
    entries.sort((left, right) => left.date.localeCompare(right.date));
    return { leaveDays, availableHours: availableTotal, entries };
  };

  const cache = new Map<string, TaskLeaveInfo>();
  const visiting = new Set<string>();
  const resolve = (task: LeaveTask): TaskLeaveInfo => {
    const cached = cache.get(task.id);
    if (cached) return cached;
    // A malformed parent chain must not loop forever.
    if (visiting.has(task.id)) return { leaveDays: 0, availableHours: 0, entries: [] };
    visiting.add(task.id);
    const children = childrenByParent.get(task.id);
    const info = children
      ? children.reduce<TaskLeaveInfo>((total, child) => {
          const childInfo = resolve(child);
          return {
            leaveDays: total.leaveDays + childInfo.leaveDays,
            availableHours: total.availableHours + childInfo.availableHours,
            entries: [...total.entries, ...childInfo.entries],
          };
        }, { leaveDays: 0, availableHours: 0, entries: [] })
      : own(task);
    visiting.delete(task.id);
    cache.set(task.id, info);
    return info;
  };

  for (const task of tasks) resolve(task);
  return cache;
}

/** The distinct leave labels overlapping a task, for a hover tooltip. */
export function leaveLabels(info: TaskLeaveInfo | undefined): string[] {
  if (!info) return [];
  return [...new Set(info.entries.map((entry) => entry.label))];
}
