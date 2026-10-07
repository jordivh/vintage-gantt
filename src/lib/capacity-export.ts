import type { CapacityGranularity, CapacityPeriod, ResourceCapacityReport } from "./capacity-engine";

/* --------------------------------------------------------------------------
 * Capacity export
 *
 * Builds the sheets of the workbook from the very figures the Capacity screen
 * shows: the same filtered reports and the same aggregated periods, so the file
 * can never disagree with the table. Nothing here calculates load — it only lays
 * out what the engine already produced, which is also why exporting can never
 * change a planning figure, a date or an assignment.
 * ------------------------------------------------------------------------ */

/** One cell, in the writer's own terms: a typed value, a number format and a style. */
export interface ExportCell {
  value?: string | number | Date | boolean;
  type?: StringConstructor | NumberConstructor | DateConstructor | BooleanConstructor;
  format?: string;
  fontWeight?: "bold";
  fontStyle?: "italic";
  fontSize?: number;
  backgroundColor?: string;
  textColor?: string;
  align?: "left" | "center" | "right";
}

export type ExportRow = ExportCell[];

export interface ExportSheet {
  /** Sheet tab name. */
  name: string;
  columns: { width: number }[];
  /** Rows (the block above the table plus its header row) that stay visible while scrolling. */
  stickyRowsCount: number;
  data: ExportRow[];
}

/** Excel's percentage format: the stored value stays the real fraction (0.35 → 35%). */
export const PERCENT_FORMAT = "0%";
/** Hours stay real numbers: at most three decimals, trailing zeros dropped (8, 7.5, 6.25). */
export const HOURS_FORMAT = "0.###";
/** Real Excel date format, matching the pickers elsewhere in the app. */
export const EXPORT_DATE_FORMAT = "dd/mm/yyyy";
/** Excel's classic "bad" style, used on an overallocated utilisation cell. */
export const OVERLOAD_FILL = "#FFC7CE";
export const OVERLOAD_TEXT = "#9C0006";
const TABLE_HEADER_FILL = "#EFE7D8";

/** The readable filter summary the header block prints. */
export interface CapacityExportFilters {
  resource?: string;
  project?: string;
  client?: string;
}

export interface CapacityExportInput {
  /** The day the file is made on (ISO), written as a real Excel date. */
  exportDate: string;
  granularity: CapacityGranularity;
  /**
   * The exact period on screen (`Week 40 · 28 Sep – 4 Oct 2026`, `October 2026`).
   * The sheet names it instead of only the view, so a file always says which
   * week or month it holds.
   */
  periodLabel?: string;
  /** Exactly the people the screen is showing, filters already applied. */
  reports: ResourceCapacityReport[];
  /** The screen's own aggregated periods for one person. */
  periodsFor: (resourceId: string) => CapacityPeriod[];
  /** projectId → client, for the "By project" sheet. */
  clients: Map<string, string | undefined>;
  filters: CapacityExportFilters;
}

/** The three filters as one readable line; an unset filter says so explicitly. */
export function filterSummary(filters: CapacityExportFilters): string {
  return [
    `Employee: ${filters.resource?.trim() || "all"}`,
    `Project: ${filters.project?.trim() || "all"}`,
    `Client: ${filters.client?.trim() || "all"}`,
  ].join(" · ");
}

/** `Capacity_week_2026-09-29.xlsx` — period setting plus the day of the export. */
export function capacityExportFileName(granularity: CapacityGranularity, exportDate: string): string {
  const period = granularity === "month" ? "month" : "week";
  return `Capacity_${period}_${exportDate}.xlsx`;
}

const text = (value: string): ExportCell => ({ value, type: String });
const hours = (value: number): ExportCell => ({ value, type: Number, format: HOURS_FORMAT, align: "right" });
const dateCell = (value: string): ExportCell => ({ value: new Date(`${value}T12:00:00`), type: Date, format: EXPORT_DATE_FORMAT });
const label = (value: string): ExportCell => ({ value, type: String, fontWeight: "bold" });
const headerCell = (value: string): ExportCell => ({ value, type: String, fontWeight: "bold", backgroundColor: TABLE_HEADER_FILL });

