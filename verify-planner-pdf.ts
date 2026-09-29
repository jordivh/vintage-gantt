import { PDFDocument } from "pdf-lib";
import {
  createDefaultCalendarSystem,
  type CalendarException,
  type CalendarSystem,
  type PlannerCalendar,
  type Weekday,
} from "./src/lib/scheduling-engine";
import { withCalculatedPlanningFields, type PlannerTask } from "./src/lib/planner-model";
import { buildPlannerPdfModel } from "./src/lib/planner-pdf";
import { renderPlannerPdf } from "./src/lib/planner-pdf-document";
import {
  R3_CHRIS_LEAVE,
  R3_RESOURCES,
  r3AssignmentsA,
  r3TasksA,
  r3TasksB,
  r3AssignmentsB,
} from "./src/lib/r3-fixture";

const base = createDefaultCalendarSystem();
const people: PlannerCalendar[] = R3_RESOURCES.map((resource) => ({
  id: resource.calendarId,
  name: resource.name,
  type: "person" as const,
  parentCalendarId: "base",
  isDefault: false,
  workingDays: resource.workingDays as Weekday[],
}));
const leave: CalendarException = {
  id: R3_CHRIS_LEAVE.id,
  calendarId: R3_CHRIS_LEAVE.calendarId,
  startDate: R3_CHRIS_LEAVE.startDate,
  endDate: R3_CHRIS_LEAVE.endDate,
  label: R3_CHRIS_LEAVE.label,
  type: "leave",
  isWorkingDay: false,
  source: "manual",
};
const system: CalendarSystem = {
  calendars: [...base.calendars, ...people],
  exceptions: [leave],
  defaultCalendarId: base.defaultCalendarId,
};

const report = async (label: string, bytes: Uint8Array) => {
  const doc = await PDFDocument.load(bytes);
  const size = doc.getPage(0).getSize();
  console.log(`${label}: ${bytes.length} bytes, ${doc.getPageCount()} pages, first page ${Math.round(size.width / 2.834645669)}x${Math.round(size.height / 2.834645669)} mm`);
};

/* 1. The R3-A project, monitoring mode, with an active baseline. */
const r3Tasks = withCalculatedPlanningFields(r3TasksA("proj-a", "ver-a", "r3a") as PlannerTask[], system, "base");
const modelA = buildPlannerPdfModel({
  projectName: "TP-R3-A",
  client: "Gemeente Utrecht",
  versionName: "Plan v1",
  mode: "monitoring",
  baselineName: "Baseline 27 Sep 2026",
  exportDate: "2026-09-29",
  today: "2026-09-29",
  tasks: r3Tasks,
  assignments: r3AssignmentsA("r3a"),
  resources: R3_RESOURCES.map((resource) => ({ id: resource.id, name: resource.name })),
  baselineTasks: r3Tasks.map((task) => ({ taskId: task.id, startDate: task.start, finishDate: task.finish })),
  system,
  projectCalendarId: "base",
});
console.log("A rows", modelA.rows.length, "chartDays", modelA.chart?.totalDays, "links", modelA.links.length, "summary:", modelA.meta.summaryLine);
console.log("A row 0:", JSON.stringify(modelA.rows[0]));
await report("A a3-landscape", await renderPlannerPdf(modelA, { paper: "a3", orientation: "landscape", includeGantt: true }));
await report("A a4-portrait (no gantt)", await renderPlannerPdf(modelA, { paper: "a4", orientation: "portrait", includeGantt: false }));

/* 2. A long project: 180 tasks over three years, A4 landscape. */
const long: PlannerTask[] = [];
for (let index = 0; index < 18; index += 1) {
  long.push({
    id: `s${index}`, parentId: null, name: `Phase ${index + 1}`, duration: 0, durationUnit: "days",
    start: "2026-10-05", finish: "2026-10-05", predecessors: "", resource: "", percent: 0, notes: "",
    color: "ochre", work: 0, distribution: "even", marginPct: 0, marginDaysOriginal: 0, marginDaysConsumed: 0,
  });
}
for (let index = 0; index < 180; index += 1) {
  const start = new Date("2026-10-05T12:00:00");
  start.setDate(start.getDate() + index * 6);
  const finish = new Date(start);
  finish.setDate(finish.getDate() + 4);
  const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  long.push({
    id: `t${index}`, parentId: `s${Math.floor(index / 10)}`, name: `Work package ${index + 1} with a deliberately long task name`, duration: 5, durationUnit: "days",
    start: iso(start), finish: iso(finish), predecessors: index % 10 === 0 ? "" : `t${index - 1}FS`, resource: "", percent: index % 3 === 0 ? 0 : index % 3 === 1 ? 45 : 100,
    notes: "", color: ["ochre", "sage", "clay", "ink", "rust"][index % 5], work: 40, distribution: "even",
    marginPct: 20, marginDaysOriginal: 2, marginDaysConsumed: 1,
  });
}
long.push({
  id: "m1", parentId: "s0", name: "Gate review", duration: 0, durationUnit: "days", start: "2027-01-04", finish: "2027-01-04",
  predecessors: "t4FS", resource: "", percent: 0, notes: "", color: "clay", work: 0, distribution: "even",
  marginPct: 0, marginDaysOriginal: 0, marginDaysConsumed: 0,
});
const longTasks = withCalculatedPlanningFields(long, system, "base");
const modelB = buildPlannerPdfModel({
  projectName: "North Sea Wind Farm — Phase II",
  client: "Rijkswaterstaat",
  versionName: "Baseline plan",
  mode: "planning",
  baselineName: null,
  exportDate: "2026-09-29",
  today: "2026-09-29",
  tasks: longTasks,
  assignments: longTasks.slice(0, 40).map((task, index) => ({ taskId: task.id, resourceId: R3_RESOURCES[index % 3].id })),
  resources: R3_RESOURCES.map((resource) => ({ id: resource.id, name: resource.name })),
  system,
  projectCalendarId: "base",
});
console.log("B rows", modelB.rows.length, "chartDays", modelB.chart?.totalDays, "links", modelB.links.length, "summary:", modelB.meta.summaryLine);
await report("B a4-landscape", await renderPlannerPdf(modelB, { paper: "a4", orientation: "landscape", includeGantt: true }));
await report("B a3-landscape", await renderPlannerPdf(modelB, { paper: "a3", orientation: "landscape", includeGantt: true }));

/* 3. An empty project. */
const modelC = buildPlannerPdfModel({
  projectName: "Empty project", versionName: "Plan v1", mode: "planning", exportDate: "2026-09-29", tasks: [],
});
console.log("C empty", modelC.empty, "chart", modelC.chart);
await report("C empty", await renderPlannerPdf(modelC, { paper: "a3", orientation: "landscape", includeGantt: true }));

await Bun.write("/tmp/plan-a3.pdf", await renderPlannerPdf(modelA, { paper: "a3", orientation: "landscape", includeGantt: true }));
await Bun.write("/tmp/plan-long-a4.pdf", await renderPlannerPdf(modelB, { paper: "a4", orientation: "landscape", includeGantt: true }));
await Bun.write("/tmp/plan-empty.pdf", await renderPlannerPdf(modelC, { paper: "a3", orientation: "landscape", includeGantt: true }));
console.log("written /tmp/plan-a3.pdf /tmp/plan-long-a4.pdf /tmp/plan-empty.pdf");
