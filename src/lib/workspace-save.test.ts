/**
 * Saving the workspace.
 *
 * The client sends the whole workspace on every change, and the database has to
 * end up holding exactly that payload again — but a save must only *write* what
 * differs. Rewriting every row (delete all, insert all) made each save cost
 * twice the company's row count: after "Optimize planning" adds a second version
 * of a large plan, that is thousands of documents in one transaction, which is
 * both slow on every edit and, once the plan grows enough, larger than a
 * mutation may write at all (Convex allows 16,000 documents and 16 MiB per
 * mutation) — the save is then refused and the screen rolls back, exactly the
 * "Could not save to the central planner database" the plan showed.
 *
 * These cases pin the fix down: the payload is still stored exactly, unchanged
 * rows are never touched, a changed row is written in place (its `_id` survives),
 * and a one-field edit of a large optimized plan costs one write.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { normalizeWorkspaceRelations } from "./company-integrity";
import { applyPlanningModeMargins, copyTasksToVersion, dependenciesForTasks, type PlannerTask } from "./planner-model";
import { createDefaultCalendarSystem } from "./scheduling-engine";
import { withoutSnapshotLog } from "./remaining-work";

const modules = {
  "./planner.ts": () => import("../convex/planner"),
  "./companies.ts": () => import("../convex/companies"),
  "./auth.ts": () => import("../convex/auth"),
  "./_generated/api.ts": () => import("../convex/_generated/api"),
  "./_generated/server.ts": () => import("../convex/_generated/server"),
};

const NOW = "2026-10-08T09:00:00.000Z";
const CALENDAR_ID = "cal-standard";
const PROJECT_ID = "proj-open";
const RESOURCE_ID = "res-anna";

const task = (over: Partial<PlannerTask> & { id: string; start: string; finish: string }): PlannerTask => ({
  parentId: null, name: over.id, duration: 2, durationUnit: "days", isMilestone: false, predecessors: "",
  resource: "", percent: 0, notes: "", color: "sage", marginPct: 0, work: 16, ...over,
} as PlannerTask);

/** The planner's biggest project: a summary and 249 work packages under it. */
const largestProject = (count = 249): PlannerTask[] => {
  const rows: PlannerTask[] = [task({ id: "P0", name: "Main works", duration: count * 2, start: "2026-10-05", finish: "2028-01-01", work: count * 16 })];
  for (let index = 1; index <= count; index += 1) {
    rows.push(task({
      id: `T${index}`,
      parentId: "P0",
      name: `Work package ${index}`,
      duration: 3,
      start: "2026-10-05",
      finish: "2026-10-07",
      work: 24,
      predecessors: index > 1 ? `T${index - 1}FS` : "",
      marginPct: 10,
      marginDaysOriginal: 1,
      marginDaysConsumed: 0,
      isCritical: index % 3 === 0,
      percent: index % 4 === 0 ? 50 : 0,
    }));
  }
  return rows;
};

interface PayloadSource {
  tasks: readonly (PlannerTask & { projectId: string; versionId: string; sortOrder: number })[];
  assignments?: readonly { id: string; taskId: string; resourceId: string }[];
  versions?: readonly Record<string, unknown>[];
  baselines?: readonly Record<string, unknown>[];
  baselineTasks?: readonly Record<string, unknown>[];
}

/**
 * Exactly what `CalendarStoreProvider.buildWorkspacePayload` sends: every task,
 * the dependencies derived from them, and the relations repaired so only this
 * company's own records are named.
 */
const buildPayload = (source: PayloadSource) => {
  const byProject: Record<string, PlannerTask[]> = {};
  for (const row of source.tasks) (byProject[row.projectId] ??= []).push(row);
  // Held in a variable first: this is the shape the app sends, not a value that
  // has to be one of `company-integrity`'s minimal relation rows.
  const rows = {
    projects: [{ id: PROJECT_ID, name: "Jackon Insulation", status: "active", kind: "project", startDate: "2026-10-05", schedulingDirection: "forward", calendarId: CALENDAR_ID, createdAt: NOW, updatedAt: NOW }],
    tasks: source.tasks.map((row) => ({ ...withoutSnapshotLog(row), projectId: row.projectId })),
    dependencies: Object.entries(byProject).flatMap(([projectId, rows]) =>
      dependenciesForTasks(rows).map((dependency, index) => ({ ...dependency, id: `dep-${projectId}-${index}`, projectId }))),
    calendars: [{ id: CALENDAR_ID, name: "Standard workweek", type: "base", parentCalendarId: null, isDefault: true, workingDays: [1, 2, 3, 4, 5] }],
    exceptions: [],
    resources: [{ id: RESOURCE_ID, name: "Anna", role: "", email: "anna@example.com", colour: "sage", hoursPerWeek: 40, isActive: true, calendarId: CALENDAR_ID }],
    assignments: source.assignments ?? [],
    planVersions: source.versions ?? [{ id: "ver-1", projectId: PROJECT_ID, name: "Version 1", isActive: true, createdAt: NOW, mode: "planning" }],
    baselines: source.baselines ?? [],
    baselineTasks: source.baselineTasks ?? [],
  };
  return normalizeWorkspaceRelations(rows).rows;
};

