import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
import { recalculateTasks, type PlannerTask } from "./planner-model";
import type { PlanningDirection } from "./scheduling-engine";

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

/* ------------------------------------------------------------------ seeds */

export const BASE_CALENDAR_ID = "cal-base-belgium";
export const RIVERSIDE_CALENDAR_ID = "cal-proj-riverside";
export const RIVERSIDE_PROJECT_ID = "proj-riverside";

const seedTasks: PlannerTask[] = [
  { id: "1", parentId: null, name: "Riverside Arts Festival", duration: 18, durationUnit: "days", start: "2025-04-07", finish: "2025-04-30", isMilestone: false, predecessors: "", resource: "M. Alvarez", percent: 42, notes: "Main project brief and public opening.", color: "ochre" },
  { id: "2", parentId: "1", name: "Site & permissions", duration: 5, durationUnit: "days", start: "2025-04-07", finish: "2025-04-11", isMilestone: false, predecessors: "", resource: "E. Shaw", percent: 100, notes: "", color: "sage" },
  { id: "3", parentId: "1", name: "Artist lineup", duration: 8, durationUnit: "days", start: "2025-04-14", finish: "2025-04-23", isMilestone: false, predecessors: "2FS", resource: "M. Alvarez", percent: 66, notes: "Confirm three final commissions.", color: "clay" },
  { id: "4", parentId: "1", name: "Install & opening", duration: 4, durationUnit: "days", start: "2025-04-25", finish: "2025-04-30", isMilestone: false, predecessors: "3FS+1d", resource: "J. Bell", percent: 18, notes: "Crew call at 07:30.", color: "ink" },
  { id: "5", parentId: null, name: "Press & visitor materials", duration: 9, durationUnit: "days", start: "2025-04-10", finish: "2025-04-22", isMilestone: false, predecessors: "", resource: "R. Chen", percent: 24, notes: "Printed guide, wayfinding, web copy.", color: "rust" },
  { id: "6", parentId: "5", name: "Draft visitor guide", duration: 4, durationUnit: "days", start: "2025-04-10", finish: "2025-04-15", isMilestone: false, predecessors: "", resource: "R. Chen", percent: 72, notes: "", color: "sage" },
  { id: "7", parentId: "5", name: "Print & distribute", duration: 3, durationUnit: "days", start: "2025-04-17", finish: "2025-04-21", isMilestone: false, predecessors: "6FS+1d", resource: "R. Chen", percent: 0, notes: "", color: "clay" },
  { id: "8", parentId: null, name: "Festival opens", duration: 1, durationUnit: "days", start: "2025-05-01", finish: "2025-05-01", isMilestone: true, predecessors: "4FS, 7FS", resource: "", percent: 0, notes: "Public opening day.", color: "rust" },
];

function seedSystem(): CalendarSystem {
  const holidays: CalendarException[] = [2024, 2025, 2026].flatMap((year) =>
    belgianPublicHolidays(year).map((holiday) => ({
      id: `import-${holiday.date}`,
      calendarId: BASE_CALENDAR_ID,
      startDate: holiday.date,
      endDate: holiday.date,
      label: holiday.label,
      type: "holiday" as CalendarExceptionType,
      isWorkingDay: false,
      source: "import" as CalendarExceptionSource,
    })),
  );
  const calendars: PlannerCalendar[] = [
    { id: BASE_CALENDAR_ID, name: "Belgium — standard", type: "base", parentCalendarId: null, isDefault: true, workingDays: [1, 2, 3, 4, 5] },
    { id: RIVERSIDE_CALENDAR_ID, name: "Riverside Arts Festival", type: "project", parentCalendarId: BASE_CALENDAR_ID, isDefault: false },
    { id: "cal-person-alvarez", name: "M. Alvarez — leave", type: "person", parentCalendarId: RIVERSIDE_CALENDAR_ID, isDefault: false },
  ];
  return {
    calendars,
    exceptions: [
      ...holidays,
      { id: "exc-install-shutdown", calendarId: RIVERSIDE_CALENDAR_ID, startDate: "2025-04-28", endDate: "2025-04-30", label: "Install shutdown", type: "shutdown", isWorkingDay: false, source: "manual" },
      { id: "exc-alvarez-leave", calendarId: "cal-person-alvarez", startDate: "2025-04-24", endDate: "2025-04-24", label: "Annual leave", type: "leave", isWorkingDay: false, source: "manual" },
    ],
    defaultCalendarId: BASE_CALENDAR_ID,
  };
}

