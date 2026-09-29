import { addWorkingDays, remainingMarginDays, resolveWorkingDay, type CalendarSystem } from "./scheduling-engine";
import { dependenciesForTasks, orderTasksForDisplay, type PlanMode, type PlannerTask } from "./planner-model";
import { leafMarginTotals, marginRowsFor, percentOf } from "./margin-report";

/* --------------------------------------------------------------------------
 * Planner PDF export
 *
 * Everything the printed plan contains is derived here, from the very task
 * objects the planner grid renders (the active version's calculated tasks).
 * This module knows nothing about PDF: it produces rows, day offsets and
 * labels, so the same figures can be asserted in tests. The renderer
 * (`planner-pdf-document.ts`) only turns these numbers into ink.
 *
 * It reads. Nothing in this file writes a task, a date or an assignment.
 * ------------------------------------------------------------------------ */

export type PdfPaper = "a4" | "a3";
export type PdfOrientation = "landscape" | "portrait";

export interface PdfPageGeometry {
  widthMm: number;
  heightMm: number;
}

/** The two paper sizes the planner offers, in portrait orientation. */
export const PDF_PAPER_SIZES: Record<PdfPaper, PdfPageGeometry> = {
  a4: { widthMm: 210, heightMm: 297 },
  a3: { widthMm: 297, heightMm: 420 },
};

/** Landscape is the default for a Gantt: the timeline is the wide axis. */
export const DEFAULT_PAPER: PdfPaper = "a3";
export const DEFAULT_ORIENTATION: PdfOrientation = "landscape";
export const DEFAULT_INCLUDE_GANTT = true;

export function pageGeometry(paper: PdfPaper = DEFAULT_PAPER, orientation: PdfOrientation = DEFAULT_ORIENTATION): PdfPageGeometry {
  const size = PDF_PAPER_SIZES[paper] ?? PDF_PAPER_SIZES.a3;
  return orientation === "portrait"
    ? { widthMm: size.widthMm, heightMm: size.heightMm }
    : { widthMm: size.heightMm, heightMm: size.widthMm };
}

/** `<ProjectName>_<VersionName>_<exportdate>.pdf`, with unsafe characters neutralised. */
export function plannerPdfFileName(projectName: string, versionName: string, exportDate: string): string {
  const clean = (value: string, fallback: string) => {
    const trimmed = (value ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
    return (trimmed || fallback).slice(0, 80);
  };
  return `${clean(projectName, "Project")}_${clean(versionName, "Version")}_${exportDate}.pdf`;
}

/**
 * The characters above Latin-1 that CP1252 — and therefore WinAnsi, the
 * encoding of pdf-lib's standard fonts — can show. Everything else (arrows,
 * maths, CJK, the undefined CP1252 positions) becomes "?".
 */
const WINANSI_HIGH = "\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178";
const WINANSI_UNSAFE = new RegExp(`[^\\u0020-\\u007e\\u00a0-\\u00ff${WINANSI_HIGH}]`, "g");

/**
 * Keeps text inside what the standard fonts can actually draw: the em dash,
 * curly quotes, the middle dot and every accented letter survive, anything the
 * encoding has no slot for is replaced instead of silently dropped.
 */
export function pdfSafeText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(WINANSI_UNSAFE, "?");
}

const parseDate = (date: string) => new Date(`${date}T12:00:00`);
const daysBetween = (from: string, to: string) =>
  Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86400000);
const addDays = (date: string, amount: number) => {
  const next = parseDate(date);
  next.setDate(next.getDate() + amount);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
};
const finite = (value: number | undefined | null) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** "29 Sep 2026" — the same shape the planner sidebar uses. */
export function formatPdfDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) return "";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(parseDate(date));
}

/** "05/10" — the compact tick label on the timeline. */
export function formatPdfTick(date: string): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

/** "Oct 2026" — the band above the timeline ticks. */
export function formatPdfMonth(date: string): string {
  return new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" }).format(parseDate(date));
}

/* ------------------------------------------------------------------ layout */

export interface PdfChartWindow {
  /** First calendar day of the window, counted from the chart start. */
  startDay: number;
  dayCount: number;
}

