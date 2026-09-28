import { describe, expect, test } from "bun:test";
import {
  createDefaultCalendarSystem,
  type CalendarException,
  type CalendarSystem,
  type PlannerCalendar,
  type Weekday,
} from "./scheduling-engine";
import type { PlannerTask } from "./planner-model";
import { R3_CHRIS_LEAVE, R3_RESOURCES, r3AssignmentsA, r3AssignmentsB, r3TasksA, r3TasksB } from "./r3-fixture";
import { selectCapacityProjects, type CapacityInput } from "./capacity-engine";
import { buildOverloadIndex, getOverloadForResource, overloadByTask, overloadTooltip, projectOverload, type OverloadWeek } from "./overload";

const r3System = (): CalendarSystem => {
  const base = createDefaultCalendarSystem();
  const people: PlannerCalendar[] = R3_RESOURCES.map((resource) => ({
    id: resource.calendarId,
    name: `${resource.name} — leave`,
    type: "person",
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
  return { calendars: [...base.calendars, ...people], exceptions: [leave], defaultCalendarId: base.defaultCalendarId };
};

const people = () => R3_RESOURCES.map((resource) => ({ id: resource.id, name: resource.name, hoursPerWeek: resource.hoursPerWeek, calendarId: resource.calendarId }));

const projectA = (tasks: PlannerTask[] = r3TasksA("proj-a", "ver-a", "r3a") as PlannerTask[]) =>
  ({ projectId: "proj-a", projectName: "TP-R3-A", projectCalendarId: "base", tasks });
const projectB = () =>
  ({ projectId: "proj-b", projectName: "TP-R3-B", projectCalendarId: "base", tasks: r3TasksB("proj-b", "ver-b", "r3b") as PlannerTask[] });

const fullInput = (): CapacityInput => ({
  system: r3System(),
  resources: people(),
  assignments: [...r3AssignmentsA("r3a"), ...r3AssignmentsB("r3b")],
  projects: [projectA(), projectB()],
});

const task = (overrides: Partial<PlannerTask>): PlannerTask => ({
  id: "t",
  parentId: null,
  name: "Task",
  duration: 1,
  durationUnit: "days",
  start: "2026-10-05",
  finish: "2026-10-09",
  isMilestone: false,
  predecessors: "",
  resource: "",
  percent: 0,
  notes: "",
  color: "sage",
  marginPct: 0,
  ...overrides,
});

describe("overload — cross-project index", () => {
  test("Anna is overloaded because two projects are summed, not judged apart", () => {
    const index = buildOverloadIndex(fullInput());
    const anna = getOverloadForResource(index, "res-r3-anna", "2026-01-01", "2026-12-31");
    expect(anna.length).toBeGreaterThan(0);
    expect(anna[0].weekStart).toBe("2026-10-05");
    expect(anna[0].allocated).toBe(110);
    expect(anna[0].available).toBe(40);
    // The week names both projects, biggest first.
    expect(anna[0].breakdown.map((row) => row.projectName)).toEqual(["TP-R3-B", "TP-R3-A"]);
    expect(index.overloadedResourceIds).toContain("res-r3-anna");
  });

  test("one project alone is not an overload, so the index really is cross-project", () => {
    const index = buildOverloadIndex({ system: r3System(), resources: people(), assignments: r3AssignmentsA("r3a"), projects: [projectA()] });
    // Ontwerp is 40 h over 20 working days = 2 h/day, well within 40 h/week.
    expect(getOverloadForResource(index, "res-r3-anna", "2026-01-01", "2026-12-31")).toEqual([]);
  });

  test("a resource that is never over capacity has no overloaded weeks", () => {
    const index = buildOverloadIndex(fullInput());
    expect(index.byResource.get("res-r3-chris")?.length ?? 0).toBe(0);
  });
});

describe("overload — range filter", () => {
  test("only weeks overlapping the given range are returned", () => {
    const index = buildOverloadIndex(fullInput());
    const all = getOverloadForResource(index, "res-r3-anna", "2026-01-01", "2026-12-31");
    expect(all.length).toBeGreaterThan(1);
    const first = all[0];
    // A range that starts after the first overloaded week drops it.
    const later = getOverloadForResource(index, "res-r3-anna", "2026-10-20", "2026-12-31");
    expect(later.some((week) => week.weekStart === first.weekStart)).toBe(false);
    // A range that only touches the last day of a week still reports that week.
    const touches = getOverloadForResource(index, "res-r3-anna", first.weekEnd, first.weekEnd);
    expect(touches.map((week) => week.weekStart)).toEqual([first.weekStart]);
  });
});

describe("overload — task roll-up", () => {
  test("a leaf whose resource is overloaded in its span is flagged once", () => {
    const index = buildOverloadIndex(fullInput());
    const tasks = r3TasksA("proj-a", "ver-a", "r3a") as PlannerTask[];
    const byTask = overloadByTask(index, tasks, r3AssignmentsA("r3a"));
    const ontwerp = byTask.get("r3a1")!;
    expect(ontwerp.count).toBe(1);
    expect(ontwerp.weeks.every((week) => week.resourceId === "res-r3-anna")).toBe(true);
    expect(ontwerp.weeks.every((week) => week.weekStart >= "2026-10-05" && week.weekStart <= "2026-10-30")).toBe(true);
  });

  test("a summary only aggregates its children and never calculates its own", () => {
    const index = buildOverloadIndex(fullInput());
    const tasks = r3TasksA("proj-a", "ver-a", "r3a") as PlannerTask[];
    const byTask = overloadByTask(index, tasks, r3AssignmentsA("r3a"));
    const childFlags = ["r3a1", "r3a2", "r3a3"].filter((id) => (byTask.get(id)?.count ?? 0) > 0).length;
    expect(byTask.get("r3as")!.count).toBe(childFlags);
    expect(childFlags).toBeGreaterThan(0);
  });

  test("milestones and tasks without work are never flagged", () => {
    const index = buildOverloadIndex(fullInput());
    const tasks = [
      task({ id: "zero", work: 0, isMilestone: false, start: "2026-10-05", finish: "2026-10-30" }),
      task({ id: "mile", work: 0, isMilestone: true, start: "2026-10-05", finish: "2026-10-05" }),
    ];
    const byTask = overloadByTask(index, tasks, [
      { taskId: "zero", resourceId: "res-r3-anna" },
      { taskId: "mile", resourceId: "res-r3-anna" },
    ]);
    expect(byTask.get("zero")!.count).toBe(0);
    expect(byTask.get("mile")!.count).toBe(0);
  });
});

describe("overload — project chip and tooltip", () => {
  test("projectOverload counts the distinct people of one project", () => {
    const index = buildOverloadIndex(fullInput());
    const result = projectOverload(index, r3TasksA("proj-a", "ver-a", "r3a") as PlannerTask[], r3AssignmentsA("r3a"));
    expect(result.resourceIds).toEqual(["res-r3-anna", "res-r3-bram"]);
    expect(result.weeks.length).toBeGreaterThan(0);
  });

  test("an archived or template project contributes no load to the index", () => {
    const projects = [
      { id: "proj-a", name: "TP-R3-A", status: "active", kind: "project" as const },
      { id: "proj-t", name: "Tpl", status: "template", kind: "template" as const },
    ];
    expect(selectCapacityProjects(projects).map((project) => project.id)).toEqual(["proj-a"]);
  });

  test("the tooltip names the resource, week, hours and project split", () => {
    const index = buildOverloadIndex(fullInput());
    const weeks = getOverloadForResource(index, "res-r3-anna", "2026-01-01", "2026-12-31");
    const lines = overloadTooltip(weeks);
    expect(lines[0]).toBe(`Anna is overbelast in week van 5 okt 2026: 110 u gepland, 40 u beschikbaar (TP-R3-B 100 u, TP-R3-A 10 u)`);
    expect(lines.length).toBe(Math.min(3, weeks.length));
  });

  test("the tooltip lists at most three weeks and then adds a remainder line", () => {
    const base: OverloadWeek = { resourceId: "r", resourceName: "Anna", weekStart: "2026-10-05", weekEnd: "2026-10-11", label: "week van 5 okt 2026", allocated: 58, available: 40, breakdown: [{ projectId: "a", projectName: "TP-R3-A", allocated: 8 }] };
    const weeks = [0, 1, 2, 3, 4].map((offset) => ({ ...base, weekStart: `2026-10-${String(5 + offset * 7).padStart(2, "0")}` }));
    const lines = overloadTooltip(weeks);
    expect(lines.length).toBe(4);
    expect(lines[0]).toContain("58 u gepland, 40 u beschikbaar (TP-R3-A 8 u)");
    expect(lines[3]).toBe("+ 2 weken meer");
  });
});

describe("overload — availability", () => {
  test("a task fully inside leave is listed as unavailable per resource", () => {
    const index = buildOverloadIndex({
      system: r3System(),
      resources: people(),
      assignments: [{ taskId: "full", resourceId: "res-r3-chris" }],
      projects: [projectA([task({ id: "full", name: "Volledig verlof", duration: 5, start: "2026-10-12", finish: "2026-10-16", work: 40 })])],
    });
    expect(index.unavailableByTask.get("full")).toEqual([{ resourceId: "res-r3-chris", resourceName: "Chris", work: 40 }]);
    // A task with available days is not flagged as unavailable.
    expect(index.unavailableByTask.get("r3a1")).toBeUndefined();
  });
});