const seedResources: ResourceRecord[] = [
  { id: "res-alvarez", name: "M. Alvarez", role: "Producer", email: "marina@example.com", colour: "#d97757", hoursPerWeek: 40, isActive: true, calendarId: "cal-person-alvarez" },
  { id: "res-shaw", name: "E. Shaw", role: "Permits coordinator", email: "elias@example.com", colour: "#71947b", hoursPerWeek: 40, isActive: true, calendarId: "cal-person-shaw" },
  { id: "res-bell", name: "J. Bell", role: "Installation lead", email: "jordan@example.com", colour: "#4c78a8", hoursPerWeek: 32, isActive: true, calendarId: "cal-person-bell" },
  { id: "res-chen", name: "R. Chen", role: "Communications", email: "riley@example.com", colour: "#b7794b", hoursPerWeek: 40, isActive: true, calendarId: "cal-person-chen" },
];
const seedAssignments: TaskAssignment[] = [
  { id: "as-1", taskId: "1", resourceId: "res-alvarez" }, { id: "as-2", taskId: "3", resourceId: "res-alvarez" },
  { id: "as-3", taskId: "2", resourceId: "res-shaw" }, { id: "as-4", taskId: "4", resourceId: "res-bell" },
  { id: "as-5", taskId: "5", resourceId: "res-chen" }, { id: "as-6", taskId: "6", resourceId: "res-chen" }, { id: "as-7", taskId: "7", resourceId: "res-chen" },
];

const seedProjects: ProjectRecord[] = [
  { id: RIVERSIDE_PROJECT_ID, name: "Riverside Arts Festival", calendarId: RIVERSIDE_CALENDAR_ID, status: "active", startDate: "2025-04-01", schedulingDirection: "forward", createdAt: "2025-01-01T09:00:00.000Z", updatedAt: "2025-04-17T09:00:00.000Z" },
  { id: "proj-press", name: "Press & visitor materials", calendarId: BASE_CALENDAR_ID, status: "active", startDate: "2025-04-10", schedulingDirection: "forward", createdAt: "2025-01-02T09:00:00.000Z", updatedAt: "2025-04-17T09:00:00.000Z" },
];

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
}

const CalendarStoreContext = createContext<CalendarStoreValue | null>(null);

function recalculateProjects(
  current: Record<string, PlannerTask[]>,
  projectList: ProjectRecord[],
  system: CalendarSystem,
): Record<string, PlannerTask[]> {
  const next: Record<string, PlannerTask[]> = { ...current };
  for (const project of projectList) {
    const tasks = current[project.id];
    if (!tasks?.length) continue;
    const result = recalculateTasks(tasks, {
      direction: "forward",
      calendarSystem: system,
      projectCalendarId: project.calendarId,
    });
    if (!result.error) next[project.id] = result.tasks;
  }
  return next;
}

