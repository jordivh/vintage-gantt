import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Check, ChevronLeft, ChevronRight, Plus, Trash2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { useCalendarStore, type LeaveType, type ResourceRecord } from "@/lib/calendar-store";
import { AppBar } from "@/components/AppBar";
import { monthCells, parseIsoDate, WEEKDAY_LABELS, WEEK_ORDER, type CalendarSystem, type Weekday } from "@/lib/scheduling-engine";
import { resourceDayAvailability } from "@/lib/resource-capacity";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const leaveTypes: LeaveType[] = ["holiday leave", "sick leave", "training", "other"];
const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
/** The one date format this screen's pickers use, for both values and placeholders. */
const DATE_DISPLAY = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
/** Today, as YYYY-MM-DD, read at the moment it is asked for — never a fixed date. */
const todayIso = () => iso(new Date());
const dayCount = (start: string, end: string) => Math.floor((parseIsoDate(end).getTime() - parseIsoDate(start).getTime()) / 86400000) + 1;
const scheduleLabel = (days: Weekday[]) => {
  if (days.length === 5 && days.every((day) => [1, 2, 3, 4, 5].includes(day))) return "Mon–Fri";
  return days.length ? days.map((day) => WEEKDAY_LABELS[day].slice(0, 3)).join(", ") : "No working days";
};
/** Hours shown compactly in the year grid: 5h, 7.5h, … */
const formatHours = (hours: number) => `${Math.round(hours * 100) / 100}h`;

export default function Resources() {
  const { resources, system, createResource, updateResource, updateResourceSchedule, addResourceLeave, removeResourceLeave } = useCalendarStore();
  const [selectedId, setSelectedId] = useState(resources[0]?.id ?? "");
  const [tab, setTab] = useState<"details" | "schedule" | "leave">("details");
  const [year, setYear] = useState(() => new Date().getFullYear());
  // A new leave entry starts with no dates at all: the pickers show today only as a
  // placeholder, and an untouched field is never saved as if it held that date.
  const [newLeave, setNewLeave] = useState({ startDate: "", endDate: "", type: "holiday leave" as LeaveType, note: "" });
  const selected = resources.find((resource) => resource.id === selectedId) ?? resources[0];
  const selectedCalendar = system.calendars.find((calendar) => calendar.id === selected?.calendarId);
  const workingDays = selectedCalendar?.workingDays ?? ([1, 2, 3, 4, 5] as Weekday[]);
  const leaves = selected ? system.exceptions.filter((exception) => exception.calendarId === selected.calendarId && exception.type === "leave") : [];

  useEffect(() => {
    if (resources.length && !resources.some((resource) => resource.id === selectedId)) setSelectedId(resources[0].id);
  }, [resources, selectedId]);
  const leaveDays = useMemo(() => new Set(leaves.flatMap((leave) => {
    const dates: string[] = [];
    for (let cursor = parseIsoDate(leave.startDate); cursor <= parseIsoDate(leave.endDate); cursor.setDate(cursor.getDate() + 1)) dates.push(iso(cursor));
    return dates;
  })), [leaves]);

  const addEmployee = () => {
    const base = system.calendars.find((calendar) => calendar.isDefault);
    const created = createResource({ name: "New employee", role: "", email: "", colour: "#d97757", hoursPerWeek: 40, isActive: true });
    updateResourceSchedule(created.id, base?.workingDays ?? [1, 2, 3, 4, 5]);
    setSelectedId(created.id);
    setTab("details");
    toast.success("Employee added");
  };

  if (!selected) {
    return <div className="planner-shell"><AppBar activeKey="resources" /><EmptyState onAdd={addEmployee} /></div>;
  }

  return (
    <div className="planner-shell">
      <AppBar activeKey="resources" />

      <main className="resource-screen">
        <div className="resource-heading"><div><div className="eyebrow">TEAM DIRECTORY / PERSON CALENDARS</div><h2>People who make the plan</h2><p>Assignments, working patterns and leave stay together in each employee’s person calendar.</p></div><button className="tool-button primary" onClick={addEmployee}><Plus size={16} /> Add employee</button></div>
        <div className="resource-layout">
          <section className="resource-list card-surface">
            <div className="resource-list-head"><span>{resources.length} employees</span><span className="muted">{resources.filter((resource) => resource.isActive).length} active</span></div>
            <div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>Name</th><th>Role</th><th>Email</th><th>Hours</th><th>Schedule</th><th>Leave</th><th>Status</th></tr></thead><tbody>{resources.map((resource) => {
              const calendar = system.calendars.find((item) => item.id === resource.calendarId);
              const resourceLeaves = system.exceptions.filter((exception) => exception.calendarId === resource.calendarId && exception.type === "leave");
              const totalLeave = resourceLeaves.reduce((total, leave) => total + dayCount(leave.startDate, leave.endDate), 0);
              return <tr key={resource.id} className={resource.id === selected.id ? "active-row" : ""} onClick={() => { setSelectedId(resource.id); setTab("details"); }}>
                <td><span className="person-chip" style={{ background: resource.colour }}>{resource.name.slice(0, 1).toUpperCase()}</span><b>{resource.name}</b></td><td>{resource.role || "—"}</td><td>{resource.email || "—"}</td><td>{resource.hoursPerWeek}h</td><td>{scheduleLabel(calendar?.workingDays ?? [1, 2, 3, 4, 5])}</td><td>{totalLeave}d</td><td><span className={`status-pill ${resource.isActive ? "online" : "offline"}`}>{resource.isActive ? "Active" : "Inactive"}</span></td>
              </tr>;
            })}</tbody></table></div>
          </section>

          <aside className="resource-detail card-surface">
            <div className="detail-heading"><div className="detail-person"><span className="person-avatar" style={{ background: selected.colour }}>{selected.name.slice(0, 1).toUpperCase()}</span><div><div className="eyebrow">EMPLOYEE PROFILE</div><h3>{selected.name}</h3><span className="muted">{selected.role || "Role not set"}</span></div></div><button className="icon-button" onClick={() => updateResource(selected.id, { isActive: !selected.isActive })} title={selected.isActive ? "Deactivate" : "Activate"}>{selected.isActive ? <UserRound size={17} /> : <Check size={17} />}</button></div>
            <div className="detail-tabs">{(["details", "schedule", "leave"] as const).map((value) => <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{value === "details" ? "Details" : value === "schedule" ? "Work schedule" : "Leave"}</button>)}</div>
            {tab === "details" && <Details resource={selected} onUpdate={(patch) => updateResource(selected.id, patch)} />}
            {tab === "schedule" && <Schedule days={workingDays} hoursPerWeek={selected.hoursPerWeek} onChange={(days) => updateResourceSchedule(selected.id, days)} />}
            {tab === "leave" && <LeavePanel year={year} setYear={setYear} leaves={leaves} leaveDays={leaveDays} system={system} resource={selected} newLeave={newLeave} setNewLeave={setNewLeave} onAdd={() => { if (!newLeave.startDate || !newLeave.endDate) return toast.error("Pick a start and end date for this leave."); if (newLeave.startDate > newLeave.endDate) return toast.error("Leave end date must be after its start date"); addResourceLeave(selected.id, newLeave); toast.success("Leave saved"); }} onRemove={removeResourceLeave} />}
          </aside>
        </div>
      </main>
    </div>
  );
}

