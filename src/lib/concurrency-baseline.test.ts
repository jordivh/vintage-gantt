import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { changeRequest, fingerprint, type Workspace } from "./workspace-changes";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { recalculateTasks, type PlannerTask } from "./planner-model";
import { createDefaultCalendarSystem } from "./scheduling-engine";

const modules = {
  "./planner.ts": () => import("../convex/planner"),
  "./companies.ts": () => import("../convex/companies"),
  "./_generated/api.ts": () => import("../convex/_generated/api"),
  "./_generated/server.ts": () => import("../convex/_generated/server"),
};
const now = "2026-10-08T09:00:00.000Z";
const fixture = () => ({
  projects: ["p", "q"].map(id => ({ id, name: id, status: "active", kind: "project", startDate: "2026-10-05", schedulingDirection: "forward", calendarId: "cal", createdAt: now, updatedAt: now })),
  calendars: [{ id: "cal", name: "Standard", type: "base", parentCalendarId: null, isDefault: true, workingDays: [1, 2, 3, 4, 5] }],
  tasks: ["p", "q"].flatMap(projectId => ["v1", "v2"].flatMap(version => Array.from({ length: 125 }, (_, i) => ({
    id: `${projectId}-${version}-${i}`, projectId, versionId: `${projectId}-${version}`, sortOrder: i, parentId: null,
    name: `Task ${i}`, duration: 2, durationUnit: "days", start: "2026-10-05", finish: "2026-10-06", work: 16,
    isMilestone: false, predecessors: "", resource: "", percent: 0, notes: "", color: "sage", marginPct: 0,
  })))),
  planVersions: ["p", "q"].flatMap(projectId => ["v1", "v2"].map(v => ({ id: `${projectId}-${v}`, projectId, name: v, isActive: v === "v1", createdAt: now, mode: "planning" }))),
  dependencies: [], resources: [], assignments: [], exceptions: [], baselines: [], baselineTasks: [],
});

async function sessions() {
  const t = convexTest(schema, modules);
  const admin = await t.run(ctx => ctx.db.insert("users", { name: "A", email: "a@example.com" }));
  const a = t.withIdentity({ subject: admin });
  await a.mutation(api.companies.ensureCompany, {});
  const account = await t.run(ctx => ctx.db.get(admin));
  if (!account?.companyId) throw new Error("Missing baseline company");
  const colleague = await t.run(ctx => ctx.db.insert("users", { name: "B", email: "b@example.com", companyId: account.companyId, companyRole: "user" }));
  const b = t.withIdentity({ subject: colleague });
  await a.mutation(api.planner.replaceState, { state: fixture() });
  const read = async (actor: typeof a) => {
    const state = await actor.query(api.planner.getState, {});
    if (!state) throw new Error("Missing baseline workspace");
    return state;
  };
  const save = async (actor: typeof a, before: Workspace, after: Workspace) => actor.mutation(api.planner.saveChanges, await changeRequest(before, after));
  return { t, a, b, read, save };
}

// Regression tests use stale snapshots deliberately; no fresh-read helper here.
test("baseline: a fresh backend read by B sees A's committed edit (not UI delivery)", async () => {
  const { a, b, read, save } = await sessions();
  const before = await read(a);
  expect((await read(b)).companyId).toBe(before.companyId);
  const result = await save(a, before, { ...before, tasks: before.tasks.map(task => task.id === "p-v1-0" ? { ...task, name: "A changed this" } : task) });
  expect(result.updated).toBe(1);
  expect((await read(b)).tasks.find(task => task.id === "p-v1-0")?.name).toBe("A changed this");
});

test("stale edits in different projects preserve both users' changes", async () => {
  const { a, b, read, save } = await sessions();
  const initialA = await read(a);
  const staleB = await read(b);
  await save(a, initialA, { ...initialA, tasks: initialA.tasks.map(task => task.id === "p-v1-0" ? { ...task, name: "A changed this" } : task) });
  expect((await read(a)).tasks.find(task => task.id === "p-v1-0")?.name).toBe("A changed this");
  const result = await save(b, staleB, { ...staleB, tasks: staleB.tasks.map(task => task.id === "q-v1-0" ? { ...task, notes: "B changed this" } : task) });
  expect(result.updated).toBe(1);
  const final = await read(a);
  expect(final.tasks.find(task => task.id === "p-v1-0")?.name).toBe("A changed this");
  expect(final.tasks.find(task => task.id === "q-v1-0")?.notes).toBe("B changed this");
  expect(final.planVersions).toEqual(initialA.planVersions);
});

test("same-task conflict rejects the whole save without modifying the local input", async () => {
  const { a, b, read, save } = await sessions();
  const initialA = await read(a);
  const staleB = await read(b);
  await save(a, initialA, { ...initialA, tasks: initialA.tasks.map(task => task.id === "p-v1-0" ? { ...task, name: "A" } : task) });
  const draft = { ...staleB, tasks: staleB.tasks.map(task => task.id === "p-v1-0" ? { ...task, name: "B" } : task) };
  await expect(save(b, staleB, draft)).rejects.toThrow("Someone changed");
  expect(draft.tasks.find(task => task.id === "p-v1-0")?.name).toBe("B");
  expect((await read(a)).tasks.find(task => task.id === "p-v1-0")?.name).toBe("A");
});

