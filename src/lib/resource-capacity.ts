import {
  calendarChain,
  resolveWorkingDay,
  type CalendarSystem,
  type Weekday,
} from "./scheduling-engine";

/** The capacity facts a resource needs to answer availability questions. */
export interface CapacityResource {
  /** Contracted hours for a full working week. */
  hoursPerWeek: number;
  /** The resource's own (person) calendar. */
  calendarId: string;
}

/**
 * Where a day's availability rule came from, following the R1 precedence
 * (person beats project beats base beats the weekly pattern) plus leave:
 *   - "leave"   : a leave exception on the person calendar (availability only).
 *   - "person"  : the person calendar's own pattern or exception.
 *   - "project" : a project-level calendar in the chain.
 *   - "base"    : the base (default) calendar.
 *   - "pattern" : the built-in Monday–Friday fallback, no calendar said otherwise.
 */
export type AvailabilityLevel = "person" | "project" | "base" | "pattern" | "leave";

export interface ResourceDayAvailability {
  date: string;
  hours: number;
  level: AvailabilityLevel;
  reason: string;
}

const levelForCalendar = (type: string | undefined): AvailabilityLevel =>
  type === "person" ? "person" : type === "project" ? "project" : type === "base" ? "base" : "pattern";

/**
 * The resource's own working weekdays: the person calendar's pattern, or the
 * most specific pattern up the hierarchy, or Monday–Friday when none is set.
 */
export function resourceWorkingWeekdays(resource: CapacityResource, system: CalendarSystem): Weekday[] {
  const chain = calendarChain(system, resource.calendarId);
  return chain.find((calendar) => calendar.workingDays && calendar.workingDays.length)?.workingDays
    ?? ([1, 2, 3, 4, 5] as Weekday[]);
}

/**
 * The hours the resource can work on a calendar day, and where that rule came
 * from. The week's capacity is spread evenly over the resource's *own* working
 * weekdays, so 20 h over Mon–Thu is 5 h a day and no day is ever assumed to be
 * 8 h. A non-working day in the calendar hierarchy, a weekday this resource has
 * off, and leave all give 0 h — for this resource only. Nothing here moves a
 * task: availability is data, dates stay with the schedule.
 */
export function resourceDayAvailability(
  resource: CapacityResource,
  date: string,
  system: CalendarSystem,
): ResourceDayAvailability {
  const resolution = resolveWorkingDay(date, resource.calendarId, system);
  const level: AvailabilityLevel = resolution.exception?.type === "leave"
    ? "leave"
    : levelForCalendar(system.calendars.find((calendar) => calendar.id === resolution.sourceCalendarId)?.type);
  if (!resolution.isWorkingDay) return { date, hours: 0, level, reason: resolution.reason };
  const weekdays = resourceWorkingWeekdays(resource, system);
  const hours = weekdays.length ? Math.max(0, resource.hoursPerWeek) / weekdays.length : 0;
  return { date, hours, level, reason: resolution.reason };
}

/** The available hours for one resource on one day. */
export function availableHours(resource: CapacityResource, date: string, system: CalendarSystem): number {
  return resourceDayAvailability(resource, date, system).hours;
}
