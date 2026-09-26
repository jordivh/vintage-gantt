import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  belgianPublicHolidays,
  calendarChain,
  type CalendarException,
  type CalendarExceptionSource,
  type CalendarExceptionType,
  type CalendarSystem,
  type CalendarType,
  type PlannerCalendar,
  type Weekday,
} from "./scheduling-engine";
import { applyPlanningModeMargins, applyReplanMargins, dependenciesForTasks, planFinishDate, recalculateTasks, replanScopeIds, withCalculatedPlanningFields, type PlannerTask, type PlanMode, type ReplanScope } from "./planner-model";
import type { PlanningDirection } from "./scheduling-engine";
import { api } from "@/convex/_generated/api";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { toast } from "sonner";

export type ProjectStatus = "active" | "archived" | "template";
export interface ProjectRecord {
  id: string;
  name: string;
  /** Required: every project is planned on a calendar. */
  calendarId: string;
  status: ProjectStatus;
  startDate: string;
  schedulingDirection: PlanningDirection;
  createdAt: string;
  updatedAt: string;
  seedKey?: string;
  kind?: "project" | "template";
  isBuiltin?: boolean;
  hidden?: boolean;
}

export type LeaveType = "holiday leave" | "sick leave" | "training" | "other";
export interface ResourceRecord {
  id: string;
  name: string;
  role: string;
  email: string;
  colour: string;
  hoursPerWeek: number;
  isActive: boolean;
  calendarId: string;
}
export interface TaskAssignment { id: string; taskId: string; resourceId: string; }
export interface ModeSwitch { at: string; from: PlanMode; to: PlanMode; }
/** A timestamped entry in a version's history: a mode switch or a baseline capture. */
export interface VersionEvent { at: string; type: "mode-switch" | "baseline"; from?: PlanMode; to?: PlanMode; baselineId?: string; name?: string; }
export interface PlanVersion { id: string; projectId: string; name: string; isActive: boolean; createdAt: string; mode?: PlanMode; history?: VersionEvent[]; modeHistory?: ModeSwitch[]; }
export interface Baseline { id: string; projectId: string; versionId: string; name: string; note?: string; createdAt: string; captureDate?: string; }
export interface BaselineTask { id: string; baselineId: string; taskId: string; startDate: string; finishDate: string; durationDays: number; marginPct: number; marginDaysOriginal: number; marginDaysConsumed: number; predecessors?: string; totalFloat?: number; }

export const CALENDAR_TYPE_LABELS: Record<CalendarType, string> = {
  base: "Base",
  project: "Project",
  person: "Person",
};

export const EXCEPTION_TYPE_ORDER: CalendarExceptionType[] = [
  "holiday",
  "shutdown",
  "leave",
  "extra-working",
];

export const EXCEPTION_IS_WORKING: Record<CalendarExceptionType, boolean> = {
  holiday: false,
  shutdown: false,
  leave: false,
  "extra-working": true,
};

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 10);

/* ------------------------------------------------------------------ identifiers */

export const BASE_CALENDAR_ID = "cal-base-belgium";

/* ------------------------------------------- pure calendar-system builders */

export function makeException(input: {
  calendarId: string;
  startDate: string;
  endDate: string;
  label: string;
  type: CalendarExceptionType;
  source?: CalendarExceptionSource;
}): CalendarException {
  const [from, to] =
    input.startDate <= input.endDate ? [input.startDate, input.endDate] : [input.endDate, input.startDate];
  return {
    id: `exc-${uid()}`,
    calendarId: input.calendarId,
    startDate: from,
    endDate: to,
    label: input.label.trim(),
    type: input.type,
    isWorkingDay: EXCEPTION_IS_WORKING[input.type],
    source: input.source ?? "manual",
  };
}

export function withExceptionAdded(system: CalendarSystem, exception: CalendarException): CalendarSystem {
  return { ...system, exceptions: [...system.exceptions, exception] };
}

export function withExceptionRemoved(system: CalendarSystem, id: string): CalendarSystem {
  return { ...system, exceptions: system.exceptions.filter((exception) => exception.id !== id) };
}

export function withWorkingDays(system: CalendarSystem, calendarId: string, workingDays: Weekday[]): CalendarSystem {
  return {
    ...system,
    calendars: system.calendars.map((calendar) =>
      calendar.id === calendarId ? { ...calendar, workingDays } : calendar,
    ),
  };
}

export function withBelgianHolidays(system: CalendarSystem, year: number, calendarId = BASE_CALENDAR_ID): CalendarSystem {
  const existing = new Set(
    system.exceptions.filter((exception) => exception.calendarId === calendarId).map((exception) => exception.startDate),
  );
  const additions = belgianPublicHolidays(year)
    .filter((holiday) => !existing.has(holiday.date))
    .map((holiday) =>
      makeException({
        calendarId,
        startDate: holiday.date,
        endDate: holiday.date,
        label: holiday.label,
        type: "holiday",
        source: "import",
      }),
    );
  if (!additions.length) return system;
  return { ...system, exceptions: [...system.exceptions, ...additions] };
}

export function missingBelgianHolidays(system: CalendarSystem, year: number, calendarId = BASE_CALENDAR_ID) {
  const existing = new Set(
    system.exceptions.filter((exception) => exception.calendarId === calendarId).map((exception) => exception.startDate),
  );
  return belgianPublicHolidays(year).filter((holiday) => !existing.has(holiday.date)).length;
}

/* ------------------------------------------------------------------ store */

export interface ImpactCount {
  projects: number;
  tasks: number;
}