test("unchanged planning inputs are guarded and coupled changes fail atomically", async () => {
  const { a, b, read, save } = await sessions();
  const base = await read(a);
  const stale = await read(b);
  await save(a, base, { ...base, tasks: base.tasks.map(task => task.id === "p-v1-0" ? { ...task, duration: 3, finish: "2026-10-07" } : task) });
  const draft = { ...stale, tasks: stale.tasks.map(task => ["p-v1-1", "p-v1-2"].includes(task.id) ? { ...task, start: "2026-10-08", finish: "2026-10-09" } : task) };
  await expect(save(b, stale, draft)).rejects.toThrow("Someone changed");
  expect((await read(a)).tasks.find(task => task.id === "p-v1-1")?.start).toBe("2026-10-05");
  const fresh = await read(b);
  const next = { ...fresh, tasks: fresh.tasks.map(task => ["p-v1-1", "p-v1-2"].includes(task.id) ? { ...task, start: "2026-10-08", finish: "2026-10-09" } : task) };
  expect((await save(b, fresh, next)).updated).toBe(2);
});

test("delete versus edit conflicts in both directions; deleted tasks cannot be recreated", async () => {
  const { a, b, read, save } = await sessions();
  const stale = await read(b);
  const request = await changeRequest(stale, { ...stale, tasks: stale.tasks.map(task => task.id === "p-v1-0" ? { ...task, notes: "B" } : task) });
  await a.mutation(api.planner.deleteTasks, { projectId: "p", taskIds: ["p-v1-0"], expected: await fingerprint(stale) });
  await expect(b.mutation(api.planner.saveChanges, request)).rejects.toThrow("Someone changed");
  expect((await read(a)).tasks.some(task => task.id === "p-v1-0")).toBe(false);
  const before = await read(a);
  await save(b, before, { ...before, tasks: before.tasks.map(task => task.id === "p-v1-1" ? { ...task, notes: "B" } : task) });
  await expect(a.mutation(api.planner.deleteTasks, { projectId: "p", taskIds: ["p-v1-1"], expected: await fingerprint(before) })).rejects.toThrow("workspace changed");
  expect((await read(a)).tasks.find(task => task.id === "p-v1-1")?.notes).toBe("B");
});

test("legacy full replacement without a base or with a stale base cannot overwrite", async () => {
  const { a, b, read, save } = await sessions();
  const before = await read(a);
  await expect(a.mutation(api.planner.replaceState, { state: fixture() })).rejects.toThrow("workspace changed");
  await save(a, before, { ...before, tasks: before.tasks.map(task => task.id === "p-v1-0" ? { ...task, name: "A" } : task) });
  await expect(b.mutation(api.planner.replaceState, { state: fixture(), expected: await fingerprint(before) })).rejects.toThrow("workspace changed");
});

test("actual dependency recalculation persists every affected task in one guarded save", async () => {
  const { a, read, save } = await sessions();
  const initial = await read(a);
  const linked = { ...initial, tasks: initial.tasks.map(task => task.id === "p-v1-1" ? { ...task, predecessors: "p-v1-0FS" } : task) };
  await save(a, initial, linked);
  const before = await read(a);
  const source = before.tasks.filter(task => task.projectId === "p" && task.versionId === "p-v1");
  const edited = source.map(task => task.id === "p-v1-0" ? { ...task, duration: 4 } : task);
  const result = recalculateTasks(edited as PlannerTask[], { direction: "forward", calendarSystem: createDefaultCalendarSystem(), projectCalendarId: "cal" });
  expect(result.error).toBeUndefined();
  const byId = new Map(result.tasks.map(task => [task.id, task]));
  const next = { ...before, tasks: before.tasks.map(task => byId.has(task.id) ? { ...task, ...byId.get(task.id) } : task) };
  const request = await changeRequest(before, next);
  expect(request.changes.some(change => change.id === "p-v1-0")).toBe(true);
  expect(request.changes.some(change => change.id === "p-v1-1")).toBe(true);
  await a.mutation(api.planner.saveChanges, request);
  const after = await read(a);
  for (const task of next.tasks) expect(after.tasks.find(row => row.id === task.id)).toEqual(task);
});

test("delta API refuses cross-company row edits and missing planning guards", async () => {
  const { t, a, read } = await sessions();
  const betaId = await t.run(ctx => ctx.db.insert("users", { email: "beta@example.com" }));
  const beta = t.withIdentity({ subject: betaId });
  await beta.mutation(api.companies.ensureCompany, {});
  const before = await read(a);
  const row = before.tasks[0];
  const request = await changeRequest(before, { ...before, tasks: before.tasks.map(task => task.id === row.id ? { ...task, notes: "foreign" } : task) });
  await expect(beta.mutation(api.planner.saveChanges, request)).rejects.toThrow("Someone changed");
  expect((await read(a)).tasks[0]).toEqual(row);
  await expect(a.mutation(api.planner.saveChanges, { ...request, guards: [] })).rejects.toThrow("guard is required");
});

test("baseline: deterministic dataset and no-op writes, not billed database bytes", async () => {
  const { a, read, save } = await sessions();
  const state = fixture();
  const result = await save(a, await read(a), state);
  expect(result).toEqual({ inserted: 0, updated: 0, removed: 0, kept: 0 });
  console.info("PHASE1_BASELINE", JSON.stringify({
    environment: "convex-test, local, not billed",
    fixtureSha256: createHash("sha256").update(JSON.stringify(state)).digest("hex"),
    rows: Object.fromEntries(Object.entries(state).map(([key, value]) => [key, value.length])),
    payloadJsonUtf8Bytes: new TextEncoder().encode(JSON.stringify(state)).byteLength,
    noopWrites: result, databaseReadBytes: null, databaseWriteBytes: null,
  }));
});
