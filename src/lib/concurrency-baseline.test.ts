import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";

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
  return { a, b, read };
}

// These diagnostic assertions document current UNSAFE behavior, not desired
// concurrency guarantees. Replace them with protection assertions in phase 2.
test("baseline: a fresh backend read by B sees A's committed edit (not UI delivery)", async () => {
  const { a, b, read } = await sessions();
  const before = await read(a);
  expect((await read(b)).companyId).toBe(before.companyId);
  const result = await a.mutation(api.planner.replaceState, { state: { ...before, tasks: before.tasks.map(task => task.id === "p-v1-0" ? { ...task, name: "A changed this" } : task) } });
  expect(result.updated).toBe(1);
  expect((await read(b)).tasks.find(task => task.id === "p-v1-0")?.name).toBe("A changed this");
});

test("diagnostic: B's stale edit in another project silently overwrites A", async () => {
  const { a, b, read } = await sessions();
  const initialA = await read(a);
  const staleB = await read(b);
  await a.mutation(api.planner.replaceState, { state: { ...initialA, tasks: initialA.tasks.map(task => task.id === "p-v1-0" ? { ...task, name: "A changed this" } : task) } });
  expect((await read(a)).tasks.find(task => task.id === "p-v1-0")?.name).toBe("A changed this");
  const result = await b.mutation(api.planner.replaceState, { state: { ...staleB, tasks: staleB.tasks.map(task => task.id === "q-v1-0" ? { ...task, notes: "B changed this" } : task) } });
  expect(result.updated).toBe(2);
  const final = await read(a);
  expect(final.tasks.find(task => task.id === "p-v1-0")?.name).toBe("Task 0");
  expect(final.tasks.find(task => task.id === "q-v1-0")?.notes).toBe("B changed this");
  expect(final.planVersions).toEqual(initialA.planVersions);
});

test("diagnostic: same-field stale saves succeed with last-save-wins", async () => {
  const { a, b, read } = await sessions();
  const initialA = await read(a);
  const staleB = await read(b);
  for (const [actor, snapshot, name] of [[a, initialA, "A"], [b, staleB, "B"]] as const) {
    const result = await actor.mutation(api.planner.replaceState, { state: { ...snapshot, tasks: snapshot.tasks.map(task => task.id === "p-v1-0" ? { ...task, name } : task) } });
    expect(result.updated).toBe(1);
  }
  expect((await read(a)).tasks.find(task => task.id === "p-v1-0")?.name).toBe("B");
});

test("baseline: deterministic dataset and no-op writes, not billed database bytes", async () => {
  const { a } = await sessions();
  const state = fixture();
  const result = await a.mutation(api.planner.replaceState, { state });
  expect(result).toEqual({ inserted: 0, updated: 0, removed: 0, kept: 507 });
  console.info("PHASE1_BASELINE", JSON.stringify({
    environment: "convex-test, local, not billed",
    fixtureSha256: createHash("sha256").update(JSON.stringify(state)).digest("hex"),
    rows: Object.fromEntries(Object.entries(state).map(([key, value]) => [key, value.length])),
    payloadJsonUtf8Bytes: new TextEncoder().encode(JSON.stringify(state)).byteLength,
    noopWrites: result, databaseReadBytes: null, databaseWriteBytes: null,
  }));
});