/** The utilisation cell: a real percentage, or a dash when there is no availability. */
function utilisationCell(period: CapacityPeriod): ExportCell {
  const overloaded = period.overload;
  const style = overloaded ? { backgroundColor: OVERLOAD_FILL, textColor: OVERLOAD_TEXT, fontWeight: "bold" as const } : {};
  if (period.utilisation === null || !Number.isFinite(period.utilisation)) {
    return { value: "—", type: String, align: "right", ...style };
  }
  // The value stays the real fraction; the percentage format is what makes Excel
  // show (and sort) it as a percentage.
  return { value: period.utilisation, type: Number, format: PERCENT_FORMAT, align: "right", ...style };
}

const NO_DATA = "No data for the current selection";

/** The block above the table: what was exported, with which filters, and on what basis. */
function headerBlock(title: string, input: CapacityExportInput): ExportRow[] {
  return [
    [{ value: title, type: String, fontWeight: "bold", fontSize: 13 }],
    [label("Export date"), dateCell(input.exportDate)],
    [label("Selected period"), text(input.periodLabel?.trim() || (input.granularity === "month" ? "Month" : "Week"))],
    [label("Active filters"), text(filterSummary(input.filters))],
    [label("Basis"), text("Hours are based on the active plan version of each project only.")],
    [],
  ];
}

/** The index of the frozen table header row, one past the block above it. */
const HEADER_ROW_COUNT = 7;

/* ---------------------------------------------------------------- builders */

/** One row per employee per period, with the same figures the screen shows. */
function capacityRows(input: CapacityExportInput): ExportRow[] {
  return input.reports.flatMap((report) =>
    input.periodsFor(report.resourceId).map((period) => [
      text(report.resourceName),
      dateCell(period.start),
      dateCell(period.end),
      hours(period.available),
      hours(period.allocated),
      hours(period.remaining),
      utilisationCell(period),
    ]),
  );
}

/** The same people and periods, split into the projects that carry the hours. */
function byProjectRows(input: CapacityExportInput): ExportRow[] {
  return input.reports.flatMap((report) =>
    input.periodsFor(report.resourceId).flatMap((period) =>
      period.breakdown.map((row) => [
        text(report.resourceName),
        dateCell(period.start),
        dateCell(period.end),
        text(row.projectName),
        text(input.clients.get(row.projectId)?.trim() || "—"),
        hours(row.allocated),
      ]),
    ),
  );
}

/** Both sheets of the workbook, in tab order. */
export function buildCapacityWorkbook(input: CapacityExportInput): ExportSheet[] {
  const capacity = capacityRows(input);
  const byProject = byProjectRows(input);
  return [
    {
      name: "Capacity",
      columns: [{ width: 26 }, { width: 14 }, { width: 14 }, { width: 17 }, { width: 17 }, { width: 17 }, { width: 14 }],
      stickyRowsCount: HEADER_ROW_COUNT,
      data: [
        ...headerBlock("Capacity export", input),
        ["Employee", "Period start", "Period end", "Available hours", "Assigned hours", "Remaining hours", "Utilisation"].map(headerCell),
        ...(capacity.length ? capacity : [[{ value: NO_DATA, type: String, fontStyle: "italic" } as ExportCell]]),
      ],
    },
    {
      name: "By project",
      columns: [{ width: 26 }, { width: 14 }, { width: 14 }, { width: 30 }, { width: 22 }, { width: 17 }],
      stickyRowsCount: HEADER_ROW_COUNT,
      data: [
        ...headerBlock("Capacity export — by project", input),
        ["Employee", "Period start", "Period end", "Project", "Client", "Assigned hours"].map(headerCell),
        ...(byProject.length ? byProject : [[{ value: NO_DATA, type: String, fontStyle: "italic" } as ExportCell]]),
      ],
    },
  ];
}
