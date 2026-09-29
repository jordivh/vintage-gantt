/**
 * Company-based access — the rules, the counters and the migration report.
 *
 * Both sides of the app use this module: the Convex backend (`src/convex`) for
 * its access decisions and its migration audit, and the app shell for the
 * account menu. It is deliberately pure — no Convex, no React, no DOM — so the
 * backend can import it without pulling in browser code.
 */

/* ------------------------------------------------------------------ roles */

/**
 * The company has exactly two account types. They differ in one place only:
 * managing users and invitations. Projects, planning, resources, calendars and
 * capacity behave identically for both.
 */
export const COMPANY_ROLES = ["company_admin", "user"] as const;
export type CompanyRole = (typeof COMPANY_ROLES)[number];

export const COMPANY_ADMIN: CompanyRole = "company_admin";
export const COMPANY_USER: CompanyRole = "user";

export const COMPANY_ROLE_LABELS: Record<CompanyRole, string> = {
  company_admin: "Company admin",
  user: "User",
};

export const COMPANY_ROLE_DESCRIPTIONS: Record<CompanyRole, string> = {
  company_admin: "Manages users and invitations.",
  user: "Same rights for projects, planning, resources, calendars and capacity.",
};

/* --------------------------------------------------------------- companies */

/** A suspended company is cut off from its data without anything being removed. */
export const COMPANY_STATUSES = ["active", "suspended"] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export const COMPANY_ACTIVE: CompanyStatus = "active";
export const DEFAULT_COMPANY_STATUS: CompanyStatus = COMPANY_ACTIVE;

export const COMPANY_STATUS_LABELS: Record<CompanyStatus, string> = {
  active: "Active",
  suspended: "Suspended",
};

export function isCompanyRole(value: unknown): value is CompanyRole {
  return typeof value === "string" && (COMPANY_ROLES as readonly string[]).includes(value);
}

export function isCompanyStatus(value: unknown): value is CompanyStatus {
  return typeof value === "string" && (COMPANY_STATUSES as readonly string[]).includes(value);
}

/** Anything unknown or missing is a plain user — never silently promote. */
export function normalizeCompanyRole(value: unknown): CompanyRole {
  return isCompanyRole(value) ? value : COMPANY_USER;
}

/** Only user and invitation management is admin-only. */
export function canManageMembers(role: unknown): boolean {
  return normalizeCompanyRole(role) === COMPANY_ADMIN;
}

const SHARED_MAIL_DOMAINS = new Set([
  "gmail", "googlemail", "hotmail", "outlook", "live", "msn", "yahoo", "ymail",
  "icloud", "me", "mac", "protonmail", "proton", "gmx", "web", "telenet", "ziggo",
]);

/**
 * A readable name for the workspace that is created for a brand-new account: the
 * organisation's domain when the address looks like a work address, otherwise a
 * name built from the account.
 */
export function defaultCompanyName(account: { name?: string | null; email?: string | null }): string {
  const email = (account.email ?? "").trim().toLowerCase();
  const domain = email.includes("@") ? email.slice(email.indexOf("@") + 1).split(".")[0] : "";
  if (domain && !SHARED_MAIL_DOMAINS.has(domain)) {
    return domain.charAt(0).toUpperCase() + domain.slice(1);
  }
  const name = (account.name ?? "").trim();
  return name ? `${name}'s company` : "My company";
}

/* -------------------------------------------------- company-owned records */

/**
 * Every table whose rows belong to exactly one company. Rows can carry the link
 * themselves (projects, calendars, employees, …) or inherit it through a parent
 * that is always checked (a task through its project, a leave entry through its
 * calendar, a baseline snapshot through its baseline).
 */
export const COMPANY_SCOPED_TABLES = [
  "projects",
  "tasks",
  "dependencies",
  "calendars",
  "calendarExceptions",
  "resources",
  "taskAssignments",
  "planVersions",
  "baselines",
  "baselineTasks",
  "seedRuns",
] as const;
export type CompanyScopedTable = (typeof COMPANY_SCOPED_TABLES)[number];

export interface CompanyOwnedRow {
  companyId?: unknown;
  [key: string]: unknown;
}

/** True when a stored row still has to receive its company link. */
export function needsCompany(row: CompanyOwnedRow): boolean {
  return typeof row.companyId !== "string" || row.companyId.length === 0;
}

