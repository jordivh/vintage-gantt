import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { toast } from "sonner";
import {
  Copy,
  Download,
  GripVertical,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { AppBar } from "@/components/AppBar";
import {
  EXCEPTION_TYPE_LABELS,
  WEEKDAY_LABELS,
  WEEK_ORDER,
  calendarChain,
  monthCells,
  parseIsoDate,
  resolveWorkingDay,
  type CalendarException,
  type CalendarExceptionType,
  type CalendarSystem,
  type CalendarType,
  type PlannerCalendar,
  type Weekday,
} from "@/lib/scheduling-engine";
import {
  CALENDAR_TYPE_LABELS,
  EXCEPTION_TYPE_ORDER,
  missingBelgianHolidays,
  makeException,
  useCalendarStore,
  withBelgianHolidays,
  withExceptionAdded,
  withExceptionRemoved,
  withWorkingDays,
  type ImpactCount,
} from "@/lib/calendar-store";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const formatDate = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(
    parseIsoDate(iso),
  );

const formatRange = (start: string, end: string) =>
  start === end ? formatDate(start) : `${formatDate(start)} → ${formatDate(end)}`;

export default function Calendars() {
  const {
    system,
    calendarsUsingProjects,
    projectsAffectedBy,
    previewCalendarChange,
    applyCalendarSystem,
    createCalendar,
    duplicateCalendar,
    renameCalendar,
    deleteCalendar,
  } = useCalendarStore();

  const [selectedId, setSelectedId] = useState(
    () => system.calendars.find((calendar) => calendar.isDefault)?.id ?? system.calendars[0]?.id ?? "",
  );
  const [year, setYear] = useState(2025);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createType, setCreateType] = useState<Exclude<CalendarType, "base">>("project");
  const [createParent, setCreateParent] = useState(system.defaultCalendarId);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [drag, setDrag] = useState<{ start: string; end: string } | null>(null);
  const [rangeDialog, setRangeDialog] = useState<{
    start: string;
    end: string;
    label: string;
    type: CalendarExceptionType;
  } | null>(null);
  const [pending, setPending] = useState<{
    nextSystem: CalendarSystem;
    impact: ImpactCount;
    description: string;
  } | null>(null);
  const dragging = useRef(false);

  const selected = system.calendars.find((calendar) => calendar.id === selectedId) ?? system.calendars[0];

  useEffect(() => {
    if (!system.calendars.some((calendar) => calendar.id === selectedId)) {
      setSelectedId(system.calendars.find((calendar) => calendar.isDefault)?.id ?? system.calendars[0]?.id ?? "");
    }
  }, [selectedId, system.calendars]);

  /** Applies a change, but asks for confirmation first when it would move tasks. */
  const commitSystem = (nextSystem: CalendarSystem, changedCalendarId: string, description: string) => {
    const impact = previewCalendarChange(nextSystem, changedCalendarId);
    if (impact.tasks > 0) {
      setPending({ nextSystem, impact, description });
      return;
    }
    applyCalendarSystem(nextSystem);
    toast.success(description);
  };

  const toggleDay = (date: string) => {
    const own = system.exceptions
      .filter((exception) => exception.calendarId === selected.id && exception.startDate <= date && exception.endDate >= date)
      .sort((a, b) => (a.type === "extra-working" ? -1 : 1) - (b.type === "extra-working" ? -1 : 1));
    if (own.length) {
      commitSystem(withExceptionRemoved(system, own[0].id), selected.id, `Removed "${own[0].label}"`);
      return;
    }
    const resolution = resolveWorkingDay(date, selected.id, system);
    const type: CalendarExceptionType = resolution.isWorkingDay ? "shutdown" : "extra-working";
    const exception = makeException({
      calendarId: selected.id,
      startDate: date,
      endDate: date,
      label: resolution.isWorkingDay ? "Non-working day" : "Extra working day",
      type,
    });
    commitSystem(
      withExceptionAdded(system, exception),
      selected.id,
      `${formatDate(date)} marked ${resolution.isWorkingDay ? "non-working" : "working"}`,
    );
  };

  // Finish a click / drag gesture on the year grid.
  useEffect(() => {
    if (!drag) return;
    const onUp = () => {
      const { start, end } = drag;
      const [from, to] = start <= end ? [start, end] : [end, start];
      if (from !== to) {
        setRangeDialog({ start: from, end: to, label: "Shutdown", type: "shutdown" });
      } else {
        toggleDay(from);
      }
      dragging.current = false;
      setDrag(null);
    };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  });

  const chain = calendarChain(system, selected?.id);
  const inheritedPattern = chain.slice(1).find((calendar) => calendar.workingDays?.length)?.workingDays;
  const effectiveWorkingDays =
    selected?.workingDays ?? inheritedPattern ?? ([1, 2, 3, 4, 5] as Weekday[]);

  const ownExceptions = useMemo(
    () =>
      system.exceptions
        .filter((exception) => exception.calendarId === selected?.id)
        .sort((a, b) => a.startDate.localeCompare(b.startDate)),
    [system.exceptions, selected?.id],
  );

  const inheritedExceptions = useMemo(
    () =>
      chain
        .slice(1)
        .flatMap((calendar) =>
          system.exceptions
            .filter((exception) => exception.calendarId === calendar.id)
            .sort((a, b) => a.startDate.localeCompare(b.startDate))
            .map((exception) => ({ exception, from: calendar })),
        ),
    [chain, system.exceptions],
  );

  const missingHolidays = missingBelgianHolidays(system, year);

  const startDrag = (date: string) => {
    dragging.current = true;
    setDrag({ start: date, end: date });
  };

  const extendDrag = (date: string) => {
    if (!dragging.current) return;
    setDrag((current) => (current ? { ...current, end: date } : { start: date, end: date }));
  };

  const overrideInherited = (exception: CalendarException, makeWorking: boolean) => {
    const type: CalendarExceptionType = makeWorking ? "extra-working" : "shutdown";
    const next = withExceptionAdded(
      system,
      makeException({
        calendarId: selected.id,
        startDate: exception.startDate,
        endDate: exception.endDate,
        label: `Override: ${exception.label}`,
        type,
      }),
    );
    commitSystem(next, selected.id, `${formatRange(exception.startDate, exception.endDate)} overridden`);
  };

  const handleCreate = () => {
    const id = createCalendar({
      name: createName,
      type: createType,
      parentCalendarId: createParent,
    });
    if (!id) {
      toast.error("Only one base calendar is allowed. Pick project or person.");
      return;
    }
    setSelectedId(id);
    setCreateOpen(false);
    setCreateName("");
    toast.success("Calendar created");
  };

  const handleDelete = (calendar: PlannerCalendar) => {
    const result = deleteCalendar(calendar.id);
    if (!result.ok) toast.error(result.message ?? "Unable to delete calendar");
    else toast.success(`${calendar.name} deleted`);
  };

  return (
    <div className="planner-shell">
      <AppBar activeKey="calendars" />

      <div className="calendar-screen">
        {/* ---------------------------------------------------------- list --- */}
        <aside className="calendar-sidebar">
          <div className="calendar-panel-head">
            <div>
              <div className="eyebrow">CALENDARS</div>
              <h2>{system.calendars.length} calendars</h2>
            </div>
            <button className="tool-button primary" onClick={() => setCreateOpen((open) => !open)}>
              <Plus size={14} /> New
            </button>
          </div>

          {createOpen && (
            <div className="calendar-create">
              <label>
                Name
                <input value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="e.g. Winter shutdown" />
              </label>
              <label>
                Type
                <select value={createType} onChange={(event) => setCreateType(event.target.value as Exclude<CalendarType, "base">)}>
                  <option value="project">Project calendar</option>
                  <option value="person">Person calendar</option>
                </select>
              </label>
              <label>
                Inherits from
                <select value={createParent} onChange={(event) => setCreateParent(event.target.value)}>
                  {system.calendars.map((calendar) => (
                    <option key={calendar.id} value={calendar.id}>
                      {calendar.name} · {CALENDAR_TYPE_LABELS[calendar.type]}
                    </option>
                  ))}
                </select>
              </label>
              <div className="calendar-create-actions">
                <button className="tool-button" onClick={() => setCreateOpen(false)}>
                  Cancel
                </button>
                <button className="tool-button primary" onClick={handleCreate}>
                  Create
                </button>
              </div>
              <p className="calendar-hint">The base calendar is unique and always exists; new calendars inherit from it.</p>
            </div>
          )}

          <div className="calendar-list">
            {system.calendars.map((calendar) => {
              const projectCount = calendarsUsingProjects(calendar.id).length;
              const affected = projectsAffectedBy(calendar.id).length;
              const parent = system.calendars.find((item) => item.id === calendar.parentCalendarId);
              return (
                <button
                  key={calendar.id}
                  className={`calendar-card ${calendar.id === selected?.id ? "selected" : ""}`}
                  onClick={() => setSelectedId(calendar.id)}
                >
                  <div className="calendar-card-top">
                    {renameId === calendar.id ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            renameCalendar(calendar.id, renameValue);
                            setRenameId(null);
                          }
                          if (event.key === "Escape") setRenameId(null);
                        }}
                        onBlur={() => {
                          renameCalendar(calendar.id, renameValue);
                          setRenameId(null);
                        }}
                      />
                    ) : (
                      <strong>{calendar.name}</strong>
                    )}
                    <span className={`calendar-badge type-${calendar.type}`}>
                      {CALENDAR_TYPE_LABELS[calendar.type]}
                      {calendar.isDefault ? " · default" : ""}
                    </span>
                  </div>
                  <small>
                    {parent ? `Inherits from ${parent.name}` : "Top level"}
                    {" · "}
                    {affected} project{affected === 1 ? "" : "s"} affected
                    {projectCount ? ` (${projectCount} linked directly)` : ""}
                  </small>
                  <div className="calendar-card-actions">
                    <span
                      role="button"
                      tabIndex={0}
                      title="Rename"
                      onClick={(event) => {
                        event.stopPropagation();
                        setRenameId(calendar.id);
                        setRenameValue(calendar.name);
                      }}
                    >
                      <Pencil size={13} />
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      title="Duplicate"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedId(duplicateCalendar(calendar.id));
                        toast.success("Calendar duplicated");
                      }}
                    >
                      <Copy size={13} />
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      title="Delete"
                      className="danger"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleDelete(calendar);
                      }}
                    >
                      <Trash2 size={13} />
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* -------------------------------------------------------- detail --- */}
        {selected && (
          <section className="calendar-detail">
            <div className="calendar-detail-head">
              <div>
                <div className="eyebrow">
                  {CALENDAR_TYPE_LABELS[selected.type].toUpperCase()} CALENDAR
                  {chain[1] ? ` · INHERITS FROM ${chain[1].name.toUpperCase()}` : ""}
                </div>
                <h2>{selected.name}</h2>
              </div>
              <div className="year-nav">
                <button className="tool-button" onClick={() => setYear((value) => value - 1)}>
                  ←
                </button>
                <span>{year}</span>
                <button className="tool-button" onClick={() => setYear((value) => value + 1)}>
                  →
                </button>
              </div>
            </div>

            <div className="calendar-block">
              <div className="calendar-block-head">
                <h3>Weekly working pattern</h3>
                <small>
                  {selected.workingDays
                    ? "Defined on this calendar"
                    : `Inherited from ${chain.slice(1).find((calendar) => calendar.workingDays?.length)?.name ?? "the base calendar"}`}
                </small>
              </div>
              <div className="week-toggles">
                {WEEK_ORDER.map((weekday) => (
                  <button
                    key={weekday}
                    className={effectiveWorkingDays.includes(weekday) ? "on" : ""}
                    onClick={() => {
                      const next = effectiveWorkingDays.includes(weekday)
                        ? effectiveWorkingDays.filter((day) => day !== weekday)
                        : ([...effectiveWorkingDays, weekday] as Weekday[]).sort();
                      commitSystem(
                        withWorkingDays(system, selected.id, next as Weekday[]),
                        selected.id,
                        `${WEEKDAY_LABELS[weekday]} set to ${next.includes(weekday) ? "working" : "non-working"}`,
                      );
                    }}
                  >
                    {WEEKDAY_LABELS[weekday].slice(0, 3)}
                  </button>
                ))}
              </div>
            </div>

            <div className="calendar-block">
              <div className="calendar-block-head">
                <h3>{year} year grid</h3>
                <div className="calendar-legend">
                  <span className="legend working">Working</span>
                  <span className="legend weekend">Weekend</span>
                  <span className="legend inherited">Inherited exception</span>
                  <span className="legend own">Own exception</span>
                  <span className="legend extra">Extra working day</span>
                </div>
              </div>
              <p className="calendar-hint">
                Click a day to add or remove an exception. Drag across days to close a range
                (e.g. a shutdown period). Hover a day to see why it is working or not.
              </p>
              <div className="year-grid">
                {MONTHS.map((monthName, month) => (
                  <div className="month-card" key={monthName}>
                    <div className="month-title">{monthName}</div>
                    <div className="month-weekdays">
                      {WEEK_ORDER.map((weekday) => (
                        <span key={weekday}>{WEEKDAY_LABELS[weekday].slice(0, 1)}</span>
                      ))}
                    </div>
                    <div className="month-days">
                      {monthCells(year, month).map((date, index) => {
                        if (!date) return <span className="cal-day empty" key={`empty-${index}`} />;
                        const resolution = resolveWorkingDay(date, selected.id, system);
                        const own = Boolean(resolution.exception) && !resolution.inherited;
                        const classes = ["cal-day", resolution.isWorkingDay ? "is-working" : "is-off"];
                        if (resolution.exception) classes.push(own ? "src-own" : "src-inherited");
                        else if (!resolution.isWorkingDay) classes.push("src-weekend");
                        if (resolution.exception?.type === "extra-working") classes.push("src-extra");
                        const [from, to] = drag
                          ? drag.start <= drag.end
                            ? [drag.start, drag.end]
                            : [drag.end, drag.start]
                          : ["", ""];
                        if (drag && date >= from && date <= to) classes.push("is-selected");
                        const title = [
                          `${WEEKDAY_LABELS[parseIsoDate(date).getDay()]}, ${formatDate(date)}`,
                          resolution.reason,
                          resolution.sourceCalendarName
                            ? `from ${resolution.sourceCalendarName}${resolution.inherited ? " (inherited)" : ""}`
                            : "weekly pattern",
                        ].join(" · ");
                        return (
                          <span
                            key={date}
                            className={classes.join(" ")}
                            title={title}
                            onMouseDown={() => startDrag(date)}
                            onMouseEnter={() => extendDrag(date)}
                          >
                            {parseIsoDate(date).getDate()}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <div className="calendar-block-actions">
                <button className="tool-button primary" onClick={() => commitSystem(withBelgianHolidays(system, year), system.defaultCalendarId, `Imported Belgian public holidays for ${year}`)}>
                  <Download size={14} /> Import Belgian public holidays for {year}
                  {missingHolidays ? ` (${missingHolidays})` : " (all present)"}
                </button>
              </div>
            </div>

            <div className="calendar-block">
              <div className="calendar-block-head">
                <h3>Exceptions on {selected.name}</h3>
                <small>{ownExceptions.length} local</small>
              </div>
              {ownExceptions.length === 0 ? (
                <p className="calendar-hint">No local exceptions. Click or drag on the year grid to add one.</p>
              ) : (
                <div className="exception-table">
                  {ownExceptions.map((exception) => (
                    <div className="exception-row" key={exception.id}>
                      <span className="exception-date">{formatRange(exception.startDate, exception.endDate)}</span>
                      <span className="exception-label">
                        <GripVertical size={12} /> {exception.label}
                      </span>
                      <span className={`exception-type type-${exception.type}`}>
                        {EXCEPTION_TYPE_LABELS[exception.type]}
                      </span>
                      <span className="exception-source">This calendar</span>
                      <button className="icon-button" title="Remove" onClick={() => commitSystem(withExceptionRemoved(system, exception.id), selected.id, `Removed "${exception.label}"`)}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="calendar-block">
              <div className="calendar-block-head">
                <h3>Inherited exceptions</h3>
                <small>Read-only — override them locally if this calendar needs to differ</small>
              </div>
              {inheritedExceptions.length === 0 ? (
                <p className="calendar-hint">Nothing inherited yet.</p>
              ) : (
                <div className="exception-table">
                  {inheritedExceptions.map(({ exception, from }) => (
                    <div className="exception-row inherited" key={`${from.id}-${exception.id}`}>
                      <span className="exception-date">{formatRange(exception.startDate, exception.endDate)}</span>
                      <span className="exception-label">{exception.label}</span>
                      <span className={`exception-type type-${exception.type}`}>
                        {EXCEPTION_TYPE_LABELS[exception.type]}
                      </span>
                      <span className="exception-source">from {from.name}</span>
                      <div className="exception-override">
                        <button className="tool-button" onClick={() => overrideInherited(exception, true)}>
                          Work
                        </button>
                        <button className="tool-button" onClick={() => overrideInherited(exception, false)}>
                          Close
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}
      </div>

      {/* ------------------------------------------------ range dialog --- */}
      {rangeDialog && (
        <div className="modal-backdrop" onClick={() => setRangeDialog(null)}>
          <div className="task-modal" onClick={(event: ReactMouseEvent) => event.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <div className="eyebrow">NEW EXCEPTION</div>
                <h2>{formatRange(rangeDialog.start, rangeDialog.end)}</h2>
              </div>
              <button className="icon-button" onClick={() => setRangeDialog(null)}>
                <X size={18} />
              </button>
            </div>
            <div className="modal-grid">
              <label>
                Label
                <input
                  autoFocus
                  value={rangeDialog.label}
                  onChange={(event) => setRangeDialog({ ...rangeDialog, label: event.target.value })}
                />
              </label>
              <label>
                Type
                <select
                  value={rangeDialog.type}
                  onChange={(event) =>
                    setRangeDialog({ ...rangeDialog, type: event.target.value as CalendarExceptionType })
                  }
                >
                  {EXCEPTION_TYPE_ORDER.map((type) => (
                    <option key={type} value={type}>
                      {EXCEPTION_TYPE_LABELS[type]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="modal-actions">
              <button className="tool-button" onClick={() => setRangeDialog(null)}>
                Cancel
              </button>
              <button
                className="tool-button primary"
                onClick={() => {
                  const exception = makeException({
                    calendarId: selected.id,
                    startDate: rangeDialog.start,
                    endDate: rangeDialog.end,
                    label: rangeDialog.label,
                    type: rangeDialog.type,
                  });
                  commitSystem(
                    withExceptionAdded(system, exception),
                    selected.id,
                    `${EXCEPTION_TYPE_LABELS[rangeDialog.type]} added`,
                  );
                  setRangeDialog(null);
                }}
              >
                Add exception
              </button>
            </div>
          </div>
        </div>
      )}

      {/* -------------------------------------------- impact confirmation --- */}
      {pending && (
        <div className="modal-backdrop" onClick={() => setPending(null)}>
          <div className="task-modal" onClick={(event: ReactMouseEvent) => event.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <div className="eyebrow">CONFIRM RECALCULATION</div>
                <h2>Apply this calendar change?</h2>
              </div>
              <button className="icon-button" onClick={() => setPending(null)}>
                <X size={18} />
              </button>
            </div>
            <p className="calendar-copy">
              This affects <b>{pending.impact.projects}</b> project
              {pending.impact.projects === 1 ? "" : "s"} and will move <b>{pending.impact.tasks}</b> task
              {pending.impact.tasks === 1 ? "" : "s"}.
            </p>
            <div className="modal-actions">
              <button className="tool-button" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button
                className="tool-button primary"
                onClick={() => {
                  applyCalendarSystem(pending.nextSystem);
                  toast.success(pending.description);
                  setPending(null);
                }}
              >
                Apply and recalculate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