/** A signed-in company whose workspace holds the given plan. */
const workspace = async (payload: ReturnType<typeof buildPayload>) => {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert("users", { name: "Admin", email: "admin@example.com" }));
  await t.withIdentity({ subject: userId }).mutation(api.companies.ensureCompany, {});
  const first = await t.withIdentity({ subject: userId }).mutation(api.planner.replaceState, { state: payload });
  const save = (state: unknown) => t.withIdentity({ subject: userId }).mutation(api.planner.replaceState, { state });
  const rows = async (table: "tasks" | "dependencies" | "taskAssignments" | "planVersions" | "baselines" | "baselineTasks") =>
    await t.run((ctx) => (ctx.db.query(table) as unknown as { collect: () => Promise<{ _id: string; id: string }[]> }).collect());
  return { t, first, save, rows };
};

const versionTasks = (rows: PlannerTask[], versionId: string, offset = 0) =>
  rows.map((row, index) => ({ ...row, projectId: PROJECT_ID, versionId, sortOrder: offset + index }));

/** How many rows the payload holds, across every table. */
const rowCount = (state: object) =>
  Object.values(state).reduce<number>((total, table) => total + (table as readonly unknown[]).length, 0);

const firstProject = (versionId = "ver-1") => ({
  tasks: versionTasks(largestProject(), versionId),
  assignments: largestProject().map((row, index) => ({ id: `as-${index}`, taskId: row.id, resourceId: RESOURCE_ID })),
  baselines: [{ id: "baseline-1", projectId: PROJECT_ID, versionId, name: "Baseline 1", note: "", createdAt: NOW, captureDate: NOW }],
  baselineTasks: largestProject().map((row, index) => ({
    id: `bt-${index}`, baselineId: "baseline-1", taskId: row.id, startDate: row.start, finishDate: row.finish,
    durationDays: row.duration, work: row.work, marginPct: row.marginPct ?? 0, marginDaysOriginal: row.marginDaysOriginal ?? 0, marginDaysConsumed: 0,
  })),
});

describe("saving the workspace — what a save writes", () => {
  test("the first save stores the payload, and saving it again writes nothing", async () => {
    const source = firstProject();
    const payload = buildPayload(source);
    const { save, rows } = await workspace(payload);

    const rowsInPayload = rowCount(payload);
    expect(rowsInPayload).toBeGreaterThan(700);
    const tasksAfterSeed = await rows("tasks");
    expect(tasksAfterSeed.length).toBe(source.tasks.length);

    // The very same workspace again: the database already holds it.
    const second = await save(payload);
    expect(second).toEqual({ inserted: 0, updated: 0, removed: 0, kept: rowsInPayload });
  });

  test("a changed task is written in place, and no other row is touched", async () => {
    const source = firstProject();
    const payload = buildPayload(source);
    const { save, rows } = await workspace(payload);
    const before = await rows("tasks");
    const ids = new Map(before.map((row) => [row.id, row._id]));

    const edited = {
      ...payload,
      tasks: (payload.tasks as { id: string; finish: string }[]).map((row) =>
        row.id === "T7" ? { ...row, finish: "2026-10-15" } : row),
    };
    const summary = await save(edited);
    expect(summary.updated).toBe(1);
    expect(summary.inserted).toBe(0);
    expect(summary.removed).toBe(0);
    expect(summary.kept).toBe(rowCount(payload) - 1);

    const after = await rows("tasks");
    expect(after.length).toBe(before.length);
    // The row kept its place in the database: nothing was deleted and re-created.
    expect(new Map(after.map((row) => [row.id, row._id])).get("T7")).toBe(ids.get("T7"));
    const stored = (await rows("tasks")).find((row) => row.id === "T7") as unknown as { finish: string };
    expect(stored.finish).toBe("2026-10-15");
  });

  test("a row that is gone from the payload is deleted, and a new one is stored", async () => {
    const source = firstProject();
    const payload = buildPayload(source);
    const { t, save, rows } = await workspace(payload);

    // Deleting a task takes the rows that point at it with it, exactly as the
    // app does, so the save stays relationally closed.
    const next = buildPayload({
      ...source,
      tasks: [
        ...source.tasks.filter((row) => row.id !== "T8"),
        { ...task({ id: "T-new", name: "Extra package", start: "2026-11-02", finish: "2026-11-04" }), projectId: PROJECT_ID, versionId: "ver-1", sortOrder: 900 },
      ],
      assignments: source.assignments.filter((item) => item.taskId !== "T8"),
      baselineTasks: source.baselineTasks.filter((item) => item.taskId !== "T8"),
    });
    const summary = await save(next);
    expect(summary.removed).toBeGreaterThan(0);
    expect(summary.inserted).toBeGreaterThan(0);

    const stored = await rows("tasks");
    const storedIds = stored.map((row) => row.id);
    expect(storedIds).not.toContain("T8");
    expect(storedIds).toContain("T-new");
    expect(stored.length).toBe((next.tasks as unknown[]).length);
    // Nothing is left behind for the deleted task: neither the assignment nor
    // the baseline snapshot that named it survives.
    const storedAssignments = await t.run((ctx) => ctx.db.query("taskAssignments").collect());
    const storedBaselineTasks = await t.run((ctx) => ctx.db.query("baselineTasks").collect());
    expect(storedAssignments.some((row) => row.taskId === "T8")).toBe(false);
    expect(storedBaselineTasks.some((row) => row.taskId === "T8")).toBe(false);
  });
});