export interface PdfChartLayout {
  /** Millimetres per calendar day inside a window. */
  dayWidthMm: number;
  windows: PdfChartWindow[];
}

export interface PdfChartLayoutOptions {
  /** Below this the bars stop being readable, so the timeline is split instead. */
  minDayWidthMm?: number;
  /** Above this the chart would look empty on a page. */
  maxDayWidthMm?: number;
  /** Hard ceiling on timeline pages, so a decade-long plan still terminates. */
  maxWindows?: number;
}

/**
 * Splits the timeline into page-wide windows. Either the whole span fits one
 * page (scaled to the page width) or it is split across pages — never clipped:
 * the last window stops exactly at the last day.
 */
export function chartWindows(totalDays: number, chartWidthMm: number, options: PdfChartLayoutOptions = {}): PdfChartLayout {
  const days = Math.max(1, Math.ceil(totalDays));
  const width = Math.max(1, chartWidthMm);
  const minDayWidthMm = options.minDayWidthMm ?? 2.4;
  const maxDayWidthMm = options.maxDayWidthMm ?? 7;
  const maxWindows = Math.max(1, Math.trunc(options.maxWindows ?? 12));

  const needed = Math.ceil((days * minDayWidthMm) / width);
  const count = Math.min(Math.max(1, needed), maxWindows);
  const dayCount = Math.ceil(days / count);
  const windows: PdfChartWindow[] = [];
  for (let startDay = 0; startDay < days; startDay += dayCount) {
    windows.push({ startDay, dayCount: Math.min(dayCount, days - startDay) });
  }
  return { dayWidthMm: Math.min(width / dayCount, maxDayWidthMm), windows };
}

/** Splits rows into page-sized blocks; a block is never empty. */
export function chunkRows<T>(rows: readonly T[], perPage: number): T[][] {
  const size = Math.max(1, Math.trunc(perPage));
  const list = Array.isArray(rows) ? rows : [];
  const blocks: T[][] = [];
  for (let index = 0; index < list.length; index += size) blocks.push(list.slice(index, index + size) as T[]);
  return blocks;
}

/** How many days between two tick labels, so the labels never collide. */
export function tickEveryDays(dayWidthMm: number): number {
  const widths = [1, 2, 7, 14, 28, 91, 182, 365];
  return widths.find((candidate) => candidate * dayWidthMm >= 10) ?? 365;
}

/* -------------------------------------------------------------------- rows */

/** The status the planner's own fields describe. Derived, never stored. */
export function pdfTaskStatus(task: Pick<PlannerTask, "percent" | "actualStart" | "actualFinish">): string {
  if (task.actualFinish || finite(task.percent) >= 100) return "Complete";
  if (task.actualStart || finite(task.percent) > 0) return "In progress";
  return "Not started";
}

export interface PlannerPdfRow {
  id: string;
  /** WBS number ("1.2.3"), from the outline hierarchy. */
  wbs: string;
  name: string;
  depth: number;
  isSummary: boolean;
  isMilestone: boolean;
  isCritical: boolean;
  /** The task's own bar colour key, so the chart keeps the screen's colours. */
  colorKey: string;
  start: string;
  finish: string;
  durationText: string;
  workText: string;
  assigneeText: string;
  statusText: string;
  marginText: string;
  marginPlannedDays: number;
  marginConsumedDays: number;
  marginRemainingDays: number;
  /** Calendar days from the chart start to the bar's first day. */
  barStartDay: number;
  /** Calendar days the bar spans, both ends included. */
  barDays: number;
  /** Calendar days of remaining reserve drawn after the bar (0 when there is none). */
  marginDays: number;
  progressPct: number;
  /** The baseline bar when a baseline is active and covers this task. */
  baseline: { startDay: number; days: number } | null;
  rowIndex: number;
}

/** A dependency, expressed in rows and calendar days so the renderer can draw it. */
export interface PlannerPdfLink {
  predecessorId: string;
  successorId: string;
  type: string;
  lagDays: number;
  /** Days from the chart start where the link leaves the predecessor's slot. */
  fromDay: number;
  /** Days from the chart start where the link meets the successor's start. */
  toDay: number;
  predecessorRow: number;
  successorRow: number;
}

