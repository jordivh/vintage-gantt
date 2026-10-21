import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { changeRequest, fingerprint, projectInputs, workspaceGuardScope, type Workspace } from "./workspace-changes";
import { plannerReadPolicy } from "./planner-read-policy";
import { createHash } from "node:crypto";
import { computeResourceLoads, type CapacityInput } from "./capacity-engine";
import { buildOverloadIndex } from "./overload";
import type { PlannerTask } from "./planner-model";
import type { CalendarSystem } from "./scheduling-engine";

const modules = {
  "./planner.ts": () => import("../convex/planner"), "./plannerReads.ts": () => import("../convex/plannerReads"),
  "./companies.ts": () => import("../convex/companies"),
  "./_generated/api.ts": () => import("../convex/_generated/api"), "./_generated/server.ts": () => import("../convex/_generated/server"),
};
const fixture = () => {
  const now = "2026-10-08T09:00:00.000Z";
  const projects = ["p", "q", "archive", "template"].map(id => ({ id, name: id, status: id === "archive" ? "archived" : id === "template" ? "template" : "active", kind: id === "template" ? "template" : "project", startDate: "2026-10-05", calendarId: "cal", schedulingDirection: "forward", createdAt: now, updatedAt: now }));
  const tasks = projects.flatMap(project => ["v1", "v2"].flatMap(v => Array.from({ length: 125 }, (_, i) => ({ id: `${project.id}-${v}-${i}`, projectId: project.id, versionId: `${project.id}-${v}`, sortOrder: i, parentId: null, name: `Task ${i}`, duration: 2, durationUnit: "days", start: "2026-10-05", finish: "2026-10-06", work: 16, isMilestone: false, predecessors: "", resource: "", percent: 0, notes: "", color: "sage" }))));
  const baselines = projects.map(project => ({ id: `base-${project.id}`, projectId: project.id, versionId: `${project.id}-v1`, name: "Baseline", createdAt: now }));
  return { projects, tasks, calendars: [{ id: "cal", name: "Standard", type: "base", parentCalendarId: null, isDefault: true, workingDays: [1, 2, 3, 4, 5] }],
    resources: [{ id: "r", name: "Anna", role: "", email: "", colour: "sage", hoursPerWeek: 40, isActive: true, calendarId: "cal" }],
    planVersions: projects.flatMap(project => ["v1", "v2"].map(v => ({ id: `${project.id}-${v}`, projectId: project.id, name: v, isActive: v === "v1", createdAt: now, mode: "planning" }))),
    baselines, baselineTasks: baselines.flatMap(b => tasks.filter(t => t.projectId === b.projectId && t.versionId === b.versionId).map(t => ({ id: `snapshot-${t.id}`, baselineId: b.id, taskId: t.id, startDate: t.start, finishDate: t.finish, durationDays: 2, marginPct: 0, marginDaysOriginal: 0, marginDaysConsumed: 0 }))),
    assignments: tasks.map(t => ({ id: `as-${t.id}`, taskId: t.id, resourceId: "r" })), dependencies: [],
    exceptions: [{ id: "leave", calendarId: "cal", startDate: "2026-10-12", endDate: "2026-10-16", label: "Leave", type: "leave", isWorkingDay: false, source: "manual" }],
  };
};
async function setup() {
  const t = convexTest(schema, modules);
  const user = await t.run(ctx => ctx.db.insert("users", { email: "a@example.com" }));
  const a = t.withIdentity({ subject: user });
  await a.mutation(api.companies.ensureCompany, {});
  await a.mutation(api.planner.replaceState, { state: fixture() });
  const account = await t.run(ctx => ctx.db.get(user));
  const colleague = await t.run(ctx => ctx.db.insert("users", { email: "b@example.com", companyId: account?.companyId, companyRole: "user" }));
  const b = t.withIdentity({ subject: colleague });
  const read = async (actor: typeof a, requests = [{ projectId: "p", versionIds: ["p-v1"], allVersions: false }], baselineIds: string[] = []) => {
    const catalog = await actor.query(api.plannerReads.catalog, {});
    const calendars = await actor.query(api.plannerReads.calendars, {});
    const people = await actor.query(api.plannerReads.people, {});
    const plans = await actor.query(api.plannerReads.plans, { requests });
    const snapshots = await actor.query(api.plannerReads.snapshots, { baselineIds });
    if (!catalog || !calendars || !people || !plans || !snapshots) throw new Error("Missing reads");
    return { state: { ...catalog, ...calendars, ...people, ...plans, ...snapshots } as Workspace, coverage: plans.coverage };
  };
  return { t, a, b, read };
}

test("route policy excludes hidden planning data and keeps active cross-project workload", () => {
  const data = fixture();
  expect(plannerReadPolicy("/account", data.projects, data.planVersions, "p", "p-v1").requests).toEqual([]);
  const dashboard = plannerReadPolicy("/dashboard", data.projects, data.planVersions, "p", "p-v2");
  expect(dashboard.requests.map(r => r.projectId)).toEqual(["p", "q"]);
  expect(dashboard.requests[0].versionIds).toEqual(["p-v1", "p-v2"]);
  expect(dashboard.requests.every(r => !r.allVersions)).toBe(true);
  expect(plannerReadPolicy("/projects", data.projects, data.planVersions, "p", "p-v1").requests.map(r => r.projectId)).toEqual(["p", "q", "archive"]);
  expect(plannerReadPolicy("/calendars", data.projects, data.planVersions, "p", "p-v1").requests.every(r => r.allVersions)).toBe(true);
});

