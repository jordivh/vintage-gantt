import { useMemo } from "react";
import { useNavigate } from "react-router";
import { ArrowLeft, BarChart3 } from "lucide-react";
import { useCalendarStore } from "@/lib/calendar-store";
import { withCalculatedPlanningFields } from "@/lib/planner-model";

export default function MarginReport() {
  const navigate = useNavigate();
  const { activeProject, tasks, system } = useCalendarStore();
  const rows = useMemo(() => withCalculatedPlanningFields(tasks, system, activeProject.calendarId)
    .filter((task) => (task.marginDaysOriginal ?? 0) > 0)
    .sort((a, b) => (b.marginDaysConsumed ?? 0) - (a.marginDaysConsumed ?? 0)), [tasks, system, activeProject.calendarId]);
  const totalOriginal = rows.reduce((sum, task) => sum + (task.marginDaysOriginal ?? 0), 0);
  const totalConsumed = rows.reduce((sum, task) => sum + (task.marginDaysConsumed ?? 0), 0);
  const totalRemaining = Math.max(0, totalOriginal - totalConsumed);
  const percent = totalOriginal ? Math.round((totalConsumed / totalOriginal) * 100) : 0;

  return <div className="planner-shell">
    <header className="planner-topbar">
      <div className="brand-lockup"><div className="brand-mark">⌁</div><div><div className="eyebrow">PLANNER / REPORTS</div><h1>Margin report</h1></div></div>
      <nav className="topnav"><button className="tool-button" onClick={() => navigate("/dashboard")}>Planner</button><button className="tool-button" onClick={() => navigate("/projects")}>Projects</button><button className="tool-button" onClick={() => navigate("/calendars")}>Calendars</button><button className="tool-button" onClick={() => navigate("/resources")}>Resources</button></nav>
    </header>
    <main className="projects-screen">
      <button className="link-button" onClick={() => navigate("/dashboard")}><ArrowLeft size={14} /> Back to planner</button>
      <div className="projects-heading"><div><div className="eyebrow">MARGIN REPORT</div><h2>{activeProject.name}</h2><p>Reserve consumption is separate from critical-path float.</p></div><BarChart3 size={28} /></div>
      <section className="project-catalog-card margin-summary"><div><b>Planned margin</b><strong>{totalOriginal} d</strong></div><div><b>Consumed</b><strong>{totalConsumed} d</strong></div><div><b>Remaining</b><strong>{totalRemaining} d</strong></div><div><b>Consumed</b><strong>{percent}%</strong></div></section>
      <section className="project-catalog-card"><table className="project-table"><thead><tr><th>Task</th><th>Margin</th><th>Consumed</th><th>Remaining</th><th>Status</th></tr></thead><tbody>{rows.map((task) => { const original = task.marginDaysOriginal ?? 0; const consumed = task.marginDaysConsumed ?? 0; return <tr key={task.id}><td><b>{task.name}</b></td><td>{original} d</td><td><div className="margin-report-bar"><span style={{ width: `${original ? consumed / original * 100 : 0}%` }} /></div>{consumed} d</td><td>{Math.max(0, original - consumed)} d</td><td>{task.isCritical && consumed >= original ? "Critical: margin exhausted" : task.isCritical ? "Critical" : "Available"}</td></tr>; })}</tbody></table>{!rows.length && <p className="calendar-copy">No task margins have been planned yet.</p>}</section>
    </main>
  </div>;
}
