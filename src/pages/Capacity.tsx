import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarRange, CheckCircle2, ExternalLink, FilterX } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";
import { useCalendarStore } from "@/lib/calendar-store";
import { AppBar } from "@/components/AppBar";
import {
  DISTRIBUTION_OPTIONS,
  type PlannerTask,
} from "@/lib/planner-model";
import {
  aggregatePeriods,
  capacityClients,
  computeResourceLoads,
  matchesResourceFilter,
  selectCapacityProjects,
  formatCapacityHours,
  overloadWarning,
  type CapacityGranularity,
  type CapacityPeriod,
  type ResourceCapacityReport,
} from "@/lib/capacity-engine";

interface AssignmentRow {
  taskId: string;
  taskName: string;
  projectId: string;
  projectName: string;
  versionId: string;
  start: string;
  finish: string;
  work: number;
  distribution: string;
}

const distributionLabel = (value: string) =>
  DISTRIBUTION_OPTIONS.find((option) => option.value === value)?.label ?? "Gelijk (even)";

/** The peak utilisation across the shown periods, or null when there is none. */
const peakUtilisation = (periods: CapacityPeriod[]): number | null => {
  const values = periods.map((period) => period.utilisation).filter((value): value is number => value !== null);
  return values.length ? Math.max(...values) : null;
};