function Details({ resource, onUpdate }: { resource: ResourceRecord; onUpdate: (patch: Partial<ResourceRecord>) => void }) {
  return <div className="detail-content"><div className="detail-grid">
    <label>Full name<input value={resource.name} onChange={(event) => onUpdate({ name: event.target.value })} /></label>
    <label>Role<input value={resource.role} onChange={(event) => onUpdate({ role: event.target.value })} placeholder="e.g. Producer" /></label>
    <label>Email<input type="email" value={resource.email} onChange={(event) => onUpdate({ email: event.target.value })} /></label>
    <label>Capacity (hours/week)<input type="number" min="0" max="168" value={resource.hoursPerWeek} onChange={(event) => onUpdate({ hoursPerWeek: Math.max(0, Number(event.target.value) || 0) })} /></label>
    <label>Label colour<div className="colour-input"><input type="color" value={resource.colour} onChange={(event) => onUpdate({ colour: event.target.value })} /><code>{resource.colour}</code></div></label>
  </div><label className="toggle-row"><span><b>Active employee</b><small>Inactive people remain on historical assignments.</small></span><input type="checkbox" checked={resource.isActive} onChange={(event) => onUpdate({ isActive: event.target.checked })} /></label></div>;
}

function Schedule({ days, hoursPerWeek, onChange }: { days: Weekday[]; hoursPerWeek: number; onChange: (days: Weekday[]) => void }) {
  const perDay = days.length ? Math.max(0, hoursPerWeek) / days.length : 0;
  return <div className="detail-content"><p className="calendar-copy">This personal pattern is the resource's own working week. The weekly capacity is spread evenly over these days, so 20 h over Mon–Thu is 5 h a day. Leave does not move project tasks.</p><div className="weekday-grid">{WEEK_ORDER.map((day) => <button key={day} className={days.includes(day) ? "selected" : ""} onClick={() => onChange(days.includes(day) ? days.filter((item) => item !== day) : [...days, day].sort((a, b) => a - b) as Weekday[])}><span>{WEEKDAY_LABELS[day].slice(0, 3)}</span>{days.includes(day) && <Check size={15} />}</button>)}</div><div className="schedule-summary"><CalendarDays size={17} /> {scheduleLabel(days)} · {days.length} working days · {formatHours(perDay)}/day</div></div>;
}

