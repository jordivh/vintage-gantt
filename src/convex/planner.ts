import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { remapPredecessorText } from "../lib/planner-model";
import { R3_CHRIS_LEAVE, R3_PROJECTS, R3_RESOURCES, R3_SEED_KEY } from "../lib/r3-fixture";
import { companyTable, deleteCompanyRows, requireCompany, rowsByOwner, viewerScope } from "./companies";

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
  if (!scope.companyId) return { userId: scope.userId, companyId: null, role: scope.role };
  const company = await ctx.db.get(scope.companyId);
  if (!company || company.status !== "active") return null;
  return { userId: scope.userId, companyId: scope.companyId, role: scope.role };
};

/** Never persists a company or owner supplied by the browser. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const withoutScope = (item: any): any => {
  const { companyId: _companyId, ownerId: _ownerId, ...rest } = item;
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

/** Creates the one empty starter project a brand-new workspace opens on, exactly once. */
const ensureStarterProject = async (ctx: MutationCtx, identity: Identity, now: string) => {
  const { companyId } = identity;
  const starterRun = await ctx.db.query("seedRuns").withIndex("by_company_seed", (q) => q.eq("companyId", companyId as never).eq("seedKey", STARTER_SEED_KEY)).first();
  if (starterRun) return false;
  const projects = await ctx.db.query("projects").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect();
  const hasRealProject = projects.some((project) => (project.kind ?? (project.status === "template" ? "template" : "project")) === "project");
  if (!hasRealProject) {
    const calendars = await ctx.db.query("calendars").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect();
    const calendarId = calendars.find((calendar) => calendar.isDefault)?.id ?? "cal-base-belgium";
    await ctx.db.insert("projects", { ownerId: identity.ownerId, companyId, id: "proj-welcome", name: "New project", status: "active", kind: "project", startDate: new Date().toISOString().slice(0, 10), schedulingDirection: "forward", calendarId, createdAt: now, updatedAt: now });
    await ctx.db.insert("planVersions", { ownerId: identity.ownerId, companyId, id: "version-proj-welcome-1", projectId: "proj-welcome", name: "Versie 1", isActive: true, createdAt: now, mode: "planning" });
  }
  await ctx.db.insert("seedRuns", { ownerId: identity.ownerId, companyId, seedKey: STARTER_SEED_KEY, executedAt: now });
  return !hasRealProject;
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
  if (executed && !legacyRows.length) {
    // The built-in template was deleted on purpose — it must stay deleted.
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
  const calendars = await ctx.db.query("calendars").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).collect();
  const base = calendars.find((calendar) => calendar.id === "cal-base-belgium") ?? calendars.find((calendar) => calendar.isDefault);
  const baseCalendarId = base?.id ?? "cal-base-belgium";
  if (!base) await ctx.db.insert("calendars", { ownerId: identity.ownerId, companyId, id: baseCalendarId, name: "Belgium — standard", type: "base", parentCalendarId: null, isDefault: true, workingDays: [1, 2, 3, 4, 5] });
  for (const resource of R3_RESOURCES) {
    await ctx.db.insert("calendars", { ownerId: identity.ownerId, companyId, id: resource.calendarId, name: `${resource.name} — leave`, type: "person", parentCalendarId: baseCalendarId, isDefault: false, workingDays: resource.workingDays });
    await ctx.db.insert("resources", { ownerId: identity.ownerId, companyId, id: resource.id, name: resource.name, role: "", email: "", colour: resource.colour, hoursPerWeek: resource.hoursPerWeek, isActive: true, calendarId: resource.calendarId });
  }
  await ctx.db.insert("calendarExceptions", { ownerId: identity.ownerId, companyId, id: R3_CHRIS_LEAVE.id, calendarId: R3_CHRIS_LEAVE.calendarId, startDate: R3_CHRIS_LEAVE.startDate, endDate: R3_CHRIS_LEAVE.endDate, label: R3_CHRIS_LEAVE.label, type: "leave", isWorkingDay: false, source: "manual" });
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
  args: { templateId: v.string(), hidden: v.boolean() },
  handler: async (ctx, args) => {
    const { companyId } = await requireCompany(ctx);
    const project = await ctx.db.query("projects").withIndex("by_company", (q) => q.eq("companyId", companyId as never)).filter((q) => q.eq(q.field("id"), args.templateId)).first();
    if (!project || (project.kind ?? (project.status === "template" ? "template" : "project")) !== "template") throw new Error("Template not found.");
    await ctx.db.patch(project._id, { hidden: args.hidden, updatedAt: new Date().toISOString() });
  },
});

export const deleteTemplate = mutation({
  args: { templateId: v.string() },
  handler: async (ctx, args) => {
    const { companyId } = await requireCompany(ctx);
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

export const replaceState = mutation({
  args: { state: v.any() },
  handler: async (ctx, args) => {
    // The company always comes from the session: a company id in the payload is
    // discarded, so a browser can never write into (or hide data from) another
    // company.
    const { userId, companyId } = await requireCompany(ctx);
    const tableNames = ["projects", "tasks", "dependencies", "calendars", "calendarExceptions", "resources", "taskAssignments", "planVersions", "baselines", "baselineTasks"] as const;
    for (const table of tableNames) await deleteCompanyRows(ctx, table, companyId);
    const state = args.state as { projects?: any[]; tasks?: any[]; dependencies?: any[]; calendars?: any[]; exceptions?: any[]; resources?: any[]; assignments?: any[]; planVersions?: any[]; baselines?: any[]; baselineTasks?: any[] };
    const scope = { ownerId: userId, companyId };
    for (const item of state.projects ?? []) await ctx.db.insert("projects", { ...withoutScope(item), ...scope });
    for (const [index, item] of (state.tasks ?? []).entries()) await ctx.db.insert("tasks", { ...withoutScope(item), ...scope, sortOrder: item.sortOrder ?? index });
    for (const item of state.dependencies ?? []) await ctx.db.insert("dependencies", { ...withoutScope(item), ...scope });
    for (const item of state.calendars ?? []) await ctx.db.insert("calendars", { ...withoutScope(item), ...scope });
    for (const item of state.exceptions ?? []) await ctx.db.insert("calendarExceptions", { ...withoutScope(item), ...scope });
    for (const item of state.resources ?? []) await ctx.db.insert("resources", { ...withoutScope(item), ...scope });
    for (const item of state.assignments ?? []) await ctx.db.insert("taskAssignments", { ...withoutScope(item), ...scope });
    for (const item of state.planVersions ?? []) await ctx.db.insert("planVersions", { ...withoutScope(item), ...scope });
    for (const item of state.baselines ?? []) await ctx.db.insert("baselines", { ...withoutScope(item), ...scope });
    for (const item of state.baselineTasks ?? []) await ctx.db.insert("baselineTasks", { ...withoutScope(item), ...scope });
  },
});