export default function Capacity() {
  const navigate = useNavigate();
  const { system, resources, assignments, projects, projectTasks, planVersions, openTask } = useCalendarStore();
  // The planner's overload indicators deep-link here: a resource (warning icon)
  // or a project (context-bar chip), optionally scrolled to the first heavy week.
  const [searchParams] = useSearchParams();
  const focusWeek = searchParams.get("week") ?? "";
  const [granularity, setGranularity] = useState<CapacityGranularity>("week");
  const [selectedId, setSelectedId] = useState("");
  const [filterResource, setFilterResource] = useState(() => searchParams.get("resource") ?? "");
  const [filterProject, setFilterProject] = useState(() => searchParams.get("project") ?? "");
  const [filterClient, setFilterClient] = useState("");

  const clients = useMemo(() => capacityClients(projects), [projects]);
  // Every regular, non-archived project — the options the filters offer.
  const selectableProjects = useMemo(() => selectCapacityProjects(projects), [projects]);
  // Archived work must never contribute load, so it is filtered out here (the
  // project/client filters narrow further).
  const filteredProjects = useMemo(
    () => selectCapacityProjects(projects, { projectId: filterProject, client: filterClient }),
    [projects, filterProject, filterClient],
  );

  const taskIndex = useMemo(() => {
    const map = new Map<string, { task: PlannerTask; projectId: string; projectName: string; versionId: string }>();
    for (const project of filteredProjects) {
      const versionId = planVersions.find((version) => version.projectId === project.id && version.isActive)?.id ?? "";
      for (const task of projectTasks(project.id)) map.set(task.id, { task, projectId: project.id, projectName: project.name, versionId });
    }
    return map;
  }, [filteredProjects, projectTasks, planVersions]);

  // Load comes from the active version of each remaining project only, so no
  // version is counted twice and nothing archived or deleted leaves ghost load.
  const reports = useMemo(() => computeResourceLoads({
    system,
    resources: resources.map((resource) => ({ id: resource.id, name: resource.name, hoursPerWeek: resource.hoursPerWeek, calendarId: resource.calendarId })),
    assignments,
    projects: filteredProjects.map((project) => ({ projectId: project.id, projectName: project.name, projectCalendarId: project.calendarId, tasks: projectTasks(project.id) })),
  }), [system, resources, assignments, filteredProjects, projectTasks]);

  const visibleReports = reports.filter((report) => matchesResourceFilter(report.resourceId, { resourceId: filterResource }));

  const assignmentsByResource = useMemo(() => {
    const map = new Map<string, AssignmentRow[]>();
    for (const assignment of assignments) {
      const entry = taskIndex.get(assignment.taskId);
      if (!entry) continue;
      const list = map.get(assignment.resourceId) ?? [];
      list.push({
        taskId: entry.task.id,
        taskName: entry.task.name,
        projectId: entry.projectId,
        projectName: entry.projectName,
        versionId: entry.versionId,
        start: entry.task.start,
        finish: entry.task.finish,
        work: entry.task.work ?? 0,
        distribution: entry.task.distribution ?? "even",
      });
      map.set(assignment.resourceId, list);
    }
    for (const list of map.values()) list.sort((left, right) => left.start.localeCompare(right.start));
    return map;
  }, [assignments, taskIndex]);

  const periodsByResource = useMemo(
    () => new Map(visibleReports.map((report) => [report.resourceId, aggregatePeriods(report, granularity)])),
    [visibleReports, granularity],
  );

  const overloads = useMemo(
    () => visibleReports.flatMap((report) => (periodsByResource.get(report.resourceId) ?? [])
      .filter((period) => period.overload)
      .map((period) => ({ resourceId: report.resourceId, warning: overloadWarning(report.resourceName, period) ?? "" }))),
    [visibleReports, periodsByResource],
  );

  const selected = visibleReports.find((report) => report.resourceId === selectedId) ?? visibleReports[0];
  const selectedPeriods = selected ? periodsByResource.get(selected.resourceId) ?? [] : [];
  // Scroll the deep-linked week into view once the filtered person is rendered.
  useEffect(() => {
    if (!focusWeek || !selected) return;
    const target = document.querySelector(`[data-capacity-week="${focusWeek}"]`);
    if (target) target.scrollIntoView({ block: "center" });
  }, [focusWeek, selected?.resourceId, granularity]);
  const selectedAssignments = selected ? assignmentsByResource.get(selected.resourceId) ?? [] : [];
  const activeFilters = [
    filterResource ? { label: `Resource: ${resources.find((resource) => resource.id === filterResource)?.name ?? filterResource}`, clear: () => setFilterResource("") } : null,
    filterProject ? { label: `Project: ${selectableProjects.find((project) => project.id === filterProject)?.name ?? filterProject}`, clear: () => setFilterProject("") } : null,
    filterClient ? { label: `Client: ${filterClient}`, clear: () => setFilterClient("") } : null,
  ].filter((value): value is { label: string; clear: () => void } => value !== null);

  const openAssignment = (row: AssignmentRow) => {
    if (!row.versionId) return;
    openTask(row.projectId, row.versionId, row.taskId);
    navigate("/dashboard");
  };

  return (
    <div className="planner-shell">
      <AppBar activeKey="capacity" />

      <main className="capacity-screen">
        <div className="capacity-heading">
          <div>
            <div className="eyebrow">WORKLOAD / OVERLOAD</div>
            <h2>Who is over capacity</h2>
            <p>Every active plan version of every project, measured against each person’s own available hours. Click an assignment to open that task in its project and version.</p>
          </div>
          <div className="capacity-toggle" role="group" aria-label="Aggregation period">
            <CalendarRange size={15} />
            {(["week", "month"] as const).map((value) => (
              <button key={value} className={granularity === value ? "active" : ""} onClick={() => setGranularity(value)}>{value === "week" ? "Week" : "Month"}</button>
            ))}
          </div>
        </div>

        <section className="capacity-filters card-surface">
          <label>Resource
            <select value={filterResource} onChange={(event) => setFilterResource(event.target.value)}>
              <option value="">All resources</option>
              {resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}
            </select>
          </label>
          <label>Project
            <select value={filterProject} onChange={(event) => setFilterProject(event.target.value)}>
              <option value="">All projects</option>
              {selectableProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label>Client
            <select value={filterClient} onChange={(event) => setFilterClient(event.target.value)}>
              <option value="">All clients</option>
              {clients.map((client) => <option key={client} value={client}>{client}</option>)}
            </select>
          </label>
          <div className="capacity-filter-active">
            {activeFilters.length === 0
              ? <span className="muted">No filters</span>
              : <>
                  {activeFilters.map((filter) => <button key={filter.label} className="capacity-filter-chip" onClick={filter.clear}>{filter.label} ×</button>)}
                  <button className="capacity-clear" onClick={() => { setFilterResource(""); setFilterProject(""); setFilterClient(""); }}><FilterX size={14} /> Clear filters</button>
                </>}
          </div>
        </section>

        {resources.length === 0 ? (
          <div className="capacity-empty card-surface">Add people on the Resources screen to see their capacity.</div>
        ) : (
          <>
            {overloads.length > 0 ? (
              <section className="capacity-banner card-surface" role="alert">
                <div className="capacity-banner-head"><AlertTriangle size={18} /><b>{overloads.length} overbelasting{overloads.length === 1 ? "" : "en"}</b></div>
                <ul>
                  {overloads.map((item, index) => (
                    <li key={`${item.resourceId}-${index}`}>
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
                <div className="capacity-list-head"><span>{visibleReports.length} people</span><span className="muted">{overloads.length ? `${overloads.length} overloaded periods` : "all within capacity"}</span></div>
                {visibleReports.map((report) => {
                  const periods = periodsByResource.get(report.resourceId) ?? [];
                  const peak = peakUtilisation(periods);
                  const overloaded = periods.filter((period) => period.overload).length;
                  const rows = assignmentsByResource.get(report.resourceId) ?? [];
                  return (
                    <button key={report.resourceId} className={`capacity-person ${report.resourceId === selected?.resourceId ? "current" : ""}`} onClick={() => setSelectedId(report.resourceId)}>
                      <span className="capacity-person-avatar" style={{ background: resources.find((resource) => resource.id === report.resourceId)?.colour ?? "#9a8e78" }}>{report.resourceName.slice(0, 1).toUpperCase()}</span>
                      <span className="capacity-person-copy">
                        <b>{report.resourceName}</b>
                        <small>{rows.length} assignment{rows.length === 1 ? "" : "s"} · {formatCapacityHours(report.totalAllocated)} h</small>
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
                {selected && (
                  <ResourceDetail
                    report={selected}
                    periods={selectedPeriods}
                    assignments={selectedAssignments}
                    focusWeek={focusWeek}
                    onOpenAssignment={openAssignment}
                  />
                )}
              </section>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function ResourceDetail({ report, periods, assignments, focusWeek, onOpenAssignment }: {
  report: ResourceCapacityReport;
  periods: CapacityPeriod[];
  assignments: AssignmentRow[];
  focusWeek?: string;
  onOpenAssignment: (row: AssignmentRow) => void;
}) {
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
              <PeriodRows key={period.key} period={period} resourceName={report.resourceName} focus={period.key === focusWeek} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="capacity-assignments">
        <b>Assignments</b>
        {assignments.length === 0 ? (
          <p className="muted">No assignments in the current filter — this person is shown with zero utilisation.</p>
        ) : (
          <div className="capacity-table-wrap">
            <table className="capacity-table capacity-assignment-table">
              <thead><tr><th>Task</th><th>Project</th><th>Start</th><th>Finish</th><th>Work</th><th>Distribution</th><th /></tr></thead>
              <tbody>
                {assignments.map((row) => (
                  <tr key={`${row.projectId}-${row.taskId}`} className="capacity-assignment-row" onClick={() => onOpenAssignment(row)}>
                    <td><b>{row.taskName}</b></td>
                    <td>{row.projectName}</td>
                    <td>{row.start}</td>
                    <td>{row.finish}</td>
                    <td>{formatCapacityHours(row.work)} h</td>
                    <td>{distributionLabel(row.distribution)}</td>
                    <td className="capacity-open-cell"><button type="button" title="Open this task in its project" onClick={(event) => { event.stopPropagation(); onOpenAssignment(row); }}><ExternalLink size={14} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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

function PeriodRows({ period, resourceName, focus }: { period: CapacityPeriod; resourceName: string; focus?: boolean }) {
  const warning = overloadWarning(resourceName, period);
  const percent = period.utilisation === null ? null : Math.round(period.utilisation * 100);
  return (
    <>
      <tr data-capacity-week={period.key} className={`capacity-row ${period.overload ? "overload" : ""}${focus ? " focused" : ""}`}>
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
