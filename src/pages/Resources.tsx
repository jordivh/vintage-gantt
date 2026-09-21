import { useMemo, useState } from "react";
import { CalendarDays, Check, ChevronLeft, ChevronRight, LogOut, Pencil, Plus, Trash2, UserRound, X } from "lucide-react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { useCalendarStore, type LeaveType, type ResourceRecord } from "@/lib/calendar-store";
import { parseIsoDate, resolveWorkingDay, WEEKDAY_LABELS, WEEK_ORDER, type Weekday } from "@/lib/scheduling-engine";

const leaveTypes: LeaveType[] = ["holiday leave", "sick leave", "training", "other"];
const iso = (date: Date) => date.toISOString().slice(0, 10);
const dayCount = (start: string, end: string) => Math.floor((parseIsoDate(end).getTime() - parseIsoDate(start).getTime()) / 86400000) + 1;
const scheduleLabel = (days: Weekday[]) => {
  if (days.length === 5 && days.every((day) => [1, 2, 3, 4, 5].includes(day))) return "Mon–Fri";
  return days.length ? days.map((day) => WEEKDAY_LABELS[day].slice(0, 3)).join(", ") : "No working days";
};
const monthCells = (year: number, month: number) => {
  const first = new Date(year, month, 1, 12);
  const count = new Date(year, month + 1, 0, 12).getDate();
  const leading = (first.getDay() + 6) % 7;
  return [...Array.from({ length: leading }, () => null), ...Array.from({ length: count }, (_, i) => `${year}-${String(month + 1).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`)];
};

