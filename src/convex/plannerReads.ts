import { query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { viewerScope, companyTable } from "./companies";
import { fingerprint, type Workspace } from "../lib/workspace-changes";

export async function readScope(ctx: QueryCtx) {
  const viewer = await viewerScope(ctx);
  if (!viewer?.companyId || viewer.mustChangePassword) return null;
  const company = await ctx.db.get(viewer.companyId);
  return company?.status === "active" ? { ...viewer, company } : null;
}
const strip = <T extends { _id: unknown; _creationTime: number; companyId?: unknown; ownerId: unknown }>(rows: T[]) => rows.map(({ _id, _creationTime, companyId, ownerId, ...app }) => app);

/** Catalogue metadata never reads task documents or baseline snapshots. */
export const catalog = query({ args: {}, handler: async ctx => {
  const scope = await readScope(ctx);
  if (!scope) return null;
  const [projects, versions, baselines] = await Promise.all([companyTable(ctx, "projects", scope.companyId!), companyTable(ctx, "planVersions", scope.companyId!), companyTable(ctx, "baselines", scope.companyId!)]);
  return { projects: strip(projects), planVersions: strip(versions), baselines: strip(baselines), companyId: scope.companyId, company: { name: scope.company.name, status: scope.company.status }, role: scope.role };
} });

export const calendars = query({ args: {}, handler: async ctx => {
  const scope = await readScope(ctx);
  if (!scope) return null;
  return { calendars: strip(await companyTable(ctx, "calendars", scope.companyId!)), exceptions: strip(await companyTable(ctx, "calendarExceptions", scope.companyId!)) };
} });
export const people = query({ args: {}, handler: async ctx => {
  const scope = await readScope(ctx);
  return scope ? { resources: strip(await companyTable(ctx, "resources", scope.companyId!)) } : null;
} });

export interface PlanRead { projectId: string; versionIds: string[]; allVersions: boolean }
/** Only ranges named by the client, each constrained by the authenticated company.
 * Metadata fingerprint inputs are not cached as client-owned planning rows.
 */
export async function readPlans(ctx: QueryCtx, companyId: Id<"companies">, requests: PlanRead[]) {
  const tasks = [], dependencies = [], assignments = [];
  const coverage = [];
  for (const request of requests) {
    const project = await ctx.db.query("projects").withIndex("by_company_id", q => q.eq("companyId", companyId).eq("id", request.projectId)).unique();
    if (!project) continue;
    const versions = await ctx.db.query("planVersions").withIndex("by_company_project", q => q.eq("companyId", companyId).eq("projectId", request.projectId)).collect();
    const allowed = new Set(versions.map(row => row.id));
    const ids = [...new Set(request.versionIds)].filter(id => allowed.has(id));
    const rows = request.allVersions
      ? await ctx.db.query("tasks").withIndex("by_company_project", q => q.eq("companyId", companyId).eq("projectId", request.projectId)).collect()
      : (await Promise.all([...ids, undefined].map(versionId => ctx.db.query("tasks").withIndex("by_company_project_version", q => q.eq("companyId", companyId).eq("projectId", request.projectId).eq("versionId", versionId)).collect()))).flat();
    const links = await ctx.db.query("dependencies").withIndex("by_company_project", q => q.eq("companyId", companyId).eq("projectId", request.projectId)).collect();
    const taskIds = new Set(rows.map(row => row.id));
    tasks.push(...strip(rows));
    dependencies.push(...strip(links.filter(row => taskIds.has(row.predecessorId) && taskIds.has(row.successorId))));
    assignments.push(...strip((await Promise.all(rows.map(row => ctx.db.query("taskAssignments").withIndex("by_company_task", q => q.eq("companyId", companyId).eq("taskId", row.id)).collect()))).flat()));
    coverage.push({ projectId: request.projectId, versionIds: request.allVersions ? versions.map(row => row.id) : ids, allVersions: request.allVersions });
  }
  return { tasks, dependencies, assignments, coverage };
}
export const plans = query({ args: { requests: v.array(v.object({ projectId: v.string(), versionIds: v.array(v.string()), allVersions: v.boolean() })) }, handler: async (ctx, args) => {
  const scope = await readScope(ctx);
  return scope ? readPlans(ctx, scope.companyId!, args.requests) : null;
} });

export const snapshots = query({ args: { baselineIds: v.array(v.string()) }, handler: async (ctx, args) => {
  const scope = await readScope(ctx);
  if (!scope) return null;
  const rows = [];
  const baselineIds = [];
  for (const id of [...new Set(args.baselineIds)]) {
    const baseline = await ctx.db.query("baselines").withIndex("by_company_id", q => q.eq("companyId", scope.companyId!).eq("id", id)).unique();
    if (!baseline) continue;
    baselineIds.push(id);
    rows.push(...strip(await ctx.db.query("baselineTasks").withIndex("by_company_baseline", q => q.eq("companyId", scope.companyId!).eq("baselineId", id)).collect()));
  }
  return { baselineTasks: rows, baselineIds };
} });

/** Same partial read set is checked during save; unseen versions aren't deleted
 * and changed shared calendars still invalidate the planning calculation.
 */
export async function scopedInputs(ctx: QueryCtx, companyId: Id<"companies">, request: PlanRead, baselineIds: string[]): Promise<Workspace> {
  const plan = await readPlans(ctx, companyId, [request]);
  const project = await ctx.db.query("projects").withIndex("by_company_id", q => q.eq("companyId", companyId).eq("id", request.projectId)).unique();
  const baselines = await ctx.db.query("baselines").withIndex("by_company_project", q => q.eq("companyId", companyId).eq("projectId", request.projectId)).collect();
  return {
    ...plan, projects: strip(project ? [project] : []),
    planVersions: strip(await ctx.db.query("planVersions").withIndex("by_company_project", q => q.eq("companyId", companyId).eq("projectId", request.projectId)).collect()),
    baselines: strip(baselines),
    baselineTasks: strip((await Promise.all(baselines.filter(row => baselineIds.includes(row.id)).map(row => ctx.db.query("baselineTasks").withIndex("by_company_baseline", q => q.eq("companyId", companyId).eq("baselineId", row.id)).collect()))).flat()),
    calendars: strip(await companyTable(ctx, "calendars", companyId)), exceptions: strip(await companyTable(ctx, "calendarExceptions", companyId)), resources: strip(await companyTable(ctx, "resources", companyId)),
  };
}
export async function scopedFingerprint(ctx: QueryCtx, companyId: Id<"companies">, request: PlanRead, baselineIds: string[]) {
  return fingerprint(await scopedInputs(ctx, companyId, request, baselineIds));
}
