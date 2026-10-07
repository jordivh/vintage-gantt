import { useMemo, useState } from "react";
import { AlertTriangle, CalendarRange, CheckCircle2, ChevronLeft, ChevronRight, ExternalLink, FileSpreadsheet, FilterX, Loader2 } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { useCalendarStore } from "@/lib/calendar-store";
import { UNAVAILABLE_NOTICE, scopedRefStatus } from "@/lib/company-access";
import { AppBar } from "@/components/AppBar";
import {
  DISTRIBUTION_OPTIONS,
  type PlannerTask,
} from "@/lib/planner-model";
import {
  aggregateSpans,
  capacityClients,
  computeResourceLoads,
  dayOverloadWarning,
  formatCapacityHours,
  isOverloaded,
  matchesResourceFilter,
  overloadWarning,
  reportAssignmentCount,
  reportUtilisation,
  selectCapacityProjects,
  unavailableWarning,
  type CapacityPeriod,
  type ResourceCapacityReport,
} from "@/lib/capacity-engine";
import {
  PARTIAL_WEEK,
  isCurrentPeriod,
  isIsoDate,
  periodLabel,
  periodRows,
  periodWindow,
  shiftPeriod,
  weekRangeLabel,
  type CapacityView,
} from "@/lib/capacity-period";
import { isoDate } from "@/lib/scheduling-engine";
import { buildCapacityWorkbook, capacityExportFileName } from "@/lib/capacity-export";
import { downloadCapacityWorkbook } from "@/lib/capacity-workbook";

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
  DISTRIBUTION_OPTIONS.find((option) => option.value === value)?.label ?? "Evenly spread";