export function rowsNeedingCompany<T extends CompanyOwnedRow>(rows: readonly T[]): T[] {
  return rows.filter(needsCompany);
}

/* ------------------------------------------------------------- accounting */

export interface WorkspaceSnapshot {
  projects?: CompanyOwnedRow[];
  tasks?: CompanyOwnedRow[];
  dependencies?: CompanyOwnedRow[];
  calendars?: CompanyOwnedRow[];
  calendarExceptions?: CompanyOwnedRow[];
  resources?: CompanyOwnedRow[];
  taskAssignments?: CompanyOwnedRow[];
  planVersions?: CompanyOwnedRow[];
  baselines?: CompanyOwnedRow[];
  baselineTasks?: CompanyOwnedRow[];
  seedRuns?: CompanyOwnedRow[];
}

export interface WorkspaceCounts {
  projects: number;
  tasks: number;
  dependencies: number;
  calendars: number;
  calendarExceptions: number;
  resources: number;
  taskAssignments: number;
  planVersions: number;
  baselines: number;
  baselineTasks: number;
  seedRuns: number;
}

export const EMPTY_WORKSPACE_COUNTS: WorkspaceCounts = {
  projects: 0, tasks: 0, dependencies: 0, calendars: 0, calendarExceptions: 0,
  resources: 0, taskAssignments: 0, planVersions: 0, baselines: 0, baselineTasks: 0,
  seedRuns: 0,
};

/** How many records exist per table. */
export function workspaceCounts(snapshot: WorkspaceSnapshot): WorkspaceCounts {
  return {
    projects: (snapshot.projects ?? []).length,
    tasks: (snapshot.tasks ?? []).length,
    dependencies: (snapshot.dependencies ?? []).length,
    calendars: (snapshot.calendars ?? []).length,
    calendarExceptions: (snapshot.calendarExceptions ?? []).length,
    resources: (snapshot.resources ?? []).length,
    taskAssignments: (snapshot.taskAssignments ?? []).length,
    planVersions: (snapshot.planVersions ?? []).length,
    baselines: (snapshot.baselines ?? []).length,
    baselineTasks: (snapshot.baselineTasks ?? []).length,
    seedRuns: (snapshot.seedRuns ?? []).length,
  };
}