interface CalendarStoreValue {
  system: CalendarSystem;
  projects: ProjectRecord[];
  activeProject: ProjectRecord;
  activeProjectId: string;
  setActiveProject: (projectId: string) => void;
  tasks: PlannerTask[];
  projectTasks: (projectId: string) => PlannerTask[];
  /** `useState`-compatible setter for the active project's tasks. */
  setTasks: (updater: PlannerTask[] | ((prev: PlannerTask[]) => PlannerTask[])) => void;
  setProjectCalendar: (projectId: string, calendarId: string, nextSystem?: CalendarSystem) => void;
  createProject: (input: { name: string; startDate: string; schedulingDirection: PlanningDirection; calendarId: string }) => string;
  createProjectFromTemplate: (input: { templateId: string | null; name: string; startDate: string; calendarId: string; schedulingDirection: PlanningDirection; includeAssignments?: boolean }) => Promise<{ id: string; skippedAssignments: number }>;
  saveAsTemplate: (projectId: string, versionId: string, name: string) => Promise<void>;
  setTemplateHidden: (templateId: string, hidden: boolean) => Promise<void>;
  deleteTemplate: (templateId: string) => Promise<void>;
  renameProject: (projectId: string, name: string) => void;
  duplicateProject: (projectId: string, name: string) => string;
  archiveProject: (projectId: string) => void;
  deleteProject: (projectId: string) => { ok: boolean; taskCount: number };
  calendarsUsingProjects: (calendarId: string) => ProjectRecord[];
  projectsAffectedBy: (calendarId: string) => ProjectRecord[];
  previewCalendarChange: (nextSystem: CalendarSystem, changedCalendarId: string) => ImpactCount;
  previewProjectRelink: (projectId: string, calendarId: string) => ImpactCount;
  resources: ResourceRecord[];
  assignments: TaskAssignment[];
  updateResource: (id: string, patch: Partial<ResourceRecord>) => void;
  updateResourceSchedule: (id: string, workingDays: Weekday[]) => void;
  createResource: (input: Omit<ResourceRecord, "id" | "calendarId">) => ResourceRecord;
  setTaskAssignments: (taskId: string, resourceIds: string[]) => void;
  addResourceLeave: (resourceId: string, input: { startDate: string; endDate: string; type: LeaveType; note?: string }) => void;
  removeResourceLeave: (exceptionId: string) => void;
  resourceLeave: (resourceId: string) => CalendarException[];
  /** Applies a new calendar system and immediately re-plans every affected project. */
  applyCalendarSystem: (nextSystem: CalendarSystem) => void;
  createCalendar: (input: { name: string; type: CalendarType; parentCalendarId: string | null; workingDays?: Weekday[] }) => string | null;
  duplicateCalendar: (id: string) => string;
  renameCalendar: (id: string, name: string) => void;
  deleteCalendar: (id: string) => { ok: boolean; message?: string };
  planVersions: PlanVersion[];
  baselines: Baseline[];
  baselineTasks: BaselineTask[];
  createBaseline: (name: string, note?: string, captureDate?: string) => string;
  deleteBaseline: (baselineId: string) => void;
  activeVersionId: string;
  setActiveVersion: (versionId: string) => void;
  /**
   * Switches a version between Planning and Monitoring. Monitoring requires a
   * baseline on that version, and a version can never go back to Planning —
   * that happens by creating a new version (Replan). Every switch is timestamped
   * in the version's history.
   */
  setPlanMode: (versionId: string, mode: PlanMode) => { ok: boolean; message?: string };
  createPlanVersion: (name: string) => string;
  /**
   * Builds fresh reserve for the remaining work: always creates a new plan
   * version, leaving the current one untouched, then applies the new margin
   * percentage to the tasks in scope and resets their consumed margin. Returns
   * the new version id, how many tasks were affected and the finish it plans.
   */
  replanProject: (input: { name: string; scope: ReplanScope; selectedTaskIds?: string[]; marginPct: number }) => { versionId: string; affected: number; finish: string };
  deletePlanVersion: (versionId: string) => { ok: boolean; message?: string };
}

const CalendarStoreContext = createContext<CalendarStoreValue | null>(null);

function recalculateProjects(
  current: Record<string, PlannerTask[]>,
  projectList: ProjectRecord[],
  system: CalendarSystem,
): Record<string, PlannerTask[]> {
  const next: Record<string, PlannerTask[]> = { ...current };
  for (const project of projectList) {
    if ((project.kind ?? (project.status === "template" ? "template" : "project")) !== "project") continue;
    const tasks = current[project.id];
    if (!tasks?.length) continue;
    const result = recalculateTasks(tasks, {
      direction: "forward",
      calendarSystem: system,
      projectCalendarId: project.calendarId,
    });
    if (!result.error) next[project.id] = withCalculatedPlanningFields(result.tasks, system, project.calendarId);
  }
  return next;
}