describe("saving the workspace — a large plan with an optimized second version", () => {
  test("applying the optimized version only inserts the new version's rows", async () => {
    const source = firstProject();
    const payload = buildPayload(source);
    const { save } = await workspace(payload);

    // Exactly what "Apply" writes: a second full version of every task, its
    // assignments and its own baseline snapshots.
    let counter = 0;
    const copy = copyTasksToVersion(largestProject(), "ver-2", () => `task-copy-${++counter}`);
    if (copy.error) throw new Error(copy.error);
    const optimized = applyPlanningModeMargins(copy.tasks);
    const applied = buildPayload({
      tasks: [...source.tasks, ...versionTasks(optimized, "ver-2", source.tasks.length)],
      assignments: [
        ...source.assignments,
        ...source.assignments.map((item, index) => ({ id: `as-copy-${index}`, taskId: copy.idMap.get(item.taskId) ?? item.taskId, resourceId: RESOURCE_ID })),
      ],
      versions: [
        { id: "ver-1", projectId: PROJECT_ID, name: "Version 1", isActive: false, createdAt: NOW, mode: "planning" },
        { id: "ver-2", projectId: PROJECT_ID, name: "Optimized", isActive: true, createdAt: NOW, mode: "planning" },
      ],
      baselines: source.baselines,
      baselineTasks: source.baselineTasks,
    });

    const summary = await save(applied);
    // The plan that was already stored is left as it is: only the new version
    // arrives. Nothing is deleted and re-inserted to save it.
    expect(summary.removed).toBe(0);
    expect(summary.updated).toBeGreaterThan(0); // the first version is no longer active
    expect(summary.updated).toBeLessThan(3);
    expect(summary.inserted).toBeGreaterThan(700);
    expect(summary.kept).toBeGreaterThan(700);

    const written = summary.inserted + summary.updated + summary.removed;
    const stored = rowCount(applied);
    // The whole workspace is now more than twice what it was, and saving it again
    // — which the old delete-everything-and-insert-everything save did on every
    // keystroke — writes only this. Convex allows 16,000 documents per mutation.
    expect(stored).toBeGreaterThan(1_500);
    expect(written).toBeLessThan(stored / 2);

    // And the edit that used to be refused: one field of one task.
    const edited = {
      ...applied,
      tasks: (applied.tasks as { id: string; finish: string }[]).map((row) => row.id === "T5" ? { ...row, finish: "2026-10-20" } : row),
    };
    const edit = await save(edited);
    expect(edit.updated).toBe(1);
    expect(edit.inserted).toBe(0);
    expect(edit.removed).toBe(0);
    expect(edit.kept).toBe(stored - 1);
    // One document written, out of a workspace of thousands: the old save wrote
    // every row of the workspace twice, on every single change.
    expect(edit.updated + edit.inserted + edit.removed).toBe(1);
  });
});

describe("saving the workspace — how the screens send it", () => {
  const store = () => readFileSync("src/lib/calendar-store.tsx", "utf8");

  test("a burst of changes is one save, and two saves never run at once", () => {
    const text = store();
    // The newest state is queued, an identical one is never sent, and the write
    // waits for a quiet moment instead of firing on every keystroke.
    expect(text).toContain("WORKSPACE_SAVE_QUIET_MS");
    expect(text).toContain("pendingSaveRef.current = { serialised, payload }");
    expect(text).toContain("if (serialised === lastSyncedRef.current) return;");
    expect(text).toContain("if (saveInFlightRef.current) return;");
    expect(text).toContain("if (pendingSaveRef.current) void drainSaves();");
    // The last change is not dropped when the screen goes away.
    expect(text).toContain("if (pendingSaveRef.current) void drainSaves();");
  });

  test("a refused write is still reported and the workspace is restored", () => {
    const text = store();
    expect(text).toContain("Could not save to the central planner database");
    expect(text).toContain("The last saved data was restored.");
    expect(text).toContain("restoreLastSaved()");
    // The state that failed is dropped, not retried in a loop.
    expect(text).toContain("pendingSaveRef.current = null;\n      restoreLastSaved();");
  });
});
