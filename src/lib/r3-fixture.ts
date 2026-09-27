import type { PlannerTask } from "./planner-model";

/**
 * The R3 test scenario, kept as pure data so the seed (a Convex mutation) and
 * its tests share one source of truth. Everything here is deterministic: the
 * same input always produces the same ids, dates and working-day offsets.
 */

export type R3Task = PlannerTask & { isMilestone: boolean; projectId: string; sortOrder: number };

export interface R3ResourceSeed {
  id: string;
  calendarId: string;
  name: string;
  colour: string;
  hoursPerWeek: number;
  /** Weekday numbers: 1 = Monday … 7/none = Sunday, same as the calendar model. */
  workingDays: number[];
}

export const R3_SEED_KEY = "TP-R3";

/** Anna 40 h Mon–Fri, Bram 20 h Mon–Thu (Friday off), Chris 40 h Mon–Fri. */
export const R3_RESOURCES: R3ResourceSeed[] = [
  { id: "res-r3-anna", calendarId: "cal-r3-anna", name: "Anna", colour: "#75856c", hoursPerWeek: 40, workingDays: [1, 2, 3, 4, 5] },
  { id: "res-r3-bram", calendarId: "cal-r3-bram", name: "Bram", colour: "#ad6650", hoursPerWeek: 20, workingDays: [1, 2, 3, 4] },
  { id: "res-r3-chris", calendarId: "cal-r3-chris", name: "Chris", colour: "#566b6b", hoursPerWeek: 40, workingDays: [1, 2, 3, 4, 5] },
];

/** Chris is away 12–16 October 2026 (availability only — it never moves a task). */
export const R3_CHRIS_LEAVE = {
  id: "exc-r3-chris-leave",
  calendarId: "cal-r3-chris",
  startDate: "2026-10-12",
  endDate: "2026-10-16",
  label: "holiday leave",
};

/**
 * TP-R3-A: one summary with three tasks. `p` is the id prefix — `r3a` for the
 * project, `t3a` for its template — so a template's rows reference their own ids
 * the same way the live project does. Working-day offsets are relative to the
 * template anchor (Mon 5 Oct 2026).
 */
export const r3TasksA = (projectId: string, versionId: string, p: string): R3Task[] => [
  { id: `${p}s`, projectId, parentId: null, sortOrder: 0, name: "Uitvoering", duration: 29, durationUnit: "days", start: "2026-10-05", finish: "2026-11-12", startOffsetDays: 0, finishOffsetDays: 28, isMilestone: false, predecessors: "", resource: "", percent: 0, notes: "", color: "ochre", collapsed: false, versionId, marginPct: 0, marginDaysOriginal: 0, marginDaysConsumed: 0, work: 0, distribution: "even" },
  { id: `${p}1`, projectId, parentId: `${p}s`, sortOrder: 1, name: "Ontwerp", duration: 20, durationUnit: "days", start: "2026-10-05", finish: "2026-10-30", startOffsetDays: 0, finishOffsetDays: 19, isMilestone: false, predecessors: "", resource: "", percent: 0, notes: "", color: "sage", collapsed: false, versionId, marginPct: 0, marginDaysOriginal: 0, marginDaysConsumed: 0, work: 40, distribution: "even" },
  { id: `${p}2`, projectId, parentId: `${p}s`, sortOrder: 2, name: "Opbouw", duration: 5, durationUnit: "days", start: "2026-11-02", finish: "2026-11-06", startOffsetDays: 20, finishOffsetDays: 24, isMilestone: false, predecessors: `${p}1FS`, resource: "", percent: 0, notes: "", color: "clay", collapsed: false, versionId, marginPct: 0, marginDaysOriginal: 0, marginDaysConsumed: 0, work: 40, distribution: "front" },
  { id: `${p}3`, projectId, parentId: `${p}s`, sortOrder: 3, name: "Nazicht", duration: 4, durationUnit: "days", start: "2026-11-09", finish: "2026-11-12", startOffsetDays: 25, finishOffsetDays: 28, isMilestone: false, predecessors: `${p}2FS`, resource: "", percent: 0, notes: "", color: "ink", collapsed: false, versionId, marginPct: 0, marginDaysOriginal: 0, marginDaysConsumed: 0, work: 32, distribution: "even" },
];

/** TP-R3-B: one summary holding the single 15-day task, so Analyse is WBS 1.1. */
export const r3TasksB = (projectId: string, versionId: string, p: string): R3Task[] => [
  { id: `${p}s`, projectId, parentId: null, sortOrder: 0, name: "Analysefase", duration: 15, durationUnit: "days", start: "2026-10-05", finish: "2026-10-23", startOffsetDays: 0, finishOffsetDays: 14, isMilestone: false, predecessors: "", resource: "", percent: 0, notes: "", color: "ochre", collapsed: false, versionId, marginPct: 0, marginDaysOriginal: 0, marginDaysConsumed: 0, work: 0, distribution: "even" },
  { id: `${p}1`, projectId, parentId: `${p}s`, sortOrder: 1, name: "Analyse", duration: 15, durationUnit: "days", start: "2026-10-05", finish: "2026-10-23", startOffsetDays: 0, finishOffsetDays: 14, isMilestone: false, predecessors: "", resource: "", percent: 0, notes: "", color: "sage", collapsed: false, versionId, marginPct: 0, marginDaysOriginal: 0, marginDaysConsumed: 0, work: 300, distribution: "even" },
];

export const r3AssignmentsA = (p: string) => [
  { id: `${p}-as-1`, taskId: `${p}1`, resourceId: "res-r3-anna" },
  { id: `${p}-as-2`, taskId: `${p}2`, resourceId: "res-r3-bram" },
  { id: `${p}-as-3`, taskId: `${p}3`, resourceId: "res-r3-chris" },
];

/** Anna is on both projects at once on purpose: the step-5 overload is the test. */
export const r3AssignmentsB = (p: string) => [{ id: `${p}-as-1`, taskId: `${p}1`, resourceId: "res-r3-anna" }];

export const r3DependenciesA = (projectId: string, p: string) => [
  { id: `${p}-dep-1-2`, projectId, predecessorId: `${p}1`, successorId: `${p}2`, type: "FS", lagDays: 0 },
  { id: `${p}-dep-2-3`, projectId, predecessorId: `${p}2`, successorId: `${p}3`, type: "FS", lagDays: 0 },
];

export const r3DependenciesB = (_projectId: string, _p: string) => [] as ReturnType<typeof r3DependenciesA>;

export interface R3ProjectPair {
  name: string;
  projectId: string;
  templateId: string;
  prefix: string;
  templatePrefix: string;
  tasks: (projectId: string, versionId: string, p: string) => R3Task[];
  assignments: (p: string) => { id: string; taskId: string; resourceId: string }[];
  dependencies: (projectId: string, p: string) => { id: string; projectId: string; predecessorId: string; successorId: string; type: string; lagDays: number }[];
}

export const R3_PROJECTS: R3ProjectPair[] = [
  { name: "TP-R3-A", projectId: "proj-tp-r3-a", templateId: "tpl-tp-r3-a", prefix: "r3a", templatePrefix: "t3a", tasks: r3TasksA, assignments: r3AssignmentsA, dependencies: r3DependenciesA },
  { name: "TP-R3-B", projectId: "proj-tp-r3-b", templateId: "tpl-tp-r3-b", prefix: "r3b", templatePrefix: "t3b", tasks: r3TasksB, assignments: r3AssignmentsB, dependencies: r3DependenciesB },
];
