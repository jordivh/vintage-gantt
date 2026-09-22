import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

const requireOwner = async (ctx: QueryCtx | MutationCtx) => {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("You must be signed in to access planner data.");
  return userId;
};

const collectState = async (ctx: QueryCtx | MutationCtx, ownerId: Id<"users">) => {
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

const TEST_SEED_KEY = "TP-R2";
const TEST_PROJECT_ID = "proj-tp-r2";
const TEST_VERSION_ID = "version-tp-r2-1";
const TEST_TASK_IDS = ["1", "2", "3", "4", "5", "6", "7", "8"];

const testTasks = (versionId: string) => [
  { id: "1", projectId: TEST_PROJECT_ID, parentId: null, sortOrder: 0, name: "Voorbereiding", duration: 0, durationUnit: "days", start: "2026-10-05", finish: "2026-10-13", isMilestone: false, predecessors: "", resource: "", percent: 0, notes: "", color: "ochre", collapsed: false, versionId, marginPct: 0, marginDaysOriginal: 0, marginDaysConsumed: 0 },
  { id: "2", projectId: TEST_PROJECT_ID, parentId: "1", sortOrder: 1, name: "Concept opstellen", duration: 5, durationUnit: "days", start: "2026-10-05", finish: "2026-10-09", isMilestone: false, predecessors: "", resource: "", percent: 0, notes: "", color: "ochre", versionId, marginPct: 20, marginDaysOriginal: 1, marginDaysConsumed: 0 },
  { id: "3", projectId: TEST_PROJECT_ID, parentId: "1", sortOrder: 2, name: "Concept nakijken", duration: 2, durationUnit: "days", start: "2026-10-12", finish: "2026-10-13", isMilestone: false, predecessors: "2FS", resource: "", percent: 0, notes: "", color: "sage", versionId, marginPct: 0, marginDaysOriginal: 0, marginDaysConsumed: 0 },
  { id: "4", projectId: TEST_PROJECT_ID, parentId: null, sortOrder: 3, name: "Uitvoering", duration: 0, durationUnit: "days", start: "2026-10-14", finish: "2026-10-30", isMilestone: false, predecessors: "", resource: "", percent: 0, notes: "", color: "clay", collapsed: false, versionId, marginPct: 0, marginDaysOriginal: 0, marginDaysConsumed: 0 },
  { id: "5", projectId: TEST_PROJECT_ID, parentId: "4", sortOrder: 4, name: "Bouwen", duration: 10, durationUnit: "days", start: "2026-10-14", finish: "2026-10-27", isMilestone: false, predecessors: "3FS", resource: "", percent: 0, notes: "", color: "clay", versionId, marginPct: 10, marginDaysOriginal: 1, marginDaysConsumed: 0 },
  { id: "6", projectId: TEST_PROJECT_ID, parentId: "4", sortOrder: 5, name: "Documentatie", duration: 4, durationUnit: "days", start: "2026-10-14", finish: "2026-10-19", isMilestone: false, predecessors: "3FS", resource: "", percent: 0, notes: "", color: "ink", versionId, marginPct: 50, marginDaysOriginal: 2, marginDaysConsumed: 0 },
  { id: "7", projectId: TEST_PROJECT_ID, parentId: "4", sortOrder: 6, name: "Testen", duration: 3, durationUnit: "days", start: "2026-10-28", finish: "2026-10-30", isMilestone: false, predecessors: "5FS", resource: "", percent: 0, notes: "", color: "rust", versionId, marginPct: 0, marginDaysOriginal: 0, marginDaysConsumed: 0 },
  { id: "8", projectId: TEST_PROJECT_ID, parentId: null, sortOrder: 7, name: "Oplevering", duration: 0, durationUnit: "days", start: "2026-11-02", finish: "2026-11-02", isMilestone: true, predecessors: "7FS", resource: "", percent: 0, notes: "", color: "rust", versionId, marginPct: 0, marginDaysOriginal: 0, marginDaysConsumed: 0 },
];

const testDependencies = [
  { id: "dep-tp-r2-2-3", projectId: TEST_PROJECT_ID, predecessorId: "2", successorId: "3", type: "FS", lagDays: 0 },
  { id: "dep-tp-r2-3-5", projectId: TEST_PROJECT_ID, predecessorId: "3", successorId: "5", type: "FS", lagDays: 0 },
  { id: "dep-tp-r2-3-6", projectId: TEST_PROJECT_ID, predecessorId: "3", successorId: "6", type: "FS", lagDays: 0 },
  { id: "dep-tp-r2-5-7", projectId: TEST_PROJECT_ID, predecessorId: "5", successorId: "7", type: "FS", lagDays: 0 },
  { id: "dep-tp-r2-7-8", projectId: TEST_PROJECT_ID, predecessorId: "7", successorId: "8", type: "FS", lagDays: 0 },
];

const seedTestProject = async (ctx: MutationCtx, ownerId: Id<"users">) => {
  const executed = await ctx.db.query("seedRuns").withIndex("by_owner_seed", (q) => q.eq("ownerId", ownerId as never).eq("seedKey", TEST_SEED_KEY)).first();
  const existing = await ctx.db.query("projects").withIndex("by_owner", (q) => q.eq("ownerId", ownerId as never)).filter((q) => q.eq(q.field("seedKey"), TEST_SEED_KEY)).first();
  if (executed) return false;
  const now = new Date().toISOString();
  if (existing) {
    await ctx.db.insert("seedRuns", { ownerId, seedKey: TEST_SEED_KEY, executedAt: now });
    return false;
  }
  const calendars = await ctx.db.query("calendars").withIndex("by_owner", (q) => q.eq("ownerId", ownerId as never)).collect();
  const base = calendars.find((calendar) => calendar.id === "cal-base-belgium") ?? calendars.find((calendar) => calendar.isDefault);
  const calendarId = base?.id ?? "cal-base-belgium";
  if (!base) await ctx.db.insert("calendars", { ownerId, id: calendarId, name: "Belgium — standard", type: "base", parentCalendarId: null, isDefault: true, workingDays: [1, 2, 3, 4, 5] });
  const exceptions = await ctx.db.query("calendarExceptions").withIndex("by_owner", (q) => q.eq("ownerId", ownerId as never)).collect();
  const seedExceptions = [
    { id: "exc-tp-r2-armistice", calendarId, startDate: "2026-11-11", endDate: "2026-11-11", label: "Wapenstilstand", type: "holiday", isWorkingDay: false, source: "import" },
    { id: "exc-tp-r2-shutdown", calendarId, startDate: "2026-12-24", endDate: "2027-01-01", label: "collectieve sluiting", type: "shutdown", isWorkingDay: false, source: "import" },
  ];
  for (const exception of seedExceptions) if (!exceptions.some((item) => item.calendarId === calendarId && item.startDate === exception.startDate && item.endDate === exception.endDate)) await ctx.db.insert("calendarExceptions", { ownerId, ...exception });

  const resources = await ctx.db.query("resources").withIndex("by_owner", (q) => q.eq("ownerId", ownerId as never)).collect();
  let producer: { id: string; calendarId: string } | undefined = resources.find((resource) => resource.name === "M. Alvarez");
  if (!resources.length) {
    await ctx.db.insert("calendars", { ownerId, id: "cal-tp-r2-alvarez", name: "M. Alvarez — leave", type: "person", parentCalendarId: calendarId, isDefault: false, workingDays: [1, 2, 3, 4, 5] });
    await ctx.db.insert("calendars", { ownerId, id: "cal-tp-r2-shaw", name: "E. Shaw — leave", type: "person", parentCalendarId: calendarId, isDefault: false, workingDays: [1, 2, 3, 4, 5] });
    await ctx.db.insert("resources", { ownerId, id: "res-tp-r2-alvarez", name: "M. Alvarez", role: "Producer", email: "", colour: "#ad6650", hoursPerWeek: 40, isActive: true, calendarId: "cal-tp-r2-alvarez" });
    await ctx.db.insert("resources", { ownerId, id: "res-tp-r2-shaw", name: "E. Shaw", role: "Permits coordinator", email: "", colour: "#75856c", hoursPerWeek: 40, isActive: true, calendarId: "cal-tp-r2-shaw" });
    producer = { id: "res-tp-r2-alvarez", calendarId: "cal-tp-r2-alvarez" };
  }
  await ctx.db.insert("projects", { ownerId, id: TEST_PROJECT_ID, name: "TP-R2 — Testproject", status: "active", startDate: "2026-10-05", schedulingDirection: "forward", calendarId, createdAt: now, updatedAt: now, seedKey: TEST_SEED_KEY });
  await ctx.db.insert("planVersions", { ownerId, id: TEST_VERSION_ID, projectId: TEST_PROJECT_ID, name: "Versie 1", isActive: true, createdAt: now });
  for (const task of testTasks(TEST_VERSION_ID)) await ctx.db.insert("tasks", { ownerId, ...task });
  for (const dependency of testDependencies) await ctx.db.insert("dependencies", { ownerId, ...dependency });
  if (producer) {
    await ctx.db.insert("taskAssignments", { ownerId, id: "as-tp-r2-bouwen", taskId: "5", resourceId: producer.id });
    const leaveExists = exceptions.some((item) => item.calendarId === producer.calendarId && item.startDate === "2026-10-14" && item.endDate === "2026-10-16");
    if (!leaveExists) await ctx.db.insert("calendarExceptions", { ownerId, id: "exc-tp-r2-alvarez-leave", calendarId: producer?.calendarId!, startDate: "2026-10-14", endDate: "2026-10-16", label: "Test leave", type: "leave", isWorkingDay: false, source: "manual" });
  }
  await ctx.db.insert("seedRuns", { ownerId, seedKey: TEST_SEED_KEY, executedAt: now });
  return true;
};

export const initializeWorkspace = mutation({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireOwner(ctx);
    await seedTestProject(ctx, ownerId);
  },
});

