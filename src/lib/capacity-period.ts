import { isoDate, parseIsoDate } from "./scheduling-engine";

/**
 * The period a capacity screen shows, and the rows it shows for it.
 *
 * Week view: exactly one Monday–Sunday week, one row per day — weekends and
 * non-working days included, because a day with no available hours is still a
 * day of the period.
 *
 * Month view: one calendar month, one row per Monday–Sunday week that overlaps
 * it. The first and last week are *clipped* to the month: only the days inside
 * the selected month count, the row says which range it actually covers and is
 * marked `partial`, so a figure can never quietly belong to the neighbouring
 * month.
 *
 * Everything here is pure date arithmetic over ISO `yyyy-mm-dd` strings — no
 * planning figure is computed, and nothing here can move a task or a date.
 * Labels are fixed English words and month names, so they never depend on the
 * browser's locale.
 */

export type CapacityView = "week" | "month";

/** One row of the table: a single day (week view) or a calendar week (month view). */
export interface CapacityPeriodRow {
  /** Stable per row: the day itself (week view) or the week's Monday (month view). */
  key: string;
  label: string;
  /** First day this row actually counts. */
  start: string;
  /** Last day this row actually counts. */
  end: string;
  /** True for a week clipped to the month, i.e. not a whole Monday–Sunday week. */
  partial?: boolean;
}

/** The chip a clipped month-view row carries. */
export const PARTIAL_WEEK = "Partial week";

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
/** Monday-first, matching the Monday–Sunday week the whole app plans in. */
const WEEKDAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** `yyyy-mm-dd` for a valid calendar date, and nothing else. */
export function isIsoDate(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = parseIsoDate(value);
  return !Number.isNaN(parsed.getTime()) && isoDate(parsed) === value;
}

/** The same date, moved by whole days. */
export function shiftDays(date: string, amount: number): string {
  const value = parseIsoDate(date);
  value.setDate(value.getDate() + amount);
  return isoDate(value);
}

/** The Monday on or before a date. */
export function weekStart(date: string): string {
  return shiftDays(date, -((parseIsoDate(date).getDay() + 6) % 7));
}

/** The Sunday on or after a date. */
export function weekEnd(date: string): string {
  return shiftDays(weekStart(date), 6);
}

/** The first day of the date's month. */
export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** The last day of the date's month. */
export function monthEnd(date: string): string {
  const first = parseIsoDate(monthStart(date));
  return isoDate(new Date(first.getFullYear(), first.getMonth() + 1, 0, 12));
}

/** The ISO 8601 week number (weeks start on Monday; week 1 holds the first Thursday). */
export function isoWeekNumber(date: string): number {
  const thursday = parseIsoDate(weekStart(date));
  thursday.setDate(thursday.getDate() + 3);
  const firstThursday = new Date(thursday.getFullYear(), 0, 4, 12);
  firstThursday.setDate(firstThursday.getDate() - ((firstThursday.getDay() + 6) % 7) + 3);
  return 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86400000));
}

/** `Mon 28 Sep 2026` — the weekday and the full date of one day. */
export function dayLabel(date: string): string {
  const value = parseIsoDate(date);
  return `${WEEKDAYS_SHORT[(value.getDay() + 6) % 7]} ${value.getDate()} ${MONTHS_SHORT[value.getMonth()]} ${value.getFullYear()}`;
}

/**
 * `5 – 11 Oct 2026` for a range inside one month, `28 Sep – 4 Oct 2026` inside
 * one year, and `28 Dec 2026 – 3 Jan 2027` when it crosses a year — the month is
 * never repeated needlessly, and the year is always readable.
 */
export function weekRangeLabel(start: string, end: string): string {
  const from = parseIsoDate(start);
  const to = parseIsoDate(end);
  const startText = `${from.getDate()} ${MONTHS_SHORT[from.getMonth()]}`;
  const endText = `${to.getDate()} ${MONTHS_SHORT[to.getMonth()]}`;
  const sameYear = from.getFullYear() === to.getFullYear();
  if (!sameYear) return `${startText} ${from.getFullYear()} – ${endText} ${to.getFullYear()}`;
  const sameMonth = from.getMonth() === to.getMonth();
  return `${sameMonth ? from.getDate() : startText} – ${endText} ${to.getFullYear()}`;
}

/** `October 2026`. */
export function monthLabel(date: string): string {
  const value = parseIsoDate(date);
  return `${MONTHS_LONG[value.getMonth()]} ${value.getFullYear()}`;
}

/** `Week 40 · 28 Sep – 4 Oct 2026` — the week number and the full range, with its year. */
export function weekLabel(date: string): string {
  const start = weekStart(date);
  return `Week ${isoWeekNumber(start)} · ${weekRangeLabel(start, weekEnd(start))}`;
}

/** What the period selector prints for the shown period. */
export function periodLabel(view: CapacityView, date: string): string {
  return view === "week" ? weekLabel(date) : monthLabel(date);
}

/** The first and last day the shown period counts: the whole week, or the whole month. */
export function periodWindow(view: CapacityView, date: string): { start: string; end: string } {
  return view === "week"
    ? { start: weekStart(date), end: weekEnd(date) }
    : { start: monthStart(date), end: monthEnd(date) };
}

/** A value that identifies one period, so two dates can be compared for "same period". */
export function periodKey(view: CapacityView, date: string): string {
  return view === "week" ? weekStart(date) : date.slice(0, 7);
}

/**
 * The rows of the shown period, in display order: every day of one week, or
 * every Monday–Sunday week overlapping one month with the first and last week
 * clipped to the month.
 */
export function periodRows(view: CapacityView, date: string): CapacityPeriodRow[] {
  if (view === "week") {
    const start = weekStart(date);
    return Array.from({ length: 7 }, (_, index) => {
      const day = shiftDays(start, index);
      return { key: day, label: dayLabel(day), start: day, end: day };
    });
  }
  const first = monthStart(date);
  const last = monthEnd(date);
  const rows: CapacityPeriodRow[] = [];
  for (let cursor = weekStart(first); cursor <= last; cursor = shiftDays(cursor, 7)) {
    const start = cursor < first ? first : cursor;
    const weekFinish = weekEnd(cursor);
    const end = weekFinish > last ? last : weekFinish;
    rows.push({
      key: cursor,
      label: weekRangeLabel(start, end),
      start,
      end,
      partial: start !== cursor || end !== weekFinish,
    });
  }
  return rows;
}

/** The reference date, one period further or back. The day itself never moves. */
export function shiftPeriod(view: CapacityView, date: string, amount: number): string {
  if (view === "week") return shiftDays(date, 7 * amount);
  const value = parseIsoDate(date);
  const targetMonth = value.getMonth() + amount;
  const year = value.getFullYear() + Math.floor(targetMonth / 12);
  const month = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(year, month + 1, 0, 12).getDate();
  return isoDate(new Date(year, month, Math.min(value.getDate(), lastDay), 12));
}

/** True when the reference date sits in the period that contains `today`. */
export function isCurrentPeriod(view: CapacityView, date: string, today: string): boolean {
  return periodKey(view, date) === periodKey(view, today);
}
