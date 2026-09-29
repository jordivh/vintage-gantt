import type { CalendarSystem } from "./scheduling-engine";
import { EMPTY_MARGIN_TOTALS, leafMarginTotals, marginRowsFor, type MarginTotals } from "./margin-report";
import { withCalculatedPlanningFields, type PlannerTask } from "./planner-model";

/* --------------------------------------------------------------------------
 * Margin consumption (one project, for the portfolio table)
 *
 * The projects overview must show exactly what the planner shows, so this does
 * not calculate anything of its own: it runs the very same pipeline the planner
 * context bar and the margin report use — `withCalculatedPlanningFields`, then
 * the leaf-only `marginRowsFor` rows, then `leafMarginTotals` — and only turns
 * the result into a label, a colour band and a tooltip. Reading it never touches
 * the tasks it is given.
 * ------------------------------------------------------------------------ */

export const MARGIN_CONSUMPTION_DASH = "—";

/** Below 75 % neutral, 75–100 % orange, above 100 % red (reserve exceeded). */
export type MarginConsumptionBand = "none" | "neutral" | "warning" | "exceeded";

export function marginConsumptionBand(percent: number | null | undefined): MarginConsumptionBand {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return "none";
  if (percent > 100) return "exceeded";
  if (percent >= 75) return "warning";
  return "neutral";
}

export interface MarginConsumption {
  band: MarginConsumptionBand;
  /** Whether a percentage and figures can be shown at all. */
  reported: boolean;
  /** Total reserve of the leaf tasks, in working days. */
  planned: number;
  consumed: number;
  remaining: number;
  /** Consumption as a whole percentage, or null when there is no reserve. */
  consumedPct: number | null;
  /** `"35% (7 van 20 dagen)"`, or a dash when nothing can be reported. */
  label: string;
  /** Dutch hover text naming the totale, verbruikte and resterende marge. */
  tooltip: string;
}

export interface MarginConsumptionInput {
  tasks: readonly PlannerTask[];
  system: CalendarSystem;
  projectCalendarId?: string;
  /**
   * Whether the project's active plan version has a captured baseline. Without
   * one there is nothing consumed to report, so the column stays a dash.
   */
  hasBaseline: boolean;
}

export const EMPTY_MARGIN_CONSUMPTION: MarginConsumption = {
  band: "none",
  reported: false,
  planned: 0,
  consumed: 0,
  remaining: 0,
  consumedPct: null,
  label: MARGIN_CONSUMPTION_DASH,
  tooltip: "Geen marge gedefinieerd voor deze versie.",
};

/** The current totals, or empty totals when a malformed task row slips through. */
function safeTotals(input: MarginConsumptionInput): MarginTotals {
  try {
    const tasks = Array.isArray(input.tasks) ? [...input.tasks] : [];
    if (!tasks.length || !input.system) return EMPTY_MARGIN_TOTALS;
    return leafMarginTotals(marginRowsFor(withCalculatedPlanningFields(tasks, input.system, input.projectCalendarId)));
  } catch {
    return EMPTY_MARGIN_TOTALS;
  }
}

/**
 * The consumed margin of one project version, ready for the portfolio column.
 * A project without a reserve, or one whose version has no baseline yet, reads
 * as a dash — never as `0%`.
 */
export function buildMarginConsumption(input: MarginConsumptionInput): MarginConsumption {
  const totals = safeTotals(input);
  const planned = totals.planned;
  const consumed = totals.consumed;
  const remaining = totals.remaining;
  const consumedPct = totals.consumedPct;

  if (planned <= 0) return { ...EMPTY_MARGIN_CONSUMPTION, planned, consumed, remaining, consumedPct };
  if (!input.hasBaseline || consumedPct === null) {
    return {
      ...EMPTY_MARGIN_CONSUMPTION,
      planned,
      consumed,
      remaining,
      consumedPct,
      tooltip: "Nog geen baseline op deze versie — er is nog geen marge verbruikt om te tonen.",
    };
  }

  return {
    band: marginConsumptionBand(consumedPct),
    reported: true,
    planned,
    consumed,
    remaining,
    consumedPct,
    label: `${consumedPct}% (${consumed} van ${planned} dagen)`,
    tooltip: `Totale marge: ${planned} dagen\nVerbruikte marge: ${consumed} dagen (${consumedPct}%)\nResterende marge: ${remaining} dagen`,
  };
}