export function CalendarStoreProvider({ children }: { children: ReactNode }) {
  const [system, setSystem] = useState<CalendarSystem>({ calendars: [], exceptions: [], defaultCalendarId: "" });
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [resources, setResources] = useState<ResourceRecord[]>([]);
  const [assignments, setAssignments] = useState<TaskAssignment[]>([]);
  const [tasksByProject, setTasksByProject] = useState<Record<string, PlannerTask[]>>({});
  const [activeProjectId, setActiveProjectId] = useState("");
  const [activeVersionId, setActiveVersionId] = useState("");
  const [planVersions, setPlanVersions] = useState<PlanVersion[]>([]);
  const [baselines, setBaselines] = useState<Baseline[]>([]);
  const [baselineTasks, setBaselineTasks] = useState<BaselineTask[]>([]);

  const { isAuthenticated } = useConvexAuth();
  const remoteState = useQuery(api.planner.getState, isAuthenticated ? {} : "skip");
  const initializeWorkspace = useMutation(api.planner.initializeWorkspace);
  const ensureTestProject = useMutation(api.planner.ensureTestProject);
  const createProjectFromTemplateRemote = useMutation(api.planner.createProjectFromTemplate);
  const saveAsTemplateRemote = useMutation(api.planner.saveAsTemplate);
  const setTemplateHiddenRemote = useMutation(api.planner.hideTemplate);
  const deleteTemplateRemote = useMutation(api.planner.deleteTemplate);
  const replaceRemoteState = useMutation(api.planner.replaceState);
  const hydratedRef = useRef(false);
  const migrationStartedRef = useRef(false);
  const seedStartedRef = useRef(false);
  const suppressSaveRef = useRef(false);
  const lastServerStateRef = useRef<unknown>(null);

  useEffect(() => {
    if (!isAuthenticated || remoteState === undefined || hydratedRef.current || migrationStartedRef.current) return;
    if (remoteState === null) {
      migrationStartedRef.current = true;
      let legacy: Record<string, unknown> | null = null;
      try {
        const raw = localStorage.getItem("vintage-gantt-calendar-state");
        legacy = raw ? JSON.parse(raw) as Record<string, unknown> : null;
      } catch { legacy = null; }
      const legacySystem = legacy?.system as CalendarSystem | undefined;
      const legacyProjects = legacy?.projects as ProjectRecord[] | undefined;
      const legacyTasksByProject = legacy?.tasksByProject as Record<string, PlannerTask[]> | undefined;
      const migration = legacySystem && legacyProjects ? {
        projects: legacyProjects,
        tasks: Object.entries(legacyTasksByProject ?? {}).flatMap(([projectId, rows]) => rows.map((task, index) => ({ ...task, projectId, sortOrder: index }))),
        dependencies: Object.entries(legacyTasksByProject ?? {}).flatMap(([projectId, rows]) => dependenciesForTasks(rows).map((dependency, index) => ({ ...dependency, id: `dep-${projectId}-${index}`, projectId }))),
        calendars: legacySystem.calendars,
        exceptions: legacySystem.exceptions,
        resources: (legacy?.resources as ResourceRecord[] | undefined) ?? [],
        assignments: (legacy?.assignments as TaskAssignment[] | undefined) ?? [],
        planVersions: legacyProjects.map((project) => ({ id: `version-${project.id}-1`, projectId: project.id, name: "Versie 1", isActive: true, createdAt: new Date().toISOString(), mode: "planning" as PlanMode })),
      } : null;
      const finish = migration ? replaceRemoteState({ state: migration }) : initializeWorkspace({});
      void finish.then(() => ensureTestProject({})).then(() => {
        try { localStorage.removeItem("vintage-gantt-calendar-state"); } catch { /* migration cleanup is best effort */ }
      }).catch(() => {
        migrationStartedRef.current = false;
        toast.error("Could not connect to the central planner database. Your changes were not saved.");
      });
      return;
    }
    suppressSaveRef.current = true;
    const state = remoteState as { projects: ProjectRecord[]; tasks: Array<PlannerTask & { projectId: string }>; calendars: PlannerCalendar[]; exceptions: CalendarException[]; resources: ResourceRecord[]; assignments: TaskAssignment[]; planVersions?: PlanVersion[]; baselines?: Baseline[]; baselineTasks?: BaselineTask[] };
    const grouped: Record<string, PlannerTask[]> = {};
    const rawVersions: PlanVersion[] = (state.planVersions as PlanVersion[] | undefined) ?? (state.projects ?? []).map((project) => ({ id: `version-${project.id}-1`, projectId: project.id, name: "Versie 1", isActive: true, createdAt: project.createdAt }));
    // Versions saved before modes existed behave as the versions they were: planned.
    const versions: PlanVersion[] = rawVersions.map((version) => {
      // Versions saved before the history log existed keep their mode switches.
      const legacyHistory: VersionEvent[] = (version.modeHistory ?? []).map((entry) => ({ at: entry.at, type: "mode-switch", from: entry.from, to: entry.to }));
      return { ...version, mode: (version.mode ?? "planning") as PlanMode, history: version.history ?? legacyHistory, modeHistory: version.modeHistory ?? [] };
    });
    for (const task of state.tasks ?? []) {
      const versionId = task.versionId ?? versions.find((version) => version.projectId === task.projectId && version.isActive)?.id ?? `version-${task.projectId}-1`;
      (grouped[task.projectId] ??= []).push({ ...task, versionId });
    }
    setProjects(state.projects ?? []);
    setSystem({ calendars: state.calendars ?? [], exceptions: state.exceptions ?? [], defaultCalendarId: state.calendars?.find((calendar) => calendar.isDefault)?.id ?? "" });
    setResources(state.resources ?? []);
    setAssignments(state.assignments ?? []);
    setPlanVersions(versions);
    setActiveVersionId((current) => versions.some((version) => version.id === current && version.projectId === activeProjectId) ? current : versions.find((version) => version.projectId === activeProjectId && version.isActive)?.id ?? versions.find((version) => version.projectId === activeProjectId)?.id ?? "");
    setBaselines(state.baselines ?? []);
    setBaselineTasks(state.baselineTasks ?? []);
    setTasksByProject(grouped);
    const isRegularProject = (project: ProjectRecord) => (project.kind ?? (project.status === "template" ? "template" : "project")) === "project";
    const fallback = (state.projects ?? []).filter((project) => project.status === "active" && isRegularProject(project)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? (state.projects ?? []).find((project) => project.status !== "archived" && isRegularProject(project));
    setActiveProjectId((current) => (state.projects ?? []).some((project) => project.id === current && project.status !== "archived" && (project.kind ?? (project.status === "template" ? "template" : "project")) === "project") ? current : fallback?.id ?? "");
    hydratedRef.current = true;
    lastServerStateRef.current = remoteState;
  }, [isAuthenticated, remoteState, initializeWorkspace, replaceRemoteState]);

  useEffect(() => {
    if (!isAuthenticated || remoteState === undefined || remoteState === null || seedStartedRef.current) return;
    seedStartedRef.current = true;
    void ensureTestProject({}).then((result) => {
      if (result === true) hydratedRef.current = false;
    }).catch(() => {
      seedStartedRef.current = false;
      toast.error("Could not prepare the server-side test project.");
    });
  }, [isAuthenticated, remoteState, ensureTestProject]);

  useEffect(() => {
    if (!isAuthenticated || !hydratedRef.current) return;
    if (suppressSaveRef.current) { suppressSaveRef.current = false; return; }
    const state = {
      projects,
      tasks: Object.entries(tasksByProject).flatMap(([projectId, rows]) => rows.map((task, index) => ({ ...task, projectId, sortOrder: index }))),
      dependencies: Object.entries(tasksByProject).flatMap(([projectId, rows]) => dependenciesForTasks(rows).map((dependency, index) => ({ ...dependency, id: `dep-${projectId}-${index}`, projectId }))),
      calendars: system.calendars,
      exceptions: system.exceptions,
      resources,
      assignments,
      planVersions,
      baselines,
      baselineTasks,
    };
    void replaceRemoteState({ state }).then(() => { lastServerStateRef.current = state; }).catch(() => {
      toast.error("Could not save to the central planner database. The last saved data was restored.");
      const previous = lastServerStateRef.current as typeof state | null;
      if (!previous) return;
      suppressSaveRef.current = true;
      setProjects(previous.projects);
      setSystem({ calendars: previous.calendars, exceptions: previous.exceptions, defaultCalendarId: previous.calendars.find((calendar) => calendar.isDefault)?.id ?? "" });
      setResources(previous.resources);
      setAssignments(previous.assignments);
      const restored: Record<string, PlannerTask[]> = {};
      for (const task of previous.tasks) (restored[task.projectId] ??= []).push(task);
      setTasksByProject(restored);
      setPlanVersions(previous.planVersions ?? []);
      setBaselines(previous.baselines ?? []);
      setBaselineTasks(previous.baselineTasks ?? []);
    });
  }, [isAuthenticated, projects, system, resources, assignments, tasksByProject, planVersions, baselines, baselineTasks, replaceRemoteState]);
  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId && (project.kind ?? (project.status === "template" ? "template" : "project")) === "project") ?? projects.find((project) => (project.kind ?? (project.status === "template" ? "template" : "project")) === "project") ?? {
      id: "",
      name: "No project selected",
      calendarId: system.defaultCalendarId,
      status: "active" as ProjectStatus,
      startDate: "",
      schedulingDirection: "forward" as PlanningDirection,
      createdAt: "",
      updatedAt: "",
    },
    [projects, activeProjectId, system.defaultCalendarId],
  );
  const tasks = (tasksByProject[activeProjectId] ?? []).filter((task) => !task.versionId || task.versionId === activeVersionId);
  const projectTasks = useCallback((projectId: string) => {
    const versionId = planVersions.find((version) => version.projectId === projectId && version.isActive)?.id;
    return (tasksByProject[projectId] ?? []).filter((task) => !task.versionId || !versionId || task.versionId === versionId);
  }, [tasksByProject, planVersions]);

  const setActiveVersion = useCallback((versionId: string) => {
    if (!planVersions.some((version) => version.id === versionId && version.projectId === activeProjectId)) return;
    setActiveVersionId(versionId);
    setPlanVersions((current) => current.map((version) => version.projectId === activeProjectId ? { ...version, isActive: version.id === versionId } : version));
  }, [activeProjectId, planVersions]);

  const setPlanMode = useCallback<CalendarStoreValue["setPlanMode"]>((versionId, mode) => {
    const version = planVersions.find((item) => item.id === versionId && item.projectId === activeProjectId);
    if (!version) return { ok: false, message: "Plan version not found." };
    const from: PlanMode = version.mode ?? "planning";
    if (from === mode) return { ok: true };
    if (mode === "monitoring" && !baselines.some((baseline) => baseline.versionId === versionId)) {
      return { ok: false, message: "Monitoring needs a baseline. Set a baseline on this version first." };
    }
    if (mode === "planning") {
      return { ok: false, message: "A version cannot go back to Planning. Create a new version (Replan) instead." };
    }
    const at = new Date().toISOString();
    setPlanVersions((current) => current.map((item) => item.id === versionId
      ? {
          ...item,
          mode,
          modeHistory: [...(item.modeHistory ?? []), { at, from, to: mode }],
          history: [...(item.history ?? []), { at, type: "mode-switch" as const, from, to: mode }],
        }
      : item));
    return { ok: true };
  }, [activeProjectId, planVersions, baselines]);

  const createPlanVersion = useCallback((name: string) => {
    const source = (tasksByProject[activeProjectId] ?? []).filter((task) => !task.versionId || task.versionId === activeVersionId);
    const id = `version-${uid()}`;
    // A new version always starts out being planned: consumed margin resets and
    // the reserve in days is re-derived from each percentage.
    const version: PlanVersion = { id, projectId: activeProjectId, name: name.trim() || `Version ${planVersions.filter((item) => item.projectId === activeProjectId).length + 1}`, isActive: true, createdAt: new Date().toISOString(), mode: "planning", modeHistory: [] };
    const idMap = new Map(source.map((task) => [task.id, `task-${uid()}`]));
    const copied = applyPlanningModeMargins(source.map((task) => ({
      ...task,
      id: idMap.get(task.id) ?? `task-${uid()}`,
      parentId: task.parentId ? idMap.get(task.parentId) ?? null : null,
      predecessors: task.predecessors.split(",").map((part) => {
        const match = part.trim().match(/^(\d+)(.*)$/);
        if (!match) return part.trim();
        return `${idMap.get(match[1]) ?? match[1]}${match[2]}`;
      }).filter(Boolean).join(", "),
      versionId: id,
    })));
    const sourceTaskIds = new Set(source.map((task) => task.id));
    const copiedAssignments = assignments
      .filter((assignment) => sourceTaskIds.has(assignment.taskId))
      .map((assignment) => ({ ...assignment, id: `as-${uid()}`, taskId: idMap.get(assignment.taskId) ?? assignment.taskId }));
    setPlanVersions((current) => [...current.map((item) => item.projectId === activeProjectId ? { ...item, isActive: false } : item), version]);
    setTasksByProject((current) => ({ ...current, [activeProjectId]: [...(current[activeProjectId] ?? []), ...copied] }));
    setAssignments((current) => [...current, ...copiedAssignments]);
    setActiveVersionId(id);
    return id;
  }, [activeProjectId, activeVersionId, assignments, planVersions, tasksByProject]);

  const replanProject = useCallback<CalendarStoreValue["replanProject"]>((input) => {
    const source = (tasksByProject[activeProjectId] ?? []).filter((task) => !task.versionId || task.versionId === activeVersionId);
    const id = `version-${uid()}`;
    const affected = replanScopeIds(source, input).size;
    const margined = applyReplanMargins(source, input);
    const version: PlanVersion = { id, projectId: activeProjectId, name: input.name.trim() || `Replan ${input.marginPct}%`, isActive: true, createdAt: new Date().toISOString(), mode: "planning", modeHistory: [] };
    const idMap = new Map(source.map((task) => [task.id, `task-${uid()}`]));
    const rewritePredecessors = (text: string) => text.split(",").map((part) => {
      const match = part.trim().match(/^(\d+)(.*)$/);
      if (!match) return part.trim();
      return `${idMap.get(match[1]) ?? match[1]}${match[2]}`;
    }).filter(Boolean).join(", ");
    const copied = margined.map((task) => ({
      ...task,
      id: idMap.get(task.id) ?? `task-${uid()}`,
      parentId: task.parentId ? idMap.get(task.parentId) ?? null : null,
      predecessors: rewritePredecessors(task.predecessors),
      versionId: id,
    }));
    const result = recalculateTasks(copied, {
      direction: "forward",
      calendarSystem: system,
      projectCalendarId: activeProject.calendarId,
    });
    const scheduled = result.error ? copied : withCalculatedPlanningFields(result.tasks, system, activeProject.calendarId);
    const sourceTaskIds = new Set(source.map((task) => task.id));
    const copiedAssignments = assignments
      .filter((assignment) => sourceTaskIds.has(assignment.taskId))
      .map((assignment) => ({ ...assignment, id: `as-${uid()}`, taskId: idMap.get(assignment.taskId) ?? assignment.taskId }));
    setPlanVersions((current) => [...current.map((item) => item.projectId === activeProjectId ? { ...item, isActive: false } : item), version]);
    setTasksByProject((current) => ({ ...current, [activeProjectId]: [...(current[activeProjectId] ?? []), ...scheduled] }));
    setAssignments((current) => [...current, ...copiedAssignments]);
    setActiveVersionId(id);
    return { versionId: id, affected, finish: planFinishDate(scheduled) };
  }, [activeProjectId, activeVersionId, assignments, tasksByProject, system, activeProject.calendarId]);

  const deletePlanVersion = useCallback<CalendarStoreValue["deletePlanVersion"]>((versionId) => {
    const versions = planVersions.filter((version) => version.projectId === activeProjectId);
    if (versions.length <= 1) return { ok: false, message: "A project must keep at least one plan version." };
    const target = versions.find((version) => version.id === versionId);
    if (!target) return { ok: false, message: "Plan version not found." };
    const fallback = versions.find((version) => version.id !== versionId);
    const removedTaskIds = new Set((tasksByProject[activeProjectId] ?? []).filter((task) => task.versionId === versionId).map((task) => task.id));
    setTasksByProject((current) => ({ ...current, [activeProjectId]: (current[activeProjectId] ?? []).filter((task) => task.versionId !== versionId) }));
    setAssignments((current) => current.filter((assignment) => !removedTaskIds.has(assignment.taskId)));
    setPlanVersions((current) => current.filter((version) => version.id !== versionId).map((version) => version.id === fallback?.id ? { ...version, isActive: true } : version));
    if (activeVersionId === versionId && fallback) setActiveVersionId(fallback.id);
    return { ok: true };
  }, [activeProjectId, activeVersionId, assignments, planVersions, tasksByProject]);

  useEffect(() => {
    const version = planVersions.find((item) => item.projectId === activeProjectId && item.isActive) ?? planVersions.find((item) => item.projectId === activeProjectId);
    if (version && version.id !== activeVersionId) setActiveVersionId(version.id);
  }, [activeProjectId, planVersions, activeVersionId]);

  const createBaseline = useCallback<CalendarStoreValue["createBaseline"]>((name, note, captureDate) => {
    const version = planVersions.find((item) => item.projectId === activeProjectId && item.isActive) ?? planVersions.find((item) => item.projectId === activeProjectId);
    const versionId = version?.id ?? activeVersionId;
    const id = `baseline-${uid()}`;
    const at = new Date().toISOString();
    const baseline: Baseline = { id, projectId: activeProjectId, versionId, name: name.trim() || "Baseline", note, createdAt: at, captureDate: captureDate || at.slice(0, 10) };
    // A full, immutable snapshot of the version: dates, work, dependencies,
    // margin percentage, reserve in days and consumption.
    const snapshots: BaselineTask[] = (tasksByProject[activeProjectId] ?? []).filter((task) => !task.versionId || task.versionId === versionId).map((task) => ({ id: `baseline-task-${uid()}`, baselineId: id, taskId: task.id, startDate: task.start, finishDate: task.finish, durationDays: task.duration, marginPct: task.marginPct ?? 0, marginDaysOriginal: task.marginDaysOriginal ?? 0, marginDaysConsumed: task.marginDaysConsumed ?? 0, predecessors: task.predecessors, totalFloat: task.totalFloat ?? 0 }));
    setBaselines((current) => [...current, baseline]);
    setBaselineTasks((current) => [...current, ...snapshots]);
    // Capture is part of the version's history, timestamped like a mode switch.
    setPlanVersions((current) => current.map((item) => item.id === versionId
      ? { ...item, history: [...(item.history ?? []), { at, type: "baseline" as const, baselineId: id, name: baseline.name }] }
      : item));
    return id;
  }, [activeProjectId, activeVersionId, planVersions, tasksByProject]);

  const deleteBaseline = useCallback((baselineId: string) => {
    setBaselines((current) => current.filter((baseline) => baseline.id !== baselineId));
    setBaselineTasks((current) => current.filter((snapshot) => snapshot.baselineId !== baselineId));
  }, []);

  const resourceLeave = useCallback((resourceId: string) => {
    const resource = resources.find((item) => item.id === resourceId);
    return resource ? system.exceptions.filter((exception) => exception.calendarId === resource.calendarId && exception.type === "leave") : [];
  }, [resources, system]);

  const createResource = useCallback<CalendarStoreValue["createResource"]>((input) => {
    const id = `res-${uid()}`;
    const calendarId = `cal-person-${uid()}`;
    const base = system.calendars.find((calendar) => calendar.isDefault);
    const calendar: PlannerCalendar = { id: calendarId, name: `${input.name} — leave`, type: "person", parentCalendarId: base?.id ?? system.defaultCalendarId, isDefault: false, workingDays: base?.workingDays };
    setSystem((current) => ({ ...current, calendars: [...current.calendars, calendar] }));
    const resource = { ...input, id, calendarId };
    setResources((current) => [...current, resource]);
    return resource;
  }, [system]);

  const updateResource = useCallback((id: string, patch: Partial<ResourceRecord>) => {
    setResources((current) => current.map((resource) => resource.id === id ? { ...resource, ...patch } : resource));
  }, []);

  const updateResourceSchedule = useCallback((id: string, workingDays: Weekday[]) => {
    const resource = resources.find((item) => item.id === id);
    if (!resource) return;
    setSystem((current) => ({
      ...current,
      calendars: current.calendars.map((calendar) =>
        calendar.id === resource.calendarId ? { ...calendar, workingDays } : calendar,
      ),
    }));
  }, [resources]);

  const setTaskAssignments = useCallback((taskId: string, resourceIds: string[]) => {
    setAssignments((current) => [...current.filter((assignment) => assignment.taskId !== taskId), ...resourceIds.map((resourceId) => ({ id: `as-${uid()}`, taskId, resourceId }))]);
  }, []);

  const setActiveProject = useCallback((projectId: string) => {
    if (projects.some((project) => project.id === projectId && project.status !== "archived" && (project.kind ?? (project.status === "template" ? "template" : "project")) === "project")) setActiveProjectId(projectId);
  }, [projects]);

  const createProject = useCallback<CalendarStoreValue["createProject"]>((input) => {
    const id = `proj-${uid()}`;
    const now = new Date().toISOString();
    const project: ProjectRecord = { id, name: input.name.trim() || "Untitled project", status: "active", startDate: input.startDate, schedulingDirection: input.schedulingDirection, calendarId: input.calendarId, createdAt: now, updatedAt: now };
    setProjects((current) => [...current, project]);
    setTasksByProject((current) => ({ ...current, [id]: [] }));
    const version: PlanVersion = { id: `version-${id}-1`, projectId: id, name: "Versie 1", isActive: true, createdAt: now, mode: "planning", modeHistory: [] };
    setPlanVersions((current) => [...current, version]);
    setActiveVersionId(version.id);
    setActiveProjectId(id);
    return id;
  }, []);

  const createProjectFromTemplate = useCallback<CalendarStoreValue["createProjectFromTemplate"]>(async (input) => {
    const result = await createProjectFromTemplateRemote({ ...input, includeAssignments: input.includeAssignments ?? false });
    const created = result as { project: ProjectRecord; version: PlanVersion; tasks: PlannerTask[]; assignments: TaskAssignment[]; skippedAssignments: number };
    setProjects((current) => [...current, created.project]);
    setPlanVersions((current) => [...current, created.version]);
    setTasksByProject((current) => ({ ...current, [created.project.id]: created.tasks.map((task) => ({ ...task, versionId: created.version.id })) }));
    setAssignments((current) => [...current, ...created.assignments]);
    setActiveVersionId(created.version.id);
    setActiveProjectId(created.project.id);
    return { id: created.project.id, skippedAssignments: created.skippedAssignments };
  }, [createProjectFromTemplateRemote]);

  const saveAsTemplate = useCallback<CalendarStoreValue["saveAsTemplate"]>(async (projectId, versionId, name) => {
    const result = await saveAsTemplateRemote({ projectId, versionId, name });
    const created = result as { project: ProjectRecord; version: PlanVersion; tasks: PlannerTask[]; assignments: TaskAssignment[] };
    setProjects((current) => [...current, created.project]);
    setPlanVersions((current) => [...current, created.version]);
    setTasksByProject((current) => ({ ...current, [created.project.id]: created.tasks.map((task) => ({ ...task, versionId: created.version.id })) }));
    setAssignments((current) => [...current, ...created.assignments]);
  }, [saveAsTemplateRemote]);

  const setTemplateHidden = useCallback<CalendarStoreValue["setTemplateHidden"]>(async (templateId, hidden) => {
    await setTemplateHiddenRemote({ templateId, hidden });
    setProjects((current) => current.map((project) => project.id === templateId ? { ...project, hidden, updatedAt: new Date().toISOString() } : project));
  }, [setTemplateHiddenRemote]);

  const deleteTemplate = useCallback<CalendarStoreValue["deleteTemplate"]>(async (templateId) => {
    await deleteTemplateRemote({ templateId });
    const taskIds = new Set((tasksByProject[templateId] ?? []).map((task) => task.id));
    setProjects((current) => current.filter((project) => project.id !== templateId));
    setTasksByProject((current) => { const next = { ...current }; delete next[templateId]; return next; });
    setPlanVersions((current) => current.filter((version) => version.projectId !== templateId));
    setAssignments((current) => current.filter((assignment) => !taskIds.has(assignment.taskId)));
  }, [deleteTemplateRemote, tasksByProject]);

  const renameProject = useCallback((projectId: string, name: string) => {
    if (!name.trim()) return;
    setProjects((current) => current.map((project) => project.id === projectId ? { ...project, name: name.trim(), updatedAt: new Date().toISOString() } : project));
  }, []);

  const duplicateProject = useCallback<CalendarStoreValue["duplicateProject"]>((projectId, name) => {
    const source = projects.find((project) => project.id === projectId && (project.kind ?? (project.status === "template" ? "template" : "project")) === "project");
    const id = `proj-${uid()}`;
    const now = new Date().toISOString();
    if (!source) return id;
    const sourceTasks = tasksByProject[projectId] ?? [];
    const allTaskIds = Object.values(tasksByProject).flat().map((task) => Number(task.id)).filter(Number.isFinite);
    const idOffset = Math.max(0, ...allTaskIds) + 1;
    const idMap = new Map(sourceTasks.map((task, index) => [task.id, String(idOffset + index)]));
    const copiedTasks = sourceTasks.map((task) => ({
      ...task,
      id: idMap.get(task.id) ?? task.id,
      parentId: task.parentId ? idMap.get(task.parentId) ?? null : null,
      predecessors: task.predecessors.split(",").map((part) => {
        const match = part.trim().match(/^(\d+)(.*)$/);
        return match ? `${idMap.get(match[1]) ?? match[1]}${match[2]}` : part.trim();
      }).filter(Boolean).join(", "),
    }));
    const copiedAssignments = assignments.filter((assignment) => sourceTasks.some((task) => task.id === assignment.taskId)).map((assignment) => ({ ...assignment, id: `as-${uid()}`, taskId: idMap.get(assignment.taskId) ?? assignment.taskId }));
    const copy: ProjectRecord = { ...source, id, name: name.trim() || `${source.name} copy`, status: "active", kind: "project", isBuiltin: false, createdAt: now, updatedAt: now };
    setProjects((current) => [...current, copy]);
    setTasksByProject((current) => ({ ...current, [id]: copiedTasks }));
    setAssignments((current) => [...current, ...copiedAssignments]);
    return id;
  }, [projects, tasksByProject, assignments]);

  const archiveProject = useCallback((projectId: string) => {
    if (!projects.some((project) => project.id === projectId && (project.kind ?? (project.status === "template" ? "template" : "project")) === "project")) return;
    setProjects((current) => current.map((project) => project.id === projectId ? { ...project, status: "archived", updatedAt: new Date().toISOString() } : project));
    if (activeProjectId === projectId) setActiveProjectId(projects.find((project) => project.id !== projectId && project.status === "active" && project.kind !== "template")?.id ?? "");
  }, [activeProjectId, projects]);

  const deleteProject = useCallback<CalendarStoreValue["deleteProject"]>((projectId) => {
    const taskCount = (tasksByProject[projectId] ?? []).length;
    const project = projects.find((item) => item.id === projectId);
    if (!project || (project.kind ?? (project.status === "template" ? "template" : "project")) !== "project") return { ok: false, taskCount };
    const regularProjects = projects.filter((item) => (item.kind ?? (item.status === "template" ? "template" : "project")) === "project");
    if (regularProjects.length <= 1) return { ok: false, taskCount };
    setProjects((current) => current.filter((project) => project.id !== projectId));
    setTasksByProject((current) => { const next = { ...current }; delete next[projectId]; return next; });
    const taskIds = new Set((tasksByProject[projectId] ?? []).map((task) => task.id));
    setAssignments((current) => current.filter((assignment) => !taskIds.has(assignment.taskId)));
    if (activeProjectId === projectId) setActiveProjectId(regularProjects.find((item) => item.id !== projectId && item.status === "active")?.id ?? regularProjects.find((item) => item.id !== projectId)?.id ?? "");
    return { ok: true, taskCount };
  }, [activeProjectId, projects, tasksByProject]);

  const addResourceLeave = useCallback<CalendarStoreValue["addResourceLeave"]>((resourceId, input) => {
    const resource = resources.find((item) => item.id === resourceId);
    if (!resource) return;
    const exception = makeException({ calendarId: resource.calendarId, startDate: input.startDate, endDate: input.endDate, label: `${input.type}${input.note ? ` · ${input.note}` : ""}`, type: "leave", source: "manual" });
    setSystem((current) => ({ ...current, exceptions: [...current.exceptions, exception] }));
  }, [resources]);

  const removeResourceLeave = useCallback((exceptionId: string) => {
    setSystem((current) => ({ ...current, exceptions: current.exceptions.filter((exception) => exception.id !== exceptionId) }));
  }, []);

  const setTasks = useCallback(
    (updater: PlannerTask[] | ((prev: PlannerTask[]) => PlannerTask[])) => {
      setTasksByProject((current) => {
        const all = current[activeProjectId] ?? [];
        const previous = all.filter((task) => !task.versionId || task.versionId === activeVersionId);
        const next = typeof updater === "function" ? updater(previous) : updater;
        const nextIds = new Set(next.map((task) => task.id));
        const preserved = all.filter((task) => task.versionId && task.versionId !== activeVersionId && !nextIds.has(task.id));
        setProjects((projectList) => projectList.map((project) => project.id === activeProjectId ? { ...project, updatedAt: new Date().toISOString() } : project));
        return { ...current, [activeProjectId]: [...preserved, ...next.map((task) => ({ ...task, versionId: task.versionId ?? activeVersionId }))] };
      });
    },
    [activeProjectId, activeVersionId],
  );

  /** Applies a new calendar system and re-plans every project that depends on it. */
  const applyCalendarSystem = useCallback(
    (nextSystem: CalendarSystem) => {
      setSystem(nextSystem);
      setTasksByProject((current) => recalculateProjects(current, projects, nextSystem));
    },
    [projects],
  );

  const calendarsUsingProjects = useCallback(
    (calendarId: string) => projects.filter((project) => (project.kind ?? (project.status === "template" ? "template" : "project")) === "project" && project.calendarId === calendarId),
    [projects],
  );

  const projectsAffectedBy = useCallback(
    (calendarId: string) =>
      projects.filter((project) => (project.kind ?? (project.status === "template" ? "template" : "project")) === "project" &&
        calendarChain(system, project.calendarId).some((calendar) => calendar.id === calendarId),
      ),
    [projects, system],
  );

  const previewCalendarChange = useCallback(
    (nextSystem: CalendarSystem, changedCalendarId: string): ImpactCount => {
      const affected = projectsAffectedBy(changedCalendarId);
      let moved = 0;
      for (const project of affected) {
        const projectTasks = tasksByProject[project.id];
        if (!projectTasks?.length) continue;
        const result = recalculateTasks(projectTasks, {
          direction: "forward",
          calendarSystem: nextSystem,
          projectCalendarId: project.calendarId,
        });
        if (!result.error) moved += result.moved;
      }
      return { projects: affected.length, tasks: moved };
    },
    [projectsAffectedBy, tasksByProject],
  );

  const previewProjectRelink = useCallback(
    (projectId: string, calendarId: string): ImpactCount => {
      const projectTasks = tasksByProject[projectId];
      if (!projectTasks?.length) return { projects: 1, tasks: 0 };
      const result = recalculateTasks(projectTasks, {
        direction: "forward",
        calendarSystem: system,
        projectCalendarId: calendarId,
      });
      return { projects: 1, tasks: result.error ? 0 : result.moved };
    },
    [tasksByProject, system],
  );

  const setProjectCalendar = useCallback(
    (projectId: string, calendarId: string, nextSystem?: CalendarSystem) => {
      if (!projects.some((project) => project.id === projectId && (project.kind ?? (project.status === "template" ? "template" : "project")) === "project")) return;
      const effectiveSystem = nextSystem ?? system;
      setSystem(effectiveSystem);
      setProjects((current) =>
        current.map((project) => (project.id === projectId ? { ...project, calendarId } : project)),
      );
      setTasksByProject((current) => {
        const projectTasks = current[projectId];
        if (!projectTasks?.length) return current;
        const result = recalculateTasks(projectTasks, {
          direction: "forward",
          calendarSystem: effectiveSystem,
          projectCalendarId: calendarId,
        });
        return result.error ? current : { ...current, [projectId]: result.tasks };
      });
    },
    [projects, system],
  );

  const createCalendar = useCallback<CalendarStoreValue["createCalendar"]>(
    ({ name, type, parentCalendarId, workingDays }) => {
      const trimmed = name.trim();
      // The model allows exactly one base calendar.
      if (!trimmed || type === "base") return null;
      const id = `cal-${uid()}`;
      const calendar: PlannerCalendar = {
        id,
        name: trimmed,
        type,
        parentCalendarId,
        isDefault: false,
        ...(workingDays ? { workingDays } : {}),
      };
      setSystem((current) => ({ ...current, calendars: [...current.calendars, calendar] }));
      return id;
    },
    [],
  );

  const duplicateCalendar = useCallback(
    (id: string) => {
      const source = system.calendars.find((calendar) => calendar.id === id);
      const newId = `cal-${uid()}`;
      if (!source) return newId;
      // A duplicate of the base becomes a project calendar inheriting from it.
      const copy: PlannerCalendar = source.isDefault
        ? { ...source, id: newId, name: `${source.name} (copy)`, type: "project", parentCalendarId: source.id, isDefault: false }
        : { ...source, id: newId, name: `${source.name} (copy)`, isDefault: false };
      const copiedExceptions = source.isDefault
        ? []
        : system.exceptions
            .filter((exception) => exception.calendarId === source.id)
            .map((exception) => ({ ...exception, id: `exc-${uid()}`, calendarId: newId }));
      setSystem((current) => ({
        ...current,
        calendars: [...current.calendars, copy],
        exceptions: [...current.exceptions, ...copiedExceptions],
      }));
      return newId;
    },
    [system],
  );

  const renameCalendar = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSystem((current) => ({
      ...current,
      calendars: current.calendars.map((calendar) =>
        calendar.id === id ? { ...calendar, name: trimmed } : calendar,
      ),
    }));
  }, []);

  const deleteCalendar = useCallback<CalendarStoreValue["deleteCalendar"]>(
    (id) => {
      const calendar = system.calendars.find((item) => item.id === id);
      if (!calendar) return { ok: false, message: "Calendar not found." };
      if (calendar.isDefault) {
        return { ok: false, message: "The base calendar cannot be deleted." };
      }
      const usedBy = projects.filter((project) => (project.kind ?? (project.status === "template" ? "template" : "project")) === "project" && project.calendarId === id);
      if (usedBy.length) {
        return {
          ok: false,
          message: `${usedBy.length} project${usedBy.length === 1 ? "" : "s"} still use this calendar (${usedBy
            .map((project) => project.name)
            .join(", ")}). Re-link them first.`,
        };
      }
      const children = system.calendars.filter((item) => item.parentCalendarId === id);
      if (children.length) {
        return {
          ok: false,
          message: `${children.length} calendar${children.length === 1 ? "" : "s"} inherit from this one (${children
            .map((item) => item.name)
            .join(", ")}). Delete or re-parent them first.`,
        };
      }
      setSystem((current) => ({
        ...current,
        calendars: current.calendars.filter((item) => item.id !== id),
        exceptions: current.exceptions.filter((exception) => exception.calendarId !== id),
      }));
      return { ok: true };
    },
    [projects, system],
  );

  const value = useMemo<CalendarStoreValue>(
    () => ({
      system,
      projects,
      activeProject,
      activeProjectId,
      setActiveProject,
      tasks,
      projectTasks,
      setTasks,
      setProjectCalendar,
      createProject,
      createProjectFromTemplate,
      saveAsTemplate,
      setTemplateHidden,
      deleteTemplate,
      renameProject,
      duplicateProject,
      archiveProject,
      deleteProject,
      calendarsUsingProjects,
      projectsAffectedBy,
      previewCalendarChange,
      previewProjectRelink,
      applyCalendarSystem,
      createCalendar,
      duplicateCalendar,
      renameCalendar,
      deleteCalendar,
      resources,
      assignments,
      updateResource,
      updateResourceSchedule,
      createResource,
      setTaskAssignments,
      addResourceLeave,
      removeResourceLeave,
      resourceLeave,
      planVersions,
      baselines,
      baselineTasks,
      createBaseline,
      deleteBaseline,
      activeVersionId,
      setActiveVersion,
      createPlanVersion,
      replanProject,
      deletePlanVersion,
      setPlanMode,
    }),
    [
      system, projects, activeProject, activeProjectId, setActiveProject, tasks, projectTasks, setTasks, setProjectCalendar, createProject, createProjectFromTemplate, saveAsTemplate, setTemplateHidden, deleteTemplate, renameProject, duplicateProject, archiveProject, deleteProject, calendarsUsingProjects,
      projectsAffectedBy, previewCalendarChange, previewProjectRelink, applyCalendarSystem,
      createCalendar, duplicateCalendar, renameCalendar, deleteCalendar, resources, assignments,
      updateResource, updateResourceSchedule, createResource, setTaskAssignments, addResourceLeave, removeResourceLeave, resourceLeave,
      planVersions, baselines, baselineTasks, createBaseline, deleteBaseline, activeVersionId, setActiveVersion, createPlanVersion, replanProject, deletePlanVersion, setPlanMode,
    ],
  );

  return <CalendarStoreContext.Provider value={value}>{children}</CalendarStoreContext.Provider>;
}

export function useCalendarStore() {
  const value = useContext(CalendarStoreContext);
  if (!value) throw new Error("useCalendarStore must be used inside CalendarStoreProvider");
  return value;
}