export interface PlannerPdfChart {
  /** First day drawn on the timeline. */
  start: string;
  /** Last day drawn on the timeline. */
  end: string;
  totalDays: number;
  /** Calendar days from the chart start to today; -1 when today is outside the window. */
  todayOffsetDays: number;
  /** Indices of the days that are not working days for the project calendar. */
  nonWorkingDays: number[];
}

export interface PlannerPdfMeta {
  projectName: string;
  client: string;
  versionName: string;
  mode: PlanMode;
  modeLabel: string;
  /** Name of the active baseline, or "" when none is active. */
  baselineName: string;
  /** "Yes — <name>" or "No". */
  baselineLine: string;
  exportDate: string;
  exportDateLabel: string;
  /** "12 tasks · 3 critical · 2 milestones · margin 20 d (7 d consumed)". */
  summaryLine: string;
  marginPlannedDays: number;
  marginConsumedDays: number;
  marginRemainingDays: number;
  taskCount: number;
  criticalCount: number;
  milestoneCount: number;
}

export interface PlannerPdfLegendItem {
  key: "critical" | "margin" | "baseline" | "milestone" | "summary" | "progress";
  label: string;
}

export interface PlannerPdfModel {
  fileName: string;
  meta: PlannerPdfMeta;
  rows: PlannerPdfRow[];
  links: PlannerPdfLink[];
  /** The timeline, or null when the project has no tasks to place on it. */
  chart: PlannerPdfChart | null;
  legend: PlannerPdfLegendItem[];
  /** True when the project has no tasks at all. */
  empty: boolean;
}

export interface PlannerPdfInput {
  projectName: string;
  client?: string;
  versionName: string;
  mode: PlanMode;
  baselineName?: string | null;
  /** ISO date of the export. */
  exportDate: string;
  /** ISO date treated as "today"; defaults to the export date. */
  today?: string;
  /** The project's ACTIVE version, calculated exactly as the planner grid shows it. */
  tasks: readonly PlannerTask[];
  assignments?: readonly { taskId: string; resourceId: string }[];
  resources?: readonly { id: string; name: string }[];
  /** Snapshots of the active baseline, when one is active. */
  baselineTasks?: readonly { taskId: string; startDate: string; finishDate: string }[];
  system?: CalendarSystem;
  projectCalendarId?: string;
}

export const PDF_SECTION_TITLES = {
  tasks: "Task list",
  chart: "Gantt chart",
} as const;

/** Shown instead of a table when the project has no tasks at all. */
export const PDF_NO_TASKS_MESSAGE = "No tasks in this project";

export const PDF_TABLE_HEADERS = [
  "WBS",
  "Task",
  "Start",
  "Finish",
  "Duration",
  "Workload",
  "Assignee",
  "Status",
  "Margin",
  "Critical",
] as const;

/** The screen's own timeline rule: tasks and today, two weeks either side. */
const TIMELINE_PADDING_DAYS = 14;
const MINIMUM_TIMELINE_DAYS = 62;

function wbsFor(task: PlannerTask, ordered: readonly PlannerTask[]): string {
  const parts: number[] = [];
  let current: PlannerTask | undefined = task;
  while (current) {
    const siblings = ordered.filter((candidate) => (candidate.parentId ?? null) === (current?.parentId ?? null));
    parts.unshift(siblings.findIndex((candidate) => candidate.id === current?.id) + 1);
    current = current.parentId ? ordered.find((candidate) => candidate.id === current?.parentId) : undefined;
  }
  return parts.join(".");
}

