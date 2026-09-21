import { useMemo, useState } from "react";
import { Archive, Copy, FolderOpen, LogOut, Pencil, Plus, Trash2, X } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { useCalendarStore, type ProjectRecord } from "@/lib/calendar-store";
import type { PlanningDirection } from "@/lib/scheduling-engine";

const formatDate = (value: string) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${value}T12:00:00`));
const today = new Date().toISOString().slice(0, 10);

export default function Projects() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { projects, system, projectTasks, activeProjectId, setActiveProject, createProject, renameProject, duplicateProject, archiveProject, deleteProject } = useCalendarStore();
  const [showNew, setShowNew] = useState(() => searchParams.get("new") === "1");
  const [newProject, setNewProject] = useState({ name: "", startDate: today, schedulingDirection: "forward" as PlanningDirection, calendarId: system.defaultCalendarId });
  const [rename, setRename] = useState<{ id: string; value: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectRecord | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "archived" | "template">("all");

  const visibleProjects = projects.filter((project) => statusFilter === "all" || project.status === statusFilter);
  const tasksFor = (projectId: string) => projectTasks(projectId);
  const finishFor = (projectId: string) => {
    const projectTasks = tasksFor(projectId);
    if (!projectTasks.length) return "—";
    return formatDate(projectTasks.reduce((latest, task) => task.finish > latest ? task.finish : latest, projectTasks[0].finish));
  };
  const openProject = (project: ProjectRecord) => { if (project.status === "archived") return; setActiveProject(project.id); navigate("/dashboard"); };
  const handleCreate = () => {
    if (!newProject.name.trim()) return toast.error("Give the project a name first.");
    createProject(newProject);
    setShowNew(false);
    setNewProject({ ...newProject, name: "" });
    navigate("/dashboard");
  };

  return <div className="planner-shell">
    <header className="planner-topbar"><div className="brand-lockup"><div className="brand-mark">⌁</div><div><div className="eyebrow">PROJECT CATALOG / WORKSPACE</div><h1>Projects</h1></div></div><nav className="topnav"><button className="tool-button" onClick={() => navigate("/dashboard")}>Planner</button><button className="tool-button primary" onClick={() => navigate("/projects")}>Projects</button><button className="tool-button" onClick={() => navigate("/calendars")}>Calendars</button><button className="tool-button" onClick={() => navigate("/resources")}>Resources</button></nav><div className="top-actions"><button className="avatar" title={user?.name ?? "Account"}>{user?.name?.slice(0, 1) ?? "M"}</button><button className="icon-button" title="Sign out" onClick={() => { signOut(); navigate("/"); }}><LogOut size={17} /></button></div></header>
    <main className="projects-screen"><div className="projects-heading"><div><div className="eyebrow">PROJECT CATALOG</div><h2>Everything your team is planning</h2><p>Open a project to work in its own grid, timeline, calendar and undo history.</p></div><button className="tool-button primary" onClick={() => setShowNew(true)}><Plus size={16} /> New project</button></div>
      <div className="projects-toolbar"><div className="project-filters">{(["all", "active", "archived", "template"] as const).map((filter) => <button key={filter} className={statusFilter === filter ? "active" : ""} onClick={() => setStatusFilter(filter)}>{filter === "all" ? "All projects" : filter}</button>)}</div><span className="muted">{visibleProjects.length} project{visibleProjects.length === 1 ? "" : "s"}</span></div>
      <section className="project-catalog-card"><table className="project-table"><thead><tr><th>Project</th><th>Status</th><th>Start date</th><th>Calculated finish</th><th>Tasks</th><th>Calendar</th><th>Direction</th><th>Last modified</th><th /></tr></thead><tbody>{visibleProjects.map((project) => <tr key={project.id} className={project.id === activeProjectId ? "current-project" : ""} onDoubleClick={() => openProject(project)}><td><span className="project-folder"><FolderOpen size={15} /></span><b>{project.name}</b></td><td><span className={`project-status ${project.status}`}>{project.status}</span></td><td>{formatDate(project.startDate)}</td><td>{finishFor(project.id)}</td><td>{tasksFor(project.id).length || "—"}</td><td>{system.calendars.find((calendar) => calendar.id === project.calendarId)?.name ?? "—"}</td><td>{project.schedulingDirection === "forward" ? "Forward" : "Backward"}</td><td>{formatDate(project.updatedAt.slice(0, 10))}</td><td><div className="project-actions"><button title="Open" onClick={() => openProject(project)}><FolderOpen size={14} /></button><button title="Rename" onClick={() => setRename({ id: project.id, value: project.name })}><Pencil size={14} /></button><button title="Duplicate" onClick={() => { const id = duplicateProject(project.id, `${project.name} copy`); setActiveProject(id); toast.success("Project duplicated"); }}><Copy size={14} /></button>{project.status !== "archived" && <button title="Archive" onClick={() => { archiveProject(project.id); toast.success("Project archived"); }}><Archive size={14} /></button>}<button title="Delete" onClick={() => setDeleteTarget(project)} className="danger"><Trash2 size={14} /></button></div></td></tr>)}</tbody></table></section>
    </main>
    {showNew && <div className="modal-backdrop" onClick={() => setShowNew(false)}><div className="task-modal project-modal" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><div className="eyebrow">NEW PROJECT</div><h2>Create a project</h2></div><button className="icon-button" onClick={() => setShowNew(false)}><X size={18} /></button></div><div className="modal-grid"><label>Project name<input autoFocus value={newProject.name} onChange={(event) => setNewProject({ ...newProject, name: event.target.value })} /></label><label>Start date<input type="date" value={newProject.startDate} onChange={(event) => setNewProject({ ...newProject, startDate: event.target.value })} /></label><label>Planning direction<select value={newProject.schedulingDirection} onChange={(event) => setNewProject({ ...newProject, schedulingDirection: event.target.value as PlanningDirection })}><option value="forward">Forward planning</option><option value="backward">Backward planning</option></select></label><label>Calendar<select value={newProject.calendarId} onChange={(event) => setNewProject({ ...newProject, calendarId: event.target.value })}>{system.calendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}</select></label></div><div className="modal-actions"><button className="tool-button" onClick={() => setShowNew(false)}>Cancel</button><button className="tool-button primary" onClick={handleCreate}>Create project</button></div></div></div>}
    {rename && <div className="modal-backdrop" onClick={() => setRename(null)}><div className="task-modal project-modal" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><div className="eyebrow">RENAME PROJECT</div><h2>Project name</h2></div><button className="icon-button" onClick={() => setRename(null)}><X size={18} /></button></div><input className="project-rename-input" value={rename.value} onChange={(event) => setRename({ ...rename, value: event.target.value })} /><div className="modal-actions"><button className="tool-button" onClick={() => setRename(null)}>Cancel</button><button className="tool-button primary" onClick={() => { renameProject(rename.id, rename.value); setRename(null); }}>Save name</button></div></div></div>}
    {deleteTarget && <div className="modal-backdrop" onClick={() => setDeleteTarget(null)}><div className="task-modal project-modal" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><div className="eyebrow">DELETE PROJECT</div><h2>{deleteTarget.name}</h2></div><button className="icon-button" onClick={() => setDeleteTarget(null)}><X size={18} /></button></div><p className="calendar-copy">This permanently removes <b>{(tasksFor(deleteTarget.id).length)}</b> task{tasksFor(deleteTarget.id).length === 1 ? "" : "s"} from this project. Existing calendars and employees are not affected.</p><div className="modal-actions"><button className="tool-button" onClick={() => setDeleteTarget(null)}>Cancel</button><button className="tool-button danger" onClick={() => { const result = deleteProject(deleteTarget.id); if (result.ok) toast.success("Project deleted"); else toast.error("You must keep at least one project."); setDeleteTarget(null); }}>Delete project</button></div></div></div>}
  </div>;
}
