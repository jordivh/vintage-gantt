import { internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { canonical as stableCanonical, fingerprint, projectInputs, affectedProjects, type Workspace, type WorkspaceChange, type WorkspaceGuard, type WorkspaceRow, workspaceTables } from "../lib/workspace-changes";
import type { Doc, Id } from "./_generated/dataModel";
import {
  describeReferences,
  outsideCompanyReferences,
  workspaceIsolationReport,
  type WorkspaceRelationRows,
} from "../lib/company-integrity";
import { pruneDeadPredecessors, remapPredecessorText } from "../lib/planner-model";
import { R3_CHRIS_LEAVE, R3_PROJECTS, R3_RESOURCES, R3_SEED_KEY } from "../lib/r3-fixture";
import { companyTable, requireCompany, rowsByOwner, viewerScope } from "./companies";
import type { CompanyScopedTable } from "../lib/company-scope";

/**
 * The workspace: projects, plans, calendars, people and capacity.
 *
 * Every read and write path here is scoped to the company of the signed-in
 * account. The company is resolved from the session (`viewerScope` /
 * `requireCompany`); a company id supplied by the browser is never accepted, and
 * every inserted record is stamped with the session's company. `ownerId` stays
 * as the "who wrote it" trail next to the company link.
 */

/* --------------------------------------------------------------- scoping */

/** Company whose data the caller may read, or null when signed out/inactive. */
const readableScope = async (ctx: QueryCtx | MutationCtx) => {
  const scope = await viewerScope(ctx);
  if (!scope) return null;
  // An account that still has a temporary password reads no planning data.
  if (scope.mustChangePassword) return null;
  if (!scope.companyId) return { userId: scope.userId, companyId: null, role: scope.role };
  const company = await ctx.db.get(scope.companyId);
  if (!company || company.status !== "active") return null;
  return { userId: scope.userId, companyId: scope.companyId, role: scope.role };
};

/** Never persists a company or owner supplied by the browser. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const withoutScope = (item: any): any => {
  const { companyId: _companyId, ownerId: _ownerId, _id: _storageId, _creationTime: _storageTime, ...rest } = item;
  return rest;
};

type StateTables = {
  projects: Doc<"projects">;
  tasks: Doc<"tasks">;
  dependencies: Doc<"dependencies">;
  calendars: Doc<"calendars">;
  calendarExceptions: Doc<"calendarExceptions">;
  resources: Doc<"resources">;
  taskAssignments: Doc<"taskAssignments">;
  planVersions: Doc<"planVersions">;
  baselines: Doc<"baselines">;
  baselineTasks: Doc<"baselineTasks">;
};

/** Drops the storage-only columns; the client never sees the company link. */
const stripScope = <T extends { _id: unknown; _creationTime: number; ownerId: unknown; companyId?: unknown }>(rows: T[]) =>
  rows.map((row) => {
    const { _id: _id, _creationTime: _creationTime, ownerId: _ownerId, companyId: _companyId, ...item } = row;
    return item;
  });

type StateRows = { [P in keyof StateTables]: StateTables[P][] };

const stateFrom = (rows: StateRows) => ({
  projects: stripScope(rows.projects),
  tasks: stripScope(rows.tasks),
  dependencies: stripScope(rows.dependencies),
  calendars: stripScope(rows.calendars),
  exceptions: stripScope(rows.calendarExceptions),
  resources: stripScope(rows.resources),
  assignments: stripScope(rows.taskAssignments),
  planVersions: stripScope(rows.planVersions),
  baselines: stripScope(rows.baselines),
  baselineTasks: stripScope(rows.baselineTasks),
});

const isEmptyState = (state: ReturnType<typeof stateFrom>) =>
  !state.projects.length && !state.calendars.length && !state.resources.length && !state.tasks.length;

/** Everything the company owns, through the company indices only. */
const collectCompanyState = async (ctx: QueryCtx | MutationCtx, companyId: Id<"companies">) => {
  const [projects, tasks, dependencies, calendars, calendarExceptions, resources, taskAssignments, planVersions, baselines, baselineTasks] = await Promise.all([
    companyTable(ctx, "projects", companyId),
    companyTable(ctx, "tasks", companyId),
    companyTable(ctx, "dependencies", companyId),
    companyTable(ctx, "calendars", companyId),
    companyTable(ctx, "calendarExceptions", companyId),
    companyTable(ctx, "resources", companyId),
    companyTable(ctx, "taskAssignments", companyId),
    companyTable(ctx, "planVersions", companyId),
    companyTable(ctx, "baselines", companyId),
    companyTable(ctx, "baselineTasks", companyId),
  ]);
  return stateFrom({ projects, tasks, dependencies, calendars, calendarExceptions, resources, taskAssignments, planVersions, baselines, baselineTasks });
};

/** Pre-migration fallback: only the caller's own rows, never another account's. */
const collectOwnerState = async (ctx: QueryCtx | MutationCtx, userId: Id<"users">) => {
  const [projects, tasks, dependencies, calendars, calendarExceptions, resources, taskAssignments, planVersions, baselines, baselineTasks] = await Promise.all([
    rowsByOwner(ctx, "projects", userId) as Promise<Doc<"projects">[]>,
    rowsByOwner(ctx, "tasks", userId) as Promise<Doc<"tasks">[]>,
    rowsByOwner(ctx, "dependencies", userId) as Promise<Doc<"dependencies">[]>,
    rowsByOwner(ctx, "calendars", userId) as Promise<Doc<"calendars">[]>,
    rowsByOwner(ctx, "calendarExceptions", userId) as Promise<Doc<"calendarExceptions">[]>,
    rowsByOwner(ctx, "resources", userId) as Promise<Doc<"resources">[]>,
    rowsByOwner(ctx, "taskAssignments", userId) as Promise<Doc<"taskAssignments">[]>,
    rowsByOwner(ctx, "planVersions", userId) as Promise<Doc<"planVersions">[]>,
    rowsByOwner(ctx, "baselines", userId) as Promise<Doc<"baselines">[]>,
    rowsByOwner(ctx, "baselineTasks", userId) as Promise<Doc<"baselineTasks">[]>,
  ]);
  return stateFrom({ projects, tasks, dependencies, calendars, calendarExceptions, resources, taskAssignments, planVersions, baselines, baselineTasks });
};

const checkWorkspaceBase = async (ctx: MutationCtx, companyId: Id<"companies">, expected?: string) => {
  if (!expected || expected !== await fingerprint(await collectCompanyState(ctx, companyId) as Workspace)) {
    throw new ConvexError({ code: "SAVE_CONFLICT", message: "This workspace changed. The operation was not applied. Your input is still available." });
  }
};

const COMPANY_FIELDS = (company: { name: string; status: string }) => ({ name: company.name, status: company.status });

export const getState = query({
  args: {},
  handler: async (ctx) => {
    const scope = await readableScope(ctx);
    if (!scope) return null;
    if (scope.companyId) {
      const company = await ctx.db.get(scope.companyId);
      if (!company) return null;
      const state = await collectCompanyState(ctx, scope.companyId);
      return isEmptyState(state)
        ? null
        : { ...state, company: COMPANY_FIELDS(company), role: scope.role, companyId: scope.companyId as string };
    }
    const state = await collectOwnerState(ctx, scope.userId);
    return isEmptyState(state) ? null : { ...state, company: null, role: scope.role, companyId: null };
  },
});

const TEST_SEED_KEY = "TP-R2";
const STARTER_SEED_KEY = "STARTER-PROJECT";
const TEST_PROJECT_ID = "proj-tp-r2";
const TEST_VERSION_ID = "version-tp-r2-1";

const templateTaskId = () => crypto.randomUUID().replace(/\D/g, "");
const dateShift = (date: string, amount: number) => {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + amount);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
};
const isWorkingDate = (date: string, calendarId: string, calendars: any[], exceptions: any[]) => {
  const chain: any[] = [];
  let current = calendars.find((calendar) => calendar.id === calendarId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.parentCalendarId ? calendars.find((calendar) => calendar.id === current.parentCalendarId) : undefined;
  }
  for (const calendar of chain) {
    const exception = exceptions.filter((item) => item.calendarId === calendar.id && item.startDate <= date && item.endDate >= date)
      .sort((a, b) => Number(b.isWorkingDay) - Number(a.isWorkingDay))[0];
    if (exception) return exception.isWorkingDay;
  }
  const pattern = chain.find((calendar) => calendar.workingDays?.length)?.workingDays ?? [1, 2, 3, 4, 5];
  return pattern.includes(new Date(`${date}T12:00:00`).getDay());
};
const resolveWorkingDate = (date: string, calendarId: string, calendars: any[], exceptions: any[]) => {
  let result = date;
  while (!isWorkingDate(result, calendarId, calendars, exceptions)) result = dateShift(result, 1);
  return result;
};
const addWorkingDateOffset = (date: string, amount: number, calendarId: string, calendars: any[], exceptions: any[]) => {
  let result = resolveWorkingDate(date, calendarId, calendars, exceptions);
  const direction = amount < 0 ? -1 : 1;
  let remaining = Math.abs(amount);
  while (remaining > 0) {
    result = dateShift(result, direction);
    if (isWorkingDate(result, calendarId, calendars, exceptions)) remaining -= 1;
  }
  return result;
};
const workingDateOffset = (from: string, to: string, calendarId: string, calendars: any[], exceptions: any[]) => {
  if (from === to) return 0;
  const direction = to > from ? 1 : -1;
  let cursor = from;
  let count = 0;
  while (cursor !== to) {
    cursor = dateShift(cursor, direction);
    if (isWorkingDate(cursor, calendarId, calendars, exceptions)) count += direction;
  }
  return count;
};
const finishDateFor = (start: string, duration: number, unit: string, calendarId: string, calendars: any[], exceptions: any[]) => {
  const days = Math.max(0, unit === "weeks" ? duration * 5 : duration);
  return days <= 1 ? start : addWorkingDateOffset(start, days - 1, calendarId, calendars, exceptions);
};
/**
 * Remaps a stored predecessor string onto copied task ids, keeping type and lag.
 * A token that cannot be resolved fails the whole copy instead of silently
 * producing a template/project with missing links.
 */
