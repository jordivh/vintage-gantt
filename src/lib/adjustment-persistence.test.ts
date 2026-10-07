/**
 * An adjustment and its removal have to survive the database: after a refresh
 * (or a version switch) the segments, the log and the removal record must still
 * be there, and removing must still reach the stored task. These cases drive the
 * same save/read pair the app uses (`replaceState` / `getState`).
 */
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { PlannerTask } from "./planner-model";
import { removeAllAdjustments } from "./remaining-work";

const modules = {
  "./planner.ts": () => import("../convex/planner"),
  "./companies.ts": () => import("../convex/companies"),
  "./passwordRecovery.ts": () => import("../convex/passwordRecovery"),
  "./auth.ts": () => import("../convex/auth"),
  "./auth/emailOtp.ts": () => import("../convex/auth/emailOtp"),
  "./auth/passwordReset.ts": () => import("../convex/auth/passwordReset"),
  "./_generated/api.ts": () => import("../convex/_generated/api"),
  "./_generated/server.ts": () => import("../convex/_generated/server"),
};

const NOW = "2026-09-12T09:00:00.000Z";

/** t1 is already adjusted: two segments, one live log entry, 80 h workload. */
const adjustedTask = {
  id: "t1", projectId: "p1", parentId: null, sortOrder: 0, name: "Running task", duration: 15, durationUnit: "days",
  start: "2026-09-01", finish: "2026-09-21", isMilestone: false, predecessors: "", resource: "", percent: 0,
  notes: "", color: "sage", versionId: "v1", work: 80, distribution: "even", marginPct: 20, marginDaysOriginal: 2, marginDaysConsumed: 2,
  allocations: [
    { kind: "fixed", days: [{ date: "2026-09-01", hours: 4 }, { date: "2026-09-14", hours: 4 }] },
    { kind: "planned", hours: 40, start: "2026-09-15", finish: "2026-09-21", distribution: "even" },
  ],
  adjustments: [{
    id: "adj-t1-1", at: "2026-09-12T09:00:00.000Z", userId: "u1", userName: "Ada", keepUntil: "2026-09-14",
    oldFinish: "2026-09-14", newFinish: "2026-09-21", oldWork: 40, newWork: 80, marginConsumed: 2, daysPushed: 3,
    reason: "Supplier delayed",
    before: { allocations: undefined, adjustments: undefined, work: 40, duration: 10, durationUnit: "days", finish: "2026-09-14", distribution: "even", marginPct: 20, marginDaysOriginal: 2, marginDaysConsumed: 0 },
  }],
};

const successorTask = {
  id: "t2", projectId: "p1", parentId: null, sortOrder: 1, name: "Successor", duration: 2, durationUnit: "days",
  start: "2026-09-22", finish: "2026-09-23", isMilestone: false, predecessors: "t1FS", resource: "", percent: 0,
  notes: "", color: "sage", versionId: "v1", marginPct: 0, marginDaysOriginal: 0, marginDaysConsumed: 0,
};

const state = {
  projects: [{ id: "p1", name: "Project", status: "active", kind: "project" as const, startDate: "2026-09-01", schedulingDirection: "forward", calendarId: "base", createdAt: NOW, updatedAt: NOW }],
  calendars: [{ id: "base", name: "Base", type: "base", parentCalendarId: null, isDefault: true, workingDays: [1, 2, 3, 4, 5] }],
  resources: [{ id: "res1", name: "Chris", role: "", email: "chris@example.com", colour: "sage", hoursPerWeek: 40, isActive: true, calendarId: "base" }],
  exceptions: [],
  assignments: [{ id: "as1", taskId: "t1", resourceId: "res1" }],
  dependencies: [{ id: "dep1", projectId: "p1", predecessorId: "t1", successorId: "t2", type: "FS", lagDays: 0 }],
  planVersions: [{ id: "v1", projectId: "p1", name: "Version 1", isActive: true, createdAt: NOW, mode: "monitoring" }],
  baselines: [{ id: "b1", projectId: "p1", versionId: "v1", name: "Baseline 1", createdAt: NOW }],
  baselineTasks: [{ id: "bt1", baselineId: "b1", taskId: "t1", startDate: "2026-09-01", finishDate: "2026-09-14", durationDays: 10, work: 40, marginPct: 20, marginDaysOriginal: 2, marginDaysConsumed: 0 }],
  tasks: [adjustedTask, successorTask],
};