/** Field-by-field differences between two count sets, as readable lines. */
export function workspaceCountDifferences(before: WorkspaceCounts, after: WorkspaceCounts): string[] {
  const keys = Object.keys(EMPTY_WORKSPACE_COUNTS) as (keyof WorkspaceCounts)[];
  return keys
    .filter((key) => before[key] !== after[key])
    .map((key) => `${key}: ${before[key]} → ${after[key]}`);
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export interface PlanningTotals {
  tasks: number;
  leafTasks: number;
  summaryTasks: number;
  milestones: number;
  totalDurationDays: number;
  totalWorkHours: number;
  marginPlannedDays: number;
  marginConsumedDays: number;
  dependencies: number;
  baselineSnapshots: number;
  earliestStart: string | null;
  latestFinish: string | null;
}

/**
 * The handful of numbers that describe a plan. They are derived from the stored
 * records only, so they must be identical before and after the migration —
 * linking records to a company never moves a date, a duration or a margin.
 */
export function planningTotals(snapshot: WorkspaceSnapshot): PlanningTotals {
  const tasks = snapshot.tasks ?? [];
  const ids = new Set(tasks.map((task) => text(task.id)));
  const summaries = new Set(
    tasks
      .map((task) => text(task.parentId))
      .filter((parentId) => parentId.length > 0 && ids.has(parentId)),
  );
  let totalDurationDays = 0;
  let totalWorkHours = 0;
  let marginPlannedDays = 0;
  let marginConsumedDays = 0;
  let milestones = 0;
  let earliestStart: string | null = null;
  let latestFinish: string | null = null;
  for (const task of tasks) {
    const id = text(task.id);
    const duration = number(task.duration);
    totalDurationDays += duration;
    totalWorkHours += number(task.work);
    marginPlannedDays += number(task.marginDaysOriginal);
    marginConsumedDays += number(task.marginDaysConsumed);
    const isSummary = summaries.has(id);
    if (task.isMilestone === true || (duration === 0 && !isSummary)) milestones += 1;
    const start = text(task.start);
    if (start && (earliestStart === null || start < earliestStart)) earliestStart = start;
    const finish = text(task.finish);
    if (finish && (latestFinish === null || finish > latestFinish)) latestFinish = finish;
  }
  return {
    tasks: tasks.length,
    leafTasks: tasks.length - summaries.size,
    summaryTasks: summaries.size,
    milestones,
    totalDurationDays,
    totalWorkHours,
    marginPlannedDays,
    marginConsumedDays,
    dependencies: (snapshot.dependencies ?? []).length,
    baselineSnapshots: (snapshot.baselineTasks ?? []).length,
    earliestStart,
    latestFinish,
  };
}

/** Human-readable differences between two planning totals, or [] when identical. */
export function planningTotalsDifferences(before: PlanningTotals, after: PlanningTotals): string[] {
  const keys = Object.keys(before) as (keyof PlanningTotals)[];
  return keys
    .filter((key) => before[key] !== after[key])
    .map((key) => `${key}: ${String(before[key])} → ${String(after[key])}`);
}

export function planningTotalsMatch(before: PlanningTotals, after: PlanningTotals): boolean {
  return planningTotalsDifferences(before, after).length === 0;
}

/* ------------------------------------------------------- migration report */

export interface CompanyMigrationReport {
  /** False when the workspace already had a company: the migration is a no-op. */
  created: boolean;
  companyId: string;
  companyName: string;
  role: CompanyRole;
  /** Rows that received their company link in this run. */
  rowsLinked: number;
  rowsLinkedPerTable: Record<string, number>;
  counts: { before: WorkspaceCounts; after: WorkspaceCounts };
  totals: { before: PlanningTotals; after: PlanningTotals };
  /** Empty when record counts and planning totals came out identical. */
  mismatch: string[];
}

export function migrationSummaryLines(report: CompanyMigrationReport): string[] {
  const lines = [
    report.created
      ? `Created company "${report.companyName}" and linked ${report.rowsLinked} existing record(s).`
      : `Company "${report.companyName}" already exists; nothing to migrate.`,
    `Records: ${report.counts.after.projects} projects, ${report.counts.after.tasks} tasks, ${report.counts.after.dependencies} dependencies, ${report.counts.after.resources} employees, ${report.counts.after.calendars} calendars, ${report.counts.after.baselines} baselines.`,
    `Plan: ${report.totals.after.tasks} tasks (${report.totals.after.milestones} milestone(s)) · ${report.totals.after.totalDurationDays} d · margin ${report.totals.after.marginPlannedDays} d planned / ${report.totals.after.marginConsumedDays} d consumed.`,
  ];
  if (report.mismatch.length) lines.push(`Mismatch detected — nothing was written: ${report.mismatch.join("; ")}`);
  return lines;
}

/* ------------------------------------------------------------ access rules */

export interface AccessDecision {
  ok: boolean;
  message?: string;
}

export interface RoleChangeRequest {
  actorUserId: string;
  actorRole: unknown;
  targetUserId: string;
  nextRole: unknown;
  /** How many company admins the company has, including the target. */
  adminCount: number;
}

/** Admin-only, and a company always keeps at least one company admin. */
export function roleChangeDecision(request: RoleChangeRequest): AccessDecision {
  if (!canManageMembers(request.actorRole)) {
    return { ok: false, message: "Only a company admin can change account types." };
  }
  if (!isCompanyRole(request.nextRole)) {
    return { ok: false, message: "Unknown account type." };
  }
  if (request.nextRole !== COMPANY_ADMIN && request.adminCount <= 1) {
    return { ok: false, message: "A company always needs at least one company admin." };
  }
  return { ok: true };
}

export interface MemberAttachRequest {
  actorRole: unknown;
  /** The company the account already belongs to, if any. */
  existingCompanyId?: string | null;
  companyId: string;
}

/** Admin-only; an account belongs to exactly one company. */
export function memberAttachDecision(request: MemberAttachRequest): AccessDecision {
  if (!canManageMembers(request.actorRole)) {
    return { ok: false, message: "Only a company admin can manage users." };
  }
  if (request.existingCompanyId && request.existingCompanyId === request.companyId) {
    return { ok: false, message: "This account is already part of the company." };
  }
  if (request.existingCompanyId) {
    return { ok: false, message: "This account already belongs to another company." };
  }
  return { ok: true };
}
