import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";

const requireOwner = async (ctx: QueryCtx | MutationCtx) => {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("You must be signed in to access planner data.");
  return userId;
};

const collectState = async (ctx: QueryCtx | MutationCtx, ownerId: string) => {
  const [projects, tasks, dependencies, calendars, calendarExceptions, resources, taskAssignments, planVersions, baselines, baselineTasks] = await Promise.all([
    ctx.db.query("projects").withIndex("by_owner", (q) => q.eq("ownerId", ownerId as never)).collect(),
    ctx.db.query("tasks").withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId as never)).collect(),
    ctx.db.query("dependencies").withIndex("by_owner", (q) => q.eq("ownerId", ownerId as never)).collect(),
    ctx.db.query("calendars").withIndex("by_owner", (q) => q.eq("ownerId", ownerId as never)).collect(),
    ctx.db.query("calendarExceptions").withIndex("by_owner", (q) => q.eq("ownerId", ownerId as never)).collect(),
    ctx.db.query("resources").withIndex("by_owner", (q) => q.eq("ownerId", ownerId as never)).collect(),
    ctx.db.query("taskAssignments").withIndex("by_owner", (q) => q.eq("ownerId", ownerId as never)).collect(),
    ctx.db.query("planVersions").withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId as never)).collect(),
    ctx.db.query("baselines").withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId as never)).collect(),
    ctx.db.query("baselineTasks").withIndex("by_owner_baseline", (q) => q.eq("ownerId", ownerId as never)).collect(),
  ]);
  if (!projects.length && !calendars.length && !resources.length && !tasks.length) return null;
  return {
    projects: projects.map(({ _id, _creationTime, ownerId: _ownerId, ...item }) => item),
    tasks: tasks.map(({ _id, _creationTime, ownerId: _ownerId, ...item }) => item),
    dependencies: dependencies.map(({ _id, _creationTime, ownerId: _ownerId, ...item }) => item),
    calendars: calendars.map(({ _id, _creationTime, ownerId: _ownerId, ...item }) => item),
    exceptions: calendarExceptions.map(({ _id, _creationTime, ownerId: _ownerId, ...item }) => item),
    resources: resources.map(({ _id, _creationTime, ownerId: _ownerId, ...item }) => item),
    assignments: taskAssignments.map(({ _id, _creationTime, ownerId: _ownerId, ...item }) => item),
    planVersions: planVersions.map(({ _id, _creationTime, ownerId: _ownerId, ...item }) => item),
    baselines: baselines.map(({ _id, _creationTime, ownerId: _ownerId, ...item }) => item),
    baselineTasks: baselineTasks.map(({ _id, _creationTime, ownerId: _ownerId, ...item }) => item),
  };
};

export const getState = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = await getAuthUserId(ctx);
    return ownerId ? collectState(ctx, ownerId) : null;
  },
});

export const initializeWorkspace = mutation({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireOwner(ctx);
    const existing = await ctx.db.query("projects").withIndex("by_owner", (q) => q.eq("ownerId", ownerId as never)).first();
    if (existing) return;
    const now = new Date().toISOString();
    await ctx.db.insert("calendars", { ownerId, id: "cal-base-belgium", name: "Belgium — standard", type: "base", parentCalendarId: null, isDefault: true, workingDays: [1, 2, 3, 4, 5] });
    const projectId = `proj-${ownerId}`;
    await ctx.db.insert("projects", { ownerId, id: projectId, name: "My first project", status: "active", startDate: now.slice(0, 10), schedulingDirection: "forward", calendarId: "cal-base-belgium", createdAt: now, updatedAt: now });
    await ctx.db.insert("planVersions", { ownerId, id: `version-${projectId}-1`, projectId, name: "Versie 1", isActive: true, createdAt: now });
  },
});

export const replaceState = mutation({
  args: { state: v.any() },
  handler: async (ctx, args) => {
    const ownerId = await requireOwner(ctx);
    const tableNames = ["projects", "tasks", "dependencies", "calendars", "calendarExceptions", "resources", "taskAssignments", "planVersions", "baselines", "baselineTasks"] as const;
    for (const table of tableNames) {
      const rows = await ctx.db.query(table).filter((q) => q.eq(q.field("ownerId"), ownerId)).collect();
      for (const row of rows) await ctx.db.delete(row._id);
    }
    const state = args.state as { projects?: any[]; tasks?: any[]; dependencies?: any[]; calendars?: any[]; exceptions?: any[]; resources?: any[]; assignments?: any[]; planVersions?: any[]; baselines?: any[]; baselineTasks?: any[] };
    for (const item of state.projects ?? []) await ctx.db.insert("projects", { ...item, ownerId });
    for (const [index, item] of (state.tasks ?? []).entries()) await ctx.db.insert("tasks", { ...item, ownerId, sortOrder: item.sortOrder ?? index });
    for (const item of state.dependencies ?? []) await ctx.db.insert("dependencies", { ...item, ownerId });
    for (const item of state.calendars ?? []) await ctx.db.insert("calendars", { ...item, ownerId });
    for (const item of state.exceptions ?? []) await ctx.db.insert("calendarExceptions", { ...item, ownerId });
    for (const item of state.resources ?? []) await ctx.db.insert("resources", { ...item, ownerId });
    for (const item of state.assignments ?? []) await ctx.db.insert("taskAssignments", { ...item, ownerId });
    for (const item of state.planVersions ?? []) await ctx.db.insert("planVersions", { ...item, ownerId });
    for (const item of state.baselines ?? []) await ctx.db.insert("baselines", { ...item, ownerId });
    for (const item of state.baselineTasks ?? []) await ctx.db.insert("baselineTasks", { ...item, ownerId });
  },
});