export function CalendarStoreProvider({ children }: { children: ReactNode }) {
  const [system, setSystem] = useState<CalendarSystem>(seedSystem);
  const [projects, setProjects] = useState<ProjectRecord[]>(seedProjects);
  const [resources, setResources] = useState<ResourceRecord[]>(seedResources);
  const [assignments, setAssignments] = useState<TaskAssignment[]>(seedAssignments);
  const [tasksByProject, setTasksByProject] = useState<Record<string, PlannerTask[]>>({
    [RIVERSIDE_PROJECT_ID]: seedTasks,
    "proj-press": [],
  });
  const [activeProjectId, setActiveProjectId] = useState(() => {
    try { return localStorage.getItem("vintage-gantt-active-project") ?? RIVERSIDE_PROJECT_ID; } catch { return RIVERSIDE_PROJECT_ID; }
  });

  // Local persistence is the current backing store until the database adapter is added.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("vintage-gantt-calendar-state");
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<{ system: CalendarSystem; projects: ProjectRecord[]; resources: ResourceRecord[]; assignments: TaskAssignment[]; tasksByProject: Record<string, PlannerTask[]> }>;
        if (parsed.system) setSystem(parsed.system);
        if (parsed.projects) {
          const migratedProjects = parsed.projects.map((project) => ({
            id: project.id,
            name: project.name,
            calendarId: project.calendarId,
            status: project.status ?? "active",
            startDate: project.startDate ?? "2025-04-01",
            schedulingDirection: project.schedulingDirection ?? "forward",
            createdAt: project.createdAt ?? new Date().toISOString(),
            updatedAt: project.updatedAt ?? new Date().toISOString(),
          }));
          setProjects(migratedProjects);
          const persisted = migratedProjects.find((project) => project.id === activeProjectId && project.status !== "archived");
          const fallback = migratedProjects.filter((project) => project.status === "active").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? migratedProjects[0];
          setActiveProjectId(persisted?.id ?? fallback?.id ?? RIVERSIDE_PROJECT_ID);
        }
        if (parsed.resources) setResources(parsed.resources);
        if (parsed.assignments) setAssignments(parsed.assignments);
        if (parsed.tasksByProject) setTasksByProject(parsed.tasksByProject);
      }
    } catch { /* use seed data when storage is unavailable */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem("vintage-gantt-calendar-state", JSON.stringify({ system, projects, resources, assignments, tasksByProject })); } catch { /* storage is optional */ }
  }, [system, projects, resources, assignments, tasksByProject]);
  useEffect(() => {
    try { localStorage.setItem("vintage-gantt-active-project", activeProjectId); } catch { /* storage is optional */ }
  }, [activeProjectId]);
  useEffect(() => {
    try { localStorage.setItem("vintage-gantt-active-project", activeProjectId); } catch { /* storage is optional */ }
  }, [activeProjectId]);
  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? projects[0],
    [projects, activeProjectId],
  );
  const tasks = tasksByProject[activeProjectId] ?? [];
  const projectTasks = useCallback((projectId: string) => tasksByProject[projectId] ?? [], [tasksByProject]);

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
    if (projects.some((project) => project.id === projectId && project.status !== "archived")) setActiveProjectId(projectId);
  }, [projects]);

  const createProject = useCallback<CalendarStoreValue["createProject"]>((input) => {
    const id = `proj-${uid()}`;
    const now = new Date().toISOString();
    const project: ProjectRecord = { id, name: input.name.trim() || "Untitled project", status: "active", startDate: input.startDate, schedulingDirection: input.schedulingDirection, calendarId: input.calendarId, createdAt: now, updatedAt: now };
    setProjects((current) => [...current, project]);
    setTasksByProject((current) => ({ ...current, [id]: [] }));
    setActiveProjectId(id);
    return id;
  }, []);

  const renameProject = useCallback((projectId: string, name: string) => {
    if (!name.trim()) return;
    setProjects((current) => current.map((project) => project.id === projectId ? { ...project, name: name.trim(), updatedAt: new Date().toISOString() } : project));
  }, []);

  const duplicateProject = useCallback<CalendarStoreValue["duplicateProject"]>((projectId, name) => {
    const source = projects.find((project) => project.id === projectId);
    const id = `proj-${uid()}`;
    const now = new Date().toISOString();
    if (!source) return id;
    const sourceTasks = tasksByProject[projectId] ?? [];
    const allTaskIds = Object.values(tasksByProject).flat().map((task) => Number(task.id)).filter(Number.isFinite);
    const idOffset = Math.max(0, ...allTaskIds) + 1;
    const idMap = new Map(sourceTasks.map((task, index) => [task.id, String(idOffset + index)]));
    const copiedTasks = sourceTasks.map((task) => ({ ...task, id: idMap.get(task.id) ?? task.id, predecessors: task.predecessors.replace(/\d+/g, (value) => idMap.get(value) ?? value) }));
    const copiedAssignments = assignments.filter((assignment) => sourceTasks.some((task) => task.id === assignment.taskId)).map((assignment) => ({ ...assignment, id: `as-${uid()}`, taskId: idMap.get(assignment.taskId) ?? assignment.taskId }));
    const copy: ProjectRecord = { ...source, id, name: name.trim() || `${source.name} copy`, status: "template", createdAt: now, updatedAt: now };
    setProjects((current) => [...current, copy]);
    setTasksByProject((current) => ({ ...current, [id]: copiedTasks }));
    setAssignments((current) => [...current, ...copiedAssignments]);
    return id;
  }, [projects, tasksByProject, assignments]);

  const archiveProject = useCallback((projectId: string) => {
    setProjects((current) => current.map((project) => project.id === projectId ? { ...project, status: "archived", updatedAt: new Date().toISOString() } : project));
    if (activeProjectId === projectId) setActiveProjectId(projects.find((project) => project.id !== projectId && project.status === "active")?.id ?? RIVERSIDE_PROJECT_ID);
  }, [activeProjectId, projects]);

  const deleteProject = useCallback<CalendarStoreValue["deleteProject"]>((projectId) => {
    const taskCount = (tasksByProject[projectId] ?? []).length;
    if (projects.length <= 1) return { ok: false, taskCount };
    setProjects((current) => current.filter((project) => project.id !== projectId));
    setTasksByProject((current) => { const next = { ...current }; delete next[projectId]; return next; });
    const taskIds = new Set((tasksByProject[projectId] ?? []).map((task) => task.id));
    setAssignments((current) => current.filter((assignment) => !taskIds.has(assignment.taskId)));
    if (activeProjectId === projectId) setActiveProjectId(projects.find((project) => project.id !== projectId)?.id ?? RIVERSIDE_PROJECT_ID);
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
        const previous = current[activeProjectId] ?? [];
        const next = typeof updater === "function" ? updater(previous) : updater;
        setProjects((projectList) => projectList.map((project) => project.id === activeProjectId ? { ...project, updatedAt: new Date().toISOString() } : project));
        return { ...current, [activeProjectId]: next };
      });
    },
    [activeProjectId],
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
    (calendarId: string) => projects.filter((project) => project.calendarId === calendarId),
    [projects],
  );

  const projectsAffectedBy = useCallback(
    (calendarId: string) =>
      projects.filter((project) =>
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
    [system],
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
      const usedBy = projects.filter((project) => project.calendarId === id);
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
    }),
    [
      system, projects, activeProject, activeProjectId, setActiveProject, tasks, projectTasks, setTasks, setProjectCalendar, createProject, renameProject, duplicateProject, archiveProject, deleteProject, calendarsUsingProjects,
      projectsAffectedBy, previewCalendarChange, previewProjectRelink, applyCalendarSystem,
      createCalendar, duplicateCalendar, renameCalendar, deleteCalendar, resources, assignments,
      updateResource, updateResourceSchedule, createResource, setTaskAssignments, addResourceLeave, removeResourceLeave, resourceLeave,
    ],
  );

  return <CalendarStoreContext.Provider value={value}>{children}</CalendarStoreContext.Provider>;
}

export function useCalendarStore() {
  const value = useContext(CalendarStoreContext);
  if (!value) throw new Error("useCalendarStore must be used inside CalendarStoreProvider");
  return value;
}