const rewritePredecessors = (
  text: string,
  idMap: Map<string, string>,
  tasks: { id: string; parentId?: string | null; predecessors: string }[],
) => {
  const remapped = remapPredecessorText(text, idMap, tasks);
  if (remapped.unmapped.length) throw new Error(`Could not copy the plan: ${remapped.unmapped.length} predecessor reference(s) could not be remapped (${remapped.unmapped.slice(0, 3).join(", ")}).`);
  return remapped.value;
};

const testTasks = (versionId: string) => [
  { id: "92026001", projectId: TEST_PROJECT_ID, parentId: null, sortOrder: 0, name: "Voorbereiding", startOffsetDays: 0, duration: 0, durationUnit: "days", start: "2026-10-05", finish: "2026-10-13", isMilestone: false, predecessors: "", resource: "", percent: 0, notes: "", color: "ochre", collapsed: false, versionId, marginPct: 0, marginDaysOriginal: 0, marginDaysConsumed: 0 },
  { id: "92026002", projectId: TEST_PROJECT_ID, parentId: "92026001", sortOrder: 1, name: "Concept opstellen", startOffsetDays: 0, duration: 5, durationUnit: "days", start: "2026-10-05", finish: "2026-10-09", isMilestone: false, predecessors: "", resource: "", percent: 0, notes: "", color: "ochre", versionId, marginPct: 20, marginDaysOriginal: 1, marginDaysConsumed: 0 },
  { id: "92026003", projectId: TEST_PROJECT_ID, parentId: "92026001", sortOrder: 2, name: "Concept nakijken", startOffsetDays: 5, duration: 2, durationUnit: "days", start: "2026-10-12", finish: "2026-10-13", isMilestone: false, predecessors: "92026002FS", resource: "", percent: 0, notes: "", color: "sage", versionId, marginPct: 0, marginDaysOriginal: 0, marginDaysConsumed: 0 },
  { id: "92026004", projectId: TEST_PROJECT_ID, parentId: null, sortOrder: 3, name: "Uitvoering", startOffsetDays: 7, duration: 0, durationUnit: "days", start: "2026-10-14", finish: "2026-10-30", isMilestone: false, predecessors: "", resource: "", percent: 0, notes: "", color: "clay", collapsed: false, versionId, marginPct: 0, marginDaysOriginal: 0, marginDaysConsumed: 0 },
  { id: "92026005", projectId: TEST_PROJECT_ID, parentId: "92026004", sortOrder: 4, name: "Bouwen", startOffsetDays: 7, duration: 10, durationUnit: "days", start: "2026-10-14", finish: "2026-10-27", isMilestone: false, predecessors: "92026003FS", resource: "", percent: 0, notes: "", color: "clay", versionId, marginPct: 10, marginDaysOriginal: 1, marginDaysConsumed: 0 },
  { id: "92026006", projectId: TEST_PROJECT_ID, parentId: "92026004", sortOrder: 5, name: "Documentatie", startOffsetDays: 7, duration: 4, durationUnit: "days", start: "2026-10-14", finish: "2026-10-19", isMilestone: false, predecessors: "92026003FS", resource: "", percent: 0, notes: "", color: "ink", versionId, marginPct: 50, marginDaysOriginal: 2, marginDaysConsumed: 0 },
  { id: "92026007", projectId: TEST_PROJECT_ID, parentId: "92026004", sortOrder: 6, name: "Testen", startOffsetDays: 17, duration: 3, durationUnit: "days", start: "2026-10-28", finish: "2026-10-30", isMilestone: false, predecessors: "92026005FS", resource: "", percent: 0, notes: "", color: "rust", versionId, marginPct: 0, marginDaysOriginal: 0, marginDaysConsumed: 0 },
  { id: "92026008", projectId: TEST_PROJECT_ID, parentId: null, sortOrder: 7, name: "Oplevering", startOffsetDays: 20, duration: 0, durationUnit: "days", start: "2026-11-02", finish: "2026-11-02", isMilestone: true, predecessors: "92026007FS", resource: "", percent: 0, notes: "", color: "rust", versionId, marginPct: 0, marginDaysOriginal: 0, marginDaysConsumed: 0 },
];

const testDependencies = [
  { id: "dep-tp-r2-2-3", projectId: TEST_PROJECT_ID, predecessorId: "92026002", successorId: "92026003", type: "FS", lagDays: 0 },
  { id: "dep-tp-r2-3-5", projectId: TEST_PROJECT_ID, predecessorId: "92026003", successorId: "92026005", type: "FS", lagDays: 0 },
  { id: "dep-tp-r2-3-6", projectId: TEST_PROJECT_ID, predecessorId: "92026003", successorId: "92026006", type: "FS", lagDays: 0 },
  { id: "dep-tp-r2-5-7", projectId: TEST_PROJECT_ID, predecessorId: "92026005", successorId: "92026007", type: "FS", lagDays: 0 },
  { id: "dep-tp-r2-7-8", projectId: TEST_PROJECT_ID, predecessorId: "92026007", successorId: "92026008", type: "FS", lagDays: 0 },
];

/** The company a write belongs to, plus the account that performed it. */
interface Identity {
  ownerId: Id<"users">;
  companyId: Id<"companies">;
}

/** The one empty starter project a brand-new workspace opens on. */
const STARTER_PROJECT_ID = "proj-welcome";

/**
 * Creates the starter project exactly once, and only when the workspace has no
 * regular project at all. A project the user removed is never recreated: once
 * the marker exists nothing is written here again.
 */
const ensureStarterProject = async (ctx: MutationCtx, identity: Identity, now: string) => {
  const { companyId } = identity;
  const starterRun = await ctx.db.query("seedRuns").withIndex("by_company_seed", (q) => q.eq("companyId", companyId as never).eq("seedKey", STARTER_SEED_KEY)).first();
  if (starterRun) return false;
  const projects = await ctx.db.query("projects").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect();
  const hasRealProject = projects.some((project) => (project.kind ?? (project.status === "template" ? "template" : "project")) === "project");
  const alreadyThere = projects.some((project) => project.id === STARTER_PROJECT_ID);
  if (!hasRealProject && !alreadyThere) {
    const calendars = await ctx.db.query("calendars").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect();
    const calendarId = calendars.find((calendar) => calendar.isDefault)?.id ?? "cal-base-belgium";
    await ctx.db.insert("projects", { ownerId: identity.ownerId, companyId, id: STARTER_PROJECT_ID, name: "New project", status: "active", kind: "project", startDate: new Date().toISOString().slice(0, 10), schedulingDirection: "forward", calendarId, createdAt: now, updatedAt: now });
    await ctx.db.insert("planVersions", { ownerId: identity.ownerId, companyId, id: `version-${STARTER_PROJECT_ID}-1`, projectId: STARTER_PROJECT_ID, name: "Versie 1", isActive: true, createdAt: now, mode: "planning" });
  }
  await ctx.db.insert("seedRuns", { ownerId: identity.ownerId, companyId, seedKey: STARTER_SEED_KEY, executedAt: now });
  return !hasRealProject && !alreadyThere;
};

