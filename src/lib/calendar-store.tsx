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
import { applyPlanningModeMargins, applyReplanMargins, dependenciesForTasks, planFinishDate, recalculateTasks, remapCopiedTasks, removeBaselineAndSnapshots, replanScopeIds, settleMonitoringPlan, withCalculatedPlanningFields, type PlannerTask, type PlanMode, type ReplanScope } from "./planner-model";
import type { PlanningDirection } from "./scheduling-engine";
import {
  canManageMembers as roleCanManageMembers,
  migrationSummaryLines,
  type CompanyMigrationReport,
  type CompanyRole,
} from "./company-scope";
import { normalizeWorkspaceRelations } from "./company-integrity";
import { REMOVED_ACCESS_MESSAGE, invitationAcceptHref } from "./company-users";
import { ACCESS_ENDED_MESSAGE, accessEnded, accessState } from "./session-access";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuthActions } from "@convex-dev/auth/react";
import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react";
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
  /** Client / customer the project is for. Free text; drives the capacity filter. */
  client?: string;
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

/** Outcome of deleting a baseline: the comparison falls back to another
 *  baseline, or to none at all, and a failure always carries a reason. */
export interface BaselineDeleteResult {
  ok: boolean;
  message?: string;
  /** Baseline the comparison falls back to, or "" when none is left. */
  fallbackBaselineId?: string;
  snapshotsRemoved?: number;
}
export interface BaselineTask { id: string; baselineId: string; taskId: string; startDate: string; finishDate: string; durationDays: number; marginPct: number; marginDaysOriginal: number; marginDaysConsumed: number; predecessors?: string; totalFloat?: number; startConstraint?: string; }

/** The company of the signed-in account, as resolved by the server. */
export interface CompanySummary { id: string; name: string; status: string; createdAt: string; }
export interface CompanyMember { userId: string; name: string; email: string; role: CompanyRole; isSelf: boolean; }
export interface CompanyInfo { company: CompanySummary; role: CompanyRole; canManageMembers: boolean; members: CompanyMember[]; }

