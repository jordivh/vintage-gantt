/**
 * Step 6 measurement: the same fixtures as step 1, timed with the new method.
 * Small project, large project and the largest one, each with the workspace
 * around it, so the numbers can be compared one for one.
 */
import { createDefaultCalendarSystem, type CalendarSystem, type PlannerCalendar, type Weekday } from "./src/lib/scheduling-engine";
import { shiftDays } from "./src/lib/capacity-period";
import { type PlannerTask } from "./src/lib/planner-model";
import { optimizeProject, type OptimizeProjectInput, type OptimizeResource } from "./src/lib/resource-optimizer";

const base = createDefaultCalendarSystem();
const people = Array.from({ length: 12 }, (_, index) => `cal-${index}`);
const calendars: PlannerCalendar[] = people.map((id) => ({
  id, name: id, type: "person", parentCalendarId: base.defaultCalendarId, isDefault: false,
  workingDays: [1, 2, 3, 4, 5] as Weekday[],
}));
const system: CalendarSystem = { calendars: [...base.calendars, ...calendars], exceptions: [], defaultCalendarId: base.defaultCalendarId };
const resources: OptimizeResource[] = people.map((calendarId, index) => ({
  id: `res-${index}`, name: `Person ${index}`, hoursPerWeek: 40, calendarId,
}));

const task = (over: Partial<PlannerTask> & { id: string; start: string; finish: string }): PlannerTask => ({
  parentId: null, name: over.id, duration: 1, durationUnit: "days", isMilestone: false, predecessors: "",
  resource: "", percent: 0, notes: "", color: "sage", marginPct: 0, ...over,
} as PlannerTask);

const chain = (prefix: string, start: string, count: number, duration: number, stride: number): PlannerTask[] => {
  const tasks: PlannerTask[] = [];
  let cursor = start;
  for (let index = 0; index < count; index += 1) {
    tasks.push(task({
      id: `${prefix}-${index}`, name: `${prefix}-${index}`, duration,
      start: cursor, finish: shiftDays(cursor, duration + 1), work: duration * 8,
      predecessors: index === 0 ? "" : `${prefix}-${index - 1}FS`,
    }));
    cursor = shiftDays(cursor, stride);
  }
  return tasks;
};

const measure = (label: string, openTaskCount: number, openDuration: number, openStride: number) => {
  const openProject: OptimizeProjectInput = {
    projectId: "proj-open", projectName: "Open", projectCalendarId: base.defaultCalendarId,
    tasks: chain("p", "2026-10-05", openTaskCount, openDuration, openStride),
  };
  const others: OptimizeProjectInput[] = Array.from({ length: 3 }, (_, index) => ({
    projectId: `proj-${index}`, projectName: `Other ${index}`, projectCalendarId: base.defaultCalendarId,
    tasks: chain(`o${index}`, "2026-08-03", 30, 3, 2),
  }));
  const assignments = [
    ...openProject.tasks.map((item, index) => ({ taskId: item.id, resourceId: `res-${index % 4}` })),
    ...others.flatMap((project) => project.tasks.map((item, index) => ({ taskId: item.id, resourceId: `res-${index % 12}` }))),
  ];
  const input = {
    projectId: "proj-open", projects: [openProject, ...others], resources, assignments, system,
    mode: "planning" as const, today: "2026-09-01",
  };

  optimizeProject(input); // warm up
  const started = performance.now();
  const result = optimizeProject(input);
  const wall = performance.now() - started;
  if (!result.ok) throw new Error(result.error);

  console.log(`\n=== ${label}: ${openTaskCount} tasks in the open project, 90 tasks elsewhere, 12 employees ===`);
  console.log(`  load     ${"".padStart(6)}  (in the caller, unchanged)`);
  console.log(`  prepare  ${result.timings.prepareMs.toFixed(1)} ms`);
  console.log(`  optimize ${result.timings.optimizeMs.toFixed(1)} ms`);
  console.log(`  preview  ${result.timings.reportMs.toFixed(1)} ms`);
  console.log(`  total    ${result.timings.totalMs.toFixed(1)} ms (wall ${wall.toFixed(1)} ms)`);
  console.log(`  options scored: ${result.timings.evaluations}, time limited: ${result.timeLimited}`);
  console.log(`  preview: ${result.occupancy.length} employees, ${result.occupancy[0]?.weeks.length ?? 0} weeks, ` +
    `${result.moves.length} moves, ${result.unresolved.length} warnings, ${result.blockers.length} blockers`);
};

measure("small project", 10, 2, 1);
measure("large project", 40, 4, 3);
measure("largest project", 150, 3, 2);

// The same input twice must give the very same plan.
const repeatA = optimizeProject({
  projectId: "proj-open",
  projects: [{
    projectId: "proj-open", projectName: "Open", projectCalendarId: base.defaultCalendarId,
    tasks: chain("p", "2026-10-05", 40, 4, 3),
  }, ...Array.from({ length: 3 }, (_, index) => ({
    projectId: `proj-${index}`, projectName: `Other ${index}`, projectCalendarId: base.defaultCalendarId,
    tasks: chain(`o${index}`, "2026-08-03", 30, 3, 2),
  }))],
  resources,
  assignments: [],
  system,
  mode: "planning",
  today: "2026-09-01",
});
const repeatB = optimizeProject({
  projectId: "proj-open",
  projects: [{
    projectId: "proj-open", projectName: "Open", projectCalendarId: base.defaultCalendarId,
    tasks: chain("p", "2026-10-05", 40, 4, 3),
  }, ...Array.from({ length: 3 }, (_, index) => ({
    projectId: `proj-${index}`, projectName: `Other ${index}`, projectCalendarId: base.defaultCalendarId,
    tasks: chain(`o${index}`, "2026-08-03", 30, 3, 2),
  }))],
  resources,
  assignments: [],
  system,
  mode: "planning",
  today: "2026-09-01",
});
console.log("\nsame input twice gives the same plan:", repeatA.ok && repeatB.ok ? JSON.stringify(repeatA.moves) === JSON.stringify(repeatB.moves) : "n/a");
