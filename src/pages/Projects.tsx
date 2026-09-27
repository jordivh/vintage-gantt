import { useState } from "react";
import { Archive, Copy, Eye, EyeOff, FolderOpen, LogOut, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { useCalendarStore, type ProjectRecord } from "@/lib/calendar-store";
import type { PlanningDirection } from "@/lib/scheduling-engine";

const formatDate = (value: string) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${value}T12:00:00`));
const today = new Date().toISOString().slice(0, 10);

type TemplateCreateResult = { id: string; skippedAssignments: number };

export default function Projects() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { projects, system, projectTasks, activeProjectId, setActiveProject, createProjectFromTemplate, saveAsTemplate, planVersions, renameProject, setProjectClient, archiveProject, deleteProject, setTemplateHidden, deleteTemplate } = useCalendarStore();
  const [showNew, setShowNew] = useState(() => searchParams.get("new") === "1");
  const [newProject, setNewProject] = useState({ name: "", startDate: today, schedulingDirection: "forward" as PlanningDirection, calendarId: system.defaultCalendarId, templateId: "" });
  const [rename, setRename] = useState<{ id: string; value: string; client: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectRecord | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "archived" | "template">("all");
  const [saving, setSaving] = useState(false);
  const [includeAssignments, setIncludeAssignments] = useState(false);

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
  const openProject = (project: ProjectRecord) => { if (project.status === "archived" || isTemplate(project)) return; setActiveProject(project.id); navigate("/dashboard"); };
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

  const renderProjectRows = (rows: ProjectRecord[], templateSection = false) => rows.map((project) => <tr key={project.id} className={project.id === activeProjectId ? "current-project" : ""} onDoubleClick={() => openProject(project)}><td><span className="project-folder">{templateSection ? <Sparkles size={15} /> : <FolderOpen size={15} />}</span><b>{project.name}</b>{project.isBuiltin && <span className="project-status template">Built-in</span>}</td><td><span className={`project-status ${project.status}`}>{project.hidden ? "hidden" : project.status}</span></td><td>{formatDate(project.startDate)}</td><td>{finishFor(project.id)}</td><td>{tasksFor(project.id).length || "—"}</td><td>{system.calendars.find((calendar) => calendar.id === project.calendarId)?.name ?? "Base calendar"}</td><td>{project.schedulingDirection === "forward" ? "Forward" : "Backward"}</td><td>{project.client || "—"}</td><td>{formatDate(project.updatedAt.slice(0, 10))}</td><td><div className="project-actions">{templateSection ? <><button title="Rename template" onClick={() => setRename({ id: project.id, value: project.name, client: project.client ?? "" })}><Pencil size={14} /></button><button title={project.hidden ? "Show this template before using it" : "Create project from template"} disabled={project.hidden} onClick={() => { setIncludeAssignments(false); setNewProject({ name: `${project.name} copy`, startDate: today, schedulingDirection: "forward", calendarId: project.calendarId, templateId: project.id }); setShowNew(true); }}><Copy size={14} /></button><button title={project.hidden ? "Show template" : "Hide template"} onClick={async () => { try { await setTemplateHidden(project.id, !project.hidden); toast.success(project.hidden ? "Template shown" : "Template hidden"); } catch { toast.error("Could not update template visibility."); } }}>{project.hidden ? <Eye size={14} /> : <EyeOff size={14} />}</button>{!project.isBuiltin && <button title="Delete template" onClick={() => setDeleteTarget(project)} className="danger"><Trash2 size={14} /></button>}</> : <><button title="Open" onClick={() => openProject(project)}><FolderOpen size={14} /></button><button title="Rename" onClick={() => setRename({ id: project.id, value: project.name, client: project.client ?? "" })}><Pencil size={14} /></button><button title="Save as template" onClick={() => { const name = window.prompt("Template name", `${project.name} template`); const version = planVersions.find((item) => item.projectId === project.id && item.isActive) ?? planVersions.find((item) => item.projectId === project.id); if (name?.trim() && version) void saveAsTemplate(project.id, version.id, name.trim()).then(() => toast.success("Template saved")).catch((error) => toast.error(error instanceof Error ? error.message : "Could not save template.")); }}><Sparkles size={14} /></button>{project.status !== "archived" && <button title="Archive" onClick={() => { archiveProject(project.id); toast.success("Project archived"); }}><Archive size={14} /></button>}<button title="Delete" onClick={() => setDeleteTarget(project)} className="danger"><Trash2 size={14} /></button></>}</div></td></tr>);

  return <div className="planner-shell">
    <header className="planner-topbar"><div className="brand-lockup"><div className="brand-mark">⌁</div><div><div className="eyebrow">PROJECT CATALOG / WORKSPACE</div><h1>Projects</h1></div></div><nav className="topnav"><button className="tool-button" onClick={() => navigate("/dashboard")}>Planner</button><button className="tool-button primary" onClick={() => navigate("/projects")}>Projects</button><button className="tool-button" onClick={() => navigate("/calendars")}>Calendars</button><button className="tool-button" onClick={() => navigate("/resources")}>Resources</button></nav><div className="top-actions"><button className="avatar" title={user?.name ?? "Account"}>{user?.name?.slice(0, 1) ?? "M"}</button><button className="icon-button" title="Sign out" onClick={() => { signOut(); navigate("/"); }}><LogOut size={17} /></button></div></header>
    <main className="projects-screen"><div className="projects-heading"><div><div className="eyebrow">PROJECT CATALOG</div><h2>Everything your team is planning</h2><p>Open a project to work in its own grid, timeline, calendar and undo history.</p></div><button className="tool-button primary" onClick={() => { setIncludeAssignments(false); setNewProject({ ...newProject, templateId: "" }); setShowNew(true); }}><Plus size={16} /> New project</button></div>
      <div className="projects-toolbar"><div className="project-filters">{(["all", "active", "archived", "template"] as const).map((filter) => <button key={filter} className={statusFilter === filter ? "active" : ""} onClick={() => setStatusFilter(filter)}>{filter === "all" ? "All projects" : filter === "template" ? "Templates" : filter}</button>)}</div><span className="muted">{visibleCount} item{visibleCount === 1 ? "" : "s"}</span></div>
      <section className="project-catalog-card"><table className="project-table"><thead><tr><th>Project</th><th>Status</th><th>Start date</th><th>Calculated finish</th><th>Tasks</th><th>Calendar</th><th>Direction</th><th>Client</th><th>Last modified</th><th /></tr></thead><tbody>
        {statusFilter !== "template" && <><tr className="catalog-section"><td colSpan={10}>Active projects</td></tr>{renderProjectRows(visibleProjects.filter((project) => project.status === "active"))}<tr className="catalog-section"><td colSpan={10}>Archived projects</td></tr>{renderProjectRows(visibleProjects.filter((project) => project.status === "archived"))}</>}
        {(statusFilter === "all" || statusFilter === "template") && <><tr className="catalog-section"><td colSpan={10}>Templates</td></tr>{renderProjectRows(visibleTemplates, true)}{!visibleTemplates.length && <tr><td colSpan={10} className="muted">No templates yet. Save a project as a template to reuse its structure.</td></tr>}</>}
      </tbody></table></section>
    </main>
    {showNew && <div className="modal-backdrop" onClick={() => setShowNew(false)}><div className="task-modal project-modal" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><div className="eyebrow">NEW PROJECT</div><h2>Create a project</h2></div><button className="icon-button" onClick={() => setShowNew(false)}><X size={18} /></button></div><div className="modal-grid"><label>Project name<input autoFocus value={newProject.name} onChange={(event) => setNewProject({ ...newProject, name: event.target.value })} /></label><label>Start date<input type="date" value={newProject.startDate} onChange={(event) => setNewProject({ ...newProject, startDate: event.target.value })} /></label><label>Template<select value={newProject.templateId} onChange={(event) => { const selected = templates.find((template) => template.id === event.target.value); if (!event.target.value) setIncludeAssignments(false); setNewProject({ ...newProject, templateId: event.target.value, ...(selected ? { calendarId: selected.calendarId } : {}) }); }}><option value="">Empty project</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}{template.isBuiltin ? " · built-in" : ""}</option>)}</select></label><label>Planning direction<select value={newProject.schedulingDirection} onChange={(event) => setNewProject({ ...newProject, schedulingDirection: event.target.value as PlanningDirection })}><option value="forward">Forward planning</option><option value="backward">Backward planning</option></select></label><label>Calendar<select disabled={Boolean(newProject.templateId)} value={newProject.calendarId} onChange={(event) => setNewProject({ ...newProject, calendarId: event.target.value })}>{system.calendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}</select></label>{newProject.templateId && <label className="template-assignment-option"><input type="checkbox" checked={includeAssignments} onChange={(event) => setIncludeAssignments(event.target.checked)} /> Retain resource assignments where resources exist</label>}</div><div className="modal-actions"><button className="tool-button" onClick={() => setShowNew(false)}>Cancel</button><button className="tool-button primary" disabled={saving} onClick={() => void handleCreate()}>{saving ? "Creating…" : "Create project"}</button></div></div></div>}
    {rename && <div className="modal-backdrop" onClick={() => setRename(null)}><div className="task-modal project-modal" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><div className="eyebrow">PROJECT SETTINGS</div><h2>Project details</h2></div><button className="icon-button" onClick={() => setRename(null)}><X size={18} /></button></div><label className="project-settings-field">Project name<input className="project-rename-input" value={rename.value} onChange={(event) => setRename({ ...rename, value: event.target.value })} /></label><label className="project-settings-field">Client<input className="project-rename-input" value={rename.client} onChange={(event) => setRename({ ...rename, client: event.target.value })} placeholder="e.g. Acme NV" /></label><div className="modal-actions"><button className="tool-button" onClick={() => setRename(null)}>Cancel</button><button className="tool-button primary" onClick={() => { renameProject(rename.id, rename.value); setProjectClient(rename.id, rename.client); setRename(null); }}>Save changes</button></div></div></div>}
    {deleteTarget && <div className="modal-backdrop" onClick={() => setDeleteTarget(null)}><div className="task-modal project-modal" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><div className="eyebrow">{isTemplate(deleteTarget) ? "DELETE TEMPLATE" : "DELETE PROJECT"}</div><h2>{deleteTarget.name}</h2></div><button className="icon-button" onClick={() => setDeleteTarget(null)}><X size={18} /></button></div><p className="calendar-copy">This permanently removes <b>{tasksFor(deleteTarget.id).length}</b> task{tasksFor(deleteTarget.id).length === 1 ? "" : "s"} from this {isTemplate(deleteTarget) ? "template" : "project"}. Existing calendars and employees are not affected.</p><div className="modal-actions"><button className="tool-button" onClick={() => setDeleteTarget(null)}>Cancel</button><button className="tool-button danger" onClick={async () => { try { if (isTemplate(deleteTarget)) await deleteTemplate(deleteTarget.id); else { const result = deleteProject(deleteTarget.id); if (!result.ok) throw new Error("You must keep at least one project."); } toast.success(isTemplate(deleteTarget) ? "Template deleted" : "Project deleted"); } catch (error) { toast.error(error instanceof Error ? error.message : "Could not delete."); } setDeleteTarget(null); }}>Delete</button></div></div></div>}
  </div>;
}