export default function Resources() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { resources, system, createResource, updateResource, updateResourceSchedule, addResourceLeave, removeResourceLeave } = useCalendarStore();
  const [selectedId, setSelectedId] = useState(resources[0]?.id ?? "");
  const [tab, setTab] = useState<"details" | "schedule" | "leave">("details");
  const [year, setYear] = useState(2025);
  const [newLeave, setNewLeave] = useState({ startDate: "2025-05-05", endDate: "2025-05-05", type: "holiday leave" as LeaveType, note: "" });
  const selected = resources.find((resource) => resource.id === selectedId) ?? resources[0];
  const selectedCalendar = system.calendars.find((calendar) => calendar.id === selected?.calendarId);
  const workingDays = selectedCalendar?.workingDays ?? ([1, 2, 3, 4, 5] as Weekday[]);
  const leaves = selected ? system.exceptions.filter((exception) => exception.calendarId === selected.calendarId && exception.type === "leave") : [];
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
    return <div className="planner-shell"><EmptyState onAdd={addEmployee} /></div>;
  }

  return (
    <div className="planner-shell">
      <header className="planner-topbar">
        <div className="brand-lockup"><div className="brand-mark">⌁</div><div><div className="eyebrow">PEOPLE / WORKING TIME</div><h1>Resources</h1></div></div>
        <nav className="topnav">
          <button className="tool-button" onClick={() => navigate("/dashboard")}>Planner</button>
          <button className="tool-button" onClick={() => navigate("/calendars")}>Calendars</button>
          <button className="tool-button primary" onClick={() => navigate("/resources")}>Resources</button>
        </nav>
        <div className="top-actions"><button className="avatar" title={user?.name ?? "Account"}>{user?.name?.slice(0, 1) ?? "M"}</button><button className="icon-button" title="Sign out" onClick={() => { signOut(); navigate("/"); }}><LogOut size={17} /></button></div>
      </header>

      <main className="resource-screen">
        <div className="resource-heading"><div><div className="eyebrow">TEAM DIRECTORY / PERSON CALENDARS</div><h2>People who make the plan</h2><p>Assignments, working patterns and leave stay together in each employee’s person calendar.</p></div><button className="tool-button primary" onClick={addEmployee}><Plus size={16} /> Add employee</button></div>
        <div className="resource-layout">
          <section className="resource-list card-surface">
            <div className="resource-list-head"><span>{resources.length} employees</span><span className="muted">{resources.filter((resource) => resource.isActive).length} active</span></div>
            <div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>Name</th><th>Role</th><th>Email</th><th>Hours</th><th>Schedule</th><th>Leave {year}</th><th>Status</th></tr></thead><tbody>{resources.map((resource) => {
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
            {tab === "schedule" && <Schedule days={workingDays} onChange={(days) => updateResourceSchedule(selected.id, days)} />}
            {tab === "leave" && <LeavePanel year={year} setYear={setYear} leaves={leaves} leaveDays={leaveDays} system={system} calendarId={selected.calendarId} newLeave={newLeave} setNewLeave={setNewLeave} onAdd={() => { if (newLeave.startDate > newLeave.endDate) return toast.error("Leave end date must be after its start date"); addResourceLeave(selected.id, newLeave); toast.success("Leave saved"); }} onRemove={removeResourceLeave} />}
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
    <label>Hours per week<input type="number" min="1" max="168" value={resource.hoursPerWeek} onChange={(event) => onUpdate({ hoursPerWeek: Number(event.target.value) || 40 })} /></label>
    <label>Label colour<div className="colour-input"><input type="color" value={resource.colour} onChange={(event) => onUpdate({ colour: event.target.value })} /><code>{resource.colour}</code></div></label>
  </div><label className="toggle-row"><span><b>Active employee</b><small>Inactive people remain on historical assignments.</small></span><input type="checkbox" checked={resource.isActive} onChange={(event) => onUpdate({ isActive: event.target.checked })} /></label></div>;
}

function Schedule({ days, onChange }: { days: Weekday[]; onChange: (days: Weekday[]) => void }) {
  return <div className="detail-content"><p className="calendar-copy">This personal pattern is used by the person calendar. Leave remains visible here, but does not move project tasks yet.</p><div className="weekday-grid">{WEEK_ORDER.map((day) => <button key={day} className={days.includes(day) ? "selected" : ""} onClick={() => onChange(days.includes(day) ? days.filter((item) => item !== day) : [...days, day].sort((a, b) => a - b) as Weekday[])}><span>{WEEKDAY_LABELS[day].slice(0, 3)}</span>{days.includes(day) && <Check size={15} />}</button>)}</div><div className="schedule-summary"><CalendarDays size={17} /> {scheduleLabel(days)} · {days.length} working days each week</div></div>;
}

function LeavePanel({ year, setYear, leaves, leaveDays, system, calendarId, newLeave, setNewLeave, onAdd, onRemove }: { year: number; setYear: (year: number) => void; leaves: { id: string; startDate: string; endDate: string; label: string }[]; leaveDays: Set<string>; system: Parameters<typeof resolveWorkingDay>[2]; calendarId: string; newLeave: { startDate: string; endDate: string; type: LeaveType; note: string }; setNewLeave: (value: { startDate: string; endDate: string; type: LeaveType; note: string }) => void; onAdd: () => void; onRemove: (id: string) => void }) {
  return <div className="detail-content leave-content"><div className="leave-entry"><div className="leave-entry-title"><b>Add leave</b><span>Saved to this employee’s person calendar</span></div><div className="detail-grid"><label>From<input type="date" value={newLeave.startDate} onChange={(event) => setNewLeave({ ...newLeave, startDate: event.target.value })} /></label><label>To<input type="date" value={newLeave.endDate} onChange={(event) => setNewLeave({ ...newLeave, endDate: event.target.value })} /></label><label>Type<select value={newLeave.type} onChange={(event) => setNewLeave({ ...newLeave, type: event.target.value as LeaveType })}>{leaveTypes.map((type) => <option key={type}>{type}</option>)}</select></label><label>Note<input value={newLeave.note} onChange={(event) => setNewLeave({ ...newLeave, note: event.target.value })} placeholder="Optional note" /></label></div><button className="tool-button primary" onClick={onAdd}><Plus size={15} /> Save leave</button></div>
    <div className="leave-calendar-head"><b>Leave calendar</b><div><button className="icon-button" onClick={() => setYear(year - 1)}><ChevronLeft size={15} /></button><span>{year}</span><button className="icon-button" onClick={() => setYear(year + 1)}><ChevronRight size={15} /></button></div></div>
    <div className="year-grid">{Array.from({ length: 12 }, (_, month) => <div className="mini-month" key={month}><b>{new Date(year, month, 1).toLocaleDateString("en-US", { month: "short" })}</b><div className="mini-weekdays">{["M", "T", "W", "T", "F", "S", "S"].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}</div><div className="mini-days">{monthCells(year, month).map((date, index) => { if (!date) return <span key={`blank-${index}`} />; const resolution = resolveWorkingDay(date, calendarId, system); const leave = leaveDays.has(date); return <span key={date} className={`${leave ? "leave-day" : ""} ${!resolution.isWorkingDay ? "nonworking" : ""}`} title={`${date} · ${leave ? "Leave" : resolution.reason}`}>{Number(date.slice(-2))}</span>; })}</div></div>)}</div>
    <div className="leave-list"><b>Leave entries</b>{leaves.length === 0 && <span className="muted">No leave entered for this employee.</span>}{leaves.map((leave) => <div className="leave-list-row" key={leave.id}><span><b>{leave.startDate === leave.endDate ? leave.startDate : `${leave.startDate} → ${leave.endDate}`}</b><small>{leave.label}</small></span><button className="icon-button" onClick={() => onRemove(leave.id)}><Trash2 size={15} /></button></div>)}</div>
  </div>;
}
function EmptyState({ onAdd }: { onAdd: () => void }) { return <div className="empty-state"><UserRound size={30} /><h2>No employees yet</h2><button className="tool-button primary" onClick={onAdd}><Plus size={16} /> Add employee</button></div>; }