/**
 * A date picker that can sit empty: an empty value shows `placeholder` (today, as a
 * hint) and only picking a day in the calendar turns a date into a value.
 */
function DatePickerField({ value, placeholder, onChange }: { value: string; placeholder: string; onChange: (value: string) => void }) {
  return <Popover>
    <PopoverTrigger asChild><button type="button" className={`date-picker-button${value ? "" : " is-empty"}`}><span>{value ? DATE_DISPLAY.format(parseIsoDate(value)) : placeholder}</span><CalendarDays size={17} /></button></PopoverTrigger>
    <PopoverContent align="start" className="resource-calendar-popover"><Calendar mode="single" selected={value ? parseIsoDate(value) : undefined} onSelect={(date) => { if (date) onChange(iso(date)); }} initialFocus /></PopoverContent>
  </Popover>;
}

function LeavePanel({ year, setYear, leaves, leaveDays, system, resource, newLeave, setNewLeave, onAdd, onRemove }: { year: number; setYear: (year: number) => void; leaves: { id: string; startDate: string; endDate: string; label: string }[]; leaveDays: Set<string>; system: CalendarSystem; resource: ResourceRecord; newLeave: { startDate: string; endDate: string; type: LeaveType; note: string }; setNewLeave: (value: { startDate: string; endDate: string; type: LeaveType; note: string }) => void; onAdd: () => void; onRemove: (id: string) => void }) {
  // Today, read at render time: the pickers show it while they hold no date.
  const todayPlaceholder = DATE_DISPLAY.format(parseIsoDate(todayIso()));
  return <div className="detail-content leave-content"><div className="leave-entry"><div className="leave-entry-title"><b>Add leave</b><span>Saved to this employee’s person calendar</span></div><div className="detail-grid"><label>From<DatePickerField value={newLeave.startDate} placeholder={todayPlaceholder} onChange={(value) => setNewLeave({ ...newLeave, startDate: value })} /></label><label>To<DatePickerField value={newLeave.endDate} placeholder={todayPlaceholder} onChange={(value) => setNewLeave({ ...newLeave, endDate: value })} /></label><label>Type<select value={newLeave.type} onChange={(event) => setNewLeave({ ...newLeave, type: event.target.value as LeaveType })}>{leaveTypes.map((type) => <option key={type}>{type}</option>)}</select></label><label>Note<input value={newLeave.note} onChange={(event) => setNewLeave({ ...newLeave, note: event.target.value })} placeholder="Optional note" /></label></div><button className="tool-button primary" onClick={onAdd}><Plus size={15} /> Save leave</button></div>
    <div className="leave-calendar-head"><b>Effective working calendar</b><div><button className="icon-button" onClick={() => setYear(year - 1)}><ChevronLeft size={15} /></button><span>{year}</span><button className="icon-button" onClick={() => setYear(year + 1)}><ChevronRight size={15} /></button></div></div>
    <div className="avail-legend">{([["person", "Person pattern"], ["project", "Project calendar"], ["base", "Base calendar"], ["pattern", "Weekly pattern"], ["leave", "Leave"]] as const).map(([level, label]) => <span key={level} className={`avail-${level}`}>{label}</span>)}</div>
    <div className="resource-year-grid">{Array.from({ length: 12 }, (_, month) => <div className="mini-month" key={month}><b>{new Date(year, month, 1).toLocaleDateString("en-US", { month: "short" })}</b><div className="mini-weekdays">{["M", "T", "W", "T", "F", "S", "S"].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}</div><div className="mini-days">{monthCells(year, month).map((date, index) => { if (!date) return <span key={`blank-${index}`} />; const availability = resourceDayAvailability(resource, date, system); const leave = leaveDays.has(date); const level = leave ? "leave" : availability.level; return <span key={date} className={`avail-${level} ${leave ? "leave-day" : ""} ${availability.hours === 0 ? "nonworking" : ""}`} title={`${date} · ${formatHours(availability.hours)} available · ${level}${leave ? " (leave)" : ""} · ${availability.reason}`}><b>{Number(date.slice(-2))}</b>{availability.hours > 0 && <small>{formatHours(availability.hours)}</small>}</span>; })}</div></div>)}</div>
    <div className="leave-list"><b>Leave entries</b>{leaves.length === 0 && <span className="muted">No leave entered for this employee.</span>}{leaves.map((leave) => <div className="leave-list-row" key={leave.id}><span><b>{leave.startDate === leave.endDate ? leave.startDate : `${leave.startDate} → ${leave.endDate}`}</b><small>{leave.label}</small></span><button className="icon-button" onClick={() => onRemove(leave.id)}><Trash2 size={15} /></button></div>)}</div>
  </div>;
}
function EmptyState({ onAdd }: { onAdd: () => void }) { return <div className="empty-state"><UserRound size={30} /><h2>No employees yet</h2><button className="tool-button primary" onClick={onAdd}><Plus size={16} /> Add employee</button></div>; }
