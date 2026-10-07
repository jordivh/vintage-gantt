import { describe, expect, test } from "bun:test";
import {
  createDefaultCalendarSystem,
  type CalendarException,
  type CalendarSystem,
  type PlannerCalendar,
  type Weekday,
} from "./scheduling-engine";
import {
  aggregatePeriods,
  computeResourceLoads,
  type CapacityContribution,
  type CapacityDay,
  type CapacityPeriod,
  type ResourceCapacityReport,
} from "./capacity-engine";
import type { PlannerTask } from "./planner-model";
import { R3_CHRIS_LEAVE, R3_RESOURCES } from "./r3-fixture";
import {
  buildCapacityWorkbook,
  capacityExportFileName,
  filterSummary,
  EXPORT_DATE_FORMAT,
  HOURS_FORMAT,
  OVERLOAD_FILL,
  OVERLOAD_TEXT,
  PERCENT_FORMAT,
  type CapacityExportInput,
  type ExportRow,
  type ExportSheet,
} from "./capacity-export";

/* ------------------------------------------------------------------ helpers */

const NO_DATA = "No data for the current selection";
/** The table header row: the block above it is six rows, so this is row seven. */
const HEADER_ROW = 6;
const FROZEN_ROWS = 7;

const contribution = (projectId: string, projectName: string, hours: number): CapacityContribution =>
  ({ projectId, projectName, taskId: `${projectId}-t`, taskName: `${projectName} task`, hours });

const week = (overrides: Partial<CapacityPeriod> = {}): CapacityPeriod => ({
  key: "2026-09-28",
  label: "28 sep – 4 okt 2026",
  start: "2026-09-28",
  end: "2026-10-04",
  days: [],
  available: 40,
  allocated: 0,
  remaining: 40,
  utilisation: 0,
  overload: false,
  overloadedDays: 0,
  assignments: 0,
  breakdown: [],
  conflicts: [],
  ...overrides,
});

const person = (resourceId: string, resourceName: string): ResourceCapacityReport => ({
  resourceId,
  resourceName,
  hoursPerWeek: 40,
  days: [],
  conflicts: [],
  unavailableTasks: [],
  assignedWork: [],
  totalAllocated: 0,
  totalAvailable: 0,
  overloadedDays: 0,
});

const input = (overrides: Partial<CapacityExportInput> = {}): CapacityExportInput => ({
  exportDate: "2026-09-29",
  granularity: "week",
  reports: [],
  periodsFor: () => [],
  clients: new Map<string, string | undefined>(),
  filters: {},
  ...overrides,
});

const rowsAfterHeader = (sheet: ExportSheet) => sheet.data.slice(HEADER_ROW + 1);
const valuesOf = (row: ExportRow) => row.map((cell) => cell.value);

/* ------------------------------------------------------------------- header */

describe("export file name and filters", () => {
  test("names the file after the period setting and the export day", () => {
    expect(capacityExportFileName("week", "2026-09-29")).toBe("Capacity_week_2026-09-29.xlsx");
    expect(capacityExportFileName("month", "2026-09-29")).toBe("Capacity_month_2026-09-29.xlsx");
  });

  test("states every filter, and says 'all' when one is not set", () => {
    expect(filterSummary({})).toBe("Employee: all · Project: all · Client: all");
    expect(filterSummary({ resource: "  ", project: "Site", client: "Acme" })).toBe("Employee: all · Project: Site · Client: Acme");
  });
});