export default function Capacity() {
  const navigate = useNavigate();
  const { system, resources, assignments, projects, projectTasks, planVersions, openTask, setActiveProject } = useCalendarStore();
  // The planner's overload indicators deep-link here: a resource (warning icon)
  // or a project (context-bar chip), with the week to open.
  const [searchParams] = useSearchParams();
  const focusWeek = searchParams.get("week") ?? "";
  const today = useMemo(() => isoDate(new Date()), []);
  // Week and Month are two levels of detail of the same thing, so one reference
  // date drives both: the week or the month containing it. Switching the view
  // keeps that date, and the period buttons only move it — the selected resource
  // and every filter live outside this state and therefore survive the switch.
  const [view, setView] = useState<CapacityView>("week");
  const [reference, setReference] = useState(() => (isIsoDate(focusWeek) ? focusWeek : isoDate(new Date())));
  const [selectedId, setSelectedId] = useState("");
  // A deep link only ever carries an id of this company's own records. Anything
  // else — a stranger's id, a record that has since been deleted — is dropped on
  // arrival, so it cannot filter the screen and is never echoed back as a label.
  const [filterResource, setFilterResource] = useState(() => {
    const requested = searchParams.get("resource") ?? "";
    return resources.some((resource) => resource.id === requested) ? requested : "";
  });
  const [filterProject, setFilterProject] = useState(() => {
    const requested = searchParams.get("project") ?? "";
    return projects.some((project) => project.id === requested && (project.kind ?? (project.status === "template" ? "template" : "project")) === "project") ? requested : "";
  });
  const [filterClient, setFilterClient] = useState("");
  const [exporting, setExporting] = useState(false);

  // The shown period and its rows: seven days for a week, one row per
  // Monday–Sunday week for a month (the first and last clipped to the month).
  const periodRange = useMemo(() => periodWindow(view, reference), [view, reference]);
  const rows = useMemo(() => periodRows(view, reference), [view, reference]);
  const selectedPeriodLabel = periodLabel(view, reference);

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
  // The window is the shown period, so every total below — the table, the person
  // list, the header figures and the overload count — is a sum over those days.
  const reports = useMemo(() => computeResourceLoads({
    system,
    resources: resources.map((resource) => ({ id: resource.id, name: resource.name, hoursPerWeek: resource.hoursPerWeek, calendarId: resource.calendarId })),
    assignments,
    projects: filteredProjects.map((project) => ({ projectId: project.id, projectName: project.name, projectCalendarId: project.calendarId, tasks: projectTasks(project.id) })),
    range: periodRange,
  }), [system, resources, assignments, filteredProjects, projectTasks, periodRange]);

  const visibleReports = reports.filter((report) => matchesResourceFilter(report.resourceId, { resourceId: filterResource }));

  // The clients of every project the export could mention, for the "By project" sheet.
  const clientByProject = useMemo(() => {
    const map = new Map<string, string | undefined>();
    for (const project of selectableProjects) map.set(project.id, project.client);
    return map;
  }, [selectableProjects]);

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
    () => new Map(visibleReports.map((report) => [report.resourceId, aggregateSpans(report, rows)])),
    [visibleReports, rows],
  );

  // One entry per row that holds at least one overloaded day — in a week view
  // those rows are the days themselves, in a month view the weeks. A week whose
  // own total stays under 100% still appears as soon as one of its days does not,
  // so "no overload" can never be said while a day inside the period is over.
  const overloads = useMemo(
    () => visibleReports.flatMap((report) => (periodsByResource.get(report.resourceId) ?? [])
      .filter((period) => period.overloadedDays > 0)
      .map((period) => ({
        resourceId: report.resourceId,
        key: period.key,
        days: period.overloadedDays,
        warning: overloadWarning(report.resourceName, period) ?? "",
      }))),
    [visibleReports, periodsByResource],
  );
  const overloadedDays = overloads.reduce((total, entry) => total + entry.days, 0);

  const selected = visibleReports.find((report) => report.resourceId === selectedId) ?? visibleReports[0];
  const selectedPeriods = selected ? periodsByResource.get(selected.resourceId) ?? [] : [];
  const selectedAssignments = selected ? assignmentsByResource.get(selected.resourceId) ?? [] : [];
  const activeFilters = [
    filterResource && resources.some((resource) => resource.id === filterResource) ? { label: `Resource: ${resources.find((resource) => resource.id === filterResource)?.name ?? ""}`, clear: () => setFilterResource("") } : null,
    filterProject && selectableProjects.some((project) => project.id === filterProject) ? { label: `Project: ${selectableProjects.find((project) => project.id === filterProject)?.name ?? ""}`, clear: () => setFilterProject("") } : null,
    filterClient ? { label: `Client: ${filterClient}`, clear: () => setFilterClient("") } : null,
  ].filter((value): value is { label: string; clear: () => void } => value !== null);

  // A deep link may carry an id of another company. Resolution is against this
  // company's own ids only, and an id that is not ours is answered with one
  // generic sentence — never with the identifier it carried.
  const deepLinkUnavailable = [
    scopedRefStatus(searchParams.get("resource") ?? "", resources.map((resource) => resource.id)),
    scopedRefStatus(searchParams.get("project") ?? "", projects.map((project) => project.id)),
  ].includes("unavailable");

  const stepPeriod = (amount: number) => setReference((current) => shiftPeriod(view, current, amount));
  // The picker opens the week (or the month) containing the chosen date; picking
  // a month keeps the reference date inside it.
  const pickDate = (value: string) => {
    const candidate = view === "month" ? `${value}-01` : value;
    if (isIsoDate(candidate)) setReference(candidate);
  };

  /**
   * Downloads exactly what is on screen as a real .xlsx workbook: the same filtered
   * people, the same rows of the same selected period, and the same figures the
   * tables show. It only reads them, so exporting can never change a plan, a date
   * or an assignment.
   */
  const exportToExcel = async () => {
    const exportDate = isoDate(new Date());
    const fileName = capacityExportFileName(view, exportDate);
    setExporting(true);
    try {
      const sheets = buildCapacityWorkbook({
        exportDate,
        granularity: view,
        periodLabel: selectedPeriodLabel,
        reports: visibleReports,
        periodsFor: (resourceId) => periodsByResource.get(resourceId) ?? [],
        clients: clientByProject,
        filters: {
          resource: filterResource ? resources.find((resource) => resource.id === filterResource)?.name ?? "" : "",
          project: filterProject ? selectableProjects.find((project) => project.id === filterProject)?.name ?? "" : "",
          client: filterClient,
        },
      });
      await downloadCapacityWorkbook(fileName, sheets);
      toast.success(`Exported ${fileName}`);
    } catch (error) {
      toast.error(error instanceof Error ? `Export failed: ${error.message}` : "Export failed. Please try again.");
    } finally {
      setExporting(false);
    }
  };

  const openAssignment = (row: AssignmentRow) => {
    if (!row.versionId) return;
    openTask(row.projectId, row.versionId, row.taskId);
    navigate("/dashboard");
  };
  // A project name anywhere on this screen opens the project in the Planner,
  // exactly like picking it in the sidebar (its active version, current mode).
  // Archived or non-project rows stay visible but are not openable.
  const canOpenProject = (projectId: string) => {
    const project = projects.find((item) => item.id === projectId);
    return !!project && project.status !== "archived" && (project.kind ?? (project.status === "template" ? "template" : "project")) === "project";
  };
  const openProjectById = (projectId: string) => {
    if (!canOpenProject(projectId)) return;
    setActiveProject(projectId);
    navigate("/dashboard");
  };

  const nextLabel = view === "week" ? "Next week" : "Next month";
  const previousLabel = view === "week" ? "Previous week" : "Previous month";

  return (
    <div className="planner-shell">
      <AppBar activeKey="capacity" />

      <main className="capacity-screen">
        <div className="capacity-heading">
          <div>
            <div className="eyebrow">WORKLOAD / OVERLOAD</div>
            <h2>Who is over capacity</h2>
            <p>Every active plan version of every project, measured against each person’s own available hours. Week shows one day per row, Month one week per row. Click an assignment to open that task in its project and version.</p>
          </div>
          <div className="capacity-heading-actions">
            <button
              type="button"
              className="tool-button primary"
              onClick={() => void exportToExcel()}
              disabled={exporting}
              title={`Download the ${view} shown below as an Excel workbook (.xlsx)`}
            >
              {exporting ? <Loader2 size={15} className="animate-spin" /> : <FileSpreadsheet size={15} />}
              {exporting ? "Exporting…" : "Export to Excel"}
            </button>
            <div className="capacity-toggle" role="group" aria-label="Aggregation period">
              <CalendarRange size={15} />
              {(["week", "month"] as const).map((value) => (
                <button key={value} className={view === value ? "active" : ""} onClick={() => setView(value)}>{value === "week" ? "Week" : "Month"}</button>
              ))}
            </div>
            <div className="capacity-period" role="group" aria-label="Selected period">
              <button type="button" className="capacity-period-nav" aria-label={previousLabel} title={previousLabel} onClick={() => stepPeriod(-1)}><ChevronLeft size={14} /></button>
              <span className="capacity-period-label" title={selectedPeriodLabel}>{selectedPeriodLabel}</span>
              <input
                type={view === "week" ? "date" : "month"}
                className="capacity-period-picker"
                aria-label={view === "week" ? "Open the week containing a date" : "Open the month to show"}
                title={view === "week" ? "Open the week containing a date" : "Open the month to show"}
                value={view === "week" ? reference : reference.slice(0, 7)}
                onChange={(event) => pickDate(event.target.value)}
              />
              <button type="button" className="capacity-period-nav" aria-label={nextLabel} title={nextLabel} onClick={() => stepPeriod(1)}><ChevronRight size={14} /></button>
              <button
                type="button"
                className="capacity-period-today"
                onClick={() => setReference(today)}
                disabled={isCurrentPeriod(view, reference, today)}
                title={view === "week" ? "Show the current week" : "Show the current month"}
              >{view === "week" ? "This week" : "This month"}</button>
            </div>
          </div>
        </div>

        {deepLinkUnavailable && <p className="scope-notice" role="status">{UNAVAILABLE_NOTICE}</p>}

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
                <div className="capacity-banner-head">
                  <AlertTriangle size={18} />
                  <b>{overloadedDays} overloaded {overloadedDays === 1 ? "day" : "days"} in this {view}</b>
                </div>
                <ul>
                  {overloads.map((item, index) => (
                    <li key={`${item.resourceId}-${item.key}-${index}`}>
                      <button type="button" className="capacity-banner-link" onClick={() => setSelectedId(item.resourceId)}>{item.warning}</button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              <section className="capacity-ok card-surface"><CheckCircle2 size={17} /> No overload: every day in this {view} stays within the available hours.</section>
            )}

            <div className="capacity-layout">
              <aside className="capacity-list card-surface">
                <div className="capacity-list-head">
                  <span>{visibleReports.length} people</span>
                  <span className="muted">{overloadedDays ? `${overloadedDays} overloaded ${overloadedDays === 1 ? "day" : "days"}` : "all within capacity"}</span>
                </div>
                {visibleReports.map((report) => {
                  const utilisation = reportUtilisation(report);
                  const rowsForPerson = assignmentsByResource.get(report.resourceId) ?? [];
                  return (
                    <button key={report.resourceId} className={`capacity-person ${report.resourceId === selected?.resourceId ? "current" : ""}`} onClick={() => setSelectedId(report.resourceId)}>
                      <span className="capacity-person-avatar" style={{ background: resources.find((resource) => resource.id === report.resourceId)?.colour ?? "#9a8e78" }}>{report.resourceName.slice(0, 1).toUpperCase()}</span>
                      <span className="capacity-person-copy">
                        <b>{report.resourceName}</b>
                        <small title={`${rowsForPerson.length} assignment${rowsForPerson.length === 1 ? "" : "s"} in the current filter, ${reportAssignmentCount(report)} with hours in this ${view}`}>
                          {reportAssignmentCount(report)} assignment{reportAssignmentCount(report) === 1 ? "" : "s"} · {formatCapacityHours(report.totalAllocated)} h
                        </small>
                      </span>
                      <span className="capacity-person-meta">
                        {utilisation === null ? "—" : `${Math.round(utilisation * 100)}%`}
                        {report.overloadedDays > 0 && (
                          <em className="capacity-person-badge" title={`${report.overloadedDays} overloaded day${report.overloadedDays === 1 ? "" : "s"} in this ${view}`}>
                            <AlertTriangle size={11} /> {report.overloadedDays}
                          </em>
                        )}
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
                    view={view}
                    periodLabelText={selectedPeriodLabel}
                    canOpenProject={canOpenProject}
                    onOpenProject={openProjectById}
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

function ResourceDetail({ report, periods, assignments, view, periodLabelText, canOpenProject, onOpenProject, onOpenAssignment }: {
  report: ResourceCapacityReport;
  periods: CapacityPeriod[];
  assignments: AssignmentRow[];
  view: CapacityView;
  periodLabelText: string;
  canOpenProject: (projectId: string) => boolean;
  onOpenProject: (projectId: string) => void;
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
  const unavailable = useMemo(() => new Set(report.unavailableTasks.map((task) => task.taskId)), [report.unavailableTasks]);
  return (
    <div className="capacity-detail-body">
      <div className="capacity-detail-head">
        <div>
          <div className="eyebrow">RESOURCE</div>
          <h3>{report.resourceName}</h3>
          <p className="capacity-detail-period">Selected period: {periodLabelText}</p>
        </div>
        <div className="capacity-totals">
          <span><small>Available</small><b>{formatCapacityHours(report.totalAvailable)} h</b></span>
          <span><small>Allocated</small><b>{formatCapacityHours(report.totalAllocated)} h</b></span>
          <span><small>Overloaded days</small><b>{report.overloadedDays}</b></span>
        </div>
      </div>

      {report.unavailableTasks.length > 0 && (
        <div className="capacity-unavailable" role="alert">
          <b><AlertTriangle size={14} /> Not available</b>
          <ul>
            {report.unavailableTasks.map((task) => (
              <li key={`${task.projectId}-${task.taskId}`}>
                {unavailableWarning(report.resourceName, task.work)}
                <span className="muted"> — {task.projectName} · {task.taskName}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="capacity-table-wrap">
        <table className="capacity-table">
          <thead><tr><th>Period</th><th>Available</th><th>Allocated</th><th>Remaining</th><th>Utilisation</th></tr></thead>
          <tbody>
            {periods.length === 0 && <tr><td colSpan={5} className="muted">No days in this {view}.</td></tr>}
            {periods.map((period) => (
              <PeriodRows key={period.key} period={period} resourceName={report.resourceName} canOpenProject={canOpenProject} onOpenProject={onOpenProject} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="capacity-assignments">
        <b>Assignments</b>
        <p className="muted">Every assignment in the current filter. The table above counts only the hours that fall inside the selected period.</p>
        {assignments.length === 0 ? (
          <p className="muted">No assignments in the current filter — this person is shown with zero utilisation.</p>
        ) : (
          <div className="capacity-table-wrap">
            <table className="capacity-table capacity-assignment-table">
              <thead><tr><th>Task</th><th>Project</th><th>Start</th><th>Finish</th><th>Work</th><th>Distribution</th><th /></tr></thead>
              <tbody>
                {assignments.map((row) => (
                  <tr key={`${row.projectId}-${row.taskId}`} className="capacity-assignment-row" onClick={() => onOpenAssignment(row)}>
                    <td><b>{row.taskName}</b>{unavailable.has(row.taskId) && <span className="capacity-row-warning" title={unavailableWarning(report.resourceName, row.work)}><AlertTriangle size={12} /></span>}</td>
                    <td>
                      <button
                        type="button"
                        className="capacity-project-link"
                        aria-label={`Open project ${row.projectName}`}
                        title={canOpenProject(row.projectId) ? `Open project ${row.projectName}` : "The project is archived"}
                        disabled={!canOpenProject(row.projectId)}
                        onClick={(event) => { event.stopPropagation(); onOpenProject(row.projectId); }}
                      >{row.projectName}</button>
                    </td>
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

function PeriodRows({ period, resourceName, canOpenProject, onOpenProject }: { period: CapacityPeriod; resourceName: string; canOpenProject: (projectId: string) => boolean; onOpenProject: (projectId: string) => void }) {
  const warning = overloadWarning(resourceName, period);
  const percent = period.utilisation === null ? null : Math.round(period.utilisation * 100);
  // A row can be under its own total and still hold a day over capacity — a week
  // clipped to a month, or one heavy day in a light week. Those days are named.
  const overloadedDayWarnings = useMemo(
    () => period.overload ? [] : period.days
      .filter((day) => isOverloaded(day.allocated, day.available))
      .map((day) => ({ date: day.date, text: dayOverloadWarning(resourceName, day) ?? "" })),
    [period, resourceName],
  );
  const rowState = period.overload ? "overload" : period.overloadedDays > 0 ? "has-overload-days" : period.available === 0 && period.allocated === 0 ? "idle" : "";
  return (
    <>
      <tr data-capacity-week={period.key} className={`capacity-row ${rowState}`}>
        <td>
          <b>{period.label}</b>
          {period.partial && <span className="capacity-partial-chip" title={`This row is not a whole week: only ${weekRangeLabel(period.start, period.end)} falls inside the selected month, and only those days are counted.`}>{PARTIAL_WEEK}</span>}
        </td>
        <td>{formatCapacityHours(period.available)} h</td>
        <td>{formatCapacityHours(period.allocated)} h</td>
        <td className={period.remaining < 0 ? "negative" : ""}>{formatCapacityHours(period.remaining)} h</td>
        <td>
          <div className="capacity-util"><span className={`capacity-util-fill ${period.overload ? "over" : ""}`} style={{ width: `${Math.min(100, percent ?? 0)}%` }} /></div>
          <span className="capacity-util-label">
            {period.overloadedDays > 0 && <AlertTriangle size={13} />}
            {percent === null ? "—" : `${percent}%`}
          </span>
        </td>
      </tr>
      {(period.allocated > 0 || warning) && (
        <tr className={`capacity-row-detail ${period.overload ? "overload" : ""}`}>
          <td colSpan={5}>
            {period.overload && warning && <p className="capacity-warning" role="alert"><AlertTriangle size={13} /> {warning}</p>}
            {overloadedDayWarnings.length > 0 && (
              <ul className="capacity-day-list" role="alert">
                {overloadedDayWarnings.slice(0, 3).map((day) => <li key={day.date}><AlertTriangle size={12} /> {day.text}</li>)}
                {overloadedDayWarnings.length > 3 && <li>+ {overloadedDayWarnings.length - 3} more overloaded days in this week</li>}
              </ul>
            )}
            {period.breakdown.length > 0 && (
              <div className="capacity-breakdown">
                <span className="muted">Breakdown:</span>
                {period.breakdown.map((row) => (
                  <button
                    key={row.projectId}
                    type="button"
                    className="capacity-chip"
                    aria-label={`Open project ${row.projectName}`}
                    title={canOpenProject(row.projectId) ? `Open project ${row.projectName}` : "The project is archived"}
                    disabled={!canOpenProject(row.projectId)}
                    onClick={() => onOpenProject(row.projectId)}
                  >{row.projectName} · {formatCapacityHours(row.allocated)} h</button>
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