const seedTestProject = async (ctx: MutationCtx, identity: Identity) => {
  const { companyId } = identity;
  const executed = await ctx.db.query("seedRuns").withIndex("by_company_seed", (q) => q.eq("companyId", companyId as never).eq("seedKey", TEST_SEED_KEY)).first();
  const allProjects = await ctx.db.query("projects").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect();
  const keyedRows = allProjects.filter((project) => project.seedKey === TEST_SEED_KEY);
  const existing = keyedRows.find((project) => project.kind === "template" || project.status === "template")
    ?? keyedRows.find((project) => project.id === TEST_PROJECT_ID)
    ?? allProjects.find((project) => project.id === TEST_PROJECT_ID)
    ?? keyedRows[0];
  const now = new Date().toISOString();
  if (existing) {
    if (!existing.isBuiltin || existing.status !== "template" || existing.kind !== "template" || existing.seedKey !== TEST_SEED_KEY) await ctx.db.patch(existing._id, { kind: "template", isBuiltin: true, status: "template", seedKey: TEST_SEED_KEY, updatedAt: now });
    if (!executed) await ctx.db.insert("seedRuns", { ownerId: identity.ownerId, companyId, seedKey: TEST_SEED_KEY, executedAt: now });
    const starterCreated = await ensureStarterProject(ctx, identity, now);
    return starterCreated;
  }
  const legacyRows = keyedRows;
  for (const legacy of legacyRows) {
    // Retain older duplicate markers without touching their project or scheduling data.
    await ctx.db.patch(legacy._id, { seedKey: undefined, updatedAt: now });
  }
  // Demo content is created for a brand-new, empty company and nothing else. A
  // company that already owns a project either still holds the template (found
  // above) or deleted it on purpose, and a company whose marker exists has been
  // seeded before — neither may ever see the record come back.
  if (allProjects.length || executed) {
    if (!executed) await ctx.db.insert("seedRuns", { ownerId: identity.ownerId, companyId, seedKey: TEST_SEED_KEY, executedAt: now });
    return await ensureStarterProject(ctx, identity, now);
  }
  const calendars = await ctx.db.query("calendars").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect();
  const base = calendars.find((calendar) => calendar.id === "cal-base-belgium") ?? calendars.find((calendar) => calendar.isDefault);
  const calendarId = base?.id ?? "cal-base-belgium";
  if (!base) await ctx.db.insert("calendars", { ownerId: identity.ownerId, companyId, id: calendarId, name: "Belgium — standard", type: "base", parentCalendarId: null, isDefault: true, workingDays: [1, 2, 3, 4, 5] });
  await ctx.db.insert("projects", { ownerId: identity.ownerId, companyId, id: TEST_PROJECT_ID, name: "TP-R2 — Testproject", status: "template", kind: "template", isBuiltin: true, startDate: "2026-10-05", schedulingDirection: "forward", calendarId, createdAt: now, updatedAt: now, seedKey: TEST_SEED_KEY });
  await ctx.db.insert("planVersions", { ownerId: identity.ownerId, companyId, id: TEST_VERSION_ID, projectId: TEST_PROJECT_ID, name: "Versie 1", isActive: true, createdAt: now, mode: "planning" });
  for (const task of testTasks(TEST_VERSION_ID)) await ctx.db.insert("tasks", { ownerId: identity.ownerId, companyId, ...task });
  for (const dependency of testDependencies) await ctx.db.insert("dependencies", { ownerId: identity.ownerId, companyId, ...dependency });
  if (!executed) await ctx.db.insert("seedRuns", { ownerId: identity.ownerId, companyId, seedKey: TEST_SEED_KEY, executedAt: now });
  await ensureStarterProject(ctx, identity, now);
  return true;
};

/* --------------------------------------------------------------- R3 seed */

/**
 * Seeds the R3 scenario exactly once per workspace: three people (with their
 * own weeks and Chris's leave) and TP-R3-A/B as a normal project *and* a
 * template each, so the scenario can be recreated after testing. Deterministic
 * ids plus a seed-run marker keep it idempotent — running it twice creates
 * nothing new. TP-R2 is left untouched.
 */
const seedR3 = async (ctx: MutationCtx, identity: Identity, now: string) => {
  const { companyId } = identity;
  const executed = await ctx.db.query("seedRuns").withIndex("by_company_seed", (q) => q.eq("companyId", companyId as never).eq("seedKey", R3_SEED_KEY)).first();
  if (executed) return;
  // Same rule as the built-in template: the scenario is created once, for a
  // brand-new company. A company that already owns a project has been seeded
  // before or removed the scenario on purpose — it must never come back.
  if ((await ctx.db.query("projects").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect()).length) {
    await ctx.db.insert("seedRuns", { ownerId: identity.ownerId, companyId, seedKey: R3_SEED_KEY, executedAt: now });
    return;
  }
  const calendars = await ctx.db.query("calendars").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect();
  const resources = await ctx.db.query("resources").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect();
  const exceptions = await ctx.db.query("calendarExceptions").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect();
  const base = calendars.find((calendar) => calendar.id === "cal-base-belgium") ?? calendars.find((calendar) => calendar.isDefault);
  const baseCalendarId = base?.id ?? "cal-base-belgium";
  if (!base) await ctx.db.insert("calendars", { ownerId: identity.ownerId, companyId, id: baseCalendarId, name: "Belgium — standard", type: "base", parentCalendarId: null, isDefault: true, workingDays: [1, 2, 3, 4, 5] });
  for (const resource of R3_RESOURCES) {
    // Deterministic ids plus an existence check, so a second run can never duplicate a person.
    if (!calendars.some((calendar) => calendar.id === resource.calendarId)) {
      await ctx.db.insert("calendars", { ownerId: identity.ownerId, companyId, id: resource.calendarId, name: `${resource.name} — leave`, type: "person", parentCalendarId: baseCalendarId, isDefault: false, workingDays: resource.workingDays });
    }
    if (!resources.some((row) => row.id === resource.id)) {
      await ctx.db.insert("resources", { ownerId: identity.ownerId, companyId, id: resource.id, name: resource.name, role: "", email: "", colour: resource.colour, hoursPerWeek: resource.hoursPerWeek, isActive: true, calendarId: resource.calendarId });
    }
  }
  if (!exceptions.some((row) => row.id === R3_CHRIS_LEAVE.id)) {
    await ctx.db.insert("calendarExceptions", { ownerId: identity.ownerId, companyId, id: R3_CHRIS_LEAVE.id, calendarId: R3_CHRIS_LEAVE.calendarId, startDate: R3_CHRIS_LEAVE.startDate, endDate: R3_CHRIS_LEAVE.endDate, label: R3_CHRIS_LEAVE.label, type: "leave", isWorkingDay: false, source: "manual" });
  }
  for (const pair of R3_PROJECTS) {
    for (const [projectId, prefix, isTemplate] of [[pair.projectId, pair.prefix, false], [pair.templateId, pair.templatePrefix, true]] as const) {
      const versionId = `version-${projectId}-1`;
      await ctx.db.insert("projects", { ownerId: identity.ownerId, companyId, id: projectId, name: isTemplate ? `${pair.name} (template)` : pair.name, status: isTemplate ? "template" : "active", kind: isTemplate ? "template" : "project", isBuiltin: isTemplate, startDate: "2026-10-05", schedulingDirection: "forward", calendarId: baseCalendarId, createdAt: now, updatedAt: now, seedKey: R3_SEED_KEY });
      await ctx.db.insert("planVersions", { ownerId: identity.ownerId, companyId, id: versionId, projectId, name: "Versie 1", isActive: true, createdAt: now, mode: "planning" });
      for (const task of pair.tasks(projectId, versionId, prefix)) await ctx.db.insert("tasks", { ownerId: identity.ownerId, companyId, ...task });
      for (const dependency of pair.dependencies(projectId, prefix)) await ctx.db.insert("dependencies", { ownerId: identity.ownerId, companyId, ...dependency });
      for (const assignment of pair.assignments(prefix)) await ctx.db.insert("taskAssignments", { ownerId: identity.ownerId, companyId, ...assignment });
    }
  }
  await ctx.db.insert("seedRuns", { ownerId: identity.ownerId, companyId, seedKey: R3_SEED_KEY, executedAt: now });
};