function buildChart(tasks: readonly PlannerTask[], today: string, system?: CalendarSystem, projectCalendarId?: string): PlannerPdfChart | null {
  if (!tasks.length) return null;
  const starts = tasks.map((task) => task.start);
  const finishes = tasks.map((task) => task.finish);
  const earliest = starts.reduce((left, right) => (left < right ? left : right));
  const latest = finishes.reduce((left, right) => (left > right ? left : right));
  const start = addDays(earliest < today ? earliest : today, -TIMELINE_PADDING_DAYS);
  const end = addDays(latest > today ? latest : today, TIMELINE_PADDING_DAYS);
  const required = Math.max(1, daysBetween(start, end) + 1);
  const totalDays = Math.max(required, MINIMUM_TIMELINE_DAYS);
  const todayOffsetDays = daysBetween(start, today);
  const nonWorkingDays: number[] = [];
  // Non-working days are only shaded when the calendar is known: the shading is
  // decoration, the bars are the document.
  if (system) {
    for (let index = 0; index < totalDays; index += 1) {
      if (!resolveWorkingDay(addDays(start, index), projectCalendarId, system).isWorkingDay) nonWorkingDays.push(index);
    }
  }
  return {
    start,
    end: addDays(start, totalDays - 1),
    totalDays,
    todayOffsetDays: todayOffsetDays >= 0 && todayOffsetDays < totalDays ? todayOffsetDays : -1,
    nonWorkingDays,
  };
}

