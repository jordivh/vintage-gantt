import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, Copy, Eye, EyeOff, FolderOpen, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { useCalendarStore, type ProjectRecord } from "@/lib/calendar-store";
import { buildMarginConsumption, EMPTY_MARGIN_CONSUMPTION, type MarginConsumption } from "@/lib/margin-consumption";
import { CATALOG_GROUP_ORDER, catalogGroupStorage, readCatalogGroups, toggleCatalogGroup, writeCatalogGroups, type CatalogGroupKey } from "@/lib/catalog-groups";
import { AppBar } from "@/components/AppBar";
import type { PlanningDirection } from "@/lib/scheduling-engine";

const formatDate = (value: string) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${value}T12:00:00`));
const today = new Date().toISOString().slice(0, 10);

type TemplateCreateResult = { id: string; skippedAssignments: number };

/** Every portfolio column can be sorted; the margin column by consumed margin. */
type ProjectSortKey = "name" | "status" | "startDate" | "finish" | "tasks" | "margin" | "calendar" | "direction" | "client" | "updated";

/** One row action, shared by the hover buttons and the right-click menu. */
interface RowAction {
  key: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  run: () => void | Promise<void>;
}

interface CatalogSection {
  key: CatalogGroupKey;
  title: string;
  rows: ProjectRecord[];
  templateSection?: boolean;
  empty?: string;
}

export default function Projects() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { projects, system, projectTasks, activeProjectId, setActiveProject, createProjectFromTemplate, saveAsTemplate, planVersions, baselines, renameProject, setProjectClient, archiveProject, restoreProject, deleteProject, setTemplateHidden, deleteTemplate } = useCalendarStore();
  const [showNew, setShowNew] = useState(() => searchParams.get("new") === "1");
  const [newProject, setNewProject] = useState({ name: "", startDate: today, schedulingDirection: "forward" as PlanningDirection, calendarId: system.defaultCalendarId, templateId: "" });
  const [rename, setRename] = useState<{ id: string; value: string; client: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectRecord | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<ProjectRecord | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "archived" | "template">("all");
  const [saving, setSaving] = useState(false);
  const [includeAssignments, setIncludeAssignments] = useState(false);
  const [sort, setSort] = useState<{ key: ProjectSortKey; direction: "asc" | "desc" } | null>(null);
  const [openGroups, setOpenGroups] = useState<Record<CatalogGroupKey, boolean>>(() => readCatalogGroups(catalogGroupStorage()));
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; projectId: string } | null>(null);
  useEffect(() => {
    writeCatalogGroups(openGroups, catalogGroupStorage());
  }, [openGroups]);
  useEffect(() => {
    if (!rowMenu) return;
    const close = () => setRowMenu(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
  }, [rowMenu]);

  const isTemplate = (project: ProjectRecord) => (project.kind ?? (project.status === "template" ? "template" : "project")) === "template";
  const templates = projects.filter((project) => isTemplate(project) && !project.hidden);
  const hiddenTemplates = projects.filter((project) => isTemplate(project) && project.hidden);
  const visibleProjects = projects.filter((project) => !isTemplate(project) && (statusFilter === "all" || project.status === statusFilter));
  const visibleTemplates = statusFilter === "all" || statusFilter === "template" ? [...templates, ...hiddenTemplates] : [];
  const tasksFor = (projectId: string) => projectTasks(projectId);
  const finishFor = (projectId: string) => {
    const taskRows = tasksFor(projectId);
    if (!taskRows.length) return "—";
    return formatDate(taskRows.reduce((latest, task) => task.finish > latest ? task.finish : latest, taskRows[0].finish));
  };
  // One margin snapshot per project, from its ACTIVE version only, using the planner's own leaf-only
  // calculation. Memoised so rendering the table never re-runs the network for every row, and it only
  // reads: nothing here writes back to the planning data.
  const marginConsumptionFor = useMemo(() => {
    const map = new Map<string, MarginConsumption>();
    for (const project of projects) {
      const versionId = planVersions.find((version) => version.projectId === project.id && version.isActive)?.id;
      map.set(project.id, buildMarginConsumption({
        tasks: projectTasks(project.id),
        system,
        projectCalendarId: project.calendarId,
        hasBaseline: baselines.some((baseline) => baseline.projectId === project.id && baseline.versionId === versionId),
      }));
    }
    return map;
  }, [projects, projectTasks, planVersions, baselines, system]);
  const marginFor = (project: ProjectRecord) => marginConsumptionFor.get(project.id) ?? EMPTY_MARGIN_CONSUMPTION;
  const sortValue = (project: ProjectRecord, key: ProjectSortKey): string | number | null => {
    switch (key) {
      case "name": return project.name.toLowerCase();
      case "status": return project.status;
      case "startDate": return project.startDate;
      case "finish": {
        const taskRows = tasksFor(project.id);
        return taskRows.length ? taskRows.reduce((latest, task) => task.finish > latest ? task.finish : latest, taskRows[0].finish) : null;
      }
      case "tasks": return tasksFor(project.id).length;
      case "margin": {
        const margin = marginFor(project);
        return margin.reported ? margin.consumedPct : null;
      }
      case "calendar": return (system.calendars.find((calendar) => calendar.id === project.calendarId)?.name ?? "Base calendar").toLowerCase();
      case "direction": return project.schedulingDirection;
      case "client": return (project.client ?? "").toLowerCase();
      case "updated": return project.updatedAt;
    }
  };
  const sortedRows = (rows: ProjectRecord[]) => {
    if (!sort) return rows;
    const factor = sort.direction === "asc" ? 1 : -1;
    const key = sort.key;
    return [...rows].sort((left, right) => {
      const a = sortValue(left, key);
      const b = sortValue(right, key);
      // Rows without a value (a project with no margin, say) always sink to the bottom.
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      if (typeof a === "number" && typeof b === "number") return (a - b) * factor;
      return String(a).localeCompare(String(b)) * factor;
    });
  };
  const toggleSort = (key: ProjectSortKey) => setSort((current) => current?.key === key ? { key, direction: current.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" });
  const sortHeader = (key: ProjectSortKey, label: string) => (
    <th key={key} aria-sort={sort?.key === key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className={`project-sort${sort?.key === key ? " active" : ""}`} onClick={() => toggleSort(key)}>
        {label}
        <span className="project-sort-arrow" aria-hidden="true">{sort?.key === key ? (sort.direction === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );
  const renderMarginCell = (project: ProjectRecord) => {
    const margin = marginFor(project);
    return <span className={`project-margin ${margin.band}`} title={margin.tooltip}>{margin.label}</span>;
  };
  const openProject = (project: ProjectRecord) => { if (project.status === "archived" || isTemplate(project)) return; setActiveProject(project.id); navigate("/dashboard"); };
  const toggleGroup = (key: CatalogGroupKey) => setOpenGroups((current) => toggleCatalogGroup(current, key));

  /**
   * The actions for one row, in menu order. The same list drives the hover buttons
   * and the right-click menu, so an archived project offers "Restore to active" in
   * both places and nothing else about the row changes.
   */
  const rowActions = (project: ProjectRecord): RowAction[] => {
    if (isTemplate(project)) return [
      { key: "rename", label: "Rename template", icon: <Pencil size={14} />, run: () => setRename({ id: project.id, value: project.name, client: project.client ?? "" }) },
      { key: "use", label: project.hidden ? "Show this template before using it" : "Create project from template", icon: <Copy size={14} />, disabled: project.hidden, run: () => { setIncludeAssignments(false); setNewProject({ name: `${project.name} copy`, startDate: today, schedulingDirection: "forward", calendarId: project.calendarId, templateId: project.id }); setShowNew(true); } },
      { key: "visibility", label: project.hidden ? "Show template" : "Hide template", icon: project.hidden ? <Eye size={14} /> : <EyeOff size={14} />, run: async () => { try { await setTemplateHidden(project.id, !project.hidden); toast.success(project.hidden ? "Template shown" : "Template hidden"); } catch { toast.error("Could not update template visibility."); } } },
      ...(project.isBuiltin ? [] : [{ key: "delete", label: "Delete template", icon: <Trash2 size={14} />, danger: true, run: () => setDeleteTarget(project) }]),
    ];
    const archived = project.status === "archived";
    return [
      { key: "open", label: archived ? "Restore the project before opening it" : "Open", icon: <FolderOpen size={14} />, disabled: archived, run: () => openProject(project) },
      { key: "rename", label: "Rename", icon: <Pencil size={14} />, run: () => setRename({ id: project.id, value: project.name, client: project.client ?? "" }) },
      { key: "template", label: "Save as template", icon: <Sparkles size={14} />, run: () => { const name = window.prompt("Template name", `${project.name} template`); const version = planVersions.find((item) => item.projectId === project.id && item.isActive) ?? planVersions.find((item) => item.projectId === project.id); if (name?.trim() && version) void saveAsTemplate(project.id, version.id, name.trim()).then(() => toast.success("Template saved")).catch((error) => toast.error(error instanceof Error ? error.message : "Could not save template.")); } },
      archived
        ? { key: "restore", label: "Restore to active", icon: <ArchiveRestore size={14} />, run: () => setRestoreTarget(project) }
        : { key: "archive", label: "Archive", icon: <Archive size={14} />, run: () => { archiveProject(project.id); toast.success("Project archived"); } },
      { key: "delete", label: "Delete", icon: <Trash2 size={14} />, danger: true, run: () => setDeleteTarget(project) },
    ];
  };
  const confirmRestore = () => {
    if (!restoreTarget) return;
    // Only the status changes: tasks, versions, baselines and assignments are kept as
    // they are, so the project counts in the capacity figures again exactly as before.
    restoreProject(restoreTarget.id);
    toast.success(`${restoreTarget.name} restored to active projects`);
    setRestoreTarget(null);
  };
  const handleCreate = async () => {
    if (!newProject.name.trim()) return toast.error("Give the project a name first.");
    setSaving(true);
    try {
      const result = await createProjectFromTemplate({
        name: newProject.name,
        startDate: newProject.startDate,
        schedulingDirection: newProject.schedulingDirection,
        calendarId: newProject.calendarId,
        templateId: newProject.templateId || null,
        includeAssignments,
      }) as TemplateCreateResult;
      setShowNew(false);
      setNewProject({ ...newProject, name: "", templateId: "" });
      navigate("/dashboard");
      if (result.skippedAssignments) toast.warning(`${result.skippedAssignments} resource assignment${result.skippedAssignments === 1 ? " was" : "s were"} skipped because the resource no longer exists.`);
      else toast.success("Project created");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the project.");
    } finally {
      setSaving(false);
    }
  };
  const visibleCount = visibleProjects.length + visibleTemplates.length;
  const settingsProject = rename ? projects.find((project) => project.id === rename.id) ?? null : null;

  /** The groups shown for the current filter, in the catalog's display order. */
  const catalogSections = (): CatalogSection[] => {
    const available: Record<CatalogGroupKey, CatalogSection> = {
      active: { key: "active", title: "Active projects", rows: visibleProjects.filter((project) => project.status === "active") },
      template: { key: "template", title: "Templates", rows: visibleTemplates, templateSection: true, empty: "No templates yet. Save a project as a template to reuse its structure." },
      archived: { key: "archived", title: "Archived projects", rows: visibleProjects.filter((project) => project.status === "archived") },
    };
    const shown: Record<CatalogGroupKey, boolean> = {
      active: statusFilter === "all" || statusFilter === "active",
      template: statusFilter === "all" || statusFilter === "template",
      archived: statusFilter === "all" || statusFilter === "archived",
    };
    return CATALOG_GROUP_ORDER.filter((key) => shown[key]).map((key) => available[key]);
  };

  const renderProjectRows = (rows: ProjectRecord[], templateSection = false) => sortedRows(rows).map((project) => <tr key={project.id} className={project.id === activeProjectId ? "current-project" : ""} onDoubleClick={() => openProject(project)} onContextMenu={(event) => { event.preventDefault(); setRowMenu({ x: event.clientX, y: event.clientY, projectId: project.id }); }}><td><span className="project-folder">{templateSection ? <Sparkles size={15} /> : <FolderOpen size={15} />}</span><b>{project.name}</b>{project.isBuiltin && <span className="project-status template">Built-in</span>}</td><td><span className={`project-status ${project.status}`}>{project.hidden ? "hidden" : project.status}</span></td><td>{formatDate(project.startDate)}</td><td>{finishFor(project.id)}</td><td>{tasksFor(project.id).length || "—"}</td><td className="project-margin-cell">{renderMarginCell(project)}</td><td>{system.calendars.find((calendar) => calendar.id === project.calendarId)?.name ?? "Base calendar"}</td><td>{project.schedulingDirection === "forward" ? "Forward" : "Backward"}</td><td>{project.client || "—"}</td><td>{formatDate(project.updatedAt.slice(0, 10))}</td><td><div className="project-actions">{rowActions(project).map((action) => <button key={action.key} type="button" title={action.label} aria-label={action.label} disabled={action.disabled} className={action.danger ? "danger" : ""} onClick={(event) => { event.stopPropagation(); void action.run(); }}>{action.icon}</button>)}</div></td></tr>);

  return <div className="planner-shell" onClick={() => setRowMenu(null)}>
    <AppBar activeKey="projects" />
    <main className="projects-screen"><div className="projects-heading"><div><div className="eyebrow">PROJECT CATALOG</div><h2>Everything your team is planning</h2><p>Open a project to work in its own grid, timeline, calendar and undo history.</p></div><button className="tool-button primary" onClick={() => { setIncludeAssignments(false); setNewProject({ ...newProject, templateId: "" }); setShowNew(true); }}><Plus size={16} /> New project</button></div>
      <div className="projects-toolbar"><div className="project-filters">{(["all", "active", "archived", "template"] as const).map((filter) => <button key={filter} className={statusFilter === filter ? "active" : ""} onClick={() => setStatusFilter(filter)}>{filter === "all" ? "All projects" : filter === "template" ? "Templates" : filter}</button>)}</div><span className="muted">{visibleCount} item{visibleCount === 1 ? "" : "s"}</span></div>
      <section className="project-catalog-card"><table className="project-table"><thead><tr>{sortHeader("name", "Project")}{sortHeader("status", "Status")}{sortHeader("startDate", "Start date")}{sortHeader("finish", "Calculated finish")}{sortHeader("tasks", "Tasks")}{sortHeader("margin", "Margeverbruik")}{sortHeader("calendar", "Calendar")}{sortHeader("direction", "Direction")}{sortHeader("client", "Client")}{sortHeader("updated", "Last modified")}<th /></tr></thead><tbody>
        {catalogSections().map((section) => {
          const open = openGroups[section.key];
          return <Fragment key={section.key}>
            <tr className="catalog-section"><td colSpan={11}><button type="button" className="catalog-toggle" aria-expanded={open} onClick={() => toggleGroup(section.key)}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span>{section.title} ({section.rows.length})</span></button></td></tr>
            {open && renderProjectRows(section.rows, Boolean(section.templateSection))}
            {open && section.empty && !section.rows.length && <tr><td colSpan={11} className="muted">{section.empty}</td></tr>}
          </Fragment>;
        })}
      </tbody></table></section>
    </main>
    {showNew && <div className="modal-backdrop" onClick={() => setShowNew(false)}><div className="task-modal project-modal" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><div className="eyebrow">NEW PROJECT</div><h2>Create a project</h2></div><button className="icon-button" onClick={() => setShowNew(false)}><X size={18} /></button></div><div className="modal-grid"><label>Project name<input autoFocus value={newProject.name} onChange={(event) => setNewProject({ ...newProject, name: event.target.value })} /></label><label>Start date<input type="date" value={newProject.startDate} onChange={(event) => setNewProject({ ...newProject, startDate: event.target.value })} /></label><label>Template<select value={newProject.templateId} onChange={(event) => { const selected = templates.find((template) => template.id === event.target.value); if (!event.target.value) setIncludeAssignments(false); setNewProject({ ...newProject, templateId: event.target.value, ...(selected ? { calendarId: selected.calendarId } : {}) }); }}><option value="">Empty project</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}{template.isBuiltin ? " · built-in" : ""}</option>)}</select></label><label>Planning direction<select value={newProject.schedulingDirection} onChange={(event) => setNewProject({ ...newProject, schedulingDirection: event.target.value as PlanningDirection })}><option value="forward">Forward planning</option><option value="backward">Backward planning</option></select></label><label>Calendar<select disabled={Boolean(newProject.templateId)} value={newProject.calendarId} onChange={(event) => setNewProject({ ...newProject, calendarId: event.target.value })}>{system.calendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}</select></label>{newProject.templateId && <label className="template-assignment-option"><input type="checkbox" checked={includeAssignments} onChange={(event) => setIncludeAssignments(event.target.checked)} /> Retain resource assignments where resources exist</label>}</div><div className="modal-actions"><button className="tool-button" onClick={() => setShowNew(false)}>Cancel</button><button className="tool-button primary" disabled={saving} onClick={() => void handleCreate()}>{saving ? "Creating…" : "Create project"}</button></div></div></div>}
    {rename && <div className="modal-backdrop" onClick={() => setRename(null)}><div className="task-modal project-modal" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><div className="eyebrow">PROJECT SETTINGS</div><h2>Project details</h2></div><button className="icon-button" onClick={() => setRename(null)}><X size={18} /></button></div><label className="project-settings-field">Project name<input className="project-rename-input" value={rename.value} onChange={(event) => setRename({ ...rename, value: event.target.value })} /></label><label className="project-settings-field">Client<input className="project-rename-input" value={rename.client} onChange={(event) => setRename({ ...rename, client: event.target.value })} placeholder="e.g. Acme NV" /></label>{settingsProject?.status === "archived" && <div className="project-settings-restore"><p>This project is archived. Restoring it puts it back under <b>Active projects</b>; its workload counts again in the capacity figures and in the portfolio totals.</p><button className="tool-button" onClick={() => { setRename(null); setRestoreTarget(settingsProject); }}><ArchiveRestore size={15} /> Restore to active</button></div>}<div className="modal-actions"><button className="tool-button" onClick={() => setRename(null)}>Cancel</button><button className="tool-button primary" onClick={() => { renameProject(rename.id, rename.value); setProjectClient(rename.id, rename.client); setRename(null); }}>Save changes</button></div></div></div>}
    {restoreTarget && <div className="modal-backdrop" onClick={() => setRestoreTarget(null)}><div className="task-modal project-modal" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><div className="eyebrow">RESTORE PROJECT</div><h2>{restoreTarget.name}</h2></div><button className="icon-button" onClick={() => setRestoreTarget(null)}><X size={18} /></button></div><p className="calendar-copy">Move <b>{restoreTarget.name}</b> back to <b>Active projects</b>? Its tasks, plan versions, baselines and resource assignments are kept unchanged — but its workload will count again in the capacity figures and in the portfolio totals.</p><div className="modal-actions"><button className="tool-button" onClick={() => setRestoreTarget(null)}>Cancel</button><button className="tool-button primary" autoFocus onClick={confirmRestore}><ArchiveRestore size={15} /> Restore to active</button></div></div></div>}
    {deleteTarget && <div className="modal-backdrop" onClick={() => setDeleteTarget(null)}><div className="task-modal project-modal" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><div className="eyebrow">{isTemplate(deleteTarget) ? "DELETE TEMPLATE" : "DELETE PROJECT"}</div><h2>{deleteTarget.name}</h2></div><button className="icon-button" onClick={() => setDeleteTarget(null)}><X size={18} /></button></div><p className="calendar-copy">This permanently removes <b>{tasksFor(deleteTarget.id).length}</b> task{tasksFor(deleteTarget.id).length === 1 ? "" : "s"} from this {isTemplate(deleteTarget) ? "template" : "project"}. Existing calendars and employees are not affected.</p><div className="modal-actions"><button className="tool-button" onClick={() => setDeleteTarget(null)}>Cancel</button><button className="tool-button danger" onClick={async () => { try { if (isTemplate(deleteTarget)) await deleteTemplate(deleteTarget.id); else { const result = deleteProject(deleteTarget.id); if (!result.ok) throw new Error("You must keep at least one project."); } toast.success(isTemplate(deleteTarget) ? "Template deleted" : "Project deleted"); } catch (error) { toast.error(error instanceof Error ? error.message : "Could not delete."); } setDeleteTarget(null); }}>Delete</button></div></div></div>}
    {rowMenu && (() => {
      const project = projects.find((item) => item.id === rowMenu.projectId);
      if (!project) return null;
      return <div className="context-menu project-row-menu" style={{ left: rowMenu.x, top: rowMenu.y }} onClick={(event) => event.stopPropagation()}>
        {rowActions(project).map((action) => <button key={action.key} type="button" disabled={action.disabled} className={action.danger ? "danger" : ""} onClick={() => { setRowMenu(null); void action.run(); }}><span>{action.label}</span>{action.icon}</button>)}
      </div>;
    })()}
  </div>;
}