export const saveAsTemplate = mutation({
  args: { projectId: v.string(), versionId: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    const { userId: ownerId, companyId } = await requireCompany(ctx);
    const source = await ctx.db.query("projects").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).filter((q) => q.eq(q.field("id"), args.projectId)).first();
    if (!source || (source.kind ?? (source.status === "template" ? "template" : "project")) !== "project") throw new Error("Choose a regular project to save as a template.");
    const sourceTasks = (await ctx.db.query("tasks").withIndex("by_company_project", (q) => q.eq("companyId", companyId as never).eq("projectId", args.projectId)).collect()).filter((task) => !task.versionId || task.versionId === args.versionId).sort((a, b) => a.sortOrder - b.sortOrder);
    if (!sourceTasks.length) throw new Error("Add tasks to this plan version before saving it as a template.");
    const now = new Date().toISOString();
    const id = `template-${crypto.randomUUID()}`;
    const versionId = `version-${id}-1`;
    const calendarRows = await ctx.db.query("calendars").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect();
    const exceptionRows = await ctx.db.query("calendarExceptions").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect();
    const idMap = new Map(sourceTasks.map((task) => [task.id, templateTaskId()]));
    await ctx.db.insert("projects", { ownerId, companyId, id, name: args.name.trim() || `${source.name} template`, status: "template", kind: "template", isBuiltin: false, startDate: source.startDate, schedulingDirection: "forward", calendarId: source.calendarId, createdAt: now, updatedAt: now });
    const version = { id: versionId, projectId: id, name: "Versie 1", isActive: true, createdAt: now, mode: "planning" as const, modeHistory: [] };
    await ctx.db.insert("planVersions", { ownerId, companyId, ...version });
    const copiedTasks: any[] = [];
    for (const task of sourceTasks) {
      const templateAnchorDate = resolveWorkingDate(source.startDate, source.calendarId, calendarRows, exceptionRows);
      const startOffsetDays = workingDateOffset(templateAnchorDate, task.start, source.calendarId, calendarRows, exceptionRows);
      const copiedTask = {
        id: idMap.get(task.id)!, projectId: id, parentId: task.parentId ? idMap.get(task.parentId) ?? null : null,
        sortOrder: task.sortOrder, name: task.name, duration: task.duration, durationUnit: task.durationUnit,
        work: task.work ?? 0, distribution: task.distribution ?? "even",
        start: task.start, finish: task.finish, startOffsetDays, finishOffsetDays: workingDateOffset(templateAnchorDate, task.finish, source.calendarId, calendarRows, exceptionRows),
        constraintOffsetDays: task.startConstraint ? workingDateOffset(templateAnchorDate, task.startConstraint, source.calendarId, calendarRows, exceptionRows) : undefined,
        isMilestone: task.duration === 0 && !sourceTasks.some((candidate) => candidate.parentId === task.id), predecessors: rewritePredecessors(task.predecessors, idMap, sourceTasks), resource: "",
        percent: 0, notes: task.notes, color: task.color, collapsed: task.collapsed ?? false, versionId,
        marginPct: sourceTasks.some((candidate) => candidate.parentId === task.id) || task.duration === 0 ? 0 : task.marginPct ?? 0,
        marginDaysOriginal: sourceTasks.some((candidate) => candidate.parentId === task.id) || task.duration === 0 ? 0 : Math.ceil(Math.max(0, task.duration * (task.durationUnit === "weeks" ? 5 : 1)) * (task.marginPct ?? 0) / 100),
        marginDaysConsumed: 0,
      };
      await ctx.db.insert("tasks", { ownerId, companyId, ...copiedTask });
      copiedTasks.push(copiedTask);
    }
    const sourceTaskIds = new Set(sourceTasks.map((task) => task.id));
    const sourceAssignments = await ctx.db.query("taskAssignments").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect();
    const resources = await ctx.db.query("resources").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect();
    const copiedAssignments: any[] = [];
    for (const assignment of sourceAssignments.filter((item) => sourceTaskIds.has(item.taskId) && idMap.has(item.taskId) && resources.some((resource) => resource.id === item.resourceId))) {
      const copied = { id: `as-${crypto.randomUUID()}`, taskId: idMap.get(assignment.taskId)!, resourceId: assignment.resourceId };
      await ctx.db.insert("taskAssignments", { ownerId, companyId, ...copied });
      copiedAssignments.push(copied);
    }
    const dependencies = await ctx.db.query("dependencies").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).filter((q) => q.eq(q.field("projectId"), args.projectId)).collect();
    const copiedDependencies: any[] = [];
    for (const dependency of dependencies) if (idMap.has(dependency.predecessorId) && idMap.has(dependency.successorId)) {
      const copied = { id: `dep-${crypto.randomUUID()}`, projectId: id, predecessorId: idMap.get(dependency.predecessorId)!, successorId: idMap.get(dependency.successorId)!, type: dependency.type, lagDays: dependency.lagDays };
      await ctx.db.insert("dependencies", { ownerId, companyId, ...copied });
      copiedDependencies.push(copied);
    }
    return { project: { id, name: args.name.trim() || `${source.name} template`, status: "template", kind: "template", isBuiltin: false, hidden: false, startDate: source.startDate, schedulingDirection: "forward", calendarId: source.calendarId, createdAt: now, updatedAt: now }, version, tasks: copiedTasks, assignments: copiedAssignments, dependencies: copiedDependencies };
  },
});

