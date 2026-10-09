import { removeTaskSubtrees } from "./task-table";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { applyPlanningModeMargins, dependenciesForTasks, recalculateTasks, pruneDeadPredecessors, withCalculatedPlanningFields, type PlannerTask } from "./planner-model";
import { createDefaultCalendarSystem, findDependencyCycle } from "./scheduling-engine";

const modules = {
  "./planner.ts": () => import("../convex/planner"),
  "./companies.ts": () => import("../convex/companies"),
  "./auth.ts": () => import("../convex/auth"),
  "./_generated/api.ts": () => import("../convex/_generated/api"),
  "./_generated/server.ts": () => import("../convex/_generated/server"),
};
export const benchmarkTasks = (count: number): PlannerTask[] => Array.from({ length: count }, (_, i) => ({ id: `t${i}`, parentId: null, name: `Task ${i}`, versionId: "v", duration: 1, durationUnit: "days", work: 8, start: "2026-10-12", finish: "2026-10-12", predecessors: "", resource: "", percent: 0, notes: "", color: "sage", isMilestone: false }));
export async function deletionFixture(count: number) {
  const t = convexTest(schema, modules);
  const id = await t.run(ctx => ctx.db.insert("users", { email: "benchmark@example.com" }));
  const actor = t.withIdentity({ subject: id });
  await actor.mutation(api.companies.ensureCompany, {});
  const system = createDefaultCalendarSystem();
  const tasks = benchmarkTasks(count);
  await actor.mutation(api.planner.replaceState, { state: {
    projects: [{ id: "p", name: "Benchmark", status: "active", startDate: "2026-10-12", calendarId: system.defaultCalendarId, schedulingDirection: "forward", createdAt: "2026-10-12", updatedAt: "2026-10-12" }],
    calendars: system.calendars, exceptions: system.exceptions, tasks: tasks.map((task, sortOrder) => ({ ...task, projectId: "p", sortOrder })),
    planVersions: [{ id: "v", projectId: "p", name: "Version 1", isActive: true, createdAt: "2026-10-12" }], dependencies: [], resources: [], assignments: [], baselines: [], baselineTasks: [],
  } });
  return { t, actor, tasks, system };
}

if (import.meta.main) for (const count of [20, 2000]) {
  const { actor, tasks, system } = await deletionFixture(count);
  const start = performance.now();
  if (process.argv.includes("--after")) {
    const change = removeTaskSubtrees(tasks, ["t10"]);
    const disappearanceMs = performance.now() - start;
    await actor.mutation(api.planner.deleteTasks, { projectId: "p", taskIds: ["t10"] });
    const saved = await actor.query(api.planner.getState, {});
    if (saved?.tasks.length !== count - 1 || change.needsScheduling) throw new Error("Deletion correctness failure");
    console.log(JSON.stringify({ mode: "after", tasks: count, disappearanceMs: +disappearanceMs.toFixed(2), persistedMs: +(performance.now() - start).toFixed(2), remaining: change.survivors.length }));
    continue;
  }
  const result = await actor.mutation(api.planner.deleteTasks, { projectId: "p", taskIds: ["t10"] });
  const saved = performance.now();
  const doomed = new Set(result.taskIds);
  const survivors = pruneDeadPredecessors(tasks.filter(task => !doomed.has(task.id))).tasks;
  const normalized = survivors.map(task => ({ ...task, isMilestone: task.duration === 0 && !survivors.some(candidate => candidate.parentId === task.id) }));
  findDependencyCycle(normalized, dependenciesForTasks(normalized));
  const recalculated = recalculateTasks(applyPlanningModeMargins(normalized), { calendarSystem: system, projectCalendarId: system.defaultCalendarId, direction: "forward" });
  withCalculatedPlanningFields(recalculated.tasks, system, system.defaultCalendarId);
  console.log(JSON.stringify({ mode: "before", tasks: count, databaseMs: +(saved - start).toFixed(2), disappearanceMs: +(performance.now() - start).toFixed(2), remaining: survivors.length }));
}