/** Builds everything the printed plan shows, straight from the planner's own fields. */
export function buildPlannerPdfModel(input: PlannerPdfInput): PlannerPdfModel {
  const allTasks = [...(input.tasks ?? [])];
  const ordered = orderTasksForDisplay(allTasks);
  const exportDate = input.exportDate;
  const today = input.today ?? input.exportDate;
  const system = input.system;
  const calendarId = input.projectCalendarId;
  const chart = buildChart(ordered, today, system, calendarId);

  const childrenOf = new Map<string, number>();
  for (const task of ordered) {
    const parent = task.parentId ?? null;
    if (parent) childrenOf.set(parent, (childrenOf.get(parent) ?? 0) + 1);
  }
  const isSummary = (task: PlannerTask) => (childrenOf.get(task.id) ?? 0) > 0;
  const isMilestone = (task: PlannerTask) => task.duration === 0 && !isSummary(task);

  const resourcesById = new Map((input.resources ?? []).map((resource) => [resource.id, resource.name]));
  const assigneesByTask = new Map<string, string[]>();
  for (const assignment of input.assignments ?? []) {
    if (!assignment?.taskId) continue;
    const name = resourcesById.get(assignment.resourceId);
    if (!name) continue;
    const list = assigneesByTask.get(assignment.taskId) ?? [];
    if (!list.includes(name)) list.push(name);
    assigneesByTask.set(assignment.taskId, list);
  }
  const baselineByTask = new Map((input.baselineTasks ?? []).map((snapshot) => [snapshot.taskId, snapshot]));

  const rows: PlannerPdfRow[] = ordered.map((task, index) => {
    const summary = isSummary(task);
    const milestone = isMilestone(task);
    const planned = Math.max(0, finite(task.marginDaysOriginal));
    const consumed = Math.min(planned, Math.max(0, finite(task.marginDaysConsumed)));
    const remaining = Math.max(0, planned - consumed);
    const consumedPct = percentOf(consumed, planned);
    // A reserve only exists on a leaf: a summary rolls its children up, so drawing
    // a zone for it would draw the same days twice. This mirrors the planner.
    const reserve = !summary && !milestone ? remainingMarginDays(task) : 0;
    const marginEnd = reserve > 0 && system ? addWorkingDays(task.finish, reserve, calendarId, system) : task.finish;
    const snapshot = baselineByTask.get(task.id);
    const depth = (() => {
      let count = 0;
      let current: PlannerTask | undefined = task;
      while (current?.parentId) {
        count += 1;
        current = ordered.find((candidate) => candidate.id === current?.parentId);
      }
      return count;
    })();

    return {
      id: task.id,
      wbs: wbsFor(task, ordered),
      name: task.name || "Untitled task",
      depth,
      isSummary: summary,
      isMilestone: milestone,
      isCritical: Boolean(task.isCritical),
      colorKey: task.color || "ochre",
      start: task.start,
      finish: task.finish,
      durationText: `${task.duration} ${task.durationUnit === "days" ? "d" : "w"}`,
      workText: milestone ? "\u2014" : `${finite(task.work)} h`,
      assigneeText: (assigneesByTask.get(task.id) ?? []).join(", ") || "\u2014",
      statusText: pdfTaskStatus(task),
      marginText: planned > 0 && consumedPct !== null
        ? `${consumedPct}% \u00b7 ${consumed} / ${planned} d`
        : "\u2014",
      marginPlannedDays: planned,
      marginConsumedDays: consumed,
      marginRemainingDays: remaining,
      barStartDay: chart ? daysBetween(chart.start, task.start) : 0,
      barDays: Math.max(1, daysBetween(task.start, task.finish) + 1),
      marginDays: reserve > 0 ? Math.max(0, daysBetween(task.finish, marginEnd)) : 0,
      progressPct: Math.min(100, Math.max(0, finite(task.percent))),
      baseline: chart && snapshot
        ? {
            startDay: daysBetween(chart.start, snapshot.startDate),
            days: Math.max(1, daysBetween(snapshot.startDate, snapshot.finishDate) + 1),
          }
        : null,
      rowIndex: index,
    };
  });

  const rowIndexById = new Map(rows.map((row) => [row.id, row]));
  const links: PlannerPdfLink[] = chart
    ? dependenciesForTasks(ordered).flatMap((dependency) => {
        const predecessor = rowIndexById.get(dependency.predecessorId);
        const successor = rowIndexById.get(dependency.successorId);
        if (!predecessor || !successor) return [];
        return [{
          predecessorId: dependency.predecessorId,
          successorId: dependency.successorId,
          type: dependency.type,
          lagDays: dependency.lagDays,
          // The link leaves the end of the predecessor's slot, margin zone included,
          // so a successor that starts after the reserve is drawn from where it may
          // actually start. Identical to the on-screen chart.
          fromDay: predecessor.barStartDay + predecessor.barDays + predecessor.marginDays,
          toDay: successor.barStartDay,
          predecessorRow: predecessor.rowIndex,
          successorRow: successor.rowIndex,
        }];
      })
    : [];

  // Leaf-only, through the margin report's own functions: the printed total can
  // never disagree with the planner chip or the margin report.
  const marginTotals = leafMarginTotals(marginRowsFor(allTasks));
  const criticalCount = rows.filter((row) => row.isCritical).length;
  const milestoneCount = rows.filter((row) => row.isMilestone).length;
  const marginLine = marginTotals.planned > 0
    ? `Margin: ${marginTotals.planned} d planned, ${marginTotals.consumed} d consumed (${marginTotals.consumedPct ?? 0}%), ${marginTotals.remaining} d remaining`
    : "Margin: none defined";
  const modeLabel = input.mode === "planning" ? "Planning" : "Monitoring";
  const baselineName = (input.baselineName ?? "").trim();

  return {
    fileName: plannerPdfFileName(input.projectName, input.versionName, exportDate),
    meta: {
      projectName: input.projectName || "Untitled project",
      client: (input.client ?? "").trim(),
      versionName: input.versionName || "Plan version",
      mode: input.mode,
      modeLabel,
      baselineName,
      baselineLine: baselineName ? `Yes - ${baselineName}` : "No",
      exportDate,
      exportDateLabel: formatPdfDate(exportDate),
      summaryLine: `${rows.length} task${rows.length === 1 ? "" : "s"} \u00b7 ${criticalCount} critical${criticalCount > 0 ? " (*)" : ""} \u00b7 ${milestoneCount} milestone${milestoneCount === 1 ? "" : "s"} \u00b7 ${marginLine}`,
      marginPlannedDays: marginTotals.planned,
      marginConsumedDays: marginTotals.consumed,
      marginRemainingDays: marginTotals.remaining,
      taskCount: rows.length,
      criticalCount,
      milestoneCount,
    },
    rows,
    links,
    chart,
    legend: [
      { key: "critical", label: "Critical path" },
      { key: "summary", label: "Summary bar" },
      { key: "milestone", label: "Milestone" },
      { key: "margin", label: "Margin zone" },
      { key: "baseline", label: "Baseline" },
      { key: "progress", label: "% complete" },
    ],
    empty: rows.length === 0,
  };
}