export const createProjectFromTemplate = mutation({
  args: { templateId: v.union(v.string(), v.null()), name: v.string(), startDate: v.string(), calendarId: v.string(), schedulingDirection: v.string(), includeAssignments: v.boolean() },
  handler: async (ctx, args) => {
    const { userId: ownerId, companyId } = await requireCompany(ctx);
    const projects = await ctx.db.query("projects").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect();
    const template = args.templateId ? projects.find((project) => project.id === args.templateId && (project.kind ?? (project.status === "template" ? "template" : "project")) === "template" && !project.hidden) : null;
    if (args.templateId && !template) throw new Error("That template is no longer available.");
    const calendars = await ctx.db.query("calendars").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect();
    const exceptions = await ctx.db.query("calendarExceptions").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect();
    const defaultCalendarId = calendars.find((calendar) => calendar.isDefault)?.id ?? args.calendarId;
    const calendarId = template
      ? (calendars.some((calendar) => calendar.id === template.calendarId) ? template.calendarId : defaultCalendarId)
      : (calendars.some((calendar) => calendar.id === args.calendarId) ? args.calendarId : defaultCalendarId);
    const id = `proj-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const versionId = `version-${id}-1`;
    const version = { id: versionId, projectId: id, name: "Versie 1", isActive: true, createdAt: now, mode: "planning" as const, modeHistory: [] };
    const project = { id, name: args.name.trim() || "Untitled project", status: "active", kind: "project" as const, isBuiltin: false, startDate: args.startDate, schedulingDirection: (args.schedulingDirection === "backward" ? "backward" : "forward"), calendarId, createdAt: now, updatedAt: now };
    await ctx.db.insert("projects", { ownerId, companyId, ...project });
    await ctx.db.insert("planVersions", { ownerId, companyId, ...version });
    const createdTasks: any[] = [];
    const createdAssignments: any[] = [];
    const createdDependencies: any[] = [];
    let skippedAssignments = 0;
    const idMap = new Map<string, string>();
    const sourceTasks = template ? (await ctx.db.query("tasks").withIndex("by_company_project", (q) => q.eq("companyId", companyId as never).eq("projectId", template.id)).collect()).sort((a, b) => a.sortOrder - b.sortOrder) : [];
    const templateVersion = template ? (await ctx.db.query("planVersions").withIndex("by_company_project", (q) => q.eq("companyId", companyId as never).eq("projectId", template.id)).collect()).find((item) => item.isActive) : undefined;
    const activeSourceTasks = sourceTasks.filter((task) => !task.versionId || task.versionId === templateVersion?.id);
    activeSourceTasks.forEach((task) => idMap.set(task.id, templateTaskId()));
    const activeSourceIds = new Set(activeSourceTasks.map((task) => task.id));
    const resourceRows = await ctx.db.query("resources").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect();
    const assignmentRows = await ctx.db.query("taskAssignments").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect();
    const projectAnchorDate = resolveWorkingDate(args.startDate, calendarId, calendars, exceptions);
    const templateAnchorDate = template ? resolveWorkingDate(template.startDate, template.calendarId, calendars, exceptions) : "";
    for (const sourceTask of activeSourceTasks) {
      const taskId = idMap.get(sourceTask.id)!;
      const startOffsetDays = sourceTask.startOffsetDays ?? workingDateOffset(templateAnchorDate, sourceTask.start, template!.calendarId, calendars, exceptions);
      const start = addWorkingDateOffset(projectAnchorDate, startOffsetDays, calendarId, calendars, exceptions);
      const finishOffsetDays = sourceTask.finishOffsetDays ?? workingDateOffset(templateAnchorDate, sourceTask.finish, template!.calendarId, calendars, exceptions);
      const hasChildren = activeSourceTasks.some((task) => task.parentId === sourceTask.id);
      const duration = hasChildren ? 0 : sourceTask.duration;
      const finish = hasChildren ? start : finishDateFor(start, duration, sourceTask.durationUnit, calendarId, calendars, exceptions);
      const marginPct = hasChildren || duration === 0 ? 0 : sourceTask.marginPct ?? 0;
      const task = {
        id: taskId, projectId: id, parentId: sourceTask.parentId ? idMap.get(sourceTask.parentId) ?? null : null, sortOrder: sourceTask.sortOrder,
        name: sourceTask.name, duration, durationUnit: sourceTask.durationUnit, work: sourceTask.work ?? 0, distribution: sourceTask.distribution ?? "even", start, finish, isMilestone: duration === 0 && !hasChildren,

        predecessors: rewritePredecessors(sourceTask.predecessors, idMap, activeSourceTasks), resource: "", percent: 0, notes: sourceTask.notes,
        color: sourceTask.color, collapsed: sourceTask.collapsed ?? false, versionId, marginPct,
        marginDaysOriginal: hasChildren || duration === 0 ? 0 : Math.ceil(Math.max(0, duration * (sourceTask.durationUnit === "weeks" ? 5 : 1)) * marginPct / 100), marginDaysConsumed: 0,
        startOffsetDays, finishOffsetDays,
        startConstraint: typeof sourceTask.constraintOffsetDays === "number" ? addWorkingDateOffset(projectAnchorDate, sourceTask.constraintOffsetDays, calendarId, calendars, exceptions) : undefined,
      };
      await ctx.db.insert("tasks", { ownerId, companyId, ...task });
      createdTasks.push(task);
      for (const assignment of args.includeAssignments ? assignmentRows.filter((row) => row.taskId === sourceTask.id) : []) {
        if (resourceRows.some((resource) => resource.id === assignment.resourceId)) {
          const copied = { id: `as-${crypto.randomUUID()}`, taskId, resourceId: assignment.resourceId };
          await ctx.db.insert("taskAssignments", { ownerId, companyId, ...copied });
          createdAssignments.push(copied);
        } else skippedAssignments += 1;
      }
    }
    if (template) {
      const deps = await ctx.db.query("dependencies").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).filter((q) => q.eq(q.field("projectId"), template.id)).collect();
      for (const dependency of deps) if (activeSourceIds.has(dependency.predecessorId) && activeSourceIds.has(dependency.successorId)) {
        const copied = { id: `dep-${crypto.randomUUID()}`, projectId: id, predecessorId: idMap.get(dependency.predecessorId)!, successorId: idMap.get(dependency.successorId)!, type: dependency.type, lagDays: dependency.lagDays };
        await ctx.db.insert("dependencies", { ownerId, companyId, ...copied });
        createdDependencies.push(copied);
      }
    }
    // Roll summary rows up from the leaves toward the root, including nested hierarchies.
    const depthOf = (task: (typeof createdTasks)[number]) => {
      let depth = 0;
      let parentId = task.parentId;
      const seen = new Set<string>();
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        depth += 1;
        parentId = createdTasks.find((candidate) => candidate.id === parentId)?.parentId ?? null;
      }
      return depth;
    };
    const taskRows = await ctx.db.query("tasks").withIndex("by_company_project", (q) => q.eq("companyId", companyId as never).eq("projectId", id)).collect();
    const rowsById = new Map(taskRows.map((row) => [row.id, row]));
    const summaries = createdTasks.filter((task) => createdTasks.some((child) => child.parentId === task.id)).sort((a, b) => depthOf(b) - depthOf(a));
    for (const summary of summaries) {
      const children = createdTasks.filter((task) => task.parentId === summary.id);
      if (!children.length) continue;
      summary.start = children.reduce((min, task) => task.start < min ? task.start : min, children[0].start);
      summary.finish = children.reduce((max, task) => task.finish > max ? task.finish : max, children[0].finish);
      summary.startOffsetDays = workingDateOffset(projectAnchorDate, summary.start, calendarId, calendars, exceptions);
      summary.finishOffsetDays = workingDateOffset(projectAnchorDate, summary.finish, calendarId, calendars, exceptions);
      summary.duration = Math.max(1, workingDateOffset(summary.start, summary.finish, calendarId, calendars, exceptions) + (isWorkingDate(summary.finish, calendarId, calendars, exceptions) ? 1 : 0));
      const row = rowsById.get(summary.id);
      if (row) await ctx.db.patch(row._id, { start: summary.start, finish: summary.finish, duration: summary.duration, startOffsetDays: summary.startOffsetDays, finishOffsetDays: summary.finishOffsetDays, isMilestone: false, marginPct: 0, marginDaysOriginal: 0, marginDaysConsumed: 0 });
    }
    return { project, version, tasks: createdTasks, assignments: createdAssignments, dependencies: createdDependencies, skippedAssignments };
  },
});

export const hideTemplate = mutation({
  args: { templateId: v.string(), hidden: v.boolean(), expected: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { companyId } = await requireCompany(ctx);
    await checkWorkspaceBase(ctx, companyId, args.expected);
    const project = await ctx.db.query("projects").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).filter((q) => q.eq(q.field("id"), args.templateId)).first();
    if (!project || (project.kind ?? (project.status === "template" ? "template" : "project")) !== "template") throw new Error("Template not found.");
    await ctx.db.patch(project._id, { hidden: args.hidden, updatedAt: new Date().toISOString() });
  },
});

export const deleteTemplate = mutation({
  args: { templateId: v.string(), expected: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { companyId } = await requireCompany(ctx);
    await checkWorkspaceBase(ctx, companyId, args.expected);
    const project = await ctx.db.query("projects").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).filter((q) => q.eq(q.field("id"), args.templateId)).first();
    if (!project || (project.kind ?? (project.status === "template" ? "template" : "project")) !== "template") throw new Error("Template not found.");
    if (project.isBuiltin) throw new Error("Built-in templates can be hidden, not deleted.");
    const tasks = await ctx.db.query("tasks").withIndex("by_company_project", (q) => q.eq("companyId", companyId as never).eq("projectId", args.templateId)).collect();
    const taskIds = new Set(tasks.map((task) => task.id));
    for (const row of tasks) await ctx.db.delete(row._id);
    for (const row of await ctx.db.query("dependencies").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).filter((q) => q.eq(q.field("projectId"), args.templateId)).collect()) await ctx.db.delete(row._id);
    for (const row of await ctx.db.query("taskAssignments").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect()) if (taskIds.has(row.taskId)) await ctx.db.delete(row._id);
    for (const row of await ctx.db.query("planVersions").withIndex("by_company_project", (q) => q.eq("companyId", companyId as never).eq("projectId", args.templateId)).collect()) await ctx.db.delete(row._id);
    await ctx.db.delete(project._id);
  },
});

/** True when the row belongs to a regular project rather than a template. */
const isRegularProject = (project: { kind?: string; status: string }) =>
  (project.kind ?? (project.status === "template" ? "template" : "project")) === "project";

/** Every project of one company, through the company index. */
const companyProjectRows = (ctx: MutationCtx, companyId: Id<"companies">) => companyTable(ctx, "projects", companyId);

/**
 * Deletes one regular project and every record that belongs to it: its tasks,
 * its dependencies, the assignments of those tasks, its plan versions, its
 * baselines and their snapshots. Nothing is rewritten and no planning figure is
 * recomputed — rows are only removed, so no orphaned row can reappear or keep
 * counting towards capacity.
 *
 * Only the signed-in company's own rows are reachable: the project is looked up
 * by id inside the company's own projects, and every cascade runs through a
 * company index, so a project id from another company cannot be deleted.
 */
export const deleteProject = mutation({
  args: { projectId: v.string(), expected: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { companyId } = await requireCompany(ctx);
    await checkWorkspaceBase(ctx, companyId, args.expected);
    const projects = await companyProjectRows(ctx, companyId);
    const project = projects.find((row) => row.id === args.projectId);
    if (!project) throw new Error("That project is not part of this company.");
    if (!isRegularProject(project)) throw new Error("That is a template. Templates are hidden or deleted from the templates list.");
    if (projects.filter(isRegularProject).length <= 1) throw new Error("You must keep at least one project.");

    const tasks = await ctx.db.query("tasks").withIndex("by_company_project", (q) => q.eq("companyId", companyId as never).eq("projectId", args.projectId)).collect();
    const taskIds = new Set(tasks.map((task) => task.id));
    const baselines = await ctx.db.query("baselines").withIndex("by_company_project", (q) => q.eq("companyId", companyId as never).eq("projectId", args.projectId)).collect();
    const baselineIds = new Set(baselines.map((baseline) => baseline.id));

    let assignments = 0;
    for (const row of await companyTable(ctx, "taskAssignments", companyId)) {
      if (taskIds.has(row.taskId)) {
        await ctx.db.delete(row._id);
        assignments += 1;
      }
    }
    let baselineTasks = 0;
    for (const row of await companyTable(ctx, "baselineTasks", companyId)) {
      if (baselineIds.has(row.baselineId)) {
        await ctx.db.delete(row._id);
        baselineTasks += 1;
      }
    }
    // A dependency belongs to the project that owns the link, but either end can
    // name a task of this project. Both are removed: a link row whose endpoint is
    // gone is an orphan, whichever project it was filed under.
    let dependencies = 0;
    for (const row of await companyTable(ctx, "dependencies", companyId)) {
      if (row.projectId !== args.projectId && !taskIds.has(row.predecessorId) && !taskIds.has(row.successorId)) continue;
      await ctx.db.delete(row._id);
      dependencies += 1;
    }
    let planVersions = 0;
    for (const row of await ctx.db.query("planVersions").withIndex("by_company_project", (q) => q.eq("companyId", companyId as never).eq("projectId", args.projectId)).collect()) {
      await ctx.db.delete(row._id);
      planVersions += 1;
    }
    for (const row of tasks) await ctx.db.delete(row._id);
    for (const row of baselines) await ctx.db.delete(row._id);
    await ctx.db.delete(project._id);
    return {
      projectId: args.projectId,
      removed: { tasks: tasks.length, dependencies, assignments, planVersions, baselines: baselines.length, baselineTasks },
    };
  },
});

/**
 * Deletes the given tasks of one project together with their subtree, their
 * assignments and every dependency that names them. A task row can therefore
 * never outlive the task it points at.
 */
export const deleteTasks = mutation({
  args: { projectId: v.string(), taskIds: v.array(v.string()), expected: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { companyId } = await requireCompany(ctx);
    const tasks = await ctx.db.query("tasks").withIndex("by_company_project", (q) => q.eq("companyId", companyId as never).eq("projectId", args.projectId)).collect();
    await checkWorkspaceBase(ctx, companyId, args.expected);
    const wanted = new Set(args.taskIds);
    const doomed = new Set(tasks.filter((task) => wanted.has(task.id)).map((task) => task.id));
    if (!doomed.size) throw new Error("That task is not part of this company.");
    // Children of a deleted task go with it, so nothing is left pointing at a gone parent.
    for (let grew = true; grew; ) {
      grew = false;
      for (const task of tasks) {
        if (task.parentId && doomed.has(task.parentId) && !doomed.has(task.id)) {
          doomed.add(task.id);
          grew = true;
        }
      }
    }
    let assignments = 0;
    for (const row of await companyTable(ctx, "taskAssignments", companyId)) {
      if (doomed.has(row.taskId)) {
        await ctx.db.delete(row._id);
        assignments += 1;
      }
    }
    // Same rule as the project delete: every link that names a doomed task goes,
    // whatever project the link was filed under.
    let dependencies = 0;
    for (const row of await companyTable(ctx, "dependencies", companyId)) {
      if (doomed.has(row.predecessorId) || doomed.has(row.successorId)) {
        await ctx.db.delete(row._id);
        dependencies += 1;
      }
    }
    for (const task of tasks) if (doomed.has(task.id)) await ctx.db.delete(task._id);
    const survivors = tasks.filter(task => !doomed.has(task.id));
    const repaired = pruneDeadPredecessors(survivors).tasks;
    for (let i = 0; i < survivors.length; i++) {
      if (repaired[i].predecessors !== survivors[i].predecessors) await ctx.db.patch(survivors[i]._id, { predecessors: repaired[i].predecessors });
    }
    return { taskIds: [...doomed], assignments, dependencies };
  },
});

/**
 * Deletes one employee with everything that only exists for them: their
 * assignments, their person calendar and that calendar's leave rows. No
 * assignment can survive pointing at an employee who is gone.
 */
export const deleteResource = mutation({
  args: { resourceId: v.string(), expected: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { companyId } = await requireCompany(ctx);
    await checkWorkspaceBase(ctx, companyId, args.expected);
    const resources = await companyTable(ctx, "resources", companyId);
    const resource = resources.find((row) => row.id === args.resourceId);
    if (!resource) throw new Error("That employee is not part of this company.");
    let assignments = 0;
    for (const row of await companyTable(ctx, "taskAssignments", companyId)) {
      if (row.resourceId === resource.id) {
        await ctx.db.delete(row._id);
        assignments += 1;
      }
    }
    // The employee's own calendar goes with them — but only when it is really
    // theirs. The shared base calendar, a calendar a project plans on, and one
    // another employee still uses all stay put, so no record is left stranded.
    let exceptions = 0;
    let calendars = 0;
    const own = (await companyTable(ctx, "calendars", companyId)).find((row) => row.id === resource.calendarId);
    const sharedWithProject = (await companyProjectRows(ctx, companyId)).some((project) => isRegularProject(project) && project.calendarId === resource.calendarId);
    const sharedWithEmployee = (await companyTable(ctx, "resources", companyId)).some((row) => row.id !== resource.id && row.calendarId === resource.calendarId);
    if (own && !own.isDefault && !sharedWithProject && !sharedWithEmployee) {
      for (const row of await companyTable(ctx, "calendarExceptions", companyId)) {
        if (row.calendarId === own.id) {
          await ctx.db.delete(row._id);
          exceptions += 1;
        }
      }
      await ctx.db.delete(own._id);
      calendars = 1;
    }
    await ctx.db.delete(resource._id);
    return { resourceId: resource.id, removed: { assignments, exceptions, calendars } };
  },
});

/**
 * Deletes one calendar and its exception rows, refusing every deletion that
 * would strand another record: the base calendar, a calendar a project still
 * plans on, one an employee still uses, and one other calendars inherit from.
 */
export const deleteCalendar = mutation({
  args: { calendarId: v.string(), expected: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { companyId } = await requireCompany(ctx);
    await checkWorkspaceBase(ctx, companyId, args.expected);
    const calendars = await companyTable(ctx, "calendars", companyId);
    const calendar = calendars.find((row) => row.id === args.calendarId);
    if (!calendar) throw new Error("That calendar is not part of this company.");
    if (calendar.isDefault) throw new Error("The base calendar cannot be deleted.");
    const planned = (await companyProjectRows(ctx, companyId)).filter((project) => isRegularProject(project) && project.calendarId === calendar.id);
    if (planned.length) {
      throw new Error(`${planned.length} project${planned.length === 1 ? "" : "s"} still use this calendar (${planned.map((project) => project.name).join(", ")}). Re-link them first.`);
    }
    const staffed = (await companyTable(ctx, "resources", companyId)).filter((resource) => resource.calendarId === calendar.id);
    if (staffed.length) {
      throw new Error(`${staffed.length} employee${staffed.length === 1 ? "" : "s"} still use this calendar (${staffed.map((resource) => resource.name).join(", ")}). Move them to another calendar first.`);
    }
    const children = calendars.filter((row) => row.parentCalendarId === calendar.id);
    if (children.length) {
      throw new Error(`${children.length} calendar${children.length === 1 ? "" : "s"} inherit from this one (${children.map((row) => row.name).join(", ")}). Delete or re-parent them first.`);
    }
    let exceptions = 0;
    for (const row of await companyTable(ctx, "calendarExceptions", companyId)) {
      if (row.calendarId === calendar.id) {
        await ctx.db.delete(row._id);
        exceptions += 1;
      }
    }
    await ctx.db.delete(calendar._id);
    return { calendarId: calendar.id, removed: { exceptions } };
  },
});

export const initializeWorkspace = mutation({
  args: {},
  handler: async (ctx) => {
    const { userId, companyId } = await requireCompany(ctx);
    const identity: Identity = { ownerId: userId, companyId };
    await seedTestProject(ctx, identity);
    await seedR3(ctx, identity, new Date().toISOString());
  },
});

export const ensureTestProject = mutation({
  args: {},
  handler: async (ctx) => {
    const { userId, companyId } = await requireCompany(ctx);
    const seeded = await seedTestProject(ctx, { ownerId: userId, companyId });
    await seedR3(ctx, { ownerId: userId, companyId }, new Date().toISOString());
    return seeded;
  },
});

/* -------------------------------------------------- workspace write budget */

/**
 * One value's serialisation, with object keys in a fixed order, so two saves of
 * the same row always compare equal — however the client happened to build it.
 */
const canonical = (value: unknown): string => {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
};

/** What a stored row holds besides the storage columns the client never sends. */
const storedContent = (row: Record<string, unknown>): string => {
  const { _id: _id, _creationTime: _creationTime, ...app } = row;
  return canonical(withoutScope(app));
};

/** The counts of one table's write: what a save really had to do. */
export interface WorkspaceWriteCount {
  inserted: number;
  updated: number;
  removed: number;
  kept: number;
}

/**
 * Brings one company table in line with the payload — and touches only the rows
 * that actually differ.
 *
 * Every save sends the whole workspace, so writing it by deleting every row and
 * inserting it again cost twice the company's row count in writes, on every
 * single change. That is what a workspace eventually outgrows: one mutation may
 * write 16,000 documents (and 16 MiB) altogether, so a plan that grows — a large
 * project, or "Optimize planning" adding a whole second version of every task —
 * can reach a point where no edit can be saved at all, and until then every edit
 * pays for the whole plan. Comparing first makes a save cost one write per
 * changed row: editing a task writes that task, and a save that changes nothing
 * writes nothing.
 *
 * The meaning of the save is unchanged: the stored workspace is exactly this
 * payload, so a row the payload no longer has is deleted.
 */
const syncCompanyTable = async (
  ctx: MutationCtx,
  table: CompanyScopedTable,
  companyId: Id<"companies">,
  scope: { ownerId: Id<"users">; companyId: Id<"companies"> },
  incoming: readonly unknown[],
  totals: WorkspaceWriteCount,
): Promise<void> => {
  // The table name is a runtime union here, so the typed database API is used
  // with the table as a plain name — the same way `companyTable` reads it.
  const db = ctx.db as unknown as {
    insert: (table: string, value: Record<string, unknown>) => Promise<unknown>;
    replace: (id: unknown, value: Record<string, unknown>) => Promise<unknown>;
    delete: (id: unknown) => Promise<unknown>;
  };
  const stored = (await companyTable(ctx, table, companyId)) as unknown as Record<string, unknown>[];
  const storedById = new Map<string, Record<string, unknown>>();
  for (const row of stored) {
    if (typeof row.id === "string" && row.id) storedById.set(row.id, row);
  }
  const seen = new Set<string>();
  for (const item of incoming) {
    const row = withoutScope(item) as Record<string, unknown>;
    const key = typeof row.id === "string" ? row.id : "";
    const existing = key ? storedById.get(key) : undefined;
    if (key) seen.add(key);
    if (!existing) {
      await db.insert(table, { ...row, ...scope });
      totals.inserted += 1;
      continue;
    }
    if (storedContent(existing) === canonical(row)) {
      totals.kept += 1;
      continue;
    }
    // The row is written as a whole, so a field the plan no longer has cannot
    // survive on the stored row.
    await db.replace(existing._id, { ...row, ...scope });
    totals.updated += 1;
  }
  for (const [key, row] of storedById) {
    if (seen.has(key)) continue;
    await db.delete(row._id);
    totals.removed += 1;
  }
};

/** Tasks carry their own order; a row without one keeps its place in the payload. */
const orderedTasks = (rows: readonly unknown[]): unknown[] =>
  rows.map((item, index) => {
    const row = withoutScope(item) as Record<string, unknown>;
    return { ...row, sortOrder: row.sortOrder ?? index };
  });

export const replaceState = mutation({
  args: { state: v.any(), expected: v.optional(v.string()) },
  handler: async (ctx, args) => {
    // The company always comes from the session: a company id in the payload is
    // discarded, so a browser can never write into (or hide data from) another
    // company.
    const { userId, companyId } = await requireCompany(ctx);
    const storedState = await collectCompanyState(ctx, companyId);
    // Legacy full replacement is never allowed to overwrite an existing workspace
    // without a transactionally checked base. Empty first-time initialization only.
    if (workspaceTables.some(table => storedState[table].length) && args.expected !== await fingerprint(storedState as Workspace)) {
      throw new ConvexError({ code: "SAVE_CONFLICT", message: "The workspace changed. Your input has not been saved or overwritten." });
    }
    const state = args.state as WorkspaceRelationRows;
    // Relations are the one place where a payload could name something the
    // company does not own. The only rows that exist besides this company's own
    // are other companies', so a relation that does not resolve inside the
    // submitted workspace is refused outright — the save is rejected, not
    // repaired, and the transaction leaves the stored workspace untouched.
    const foreign = outsideCompanyReferences(state);
    if (foreign.length) {
      throw new Error(
        `That workspace save refers to ${describeReferences(foreign).join("; ")}. Nothing was written.`,
      );
    }
    const scope = { ownerId: userId, companyId };
    const totals: WorkspaceWriteCount = { inserted: 0, updated: 0, removed: 0, kept: 0 };
    await syncCompanyTable(ctx, "projects", companyId, scope, state.projects ?? [], totals);
    await syncCompanyTable(ctx, "tasks", companyId, scope, orderedTasks(state.tasks ?? []), totals);
    await syncCompanyTable(ctx, "dependencies", companyId, scope, state.dependencies ?? [], totals);
    await syncCompanyTable(ctx, "calendars", companyId, scope, state.calendars ?? [], totals);
    await syncCompanyTable(ctx, "calendarExceptions", companyId, scope, state.exceptions ?? [], totals);
    await syncCompanyTable(ctx, "resources", companyId, scope, state.resources ?? [], totals);
    await syncCompanyTable(ctx, "taskAssignments", companyId, scope, state.assignments ?? [], totals);
    await syncCompanyTable(ctx, "planVersions", companyId, scope, state.planVersions ?? [], totals);
    await syncCompanyTable(ctx, "baselines", companyId, scope, state.baselines ?? [], totals);
    await syncCompanyTable(ctx, "baselineTasks", companyId, scope, state.baselineTasks ?? [], totals);
    // What this save actually had to write, so a save that rewrote the whole
    // workspace is visible rather than silent.
    return totals;
  },
});

const storageTable = {
  projects: "projects", tasks: "tasks", dependencies: "dependencies", calendars: "calendars",
  exceptions: "calendarExceptions", resources: "resources", assignments: "taskAssignments",
  planVersions: "planVersions", baselines: "baselines", baselineTasks: "baselineTasks",
} as const;

const conflict = () => new ConvexError({ code: "SAVE_CONFLICT", message: "Someone changed this planning while you were editing. Nothing in this save was applied. Your input is still available." });

/** Changed rows only; comparison and all writes are ONE Convex transaction. */
export const saveChanges = mutation({
  args: {
    changes: v.array(v.object({ table: v.union(...workspaceTables.map(table => v.literal(table))), id: v.string(), before: v.any(), after: v.any() })),
    guards: v.array(v.object({ projectId: v.string(), fingerprint: v.string() })),
  },
  handler: async (ctx, args) => {
    const { userId, companyId } = await requireCompany(ctx);
    const changes = args.changes as WorkspaceChange[];
    const guards = args.guards as WorkspaceGuard[];
    const cache = new Map<string, Record<string, unknown> | null>();
    const find = async (table: keyof typeof storageTable, id: string) => {
      const key = `${table}:${id}`;
      if (!cache.has(key)) {
        const rows = await ctx.db.query(storageTable[table]).withIndex("by_company_id", q => q.eq("companyId", companyId).eq("id", id)).collect();
        if (rows.length > 1) throw new Error("Duplicate record identifiers must be resolved before saving.");
        cache.set(key, rows[0] as unknown as Record<string, unknown> ?? null);
      }
      return cache.get(key) ?? null;
    };
    const appRow = (row: Record<string, unknown> | null) => {
      if (!row) return null;
      const { _id, _creationTime, ownerId, companyId, ...app } = row;
      return app;
    };
    const keys = new Set<string>();
    for (const change of changes) {
      if (keys.has(`${change.table}:${change.id}`)) throw new Error("Duplicate change.");
      keys.add(`${change.table}:${change.id}`);
      if (!change.id || (change.before && change.before.id !== change.id) || (change.after && change.after.id !== change.id)) throw new Error("Invalid change identifier.");
      if (stableCanonical(appRow(await find(change.table, change.id))) !== stableCanonical(change.before)) throw conflict();
    }
    // Validate complete read sets per affected project, including unchanged
    // predecessors, calendars and version mode. This also detects inserted rows.
    const shared: Workspace = {};
    if (guards.length) {
      shared.calendars = stripScope(await companyTable(ctx, "calendars", companyId));
      shared.exceptions = stripScope(await companyTable(ctx, "calendarExceptions", companyId));
      shared.resources = stripScope(await companyTable(ctx, "resources", companyId));
    }
    const guarded = new Set<string>();
    for (const guard of guards) {
      if (guarded.has(guard.projectId)) throw new Error("Duplicate planning guard.");
      guarded.add(guard.projectId);
      const tasks = stripScope(await ctx.db.query("tasks").withIndex("by_company_project", q => q.eq("companyId", companyId).eq("projectId", guard.projectId)).collect());
      const baselines = stripScope(await ctx.db.query("baselines").withIndex("by_company_project", q => q.eq("companyId", companyId).eq("projectId", guard.projectId)).collect());
      const assignments = (await Promise.all(tasks.map(task => ctx.db.query("taskAssignments").withIndex("by_company_task", q => q.eq("companyId", companyId).eq("taskId", task.id)).collect()))).flat();
      const snapshots = (await Promise.all(baselines.map(baseline => ctx.db.query("baselineTasks").withIndex("by_company_baseline", q => q.eq("companyId", companyId).eq("baselineId", baseline.id)).collect()))).flat();
      const project = appRow(await find("projects", guard.projectId));
      const inputs: Workspace = { ...shared, projects: project ? [project as WorkspaceRow] : [], tasks,
        planVersions: stripScope(await ctx.db.query("planVersions").withIndex("by_company_project", q => q.eq("companyId", companyId).eq("projectId", guard.projectId)).collect()), baselines,
        dependencies: stripScope(await ctx.db.query("dependencies").withIndex("by_company_project", q => q.eq("companyId", companyId).eq("projectId", guard.projectId)).collect()),
        assignments: stripScope(assignments), baselineTasks: stripScope(snapshots),
      };
      if (await fingerprint(inputs) !== guard.fingerprint) throw conflict();
    }
    const beforeRows: Workspace = Object.fromEntries(workspaceTables.map(table => [table, changes.filter(change => change.table === table && change.before).map(change => change.before)]));
    for (const projectId of affectedProjects(beforeRows, changes)) {
      // New projects have no earlier calculation inputs. Existing ones do.
      if (await find("projects", projectId) && !guarded.has(projectId)) throw new Error("A planning read guard is required.");
    }
    for (const change of changes) for (const row of [change.before, change.after]) {
      if (!row) continue;
      for (const [field, target] of [["taskId", "tasks"], ["baselineId", "baselines"]] as const) {
        if (typeof row[field] !== "string") continue;
        const storedTarget = await find(target, row[field]);
        const projectId = storedTarget?.projectId;
        if (typeof projectId === "string" && !guarded.has(projectId)) throw new Error("A planning read guard is required.");
      }
    }
    // Resolve changed relations against this company's current rows plus this
    // transaction's delta, not against a caller-provided complete workspace.
    const resolve = async (table: keyof typeof storageTable, id: unknown) => {
      if (typeof id !== "string" || !id) return true;
      const changed = changes.find(change => change.table === table && change.id === id);
      return changed ? changed.after !== null : (await find(table, id)) !== null;
    };
    const rules: Partial<Record<keyof typeof storageTable, [string, keyof typeof storageTable][]>> = {
      tasks: [["projectId", "projects"], ["parentId", "tasks"], ["versionId", "planVersions"]],
      projects: [["calendarId", "calendars"]], resources: [["calendarId", "calendars"]],
      dependencies: [["projectId", "projects"], ["predecessorId", "tasks"], ["successorId", "tasks"]],
      assignments: [["taskId", "tasks"], ["resourceId", "resources"]], exceptions: [["calendarId", "calendars"]],
      planVersions: [["projectId", "projects"]], baselines: [["projectId", "projects"]],
      baselineTasks: [["baselineId", "baselines"]], calendars: [["parentCalendarId", "calendars"]],
    };
    for (const change of changes) {
      if (!change.after) continue;
      for (const [field, target] of rules[change.table] ?? []) {
        if (!await resolve(target, change.after[field])) throw conflict();
      }
    }
    // Destructive deltas must validate inbound relationships too; uncommon
    // deletes use a company snapshot for integrity, ordinary edits do not.
    if (changes.some(change => change.after === null)) {
      const full = await collectCompanyState(ctx, companyId);
      const next = Object.fromEntries(workspaceTables.map(table => {
        const rows = new Map<string, WorkspaceRow>((full[table] as WorkspaceRow[]).map(row => [row.id, row]));
        for (const change of changes.filter(change => change.table === table)) {
          if (change.after) rows.set(change.id, change.after); else rows.delete(change.id);
        }
        return [table, [...rows.values()]];
      }));
      if (outsideCompanyReferences(next).length) throw conflict();
      const previousProjects = full.projects.filter(isRegularProject);
      if (previousProjects.length && !next.projects.some(row => isRegularProject({ kind: typeof row.kind === "string" ? row.kind : undefined, status: String(row.status) }))) throw new Error("You must keep at least one project.");
    }
    const totals: WorkspaceWriteCount = { inserted: 0, updated: 0, removed: 0, kept: 0 };
    for (const change of changes) {
      const stored = await find(change.table, change.id);
      if (!change.after) { if (stored) { await ctx.db.delete(stored._id as Id<"tasks">); totals.removed++; } }
      else {
        const row = { ...withoutScope(change.after), ownerId: userId, companyId };
        if (stored) { await ctx.db.replace(stored._id as Id<"tasks">, row); totals.updated++; }
        else { await ctx.db.insert(storageTable[change.table], row); totals.inserted++; }
      }
    }
    return totals;
  },
});

/* -------------------------------------------------------- isolation audit */

/** Every company-owned row of one company, keyed the way the relation rules read them. */
const relationRowsOf = async (
  ctx: QueryCtx | MutationCtx,
  companyId: Id<"companies">,
): Promise<WorkspaceRelationRows> => {
  const [projects, tasks, dependencies, calendars, exceptions, resources, assignments, planVersions, baselines, baselineTasks] = await Promise.all([
    ctx.db.query("projects").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect(),
    ctx.db.query("tasks").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect(),
    ctx.db.query("dependencies").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect(),
    ctx.db.query("calendars").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect(),
    ctx.db.query("calendarExceptions").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect(),
    ctx.db.query("resources").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect(),
    ctx.db.query("taskAssignments").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect(),
    ctx.db.query("planVersions").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect(),
    ctx.db.query("baselines").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect(),
    ctx.db.query("baselineTasks").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect(),
  ]);
  return { projects, tasks, dependencies, calendars, exceptions, resources, assignments, planVersions, baselines, baselineTasks };
};

/**
 * The automated company-isolation audit: for every company it reports how many
 * records of each kind it holds and whether anything in it points outside it.
 * `companiesWithForeignReferences` must stay 0 — a company that names another
 * company's record in a relation is a cross-company leak, and this is the query
 * that proves there is none. Internal on purpose: it reads every company, so
 * only the CLI or the Convex dashboard may run it.
 */
export const isolationAudit = internalQuery({
  args: { companyId: v.optional(v.id("companies")) },
  handler: async (ctx, args) => {
    const companies = args.companyId ? [await ctx.db.get(args.companyId)] : await ctx.db.query("companies").collect();
    const reports = [];
    for (const company of companies) {
      if (!company) continue;
      const rows = await relationRowsOf(ctx, company._id);
      reports.push({ companyId: company._id as string, name: company.name, ...workspaceIsolationReport(rows) });
    }
    return {
      companies: reports.length,
      companiesWithForeignReferences: reports.filter((report) => report.outsideCompany.length > 0).length,
      reports,
    };
  },
});