/** One pending invitation, as the company users screen shows it. */
export interface PendingInvitation {
  id: string;
  email: string;
  state: string;
  stateLabel: string;
  createdAt: string;
  expiresAt: string;
}

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
  setProjectClient: (projectId: string, client: string) => void;
  duplicateProject: (projectId: string, name: string) => string;
  archiveProject: (projectId: string) => void;
  /**
   * Puts an archived project back under the active projects. Only its status
   * changes: tasks, plan versions, baselines and resource assignments are
   * untouched, so nothing about the plan — dates, durations, workload, margin or
   * assignments — moves, and the project counts in the capacity figures again.
   */
  restoreProject: (projectId: string) => void;
  /**
   * Permanently removes a project and everything that belongs to it. The server
   * delete is awaited: the project disappears from the screen only after the
   * database confirmed it, and a refusal keeps it in place with a reason.
   */
  deleteProject: (projectId: string) => Promise<{ ok: boolean; taskCount: number; message?: string }>;
  /**
   * Permanently removes tasks (with their subtree) from one project. Awaited like
   * every delete: the caller applies its own state change only when `ok` is true.
   */
  deleteTasks: (projectId: string, taskIds: string[]) => Promise<{ ok: boolean; removedTaskIds: string[]; message?: string }>;
  calendarsUsingProjects: (calendarId: string) => ProjectRecord[];
  projectsAffectedBy: (calendarId: string) => ProjectRecord[];
  previewCalendarChange: (nextSystem: CalendarSystem, changedCalendarId: string) => ImpactCount;
  previewProjectRelink: (projectId: string, calendarId: string) => ImpactCount;
  resources: ResourceRecord[];
  assignments: TaskAssignment[];
  updateResource: (id: string, patch: Partial<ResourceRecord>) => void;
  updateResourceSchedule: (id: string, workingDays: Weekday[]) => void;
  createResource: (input: Omit<ResourceRecord, "id" | "calendarId">) => ResourceRecord;
  /**
   * Permanently removes an employee with their assignments, their person calendar
   * and that calendar's leave rows. Awaited, so nothing is removed on screen
   * until the database confirmed it.
   */
  deleteResource: (id: string) => Promise<{ ok: boolean; message?: string }>;
  setTaskAssignments: (taskId: string, resourceIds: string[]) => void;
  addResourceLeave: (resourceId: string, input: { startDate: string; endDate: string; type: LeaveType; note?: string }) => void;
  removeResourceLeave: (exceptionId: string) => void;
  resourceLeave: (resourceId: string) => CalendarException[];
  /** Applies a new calendar system and immediately re-plans every affected project. */
  applyCalendarSystem: (nextSystem: CalendarSystem) => void;
  createCalendar: (input: { name: string; type: CalendarType; parentCalendarId: string | null; workingDays?: Weekday[] }) => string | null;
  duplicateCalendar: (id: string) => string;
  renameCalendar: (id: string, name: string) => void;
  deleteCalendar: (id: string) => Promise<{ ok: boolean; message?: string }>;
  planVersions: PlanVersion[];
  baselines: Baseline[];
  baselineTasks: BaselineTask[];
  createBaseline: (name: string, note?: string, captureDate?: string) => string;
  /**
   * Removes a baseline together with every snapshot row stored for it, in one
   * state update (and therefore one persisted write). Never touches planning
   * data or the version's mode. Returns the baseline the comparison should fall
   * back to, or a reason when the baseline could not be deleted.
   */
  deleteBaseline: (baselineId: string) => BaselineDeleteResult;
  activeVersionId: string;
  setActiveVersion: (versionId: string) => void;
  /** Opens a task in its own project and version (used by the resource overview). */
  openTask: (projectId: string, versionId: string, taskId: string) => void;
  /** The task the planner should select next, set by `openTask` and cleared once used. */
  focusTask: { projectId: string; versionId: string; taskId: string } | null;
  clearFocusTask: () => void;
  /**
   * The company every record belongs to. The server links the signed-in account
   * to exactly one company; the browser never supplies a company id and it is
   * never treated as proof of access.
   */
  company: CompanyInfo | null;
  /** "company_admin" or "user" — they differ only for user/invitation management. */
  companyRole: CompanyRole;
  /** True only for company admins. */
  canManageMembers: boolean;
  /** Admin-only: changes an account type; the last company admin can never be demoted. */
  setCompanyMemberRole: (userId: string, role: CompanyRole) => Promise<{ ok: boolean; message?: string }>;
  /** True when this account's access to its company was removed (it is signed out). */
  accessRemoved: boolean;
  /** The company's pending invitations (admin only; empty otherwise). */
  pendingInvitations: PendingInvitation[];
  /** Admin-only: invites an email address and sends the acceptance email. */
  inviteCompanyMember: (email: string) => Promise<{ ok: boolean; message?: string }>;
  /** Admin-only: replaces a pending invitation with a fresh link and emails it. */
  resendCompanyInvitation: (email: string) => Promise<{ ok: boolean; message?: string }>;
  /** Admin-only: revokes a pending invitation, so its link can never be used. */
  revokeCompanyInvitation: (invitationId: string) => Promise<{ ok: boolean; message?: string }>;
  /** Admin-only: removes a user's access; nothing the user created is deleted. */
  removeCompanyMember: (userId: string) => Promise<{ ok: boolean; message?: string }>;
  /** Admin-only: hands company admin to another active user and steps down. */
  transferCompanyAdmin: (userId: string) => Promise<{ ok: boolean; message?: string }>;
  /**
   * Switches a version between Planning and Monitoring. Monitoring requires a
   * baseline on that version, and a version can never go back to Planning —
   * that happens by creating a new version (Replan). Every switch is timestamped
   * in the version's history.
   */
  setPlanMode: (versionId: string, mode: PlanMode) => { ok: boolean; message?: string };
  createPlanVersion: (name: string) => { ok: boolean; message?: string; versionId?: string };
  /**
   * Builds fresh reserve for the remaining work: always creates a new plan
   * version, leaving the current one untouched, then applies the new margin
   * percentage to the tasks in scope and resets their consumed margin. Returns
   * the new version id, how many tasks were affected and the finish it plans.
   */
  replanProject: (input: { name: string; scope: ReplanScope; selectedTaskIds?: string[]; marginPct: number }) => { ok: boolean; versionId: string; affected: number; finish: string; message?: string };
  deletePlanVersion: (versionId: string) => { ok: boolean; message?: string };
}

const CalendarStoreContext = createContext<CalendarStoreValue | null>(null);

/**
 * Applies the Monitoring reserve rule when a project is re-planned for a reason
 * other than a direct edit — a calendar change, say. Every task's own finish move
 * is absorbed by its own reserve, so the plan only slips by the excess.
 */
function absorbMonitoringMargins(
  rows: PlannerTask[],
  projectId: string,
  projectCalendarId: string,
  system: CalendarSystem,
  planVersionList: PlanVersion[],
): PlannerTask[] {
  let result = rows;
  for (const version of planVersionList) {
    if (version.projectId !== projectId || (version.mode ?? "planning") !== "monitoring") continue;
    const versionTasks = result.filter((task) => task.versionId === version.id);
    if (!versionTasks.length) continue;
    const settled = settleMonitoringPlan(versionTasks, versionTasks, {
      calendarSystem: system,
      projectCalendarId,
      // A calendar change affects every task's own finish, so all may spend reserve.
      changedTaskIds: new Set(versionTasks.map((task) => task.id)),
    });
    const byId = new Map(settled.tasks.map((task) => [task.id, task]));
    result = result.map((task) => byId.get(task.id) ?? task);
  }
  return result;
}