type StoredState = {
  tasks: PlannerTask[];
  baselineTasks: { taskId: string; work?: number }[];
  assignments: { id: string; taskId: string }[];
};

async function workspace(t: ReturnType<typeof convexTest>, email: string) {
  const userId = await t.run((ctx) => ctx.db.insert("users", { name: "Admin", email }));
  await t.withIdentity({ subject: userId }).mutation(api.companies.ensureCompany, {});
  await t.withIdentity({ subject: userId }).mutation(api.planner.replaceState, { state });
  return userId;
}

describe("adjustment persistence", () => {
  test("segments, log and the removal record survive a refresh", async () => {
    const t = convexTest(schema, modules);
    const userId = await workspace(t, "a@example.com");

    const first = (await t.withIdentity({ subject: userId }).query(api.planner.getState, {})) as unknown as StoredState;
    const loaded = first.tasks.find((task) => task.id === "t1")!;
    expect(loaded.allocations?.length).toBe(2);
    expect(loaded.adjustments?.length).toBe(1);
    expect(loaded.adjustments?.[0].before.distribution).toBe("even");
    expect(loaded.adjustments?.[0].before.duration).toBe(10);
    expect(first.baselineTasks.find((row) => row.taskId === "t1")?.work).toBe(40);

    // The app removes the adjustment and saves the workspace again.
    const restored = removeAllAdjustments(loaded, { id: "u1", name: "Ada" }, "2026-09-16T09:00:00.000Z")!;
    expect(restored.allocations).toBeUndefined();
    const payload = { ...state, tasks: [restored, successorTask] };
    await t.withIdentity({ subject: userId }).mutation(api.planner.replaceState, { state: payload });

    // A fresh sign-in reads it back: still no segments, and the history is kept.
    await t.withIdentity({ subject: userId }).mutation(api.companies.ensureCompany, {});
    const second = (await t.withIdentity({ subject: userId }).query(api.planner.getState, {})) as unknown as StoredState;
    const after = second.tasks.find((task) => task.id === "t1")!;
    expect(after.allocations).toBeUndefined();
    expect(after.finish).toBe("2026-09-14");
    expect(after.work).toBe(40);
    expect(after.adjustments?.length).toBe(1);
    expect(after.adjustments?.[0].removedAt).toBe("2026-09-16T09:00:00.000Z");
    expect(after.adjustments?.[0].removedByName).toBe("Ada");
    // The assignment is untouched.
    expect(second.assignments.filter((row) => row.taskId === "t1").length).toBe(1);
  });

  test("a stored removal is visible to the next session", async () => {
    const t = convexTest(schema, modules);
    const userId = await workspace(t, "b@example.com");
    const loaded = ((await t.withIdentity({ subject: userId }).query(api.planner.getState, {})) as unknown as StoredState).tasks.find((task) => task.id === "t1")!;
    const restored = removeAllAdjustments(loaded, { id: "u1", name: "Ada" }, "2026-09-16T09:00:00.000Z")!;
    await t.withIdentity({ subject: userId }).mutation(api.planner.replaceState, { state: { ...state, tasks: [restored, successorTask] } });

    const again = ((await t.withIdentity({ subject: userId }).query(api.planner.getState, {})) as unknown as StoredState).tasks.find((task) => task.id === "t1")!;
    // Nothing is left to remove, and the log still explains why.
    expect(removeAllAdjustments(again, { id: "u1", name: "Ada" }, "2026-09-17T09:00:00.000Z")).toBeNull();
    expect(again.adjustments?.[0].reason).toBe("Supplier delayed");
  });
});