export const ensureTestProject = mutation({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireOwner(ctx);
    return await seedTestProject(ctx, ownerId);
  },
});

export const resetTestProject = mutation({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireOwner(ctx);
    const project = await ctx.db.query("projects").withIndex("by_owner", (q) => q.eq("ownerId", ownerId as never)).filter((q) => q.eq(q.field("seedKey"), TEST_SEED_KEY)).first();
    if (!project) throw new Error("The seeded test project no longer exists.");
    const tasks = await ctx.db.query("tasks").withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId as never).eq("projectId", TEST_PROJECT_ID)).collect();
    const taskIds = new Set(tasks.map((task) => task.id));
    const dependencies = await ctx.db.query("dependencies").withIndex("by_owner", (q) => q.eq("ownerId", ownerId as never)).filter((q) => q.eq(q.field("projectId"), TEST_PROJECT_ID)).collect();
    const assignments = await ctx.db.query("taskAssignments").withIndex("by_owner", (q) => q.eq("ownerId", ownerId as never)).filter((q) => q.or(...[...taskIds].map((id) => q.eq(q.field("taskId"), id)))).collect();
    const versions = await ctx.db.query("planVersions").withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId as never).eq("projectId", TEST_PROJECT_ID)).collect();
    const baselines = await ctx.db.query("baselines").withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId as never).eq("projectId", TEST_PROJECT_ID)).collect();
    for (const row of tasks) await ctx.db.delete(row._id);
    for (const row of dependencies) await ctx.db.delete(row._id);
    for (const row of assignments) await ctx.db.delete(row._id);
    for (const row of versions) await ctx.db.delete(row._id);
    for (const row of baselines) await ctx.db.delete(row._id);
    const baselineTasks = await ctx.db.query("baselineTasks").withIndex("by_owner_baseline", (q) => q.eq("ownerId", ownerId as never)).collect();
    for (const row of baselineTasks.filter((item) => baselines.some((baseline) => baseline.id === item.baselineId) || taskIds.has(item.taskId))) await ctx.db.delete(row._id);
    const now = new Date().toISOString();
    const calendars = await ctx.db.query("calendars").withIndex("by_owner", (q) => q.eq("ownerId", ownerId as never)).collect();
    const baseCalendar = calendars.find((calendar) => calendar.id === "cal-base-belgium") ?? calendars.find((calendar) => calendar.isDefault);
    await ctx.db.patch(project._id, { name: "TP-R2 — Testproject", status: "active", startDate: "2026-10-05", schedulingDirection: "forward", calendarId: baseCalendar?.id ?? project.calendarId, updatedAt: now });
    await ctx.db.insert("planVersions", { ownerId, id: TEST_VERSION_ID, projectId: TEST_PROJECT_ID, name: "Versie 1", isActive: true, createdAt: now });
    for (const task of testTasks(TEST_VERSION_ID)) await ctx.db.insert("tasks", { ownerId, ...task });
    for (const dependency of testDependencies) await ctx.db.insert("dependencies", { ownerId, ...dependency });
    const producer = (await ctx.db.query("resources").withIndex("by_owner", (q) => q.eq("ownerId", ownerId as never)).collect()).find((resource) => resource.name === "M. Alvarez");
    const resetAssignment = producer ? { id: "as-tp-r2-bouwen", taskId: "5", resourceId: producer.id } : null;
    const producerCalendarId = producer?.calendarId;
    if (resetAssignment) {
      await ctx.db.insert("taskAssignments", { ownerId, ...resetAssignment });
      const leaveRows = await ctx.db.query("calendarExceptions").withIndex("by_owner", (q) => q.eq("ownerId", ownerId as never)).collect();
      for (const row of leaveRows.filter((item) => item.id === "exc-tp-r2-alvarez-leave")) await ctx.db.delete(row._id);
      await ctx.db.insert("calendarExceptions", { ownerId, id: "exc-tp-r2-alvarez-leave", calendarId: producer?.calendarId!, startDate: "2026-10-14", endDate: "2026-10-16", label: "Test leave", type: "leave", isWorkingDay: false, source: "manual" });
    }
    return {
      projectId: TEST_PROJECT_ID,
      version: { id: TEST_VERSION_ID, projectId: TEST_PROJECT_ID, name: "Versie 1", isActive: true, createdAt: now },
      tasks: testTasks(TEST_VERSION_ID),
      assignments: resetAssignment ? [resetAssignment] : [],
    };
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