test("only selected versions and snapshots are read; catalog contains no tasks", async () => {
  const { a, read } = await setup();
  const catalog = await a.query(api.plannerReads.catalog, {});
  expect(Object.keys(catalog ?? {}).includes("tasks")).toBe(false);
  const loaded = await read(a);
  expect(loaded.state.tasks?.length).toBe(125);
  expect(loaded.state.assignments?.length).toBe(125);
  expect(loaded.state.baselineTasks?.length).toBe(0);
  const comparison = await read(a, [{ projectId: "p", versionIds: ["p-v1", "p-v2"], allVersions: false }], ["base-p"]);
  expect(comparison.state.tasks?.length).toBe(250);
  expect(comparison.state.baselineTasks?.length).toBe(125);
  expect(comparison.state.baselineTasks?.every(row => row.baselineId === "base-p")).toBe(true);
});

test("partial save preserves unloaded versions, baselines, assignments and other projects", async () => {
  const { a, read } = await setup();
  const { state, coverage } = await read(a);
  const request = await changeRequest(state, { ...state, tasks: state.tasks?.map(row => row.id === "p-v1-0" ? { ...row, notes: "edited" } : row) }, coverage);
  expect(request.changes.length).toBe(1);
  await a.mutation(api.planner.saveChanges, request);
  const all = await a.query(api.planner.getState, {});
  expect(all?.tasks.length).toBe(1000);
  expect(all?.baselineTasks.length).toBe(500);
  expect(all?.assignments.length).toBe(1000);
  expect(all?.tasks.find(row => row.id === "p-v2-0")?.notes).toBe("");
});

test("calendar day off saves with unloaded templates and survives a fresh read", async () => {
  const { a, read } = await setup();
  const data = fixture();
  const policy = plannerReadPolicy("/calendars", data.projects, data.planVersions, "p", "p-v1");
  const { state, coverage } = await read(a, policy.requests);
  expect(coverage.map(row => row.projectId)).toEqual(["p", "q", "archive"]);
  const dayOff = { id: "day-off", calendarId: "cal", startDate: "2026-10-06", endDate: "2026-10-06", label: "Non-working day", type: "shutdown", isWorkingDay: false, source: "manual" };
  const next = { ...state, exceptions: [...(state.exceptions ?? []), dayOff] };
  const result = await a.mutation(api.planner.saveChanges, await changeRequest(state, next, coverage));
  expect(result.inserted).toBe(1);
  const fresh = await read(a, policy.requests);
  expect(fresh.state.exceptions?.find(row => row.id === dayOff.id)).toEqual(dayOff);
  const full = await a.query(api.planner.getState, {});
  expect(full?.tasks.filter(row => row.projectId === "template")).toEqual(data.tasks.filter(row => row.projectId === "template"));
  expect(full?.baselineTasks.length).toBe(500);
  expect(full?.assignments.length).toBe(1000);
  await a.mutation(api.planner.saveChanges, await changeRequest(fresh.state, { ...fresh.state, exceptions: fresh.state.exceptions?.filter(row => row.id !== dayOff.id) }, fresh.coverage));
  expect((await read(a, policy.requests)).state.exceptions?.some(row => row.id === dayOff.id)).toBe(false);
});

test("added calculation guards send only fields accepted by the backend validator", async () => {
  const { a, read } = await setup();
  const { state, coverage } = await read(a);
  const calculated = await changeRequest(state, state, coverage);
  // Reproduce the extra guard the store adds after an optimization even when its
  // planner calculation made no persisted row changes (the optimized result can
  // be identical to the selected version).
  const projectId = "p";
  const scope = coverage.find(row => row.projectId === projectId)!;
  calculated.guards.push({
    projectId,
    fingerprint: await fingerprint(projectInputs(state, projectId)),
    scope: workspaceGuardScope(scope, []),
  });
  expect(calculated.guards.every(guard => !guard.scope || Object.keys(guard.scope).sort().join(",") === "allVersions,baselineIds,versionIds")).toBe(true);
  await a.mutation(api.planner.saveChanges, calculated);
});