function recalculateProjects(
  current: Record<string, PlannerTask[]>,
  projectList: ProjectRecord[],
  system: CalendarSystem,
  planVersionList: PlanVersion[] = [],
): Record<string, PlannerTask[]> {
  const next: Record<string, PlannerTask[]> = { ...current };
  for (const project of projectList) {
    if ((project.kind ?? (project.status === "template" ? "template" : "project")) !== "project") continue;
    const tasks = current[project.id];
    if (!tasks?.length) continue;
    const absorbed = absorbMonitoringMargins(tasks, project.id, project.calendarId, system, planVersionList);
    const result = recalculateTasks(absorbed, {
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
  const [focusTask, setFocusTask] = useState<{ projectId: string; versionId: string; taskId: string } | null>(null);

  const { isLoading: isAuthLoading, isAuthenticated } = useConvexAuth();
  const remoteState = useQuery(api.planner.getState, isAuthenticated ? {} : "skip");
  const initializeWorkspace = useMutation(api.planner.initializeWorkspace);
  const createProjectFromTemplateRemote = useMutation(api.planner.createProjectFromTemplate);
  const saveAsTemplateRemote = useMutation(api.planner.saveAsTemplate);
  const setTemplateHiddenRemote = useMutation(api.planner.hideTemplate);
  const deleteTemplateRemote = useMutation(api.planner.deleteTemplate);
  const deleteProjectRemote = useMutation(api.planner.deleteProject);
  const deleteTasksRemote = useMutation(api.planner.deleteTasks);
  const deleteResourceRemote = useMutation(api.planner.deleteResource);
  const deleteCalendarRemote = useMutation(api.planner.deleteCalendar);
  const replaceRemoteState = useMutation(api.planner.replaceState);
  const ensureCompanyRemote = useMutation(api.companies.ensureCompany);
  const setCompanyMemberRoleRemote = useMutation(api.companies.setMemberRole);
  const inviteMemberRemote = useMutation(api.companies.inviteMember);
  const resendInvitationRemote = useMutation(api.companies.resendInvitation);
  const revokeInvitationRemote = useMutation(api.companies.revokeInvitation);
  const removeMemberRemote = useMutation(api.companies.removeMember);
  const transferAdminRemote = useMutation(api.companies.transferAdmin);
  const sendInvitationEmailRemote = useAction(api.companies.sendInvitationEmail);
  const companyInfo = useQuery(api.companies.current, isAuthenticated ? {} : "skip");
  const company = (companyInfo as CompanyInfo | null | undefined) ?? null;
  const companyRole: CompanyRole = company?.role ?? "user";
  const accessInfo = useQuery(api.companies.access, isAuthenticated ? {} : "skip");
  // A valid session survives a refresh; a removed account, a suspended company
  // and a signed-out visitor all end access. One rule decides, everywhere.
  const access = accessState({
    isLoading: isAuthLoading || (isAuthenticated && companyInfo === undefined),
    isAuthenticated,
    removed: accessInfo?.removed === true,
    companyActive: company ? company.company.status === "active" : true,
  });
  const accessRemoved = access === "denied";
  const pendingInvitationRows = useQuery(
    api.companies.pendingInvitations,
    isAuthenticated && (company?.canManageMembers ?? false) ? {} : "skip",
  );
  const pendingInvitations = (pendingInvitationRows as PendingInvitation[] | null | undefined) ?? [];
  const { signOut } = useAuthActions();
  const removalSignOutRef = useRef(false);
  const hydratedRef = useRef(false);
  const migrationStartedRef = useRef(false);
  const companyStartedRef = useRef(false);
  /** Set for exactly one run while a failed write is being rolled back. */
  const restoringRef = useRef(false);
  const lastServerStateRef = useRef<unknown>(null);
  /**
   * The exact JSON the database holds. A write is sent only when the workspace
   * differs from it, so hydrating the server's own answer never echoes back —
   * and, unlike a "skip the next write" flag, a change the user made is never
   * dropped on a timer. A skipped write is impossible; only an identical one is.
   */
  const lastSyncedRef = useRef<string | null>(null);

  /** The whole workspace exactly as it is sent to the server, relations repaired. */
  const buildWorkspacePayload = useCallback(
    (source: {
      projects: ProjectRecord[];
      tasksByProject: Record<string, PlannerTask[]>;
      system: CalendarSystem;
      resources: ResourceRecord[];
      assignments: TaskAssignment[];
      planVersions: PlanVersion[];
      baselines: Baseline[];
      baselineTasks: BaselineTask[];
    }) => {
      const state = {
        projects: source.projects,
        tasks: Object.entries(source.tasksByProject).flatMap(([projectId, rows]) => rows.map((task, index) => ({ ...task, projectId, sortOrder: index }))),
        dependencies: Object.entries(source.tasksByProject).flatMap(([projectId, rows]) => dependenciesForTasks(rows).map((dependency, index) => ({ ...dependency, id: `dep-${projectId}-${index}`, projectId }))),
        calendars: source.system.calendars,
        exceptions: source.system.exceptions,
        resources: source.resources,
        assignments: source.assignments,
        planVersions: source.planVersions,
        baselines: source.baselines,
        baselineTasks: source.baselineTasks,
      };
      // Every relation that survives has to belong to this company. A link row
      // whose target is gone can never be read, so it is dropped here rather than
      // stored: the only other rows that exist belong to other companies, and a
      // relation naming one of those is exactly what must never be written. The
      // server refuses a payload that fails this, so the two agree.
      const repaired = normalizeWorkspaceRelations(state);
      if (repaired.dropped.length) {
        console.info("[vintage-gantt] dropped relations that are not part of this company:", repaired.dropped);
      }
      return repaired.rows;
    },
    [],
  );

  useEffect(() => {
    if (!isAuthenticated || remoteState === undefined || hydratedRef.current || migrationStartedRef.current) return;
    if (remoteState === null) {
      // The signed-in company has no workspace yet, so it gets its own: an
      // empty one plus the built-in starter project. Nothing is inherited from
      // the browser — a browser is shared, so a snapshot left behind by an
      // earlier session could belong to another company, and a company must
      // never adopt records it does not own.
      // Seeding happens here and only here: for a workspace that has no records
      // at all. The server creates the starter project and the demo scenario
      // once, and never recreates a record that was removed afterwards.
      migrationStartedRef.current = true;
      void initializeWorkspace({}).catch(() => {
        migrationStartedRef.current = false;
        toast.error("Could not connect to the central planner database. Your changes were not saved.");
      });
      return;
    }
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
    // The workspace the database just handed us is, by definition, already
    // stored: recording its exact form means the next save run recognises it and
    // writes nothing, without skipping whatever the user does next.
    lastSyncedRef.current = JSON.stringify(buildWorkspacePayload({
      projects: state.projects ?? [],
      tasksByProject: grouped,
      system: { calendars: state.calendars ?? [], exceptions: state.exceptions ?? [], defaultCalendarId: state.calendars?.find((calendar) => calendar.isDefault)?.id ?? "" },
      resources: state.resources ?? [],
      assignments: state.assignments ?? [],
      planVersions: versions,
      baselines: state.baselines ?? [],
      baselineTasks: state.baselineTasks ?? [],
    }));
  }, [isAuthenticated, remoteState, initializeWorkspace, buildWorkspacePayload]);

  /**
   * Company-based access. The server creates exactly one company for the
   * signed-in account, links every existing record to it and compares record
   * counts and key planning totals before and after. A difference aborts the
   * migration server-side, so nothing is deleted, recreated or rewritten.
   */
  useEffect(() => {
    if (!isAuthenticated || companyStartedRef.current) return;
    companyStartedRef.current = true;
    void ensureCompanyRemote({})
      .then((report) => {
        const migration = report as CompanyMigrationReport;
        if (migration.created) console.info("[vintage-gantt]", migrationSummaryLines(migration).join(" "));
      })
      .catch((error: unknown) => {
        companyStartedRef.current = false;
        const reason = error instanceof Error ? error.message : String(error);
        console.error("[vintage-gantt] company migration failed:", error);
        toast.error(`Could not prepare your company workspace. ${reason}`);
      });
  }, [isAuthenticated, ensureCompanyRemote]);

  useEffect(() => {
    if (!isAuthenticated || !hydratedRef.current) return;
    // One run is skipped while a refused write is rolled back, so the rollback
    // itself is not sent back to the server.
    if (restoringRef.current) { restoringRef.current = false; return; }
    const payload = buildWorkspacePayload({ projects, tasksByProject, system, resources, assignments, planVersions, baselines, baselineTasks });
    const serialised = JSON.stringify(payload);
    // Nothing to write when the workspace is already what the database holds.
    // Only an identical payload is skipped — never a change the user made.
    if (serialised === lastSyncedRef.current) return;
    void replaceRemoteState({ state: payload }).then(() => {
      lastSyncedRef.current = serialised;
      lastServerStateRef.current = payload;
    }).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.error("[vintage-gantt] could not persist planner state:", error);
      toast.error(`Could not save to the central planner database (${reason}). The last saved data was restored.`);
      const previous = lastServerStateRef.current as {
        projects: ProjectRecord[]; tasks: Array<PlannerTask & { projectId: string }>; calendars: PlannerCalendar[]; exceptions: CalendarException[];
        resources: ResourceRecord[]; assignments: TaskAssignment[]; planVersions?: PlanVersion[]; baselines?: Baseline[]; baselineTasks?: BaselineTask[];
      } | null;
      if (!previous) return;
      restoringRef.current = true;
      lastSyncedRef.current = null;
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
  }, [isAuthenticated, projects, system, resources, assignments, tasksByProject, planVersions, baselines, baselineTasks, replaceRemoteState, buildWorkspacePayload]);
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
    // Remap parents, predecessors (type + lag) and the start constraint through
    // the id map; a single unresolvable reference fails the whole copy.
    const remapped = remapCopiedTasks(source, idMap, id);
    if (remapped.error) return { ok: false, message: remapped.error };
    const copied = applyPlanningModeMargins(remapped.tasks);
    const sourceTaskIds = new Set(source.map((task) => task.id));
    const copiedAssignments = assignments
      .filter((assignment) => sourceTaskIds.has(assignment.taskId))
      .map((assignment) => ({ ...assignment, id: `as-${uid()}`, taskId: idMap.get(assignment.taskId) ?? assignment.taskId }));
    setPlanVersions((current) => [...current.map((item) => item.projectId === activeProjectId ? { ...item, isActive: false } : item), version]);
    setTasksByProject((current) => ({ ...current, [activeProjectId]: [...(current[activeProjectId] ?? []), ...copied] }));
    setAssignments((current) => [...current, ...copiedAssignments]);
    setActiveVersionId(id);
    return { ok: true, versionId: id };
  }, [activeProjectId, activeVersionId, assignments, planVersions, tasksByProject]);

  const replanProject = useCallback<CalendarStoreValue["replanProject"]>((input) => {
    const source = (tasksByProject[activeProjectId] ?? []).filter((task) => !task.versionId || task.versionId === activeVersionId);
    const id = `version-${uid()}`;
    const affected = replanScopeIds(source, input).size;
    const margined = applyReplanMargins(source, input);
    const version: PlanVersion = { id, projectId: activeProjectId, name: input.name.trim() || `Replan ${input.marginPct}%`, isActive: true, createdAt: new Date().toISOString(), mode: "planning", modeHistory: [] };
    const idMap = new Map(source.map((task) => [task.id, `task-${uid()}`]));
    const remapped = remapCopiedTasks(margined, idMap, id);
    if (remapped.error) return { ok: false, versionId: "", affected, finish: "", message: remapped.error };
    const copied = remapped.tasks;
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
    return { ok: true, versionId: id, affected, finish: planFinishDate(scheduled) };
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
    const snapshots: BaselineTask[] = (tasksByProject[activeProjectId] ?? []).filter((task) => !task.versionId || task.versionId === versionId).map((task) => ({ id: `baseline-task-${uid()}`, baselineId: id, taskId: task.id, startDate: task.start, finishDate: task.finish, durationDays: task.duration, marginPct: task.marginPct ?? 0, marginDaysOriginal: task.marginDaysOriginal ?? 0, marginDaysConsumed: task.marginDaysConsumed ?? 0, predecessors: task.predecessors, totalFloat: task.totalFloat ?? 0, startConstraint: task.startConstraint }));
    setBaselines((current) => [...current, baseline]);
    setBaselineTasks((current) => [...current, ...snapshots]);
    // Capture is part of the version's history, timestamped like a mode switch.
    setPlanVersions((current) => current.map((item) => item.id === versionId
      ? { ...item, history: [...(item.history ?? []), { at, type: "baseline" as const, baselineId: id, name: baseline.name }] }
      : item));
    return id;
  }, [activeProjectId, activeVersionId, planVersions, tasksByProject]);

  const deleteBaseline = useCallback<CalendarStoreValue["deleteBaseline"]>((baselineId) => {
    const baseline = baselines.find((item) => item.id === baselineId);
    // Drop the baseline and its snapshots together — one state change, so they
    // are also persisted together — and find what Monitoring compares next.
    const removal = removeBaselineAndSnapshots(baselines, baselineTasks, baselineId);
    if (!removal || !baseline) {
      const message = `Baseline ${baselineId ? `"${baselineId}"` : "(no id)"} is not in this workspace, so there was nothing to delete.`;
      console.error("[vintage-gantt] deleteBaseline failed:", message, { baselineId, knownBaselines: baselines.map((item) => item.id) });
      return { ok: false, message };
    }
    setBaselines(removal.baselines);
    setBaselineTasks(removal.snapshots);
    console.info(`[vintage-gantt] deleted baseline "${baseline.name}" (${baselineId}) with ${removal.snapshotsRemoved} snapshot row(s)`);
    return { ok: true, fallbackBaselineId: removal.fallbackBaselineId, snapshotsRemoved: removal.snapshotsRemoved };
  }, [baselines, baselineTasks]);

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
    const removedBaselines = new Set(baselines.filter((baseline) => baseline.projectId === templateId).map((baseline) => baseline.id));
    setProjects((current) => current.filter((project) => project.id !== templateId));
    setTasksByProject((current) => { const next = { ...current }; delete next[templateId]; return next; });
    setPlanVersions((current) => current.filter((version) => version.projectId !== templateId));
    setAssignments((current) => current.filter((assignment) => !taskIds.has(assignment.taskId)));
    setBaselines((current) => current.filter((baseline) => baseline.projectId !== templateId));
    setBaselineTasks((current) => current.filter((row) => !removedBaselines.has(row.baselineId)));
  }, [baselines, deleteTemplateRemote, tasksByProject]);

  const renameProject = useCallback((projectId: string, name: string) => {
    if (!name.trim()) return;
    setProjects((current) => current.map((project) => project.id === projectId ? { ...project, name: name.trim(), updatedAt: new Date().toISOString() } : project));
  }, []);

  const setProjectClient = useCallback((projectId: string, client: string) => {
    setProjects((current) => current.map((project) => project.id === projectId ? { ...project, client: client.trim() || undefined, updatedAt: new Date().toISOString() } : project));
  }, []);

  /** Opens a task in its project and version, and asks the planner to select it. */
  // Every id is checked against what this company actually holds, so an id that
  // came from somewhere else — a shared link, another company — opens nothing.
  const openTask = useCallback((projectId: string, versionId: string, taskId: string) => {
    const project = projects.find((item) => item.id === projectId && (item.kind ?? (item.status === "template" ? "template" : "project")) === "project");
    const version = planVersions.find((item) => item.id === versionId && item.projectId === projectId);
    const task = (tasksByProject[projectId] ?? []).find((item) => item.id === taskId && (!item.versionId || item.versionId === versionId));
    if (!project || !version || !task) return;
    setActiveProjectId(projectId);
    setPlanVersions((current) => current.map((item) => item.projectId === projectId ? { ...item, isActive: item.id === versionId } : item));
    setActiveVersionId(versionId);
    setFocusTask({ projectId, versionId, taskId });
  }, [projects, planVersions, tasksByProject]);

  const clearFocusTask = useCallback(() => setFocusTask(null), []);

  const duplicateProject = useCallback<CalendarStoreValue["duplicateProject"]>((projectId, name) => {
    const source = projects.find((project) => project.id === projectId && (project.kind ?? (project.status === "template" ? "template" : "project")) === "project");
    const id = `proj-${uid()}`;
    const now = new Date().toISOString();
    if (!source) return id;
    const sourceTasks = tasksByProject[projectId] ?? [];
    const idMap = new Map(sourceTasks.map((task) => [task.id, `task-${uid()}`]));
    const remapped = remapCopiedTasks(sourceTasks, idMap);
    if (remapped.error) { toast.error(remapped.error); return ""; }
    const copiedTasks = remapped.tasks;
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

  const restoreProject = useCallback<CalendarStoreValue["restoreProject"]>((projectId) => {
    if (!projects.some((project) => project.id === projectId && project.status === "archived" && (project.kind ?? "project") === "project")) return;
    setProjects((current) => current.map((project) => project.id === projectId ? { ...project, status: "active", updatedAt: new Date().toISOString() } : project));
  }, [projects]);

  /**
   * Permanently deletes a project. The database is written first and the answer is
   * awaited: the project is removed from the screen only when the server
   * confirmed it, and every refusal keeps it visible with an English reason. The
   * same request removes its tasks, dependencies, assignments, plan versions and
   * baselines server-side, so no orphaned row is left counting towards capacity.
   */
  const deleteProject = useCallback<CalendarStoreValue["deleteProject"]>(async (projectId) => {
    const taskCount = (tasksByProject[projectId] ?? []).length;
    const project = projects.find((item) => item.id === projectId);
    if (!project || (project.kind ?? (project.status === "template" ? "template" : "project")) !== "project") {
      return { ok: false, taskCount, message: "That project is no longer in this workspace." };
    }
    const regularProjects = projects.filter((item) => (item.kind ?? (item.status === "template" ? "template" : "project")) === "project");
    if (regularProjects.length <= 1) return { ok: false, taskCount, message: "You must keep at least one project." };
    try {
      await deleteProjectRemote({ projectId });
    } catch (error: unknown) {
      return { ok: false, taskCount, message: error instanceof Error ? error.message : "The project could not be deleted." };
    }
    // Confirmed deleted: the screen now drops exactly what the database dropped.
    const taskIds = new Set((tasksByProject[projectId] ?? []).map((task) => task.id));
    const removedBaselines = new Set(baselines.filter((baseline) => baseline.projectId === projectId).map((baseline) => baseline.id));
    const nextProjects = projects.filter((item) => item.id !== projectId);
    const nextTasksByProject = { ...tasksByProject };
    delete nextTasksByProject[projectId];
    const nextAssignments = assignments.filter((assignment) => !taskIds.has(assignment.taskId));
    const nextPlanVersions = planVersions.filter((version) => version.projectId !== projectId);
    const nextBaselines = baselines.filter((baseline) => baseline.projectId !== projectId);
    const nextBaselineTasks = baselineTasks.filter((row) => !removedBaselines.has(row.baselineId));
    // What the screen is about to show is already stored, so it is recorded as
    // synced instead of being written a second time.
    lastSyncedRef.current = JSON.stringify(buildWorkspacePayload({
      projects: nextProjects,
      tasksByProject: nextTasksByProject,
      system,
      resources,
      assignments: nextAssignments,
      planVersions: nextPlanVersions,
      baselines: nextBaselines,
      baselineTasks: nextBaselineTasks,
    }));
    setProjects(nextProjects);
    setTasksByProject(nextTasksByProject);
    setAssignments(nextAssignments);
    setPlanVersions(nextPlanVersions);
    setBaselines(nextBaselines);
    setBaselineTasks(nextBaselineTasks);
    if (activeProjectId === projectId) setActiveProjectId(regularProjects.find((item) => item.id !== projectId && item.status === "active")?.id ?? regularProjects.find((item) => item.id !== projectId)?.id ?? "");
    return { ok: true, taskCount };
  }, [activeProjectId, assignments, baselineTasks, baselines, buildWorkspacePayload, deleteProjectRemote, planVersions, projects, resources, system, tasksByProject]);

  /**
   * Deletes tasks (with their subtree) from one project. The database goes first
   * and the answer is awaited, so the caller can leave its plan untouched when the
   * delete is refused. The assignments those tasks owned are dropped here as well;
   * the caller owns the task list and its recalculation.
   */
  const deleteTasks = useCallback<CalendarStoreValue["deleteTasks"]>(async (projectId, taskIds) => {
    if (!taskIds.length) return { ok: true, removedTaskIds: [] };
    let removedTaskIds = taskIds;
    try {
      const result = (await deleteTasksRemote({ projectId, taskIds })) as { taskIds?: string[] } | null;
      if (result?.taskIds?.length) removedTaskIds = result.taskIds;
    } catch (error: unknown) {
      return { ok: false, removedTaskIds: [], message: error instanceof Error ? error.message : "The task could not be deleted." };
    }
    const doomed = new Set(removedTaskIds);
    const nextAssignments = assignments.filter((assignment) => !doomed.has(assignment.taskId));
    setAssignments(nextAssignments);
    return { ok: true, removedTaskIds };
  }, [assignments, deleteTasksRemote]);

  /**
   * Deletes one employee with everything that only existed for them: their
   * assignments, their person calendar and that calendar's leave rows. Awaited,
   * so the directory and the capacity figures change only after the database
   * confirmed the delete.
   */
  const deleteResource = useCallback<CalendarStoreValue["deleteResource"]>(async (id) => {
    try {
      await deleteResourceRemote({ resourceId: id });
    } catch (error: unknown) {
      return { ok: false, message: error instanceof Error ? error.message : "The employee could not be deleted." };
    }
    const resource = resources.find((item) => item.id === id);
    const nextResources = resources.filter((item) => item.id !== id);
    const nextAssignments = assignments.filter((assignment) => assignment.resourceId !== id);
    // Only the employee's own calendar follows them: the shared base calendar and
    // a calendar another project or employee still uses must stay.
    const own = resource ? system.calendars.find((calendar) => calendar.id === resource.calendarId) : undefined;
    const sharedWithProject = resource ? projects.some((project) => (project.kind ?? (project.status === "template" ? "template" : "project")) === "project" && project.calendarId === resource.calendarId) : false;
    const sharedWithEmployee = resource ? resources.some((item) => item.id !== id && item.calendarId === resource.calendarId) : false;
    const dropCalendar = Boolean(own && !own.isDefault && !sharedWithProject && !sharedWithEmployee);
    const nextSystem = resource && dropCalendar
      ? { ...system, calendars: system.calendars.filter((calendar) => calendar.id !== resource.calendarId), exceptions: system.exceptions.filter((exception) => exception.calendarId !== resource.calendarId) }
      : system;
    lastSyncedRef.current = JSON.stringify(buildWorkspacePayload({
      projects, tasksByProject, system: nextSystem, resources: nextResources, assignments: nextAssignments, planVersions, baselines, baselineTasks,
    }));
    setResources(nextResources);
    setAssignments(nextAssignments);
    if (resource) setSystem(nextSystem);
    return { ok: true };
  }, [assignments, baselineTasks, baselines, buildWorkspacePayload, deleteResourceRemote, planVersions, projects, resources, system, tasksByProject]);

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
      setTasksByProject((current) => recalculateProjects(current, projects, nextSystem, planVersions));
    },
    [projects, planVersions],
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
        const absorbed = absorbMonitoringMargins(projectTasks, projectId, calendarId, effectiveSystem, planVersions);
        const result = recalculateTasks(absorbed, {
          direction: "forward",
          calendarSystem: effectiveSystem,
          projectCalendarId: calendarId,
        });
        return result.error ? current : { ...current, [projectId]: result.tasks };
      });
    },
    [projects, system, planVersions],
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

  /**
   * Deletes one calendar with its exception rows. The server repeats every guard
   * below and is awaited before anything leaves the screen, so a refusal — the
   * base calendar, a calendar a project or an employee still uses, one another
   * calendar inherits from — keeps the calendar in place with a clear reason.
   */
  const deleteCalendar = useCallback<CalendarStoreValue["deleteCalendar"]>(
    async (id) => {
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
      const staffed = resources.filter((resource) => resource.calendarId === id);
      if (staffed.length) {
        return {
          ok: false,
          message: `${staffed.length} employee${staffed.length === 1 ? "" : "s"} still use this calendar (${staffed
            .map((resource) => resource.name)
            .join(", ")}). Delete those employees or move them to another calendar first.`,
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
      try {
        await deleteCalendarRemote({ calendarId: id });
      } catch (error: unknown) {
        return { ok: false, message: error instanceof Error ? error.message : "The calendar could not be deleted." };
      }
      const nextSystem = {
        ...system,
        calendars: system.calendars.filter((item) => item.id !== id),
        exceptions: system.exceptions.filter((exception) => exception.calendarId !== id),
      };
      lastSyncedRef.current = JSON.stringify(buildWorkspacePayload({
        projects, tasksByProject, system: nextSystem, resources, assignments, planVersions, baselines, baselineTasks,
      }));
      setSystem(nextSystem);
      return { ok: true };
    },
    [assignments, baselineTasks, baselines, buildWorkspacePayload, deleteCalendarRemote, planVersions, projects, resources, system, tasksByProject],
  );

  /**
   * Drops every protected record from the screen. Called the moment access
   * ends, so a removed account, a suspended company or a signed-out visitor can
   * never leave a stale workspace on screen.
   */
  const resetWorkspace = useCallback(() => {
    setSystem({ calendars: [], exceptions: [], defaultCalendarId: "" });
    setProjects([]);
    setResources([]);
    setAssignments([]);
    setTasksByProject({});
    setActiveProjectId("");
    setActiveVersionId("");
    setPlanVersions([]);
    setBaselines([]);
    setBaselineTasks([]);
    setFocusTask(null);
    hydratedRef.current = false;
    migrationStartedRef.current = false;
    companyStartedRef.current = false;
    removalSignOutRef.current = false;
    restoringRef.current = false;
    lastServerStateRef.current = null;
    lastSyncedRef.current = null;
  }, []);

  /**
   * Access ended: clear the screen, and — when a session still exists — drop it
   * and return to Sign in. Every protected read and write refuses the account
   * server-side already; this makes the screens agree.
   */
  useEffect(() => {
    if (!accessEnded(access)) return;
    resetWorkspace();
    if (access === "signed-out" || removalSignOutRef.current) return;
    removalSignOutRef.current = true;
    // A removed account is told exactly that; any other ended session (signed
    // out, expired, suspended company) gets the neutral message. Neither names
    // a person, a project or another company.
    toast.error(accessInfo?.removed === true ? REMOVED_ACCESS_MESSAGE : ACCESS_ENDED_MESSAGE);
    void signOut();
  }, [access, resetWorkspace, signOut]);

  const invitationAction = async (run: () => Promise<{ token: string; email: string }>, done: (email: string) => string) => {
    try {
      const result = await run();
      const link = invitationAcceptHref(result.token, typeof window === "undefined" ? "" : window.location.origin);
      try {
        await sendInvitationEmailRemote({ token: result.token, link });
      } catch (error) {
        // Never the error object, and never the link in the message: a mail
        // failure can echo the message body, which carries the single-use value.
        console.error("[vintage-gantt] the invitation email could not be sent");
        return { ok: true, message: `Invitation created for ${result.email}, but the email could not be sent. Use Resend to try again.` };
      }
      return { ok: true, message: done(result.email) };
    } catch (error: unknown) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };

  const inviteCompanyMember = useCallback<CalendarStoreValue["inviteCompanyMember"]>(
    (email) => invitationAction(() => inviteMemberRemote({ email: email.trim() }), (address) => `Invitation sent to ${address}.`),
    [inviteMemberRemote, sendInvitationEmailRemote],
  );

  const resendCompanyInvitation = useCallback<CalendarStoreValue["resendCompanyInvitation"]>(
    (email) => invitationAction(
      () => resendInvitationRemote({ email: email.trim() }),
      (address) => `New invitation sent to ${address}. The previous link no longer works.`,
    ),
    [resendInvitationRemote, sendInvitationEmailRemote],
  );

  const revokeCompanyInvitation = useCallback<CalendarStoreValue["revokeCompanyInvitation"]>(async (invitationId) => {
    try {
      await revokeInvitationRemote({ invitationId: invitationId as Id<"invitations"> });
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }, [revokeInvitationRemote]);

  const removeCompanyMember = useCallback<CalendarStoreValue["removeCompanyMember"]>(async (userId) => {
    try {
      await removeMemberRemote({ userId: userId as Id<"users"> });
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }, [removeMemberRemote]);

  const transferCompanyAdmin = useCallback<CalendarStoreValue["transferCompanyAdmin"]>(async (userId) => {
    try {
      await transferAdminRemote({ userId: userId as Id<"users"> });
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }, [transferAdminRemote]);

  const setCompanyMemberRole = useCallback<CalendarStoreValue["setCompanyMemberRole"]>(async (userId, role) => {
    try {
      await setCompanyMemberRoleRemote({ userId: userId as Id<"users">, role });
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }, [setCompanyMemberRoleRemote]);

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
      restoreProject,
      deleteProject,
      deleteTasks,
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
      deleteResource,
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
      setProjectClient,
      openTask,
      focusTask,
      clearFocusTask,
      company,
      companyRole,
      canManageMembers: roleCanManageMembers(companyRole),
      setCompanyMemberRole,
      accessRemoved,
      pendingInvitations,
      inviteCompanyMember,
      resendCompanyInvitation,
      revokeCompanyInvitation,
      removeCompanyMember,
      transferCompanyAdmin,
    }),
    [
      system, projects, activeProject, activeProjectId, setActiveProject, tasks, projectTasks, setTasks, setProjectCalendar, createProject, createProjectFromTemplate, saveAsTemplate, setTemplateHidden, deleteTemplate, renameProject, duplicateProject, archiveProject, restoreProject, deleteProject, deleteTasks, calendarsUsingProjects,
      projectsAffectedBy, previewCalendarChange, previewProjectRelink, applyCalendarSystem,
      createCalendar, duplicateCalendar, renameCalendar, deleteCalendar, resources, assignments,
      updateResource, updateResourceSchedule, createResource, deleteResource, setTaskAssignments, addResourceLeave, removeResourceLeave, resourceLeave,
      planVersions, baselines, baselineTasks, createBaseline, deleteBaseline, activeVersionId, setActiveVersion, createPlanVersion, replanProject, deletePlanVersion, setPlanMode, setProjectClient, openTask, focusTask, clearFocusTask,
      company, companyRole, setCompanyMemberRole, accessRemoved, pendingInvitations,
      inviteCompanyMember, resendCompanyInvitation, revokeCompanyInvitation, removeCompanyMember, transferCompanyAdmin,
    ],
  );

  return <CalendarStoreContext.Provider value={value}>{children}</CalendarStoreContext.Provider>;
}

export function useCalendarStore() {
  const value = useContext(CalendarStoreContext);
  if (!value) throw new Error("useCalendarStore must be used inside CalendarStoreProvider");
  return value;
}
