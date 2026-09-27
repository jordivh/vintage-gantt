import { useMemo, useState } from "react";
import { AlertTriangle, CalendarRange, CheckCircle2, LogOut } from "lucide-react";
import { useNavigate } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import { useCalendarStore } from "@/lib/calendar-store";
import {
  aggregatePeriods,
  computeResourceLoads,
  formatCapacityHours,
  overloadWarning,
  type CapacityGranularity,
  type CapacityPeriod,
  type ResourceCapacityReport,
} from "@/lib/capacity-engine";

/** The peak utilisation across the shown periods, or null when there is none. */
const peakUtilisation = (periods: CapacityPeriod[]): number | null => {
  const values = periods.map((period) => period.utilisation).filter((value): value is number => value !== null);
  return values.length ? Math.max(...values) : null;
};

export default function Capacity() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { system, resources, assignments, projects, projectTasks } = useCalendarStore();
  const [granularity, setGranularity] = useState<CapacityGranularity>("week");
  const [selectedId, setSelectedId] = useState("");

  // Load is the sum of the active version's tasks across every project — the
  // caller passes exactly one (active) set of tasks per project, so no version
  // is ever counted twice. Everything is derived, so any edit recomputes here.
  const reports = useMemo(() => computeResourceLoads({
    system,
    resources: resources.map((resource) => ({ id: resource.id, name: resource.name, hoursPerWeek: resource.hoursPerWeek, calendarId: resource.calendarId })),
    assignments,
    projects: projects
      .filter((project) => (project.kind ?? (project.status === "template" ? "template" : "project")) === "project")
      .map((project) => ({ projectId: project.id, projectName: project.name, projectCalendarId: project.calendarId, tasks: projectTasks(project.id) })),
  }), [system, resources, assignments, projects, projectTasks]);

  const periodsByResource = useMemo(
    () => new Map(reports.map((report) => [report.resourceId, aggregatePeriods(report, granularity)])),
    [reports, granularity],
  );

  const overloads = useMemo(
    () => reports.flatMap((report) => (periodsByResource.get(report.resourceId) ?? [])
      .filter((period) => period.overload)
      .map((period) => ({ resourceId: report.resourceId, resourceName: report.resourceName, period, warning: overloadWarning(report.resourceName, period) ?? "" }))),
    [reports, periodsByResource],
  );

  const selected = reports.find((report) => report.resourceId === selectedId) ?? reports[0];
  const selectedPeriods = selected ? periodsByResource.get(selected.resourceId) ?? [] : [];

  const nav = (
    <nav className="topnav">
      <button className="tool-button" onClick={() => navigate("/dashboard")}>Planner</button>
      <button className="tool-button" onClick={() => navigate("/projects")}>Projects</button>
      <button className="tool-button" onClick={() => navigate("/calendars")}>Calendars</button>
      <button className="tool-button" onClick={() => navigate("/resources")}>Resources</button>
      <button className="tool-button primary" onClick={() => navigate("/capacity")}>Capacity</button>
    </nav>
  );

  return (
    <div className="planner-shell">
      <header className="planner-topbar">
        <div className="brand-lockup"><div className="brand-mark">⌁</div><div><div className="eyebrow">PEOPLE / CAPACITY</div><h1>Capacity</h1></div></div>
        {nav}
        <div className="top-actions"><button className="avatar" title={user?.name ?? "Account"}>{user?.name?.slice(0, 1) ?? "M"}</button><button className="icon-button" title="Sign out" onClick={() => { signOut(); navigate("/"); }}><LogOut size={17} /></button></div>
      </header>

      <main className="capacity-screen">
        <div className="capacity-heading">
          <div>
            <div className="eyebrow">WORKLOAD / OVERLOAD</div>
            <h2>Who is over capacity</h2>
            <p>Load is the allocated work of every active plan version, measured against each person’s own available hours. A long task with little work stays well under capacity.</p>
          </div>
          <div className="capacity-toggle" role="group" aria-label="Aggregation period">
            <CalendarRange size={15} />
            {(["week", "month"] as const).map((value) => (
              <button key={value} className={granularity === value ? "active" : ""} onClick={() => setGranularity(value)}>{value === "week" ? "Week" : "Month"}</button>
            ))}
          </div>
        </div>

        {resources.length === 0 ? (
          <div className="capacity-empty card-surface">Add people on the Resources screen to see their capacity.</div>
        ) : (
          <>
            {overloads.length > 0 ? (
              <section className="capacity-banner card-surface" role="alert">
                <div className="capacity-banner-head"><AlertTriangle size={18} /><b>{overloads.length} overbelasting{overloads.length === 1 ? "" : "en"}</b></div>
                <ul>
                  {overloads.map((item) => (
                    <li key={`${item.resourceId}-${item.period.key}`}>
                      <button type="button" className="capacity-banner-link" onClick={() => setSelectedId(item.resourceId)}>{item.warning}</button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              <section className="capacity-ok card-surface"><CheckCircle2 size={17} /> Geen overbelasting: elke periode blijft binnen de beschikbare uren.</section>
            )}

            <div className="capacity-layout">
              <aside className="capacity-list card-surface">
                <div className="capacity-list-head"><span>{reports.length} people</span><span className="muted">{overloads.length ? `${overloads.length} overloaded periods` : "all within capacity"}</span></div>
                {reports.map((report) => {
                  const periods = periodsByResource.get(report.resourceId) ?? [];
                  const peak = peakUtilisation(periods);
                  const overloaded = periods.filter((period) => period.overload).length;
                  return (
                    <button key={report.resourceId} className={`capacity-person ${report.resourceId === selected?.resourceId ? "current" : ""}`} onClick={() => setSelectedId(report.resourceId)}>
                      <span className="capacity-person-avatar" style={{ background: resources.find((resource) => resource.id === report.resourceId)?.colour ?? "#9a8e78" }}>{report.resourceName.slice(0, 1).toUpperCase()}</span>
                      <span className="capacity-person-copy">
                        <b>{report.resourceName}</b>
                        <small>{formatCapacityHours(report.hoursPerWeek)} h/week · {formatCapacityHours(report.totalAllocated)} h allocated</small>
                      </span>
                      <span className="capacity-person-meta">
                        {peak === null ? "—" : `${Math.round(peak * 100)}%`}
                        {overloaded > 0 && <em className="capacity-person-badge"><AlertTriangle size={11} /> {overloaded}</em>}
                      </span>
                    </button>
                  );
                })}
              </aside>

              <section className="capacity-detail card-surface">
                {selected && <ResourceDetail report={selected} periods={selectedPeriods} />}
              </section>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function ResourceDetail({ report, periods }: { report: ResourceCapacityReport; periods: CapacityPeriod[] }) {
  const conflicts = useMemo(() => {
    const seen = new Set<string>();
    return report.conflicts.filter((conflict) => {
      const key = `${conflict.taskId}|${conflict.otherTaskId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [report.conflicts]);
  return (
    <div className="capacity-detail-body">
      <div className="capacity-detail-head">
        <div><div className="eyebrow">RESOURCE</div><h3>{report.resourceName}</h3></div>
        <div className="capacity-totals">
          <span><small>Available</small><b>{formatCapacityHours(report.totalAvailable)} h</b></span>
          <span><small>Allocated</small><b>{formatCapacityHours(report.totalAllocated)} h</b></span>
          <span><small>Overloaded days</small><b>{report.overloadedDays}</b></span>
        </div>
      </div>

      <div className="capacity-table-wrap">
        <table className="capacity-table">
          <thead><tr><th>Period</th><th>Available</th><th>Allocated</th><th>Remaining</th><th>Utilisation</th></tr></thead>
          <tbody>
            {periods.length === 0 && <tr><td colSpan={5} className="muted">No planned work in this project range.</td></tr>}
            {periods.map((period) => (
              <PeriodRows key={period.key} period={period} resourceName={report.resourceName} />
            ))}
          </tbody>
        </table>
      </div>

      {conflicts.length > 0 && (
        <div className="capacity-conflicts">
          <b>Conflicting assignments</b>
          <p className="muted">These tasks overlap and together exceed this person’s availability.</p>
          <ul>
            {conflicts.map((conflict) => (
              <li key={`${conflict.taskId}-${conflict.otherTaskId}`}>
                <span className="conflict-task">{conflict.taskName} <small>{conflict.projectName}</small></span>
                <span className="conflict-with">together with</span>
                <span className="conflict-task">{conflict.otherTaskName} <small>{conflict.otherProjectName}</small></span>
                <span className="conflict-date">from {conflict.date}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function PeriodRows({ period, resourceName }: { period: CapacityPeriod; resourceName: string }) {
  const warning = overloadWarning(resourceName, period);
  const percent = period.utilisation === null ? null : Math.round(period.utilisation * 100);
  return (
    <>
      <tr className={`capacity-row ${period.overload ? "overload" : ""}`}>
        <td><b>{period.label}</b></td>
        <td>{formatCapacityHours(period.available)} h</td>
        <td>{formatCapacityHours(period.allocated)} h</td>
        <td className={period.remaining < 0 ? "negative" : ""}>{formatCapacityHours(period.remaining)} h</td>
        <td>
          <div className="capacity-util"><span className={`capacity-util-fill ${period.overload ? "over" : ""}`} style={{ width: `${Math.min(100, percent ?? 0)}%` }} /></div>
          <span className="capacity-util-label">
            {period.overload && <AlertTriangle size={13} />}
            {percent === null ? "—" : `${percent}%`}
          </span>
        </td>
      </tr>
      {(period.allocated > 0 || warning) && (
        <tr className={`capacity-row-detail ${period.overload ? "overload" : ""}`}>
          <td colSpan={5}>
            {warning && <p className="capacity-warning" role="alert">{warning}</p>}
            {period.breakdown.length > 0 && (
              <div className="capacity-breakdown">
                <span className="muted">Breakdown:</span>
                {period.breakdown.map((row) => (
                  <span key={row.projectId} className="capacity-chip">{row.projectName} · {formatCapacityHours(row.allocated)} h</span>
                ))}
              </div>
            )}
            {period.conflicts.length > 0 && (
              <div className="capacity-inline-conflict">
                {period.conflicts.slice(0, 4).map((conflict) => (
                  <span key={`${conflict.taskId}-${conflict.otherTaskId}`}>{conflict.taskName} ({conflict.projectName}) × {conflict.otherTaskName} ({conflict.otherProjectName})</span>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