describe("header block on both sheets", () => {
  const sheets = buildCapacityWorkbook(input());

  test("has the two named sheets, each with the block above the table", () => {
    expect(sheets.map((sheet) => sheet.name)).toEqual(["Capacity", "By project"]);
    for (const sheet of sheets) {
      expect(typeof sheet.data[0][0].value).toBe("string");
      expect(sheet.data[0][0].type).toBe(String);
      expect(sheet.data[0][0].fontWeight).toBe("bold");
      expect(sheet.data[0][0].fontSize).toBe(13);
      expect(sheet.data[1][0].value).toBe("Export date");
      expect(sheet.data[1][1].value).toEqual(new Date("2026-09-29T12:00:00"));
      expect(sheet.data[1][1].type).toBe(Date);
      expect(sheet.data[1][1].format).toBe(EXPORT_DATE_FORMAT);
      expect(sheet.data[2][1].value).toBe("Week");
      expect(sheet.data[3][1].value).toBe("Employee: all · Project: all · Client: all");
      expect(String(sheet.data[4][1].value)).toContain("active plan version");
      expect(sheet.data[5]).toEqual([]);
    }
  });

  test("follows the on-screen period setting", () => {
    const monthly = buildCapacityWorkbook(input({ granularity: "month" }));
    expect(monthly[0].data[2][1].value).toBe("Month");
  });

  test("names the exact week or month the screen selected", () => {
    const named = buildCapacityWorkbook(input({ granularity: "month", periodLabel: "October 2026" }));
    expect(named[0].data[2][1].value).toBe("October 2026");
    expect(named[1].data[2][1].value).toBe("October 2026");
    const weekly = buildCapacityWorkbook(input({ periodLabel: "Week 41 · 5 – 11 Oct 2026" }));
    expect(weekly[0].data[2][1].value).toBe("Week 41 · 5 – 11 Oct 2026");
    // a blank label never leaves the file without a period
    expect(buildCapacityWorkbook(input({ periodLabel: "   " }))[0].data[2][1].value).toBe("Week");
  });

  test("freezes the block and the table header row", () => {
    for (const sheet of sheets) {
      expect(sheet.stickyRowsCount).toBe(FROZEN_ROWS);
      // the row that gets frozen last is the table's own header row
      expect(sheet.data[HEADER_ROW].every((cell) => cell.fontWeight === "bold")).toBe(true);
      expect(sheet.data[HEADER_ROW + 1][0].fontWeight).toBeUndefined();
    }
  });

  test("keeps every column wide enough for its heading", () => {
    for (const sheet of sheets) {
      expect(sheet.columns.length).toBe(sheet.data[HEADER_ROW].length);
      expect(sheet.columns.every((column) => column.width >= 14)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------- sheet: rows */

describe("Capacity sheet", () => {
  test("writes one row per employee per period with the screen's own figures", () => {
    const anna = person("r1", "Anna");
    const periods = [
      week({ key: "a", start: "2026-09-28", end: "2026-10-04", available: 40, allocated: 10, remaining: 30, utilisation: 0.25 }),
      week({ key: "b", start: "2026-10-05", end: "2026-10-11", available: 40, allocated: 40, remaining: 0, utilisation: 1 }),
    ];
    const sheet = buildCapacityWorkbook(input({ reports: [anna], periodsFor: () => periods }))[0];
    const rows = rowsAfterHeader(sheet);
    expect(rows.length).toBe(2);
    expect(valuesOf(rows[0])).toEqual(["Anna", new Date("2026-09-28T12:00:00"), new Date("2026-10-04T12:00:00"), 40, 10, 30, 0.25]);
    expect(valuesOf(rows[1])).toEqual(["Anna", new Date("2026-10-05T12:00:00"), new Date("2026-10-11T12:00:00"), 40, 40, 0, 1]);
    // dates are real date values, hours are real numbers — never text with a unit
    expect(rows[0][1].type).toBe(Date);
    expect(rows[0][1].format).toBe(EXPORT_DATE_FORMAT);
    for (const index of [3, 4, 5]) {
      expect(typeof rows[0][index].value).toBe("number");
      expect(rows[0][index].type).toBe(Number);
      expect(rows[0][index].format).toBe(HOURS_FORMAT);
      expect(String(rows[0][index].value)).not.toContain("h");
    }
  });

  test("writes utilisation as a real percentage", () => {
    const periods = [week({ available: 40, allocated: 14, remaining: 26, utilisation: 0.35 })];
    const rows = rowsAfterHeader(buildCapacityWorkbook(input({ reports: [person("r1", "Anna")], periodsFor: () => periods }))[0]);
    expect(rows[0][6]).toEqual({ value: 0.35, type: Number, format: PERCENT_FORMAT, align: "right" });
  });

  test("fills an overallocated utilisation cell red and leaves the rest alone", () => {
    const periods = [week({ available: 40, allocated: 50, remaining: -10, utilisation: 1.25, overload: true })];
    const rows = rowsAfterHeader(buildCapacityWorkbook(input({ reports: [person("r1", "Anna")], periodsFor: () => periods }))[0]);
    expect(rows[0][6].backgroundColor).toBe(OVERLOAD_FILL);
    expect(rows[0][6].textColor).toBe(OVERLOAD_TEXT);
    expect(rows[0][6].format).toBe(PERCENT_FORMAT);
    expect(rows[0].slice(0, 6).every((cell) => cell.backgroundColor === undefined)).toBe(true);
  });

  test("shows a dash, never 0%, when a period has no availability at all", () => {
    const periods = [week({ available: 0, allocated: 0, remaining: 0, utilisation: null })];
    const rows = rowsAfterHeader(buildCapacityWorkbook(input({ reports: [person("r1", "Chris")], periodsFor: () => periods }))[0]);
    expect(rows[0][6]).toEqual({ value: "—", type: String, align: "right" });
    expect(rows[0][3].value).toBe(0);
    expect(rows[0][4].value).toBe(0);
  });

  test("exports only the people it is given, so an active filter can never be dropped", () => {
    const anna = person("r1", "Anna");
    const bram = person("r2", "Bram");
    const sheet = buildCapacityWorkbook(input({
      reports: [bram],
      periodsFor: (resourceId) => [week({ key: resourceId, allocated: 8, remaining: 32, utilisation: 0.2 })],
    }))[0];
    const names = rowsAfterHeader(sheet).map((row) => row[0].value);
    expect(names).toEqual(["Bram"]);
    expect(JSON.stringify(sheet.data)).not.toContain("Anna");
    expect(anna.resourceName).toBe("Anna");
  });
});

/* ------------------------------------------------------ sheet: by project */

describe("By project sheet", () => {
  test("splits the same periods into the projects that carry the hours", () => {
    const periods = [
      week({ start: "2026-09-28", end: "2026-10-04", available: 40, allocated: 14, remaining: 26, utilisation: 0.35, breakdown: [{ projectId: "p1", projectName: "Site", allocated: 10 }, { projectId: "p2", projectName: "Tour", allocated: 4 }] }),
      week({ key: "next", start: "2026-10-05", end: "2026-10-11", available: 40, allocated: 0, remaining: 40, utilisation: 0, breakdown: [] }),
    ];
    const sheet = buildCapacityWorkbook(input({
      reports: [person("r1", "Anna")],
      periodsFor: () => periods,
      clients: new Map<string, string | undefined>([["p1", "Acme"], ["p2", undefined]]),
    }))[1];
    expect(sheet.name).toBe("By project");
    const rows = rowsAfterHeader(sheet);
    expect(rows.map(valuesOf)).toEqual([
      ["Anna", new Date("2026-09-28T12:00:00"), new Date("2026-10-04T12:00:00"), "Site", "Acme", 10],
      ["Anna", new Date("2026-09-28T12:00:00"), new Date("2026-10-04T12:00:00"), "Tour", "—", 4],
    ]);
    expect(rows[0][5]).toEqual({ value: 10, type: Number, format: HOURS_FORMAT, align: "right" });
    // a period without projects has nothing to break down
    expect(rows.every((row) => String(row[3].value) !== "")).toBe(true);
  });
});

/* --------------------------------------------------------------- no data */

describe("an empty selection", () => {
  test("still produces both sheets with an explicit line instead of an empty file", () => {
    const sheets = buildCapacityWorkbook(input());
    expect(sheets.length).toBe(2);
    for (const sheet of sheets) {
      expect(rowsAfterHeader(sheet).map(valuesOf)).toEqual([[NO_DATA]]);
      expect(sheet.columns.length).toBeGreaterThan(0);
      expect(sheet.data[3][1].value).toContain("Employee: all");
    }
  });

  test("reports the active filters even when nothing matches", () => {
    const sheets = buildCapacityWorkbook(input({ filters: { project: "Site", client: "Acme" } }));
    expect(sheets[0].data[3][1].value).toBe("Employee: all · Project: Site · Client: Acme");
    expect(rowsAfterHeader(sheets[0]).map(valuesOf)).toEqual([[NO_DATA]]);
  });
});

/* --------------------------------------------------------------- read only */

describe("building the export is read only", () => {
  test("leaves the reports and periods exactly as they were", () => {
    const anna = person("r1", "Anna");
    const periods = [week({ allocated: 50, remaining: -10, utilisation: 1.25, overload: true, breakdown: [{ projectId: "p1", projectName: "Site", allocated: 50 }] })];
    const before = JSON.stringify([anna, periods]);
    buildCapacityWorkbook(input({ reports: [anna], periodsFor: () => periods }));
    expect(JSON.stringify([anna, periods])).toBe(before);
  });
});

/* ------------------------------------------- consistency with the engine */

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

const r3Person = (id: string) => {
  const resource = R3_RESOURCES.find((item) => item.id === id)!;
  return { id: resource.id, name: resource.name, hoursPerWeek: resource.hoursPerWeek, calendarId: resource.calendarId };
};

const chrisTask: PlannerTask = {
  id: "chris-task",
  parentId: null,
  name: "Opbouw",
  duration: 20,
  durationUnit: "days",
  start: "2026-10-05",
  finish: "2026-10-30",
  isMilestone: false,
  predecessors: "",
  resource: "",
  percent: 0,
  notes: "",
  color: "sage",
  marginPct: 0,
  marginDaysOriginal: 0,
  marginDaysConsumed: 0,
  work: 40,
  distribution: "even",
};

describe("the export mirrors the engine", () => {
  const system = r3System();
  const reports = computeResourceLoads({
    system,
    resources: [r3Person("res-r3-chris")],
    assignments: [{ taskId: chrisTask.id, resourceId: "res-r3-chris" }],
    projects: [{ projectId: "proj-a", projectName: "TP-R3-A", projectCalendarId: "base", tasks: [chrisTask] }],
  });
  const chris = reports[0];
  const periods = aggregatePeriods(chris, "week");

  test("writes one row per period, in the same order, with the same hours", () => {
    const sheet = buildCapacityWorkbook(input({
      reports,
      periodsFor: (resourceId) => (resourceId === chris.resourceId ? periods : []),
    }))[0];
    const rows = rowsAfterHeader(sheet);
    expect(rows.length).toBe(periods.length);
    expect(rows.map((row) => [row[0].value, row[1].value, row[3].value, row[4].value, row[5].value]))
      .toEqual(periods.map((period) => [
        "Chris",
        new Date(`${period.start}T12:00:00`),
        period.available,
        period.allocated,
        period.remaining,
      ]));
  });

  test("a leave week offers no availability and holds no hours", () => {
    const leaveWeek = periods.find((period) => period.start === R3_CHRIS_LEAVE.startDate);
    expect(leaveWeek).toBeDefined();
    expect(leaveWeek?.available).toBe(0);
    expect(leaveWeek?.allocated).toBe(0);
    const sheet = buildCapacityWorkbook(input({ reports, periodsFor: () => periods }))[0];
    const row = rowsAfterHeader(sheet).find((candidate) => candidate[1].value instanceof Date && (candidate[1].value as Date).getTime() === new Date("2026-10-12T12:00:00").getTime());
    expect(row?.[3].value).toBe(0);
    expect(row?.[4].value).toBe(0);
  });
});
