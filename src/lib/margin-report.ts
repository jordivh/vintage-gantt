import type { CalendarSystem } from "./scheduling-engine";
import { orderTasksForDisplay, withCalculatedPlanningFields, type PlanMode, type PlannerTask } from "./planner-model";

/* --------------------------------------------------------------------------
 * Margin report
 *
 * Everything the report shows is derived here, from the same calculated task
 * fields the planner grid uses. Two rules keep the numbers honest:
 *
 *   1. Only LEAF tasks carry a reserve. A summary row's `marginDaysOriginal` is
 *      the roll-up of its children, so counting summaries would count the same
 *      days twice. Totals are therefore always the sum of the leaf rows.
 *   2. Nothing is assumed to be present. A missing, negative or non-finite
 *      value reads as 0, and a consumption percentage without a planned reserve
 *      is "unknown" (null → rendered as a dash) instead of a division by zero.
 * ------------------------------------------------------------------------ */

const days = (value: number | undefined | null): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/** `consumed / planned` as a whole percentage, or null when there is no reserve. */
export function percentOf(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return Math.round((part / whole) * 100);
}

/** A margin snapshot of one task: the float it had when the baseline was taken. */
export interface MarginBaselineFloat {
  taskId: string;
  totalFloat?: number;
}

export interface MarginBaseline {
  id?: string;
  name?: string;
  captureDate?: string;
  floats: readonly MarginBaselineFloat[];
}

export interface MarginReportRow {
  id: string;
  /** Sequential display id, matching the planner grid's numbering. */
  displayId: number;
  name: string;
  /** Working days of float left; 0 is on the critical path. */
  totalFloat: number;
  /** Whether the task is currently on the critical path (no float left). */
  isCritical: boolean;
  /** Float at baseline time, or null when no baseline covers this task. */
  baselineFloat: number | null;
  /** Had float when the baseline was taken and has none now. */
  becameCritical: boolean;
  planned: number;
  consumed: number;
  remaining: number;
  /** Consumption as a percentage of the planned reserve; null when there is none. */
  consumedPct: number | null;
  /** False for tasks and milestones without a planned reserve. */
  hasMargin: boolean;
}

export interface MarginTotals {
  planned: number;
  consumed: number;
  remaining: number;
  consumedPct: number | null;
}

export const EMPTY_MARGIN_TOTALS: MarginTotals = { planned: 0, consumed: 0, remaining: 0, consumedPct: null };

export interface MarginReport {
  projectId: string;
  versionId: string;
  versionName: string;
  mode: PlanMode;
  /** Leaf rows in display order, consumption first. */
  rows: MarginReportRow[];
  totals: MarginTotals;
  criticalCount: number;
  becameCriticalCount: number;
  baselineName: string | null;
  baselineCaptureDate: string | null;
}

/**
 * Projects tasks that already carry calculated planning fields into report rows.
 * Summaries are dropped: their margin is a roll-up of their children.
 */
export function marginRowsFor(tasks: readonly PlannerTask[]): MarginReportRow[] {
  const list = Array.isArray(tasks) ? tasks : [];
  const summaryIds = new Set(
    list.filter((task) => list.some((child) => child.parentId === task.id)).map((task) => task.id),
  );
  return orderTasksForDisplay(list)
    .map((task, index) => {
      const planned = Math.max(0, days(task.marginDaysOriginal));
      const consumed = Math.min(planned, Math.max(0, days(task.marginDaysConsumed)));
      return {
        id: task.id,
        displayId: index + 1,
        name: task.name || "Untitled task",
        totalFloat: Math.max(0, days(task.totalFloat)),
        isCritical: Boolean(task.isCritical),
        baselineFloat: null,
        becameCritical: false,
        planned,
        consumed,
        remaining: Math.max(0, planned - consumed),
        consumedPct: percentOf(consumed, planned),
        hasMargin: planned > 0,
      };
    })
    .filter((row) => !summaryIds.has(row.id));
}

/** The project totals: the sum of the leaf rows, and nothing else. */
export function leafMarginTotals(rows: readonly MarginReportRow[]): MarginTotals {
  const list = Array.isArray(rows) ? rows : [];
  const planned = list.reduce((sum, row) => sum + days(row.planned), 0);
  const consumed = list.reduce((sum, row) => sum + days(row.consumed), 0);
  const remaining = Math.max(0, planned - consumed);
  return { planned, consumed, remaining, consumedPct: percentOf(consumed, planned) };
}

/** Highest consumption first; margin-less tasks last; stable ties. */
export function sortMarginRows(rows: readonly MarginReportRow[]): MarginReportRow[] {
  return [...rows].sort((left, right) =>
    Number(right.hasMargin) - Number(left.hasMargin)
    || right.consumed - left.consumed
    || right.planned - left.planned
    || left.displayId - right.displayId
    || left.name.localeCompare(right.name),
  );
}

export interface MarginReportInput {
  tasks: readonly PlannerTask[];
  system: CalendarSystem;
  projectCalendarId?: string;
  projectId: string;
  versionId: string;
  versionName?: string;
  mode: PlanMode;
  /** The baseline to compare float against; omit when none was captured. */
  baseline?: MarginBaseline | null;
}

/** Builds the whole report for one project version, from raw (uncalculated) tasks. */
export function buildMarginReport(input: MarginReportInput): MarginReport {
  const rows = marginRowsFor(withCalculatedPlanningFields([...(input.tasks ?? [])], input.system, input.projectCalendarId));
  const floats = new Map<string, number>();
  for (const snapshot of input.baseline?.floats ?? []) {
    if (snapshot?.taskId) floats.set(snapshot.taskId, days(snapshot.totalFloat));
  }
  const marked = rows.map((row) => {
    if (!floats.has(row.id)) return row;
    const baselineFloat = floats.get(row.id) ?? 0;
    return { ...row, baselineFloat, becameCritical: baselineFloat > 0 && row.isCritical };
  });
  return {
    projectId: input.projectId,
    versionId: input.versionId,
    versionName: input.versionName?.trim() || "Plan version",
    mode: input.mode,
    rows: sortMarginRows(marked),
    totals: leafMarginTotals(marked),
    criticalCount: marked.filter((row) => row.isCritical).length,
    becameCriticalCount: marked.filter((row) => row.becameCritical).length,
    baselineName: input.baseline?.name?.trim() || null,
    baselineCaptureDate: input.baseline?.captureDate ?? null,
  };
}

/** TC-44 stated in words. */
export function becameCriticalHeadline(count: number): string {
  const total = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  if (total === 0) return "No task became critical through margin consumption.";
  return total === 1
    ? "1 task became critical through margin consumption."
    : `${total} tasks became critical through margin consumption.`;
}
