import { expect, test } from "bun:test";
import { convexTest } from "./convex-test-workspace";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { PlannerTask } from "./planner-model";
import { syncVerticalScroll, removeTaskSubtrees, restoreDeletedTasks, insertTaskBelow, taskSubtreeIds, columnWidth, readColumnWidths, writeColumnWidths } from "./task-table";

const row = (id: string, parentId: string | null = null): PlannerTask => ({ id, parentId, versionId: "v1", name: id, duration: 1, durationUnit: "days", work: 0, start: "2026-10-12", finish: "2026-10-12", isMilestone: false, predecessors: "", resource: "", percent: 0, notes: "", color: "sage" });

test("insert below follows the whole subtree and preserves sibling order and defaults", () => {
  const tasks = [row("a"), row("b", "a"), row("c", "b"), row("d", "a"), row("e")];
  const next = insertTaskBelow(tasks, "a", row("new"));
  expect(next.map(task => task.id)).toEqual(["a", "b", "c", "d", "new", "e"]);
  expect(next[4].parentId).toBeNull();
  expect(next[4].predecessors).toBe("");
  expect(next.filter(task => task.id !== "new")).toEqual(tasks);
  const nested = insertTaskBelow(tasks, "b", row("new"));
  expect(nested.map(task => task.id)).toEqual(["a", "b", "c", "new", "d", "e"]);
  expect(nested[3].parentId).toBe("a");
  expect(nested[3].versionId).toBe("v1");
  expect([...taskSubtreeIds(tasks, ["a"])]).toEqual(["a", "b", "d", "c"]);
});

test("inserted sibling order survives the real workspace save/read interface", async () => {
  const t = convexTest(schema, {
    "./planner.ts": () => import("../convex/planner"),
    "./companies.ts": () => import("../convex/companies"),
    "./auth.ts": () => import("../convex/auth"),
    "./_generated/api.ts": () => import("../convex/_generated/api"),
    "./_generated/server.ts": () => import("../convex/_generated/server"),
  });
  const id = await t.run(ctx => ctx.db.insert("users", { email: "insert@example.com" }));
  const actor = t.withIdentity({ subject: id });
  await actor.mutation(api.companies.ensureCompany, {});
  const next = insertTaskBelow([row("a"), row("b", "a"), row("c", "b"), row("d")], "a", row("new"));
  await actor.mutation(api.planner.replaceState, { state: {
    projects: [{ id: "p", name: "Insertion", startDate: "2026-10-12", calendarId: "cal", status: "active", schedulingDirection: "forward", createdAt: "2026-10-12", updatedAt: "2026-10-12" }],
    calendars: [{ id: "cal", name: "Calendar", type: "base", parentCalendarId: null, isDefault: true }],
    tasks: next.map((task, sortOrder) => ({ ...task, projectId: "p", sortOrder })),
    planVersions: [{ id: "v1", projectId: "p", name: "Version 1", isActive: true, createdAt: "2026-10-12" }],
    dependencies: [], resources: [], assignments: [], exceptions: [], baselines: [], baselineTasks: [],
  } });
  const saved = await actor.query(api.planner.getState, {});
  expect(saved?.tasks.map(task => task.id)).toEqual(["a", "b", "c", "new", "d"]);
  expect(saved?.tasks[3].parentId).toBeNull();
});

test("deletion removes the full subtree and links, and rollback preserves later edits", () => {
  const before = [row("a"), row("b", "a"), row("c", "b"), { ...row("d"), predecessors: "bFS" }, row("e")];
  const change = removeTaskSubtrees(before, ["a"]);
  expect(change.survivors.map(task => task.id)).toEqual(["d", "e"]);
  expect(change.survivors[0].predecessors).toBe("");
  expect(change.needsScheduling).toBe(true);
  const live = [{ ...change.survivors[0], name: "Later edit" }, change.survivors[1], row("new")];
  const restored = restoreDeletedTasks(before, change.survivors, live);
  expect(restored.map(task => task.id)).toEqual(["a", "b", "c", "d", "e", "new"]);
  expect(restored[3].name).toBe("Later edit");
  expect(restored[3].predecessors).toBe("bFS");
  expect(removeTaskSubtrees([row("a"), row("b")], ["a"]).needsScheduling).toBe(false);
  expect(removeTaskSubtrees([row("a"), row("b", "a")], ["b"]).needsScheduling).toBe(true);
});

test("vertical scroll sync is bidirectional, fractional, idempotent, and horizontal-independent", () => {
  let writes = 0;
  let top = 0;
  const grid = { scrollTop: 123.5, scrollLeft: 71, scrollHeight: 4200, clientHeight: 500 };
  const timeline = { get scrollTop() { return top; }, set scrollTop(value) { top = value; writes++; }, scrollLeft: 899, scrollHeight: 4200, clientHeight: 500 };
  syncVerticalScroll(grid, timeline);
  expect(timeline.scrollTop).toBe(123.5);
  syncVerticalScroll(timeline, grid);
  syncVerticalScroll(grid, timeline);
  expect(writes).toBe(1);
  timeline.scrollTop = 211.25;
  syncVerticalScroll(timeline, grid);
  expect(grid.scrollTop).toBe(211.25);
  expect(grid.scrollLeft).toBe(71);
  expect(timeline.scrollLeft).toBe(899);
  grid.scrollHeight = timeline.scrollHeight = 600;
  syncVerticalScroll(grid, timeline);
  expect(grid.scrollTop).toBe(100);
  expect(timeline.scrollTop).toBe(100);
});

test("column widths clamp and persist per user, not per shared browser", () => {
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
  expect(columnWidth(-20)).toBe(48);
  expect(columnWidth(238.7)).toBe(239);
  writeColumnWidths(storage, "alice", { name: 400, id: 48 });
  expect(readColumnWidths(storage, "alice")).toEqual({ name: 400, id: 48 });
  expect(readColumnWidths(storage, "bob")).toEqual({});
  saved.set("vintage-gantt-column-widths:alice", '{"name":0,"id":"invalid"}');
  expect(readColumnWidths(storage, "alice")).toEqual({ name: 48 });
});

test("invalid or unavailable view storage doesn't crash the planner", () => {
  const storage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  expect(readColumnWidths(storage, "alice")).toEqual({});
  writeColumnWidths(storage, "alice", { name: 300 });
});