test("calendar save still rejects concurrent changes to loaded planning inputs atomically", async () => {
  const { a, b, read } = await setup();
  const data = fixture();
  const requests = plannerReadPolicy("/calendars", data.projects, data.planVersions, "p", "p-v1").requests;
  const stale = await read(a, requests);
  const colleague = await read(b);
  await b.mutation(api.planner.saveChanges, await changeRequest(colleague.state, { ...colleague.state, tasks: colleague.state.tasks?.map(row => row.id === "p-v1-0" ? { ...row, notes: "Colleague edit" } : row) }, colleague.coverage));
  const dayOff = { id: "conflicting-day-off", calendarId: "cal", startDate: "2026-10-06", endDate: "2026-10-06", label: "Non-working day", type: "shutdown", isWorkingDay: false, source: "manual" };
  await expect(a.mutation(api.planner.saveChanges, await changeRequest(stale.state, { ...stale.state, exceptions: [...(stale.state.exceptions ?? []), dayOff] }, stale.coverage))).rejects.toThrow("Someone changed");
  const full = await a.query(api.planner.getState, {});
  expect(full?.exceptions.some(row => row.id === dayOff.id)).toBe(false);
  expect(full?.tasks.find(row => row.id === "p-v1-0")?.notes).toBe("Colleague edit");
});

test("scoped stale same-project save conflicts; different-project saves survive", async () => {
  const { a, b, read } = await setup();
  const baseA = await read(a);
  const baseB = await read(b);
  const q = await read(b, [{ projectId: "q", versionIds: ["q-v1"], allVersions: false }]);
  const edit = (state: Workspace, id: string, notes: string) => ({ ...state, tasks: state.tasks?.map(row => row.id === id ? { ...row, notes } : row) });
  await a.mutation(api.planner.saveChanges, await changeRequest(baseA.state, edit(baseA.state, "p-v1-0", "A"), baseA.coverage));
  await expect(b.mutation(api.planner.saveChanges, await changeRequest(baseB.state, edit(baseB.state, "p-v1-1", "B"), baseB.coverage))).rejects.toThrow("Someone changed");
  await b.mutation(api.planner.saveChanges, await changeRequest(q.state, edit(q.state, "q-v1-0", "B"), q.coverage));
  const fresh = await read(b);
  expect(fresh.state.tasks?.find(row => row.id === "p-v1-0")?.notes).toBe("A");
});

test("foreign company ids cannot retrieve plan rows or snapshots", async () => {
  const { t, a } = await setup();
  const id = await t.run(ctx => ctx.db.insert("users", { email: "foreign@example.com" }));
  const foreign = t.withIdentity({ subject: id });
  await foreign.mutation(api.companies.ensureCompany, {});
  expect((await foreign.query(api.plannerReads.plans, { requests: [{ projectId: "p", versionIds: ["p-v1"], allVersions: true }] }))?.tasks).toEqual([]);
  expect((await foreign.query(api.plannerReads.snapshots, { baselineIds: ["base-p"] }))?.baselineTasks).toEqual([]);
  expect((await a.query(api.plannerReads.people, {}))?.resources.length).toBe(1);
});

test("active scoped data reproduces capacity, leave and cross-project overload exactly", async () => {
  const { a, read } = await setup();
  const full = await a.query(api.planner.getState, {});
  if (!full) throw new Error("Missing fixture");
  const partial = await read(a, [{ projectId: "p", versionIds: ["p-v1"], allVersions: false }, { projectId: "q", versionIds: ["q-v1"], allVersions: false }]);
  const input = (state: Workspace): CapacityInput => ({
    system: { calendars: state.calendars, exceptions: state.exceptions, defaultCalendarId: "cal" } as unknown as CalendarSystem,
    resources: (state.resources ?? []).map(row => ({ id: row.id, name: String(row.name), hoursPerWeek: Number(row.hoursPerWeek), calendarId: String(row.calendarId) })),
    assignments: (state.assignments ?? []).map(row => ({ taskId: String(row.taskId), resourceId: String(row.resourceId) })),
    projects: (state.projects ?? []).filter(row => row.status === "active" && row.kind !== "template").map(row => ({ projectId: row.id, projectName: String(row.name), projectCalendarId: String(row.calendarId), tasks: (state.tasks ?? []).filter(task => task.projectId === row.id && task.versionId === `${row.id}-v1`) as unknown as PlannerTask[] })),
  });
  expect(computeResourceLoads(input(partial.state))).toEqual(computeResourceLoads(input(full as Workspace)));
  expect(buildOverloadIndex(input(partial.state))).toEqual(buildOverloadIndex(input(full as Workspace)));
});

test("repeatable read-result comparison is NOT billed database-byte measurement", async () => {
  const { a, read } = await setup();
  const full = await a.query(api.planner.getState, {});
  const partial = await read(a, [{ projectId: "p", versionIds: ["p-v1"], allVersions: false }, { projectId: "q", versionIds: ["q-v1"], allVersions: false }]);
  expect(partial.state.tasks?.length).toBe(250);
  expect(full?.tasks.length).toBe(1000);
  console.info("PHASE3_READ_RESULT", JSON.stringify({ fixtureSha256: createHash("sha256").update(JSON.stringify(fixture())).digest("hex"), fullTasks: full?.tasks.length, selectedTasks: partial.state.tasks?.length,
    fullSnapshots: full?.baselineTasks.length, selectedSnapshots: partial.state.baselineTasks?.length,
    fullResultJsonBytes: new TextEncoder().encode(JSON.stringify(full)).length, selectedCombinedResultJsonBytes: new TextEncoder().encode(JSON.stringify(partial.state)).length,
    databaseReadBytes: null, note: "Local return-value sizes, not database I/O or live Usage" }));
});
