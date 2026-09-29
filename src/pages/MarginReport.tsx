import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Activity, ArrowLeft, BarChart3 } from "lucide-react";
import { useCalendarStore, type BaselineTask } from "@/lib/calendar-store";
import {
  EMPTY_MARGIN_TOTALS,
  becameCriticalHeadline,
  buildMarginReport,
  type MarginReport as MarginReportData,
  type MarginReportRow,
} from "@/lib/margin-report";
import type { PlanMode } from "@/lib/planner-model";
import { UNAVAILABLE_NOTICE, scopedRefStatus } from "@/lib/company-access";
import { AppBar } from "@/components/AppBar";

/**
 * Margin report — the project's reserve consumption for one plan version.
 *
 * Totals are the sum of the LEAF tasks only (a summary row rolls its children
 * up, so counting it would double the reserve). Every value is read defensively:
 * tasks without margin, milestones, zero-duration tasks and rows whose stored
 * margin fields are missing all render as 0 d or a dash, and the calculation is
 * wrapped so a bad row can never take the page down.
 */

const formatDays = (value: number | null | undefined): string =>
  typeof value === "number" && Number.isFinite(value) ? `${value} d` : "—";

const formatPercent = (value: number | null): string =>
  typeof value === "number" && Number.isFinite(value) ? `${value}%` : "—";

const flagFor = (row: MarginReportRow): string => {
  if (row.becameCritical) return "became-critical";
  if (row.isCritical) return "critical";
  if (!row.hasMargin) return "none";
  return "available";
};

const flagLabel = (row: MarginReportRow): string => {
  if (row.becameCritical) return "became critical";
  if (row.isCritical) return "critical";
  if (!row.hasMargin) return "no margin";
  return "available";
};

export default function MarginReport() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const {
    activeProject,
    activeVersionId,
    planVersions,
    baselines,
    baselineTasks,
    system,
    tasks,
  } = useCalendarStore();
  const [showNoMargin, setShowNoMargin] = useState(false);

  const projectId = activeProject?.id ?? "";
  const version = planVersions.find((item) => item.id === activeVersionId && item.projectId === projectId)
    ?? planVersions.find((item) => item.projectId === projectId && item.isActive)
    ?? null;
  const versionId = version?.id ?? activeVersionId ?? "";
  const mode: PlanMode = version?.mode ?? "planning";
  const versionName = version?.name ?? "Plan version";

  // The planner passes the baseline it is showing; otherwise the latest capture
  // on this version decides what "had float before" means.
  const requestedBaselineId = searchParams.get("baseline") ?? "";
  // A copied link may name another company's baseline. It resolves against this
  // company's own baseline ids only; anything else gets one generic sentence.
  const baselineRefUnavailable = scopedRefStatus(requestedBaselineId, baselines.map((item) => item.id)) === "unavailable";
  const versionBaselines = baselines.filter((baseline) => baseline.projectId === projectId && baseline.versionId === versionId);
  const baseline = versionBaselines.find((item) => item.id === requestedBaselineId)
    ?? [...versionBaselines].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    ?? null;

  const [report, failure] = useMemo<[MarginReportData | null, string]>(() => {
    try {
      return [buildMarginReport({
        tasks,
        system,
        projectCalendarId: activeProject?.calendarId,
        projectId,
        versionId,
        versionName,
        mode,
        baseline: baseline
          ? {
            id: baseline.id,
            name: baseline.name,
            captureDate: baseline.captureDate,
            floats: baselineTasks.filter((snapshot: BaselineTask) => snapshot.baselineId === baseline.id),
          }
          : null,
      }), ""];
    } catch (cause) {
      return [null, cause instanceof Error ? cause.message : "The margin data could not be read."];
    }
  }, [tasks, system, activeProject?.calendarId, projectId, versionId, versionName, mode, baseline, baselineTasks]);

  const allRows = report?.rows ?? [];
  const totals = report?.totals ?? EMPTY_MARGIN_TOTALS;
  const rows = showNoMargin ? allRows : allRows.filter((row) => row.hasMargin);
  const hiddenNoMargin = allRows.length - rows.length;

  return <div className="planner-shell">
    <AppBar activeKey="planner" label="Margin report" />
    <main className="projects-screen">
      <button className="link-button" onClick={() => navigate("/dashboard")}><ArrowLeft size={14} /> Back to planner</button>
      <div className="projects-heading">
        <div>
          <div className="eyebrow">MARGIN REPORT</div>
          <h2>{activeProject?.name ?? "No project selected"}</h2>
          <p>{versionName} · {baseline ? `float compared with ${baseline.name}${baseline.captureDate ? ` (${baseline.captureDate})` : ""}` : "no baseline captured on this version"}</p>
        </div>
        <div className="margin-report-meta">
          <span className={`mode-badge ${mode}`} title={mode === "monitoring" ? "This version tracks reality against its baseline." : "This version is still being planned."}>{mode === "monitoring" ? "Monitoring" : "Planning"}</span>
          <BarChart3 size={28} />
        </div>
      </div>

      {baselineRefUnavailable && <p className="scope-notice" role="status">{UNAVAILABLE_NOTICE}</p>}

      {!report ? (
        <p className="margin-report-note danger"><b>The report could not be read.</b> {failure || "The margin data could not be read."} The rest of the planner still works — try Recalculate on the plan, or open a different plan version.</p>
      ) : <>
        {mode === "planning" && (
          <p className="margin-report-note"><b>This version is in Planning mode.</b> Reserve is only consumed while tracking reality, so every figure below reads 0 d consumed. Set a baseline and switch the version to Monitoring to make this report meaningful.</p>
        )}

        <section className={`critical-headline${report.becameCriticalCount ? " alert" : ""}`}>
          <Activity size={18} />
          <div>
            <strong>{becameCriticalHeadline(report.becameCriticalCount)}</strong>
            <small>
              {report.criticalCount} of {report.rows.length} leaf tasks {report.rows.length === 1 ? "is" : "are"} on the critical path now.
              {baseline
                ? " A task is flagged when it had float in the baseline and has none left."
                : " Capture a baseline to tell newly critical tasks apart from tasks that were always critical."}
            </small>
          </div>
        </section>

        <section className="project-catalog-card margin-summary">
          <div><b>Planned margin</b><strong>{formatDays(totals.planned)}</strong></div>
          <div><b>Consumed</b><strong>{formatDays(totals.consumed)}</strong></div>
          <div><b>Remaining</b><strong>{formatDays(totals.remaining)}</strong></div>
          <div><b>Consumed</b><strong>{formatPercent(totals.consumedPct)}</strong></div>
        </section>
        <p className="margin-report-totals-note">
          Leaf tasks only. A summary row rolls its children's reserve up, so counting it would double the total — these figures are exactly the sum of the task rows below.
        </p>

        <div className="margin-report-toolbar">
          <div>
            <div className="eyebrow">PER-TASK CONSUMPTION</div>
            <p>{rows.length} of {allRows.length} leaf tasks shown, highest consumption first.</p>
          </div>
          <label className="margin-report-toggle">
            <input type="checkbox" checked={showNoMargin} onChange={(event) => setShowNoMargin(event.target.checked)} />
            Show tasks without margin{!showNoMargin && hiddenNoMargin ? ` (${hiddenNoMargin})` : ""}
          </label>
        </div>

        <section className="project-catalog-card">
          <table className="project-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Task</th>
                <th>Planned</th>
                <th>Consumed</th>
                <th>Remaining</th>
                <th>Consumed %</th>
                <th>Float</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.displayId}</td>
                  <td><b>{row.name}</b></td>
                  <td>{formatDays(row.planned)}</td>
                  <td>
                    <div className="margin-report-bar"><span style={{ width: `${row.consumedPct ?? 0}%` }} /></div>
                    {formatDays(row.consumed)}
                  </td>
                  <td>{formatDays(row.remaining)}</td>
                  <td>{formatPercent(row.consumedPct)}</td>
                  <td title={row.baselineFloat === null ? "No baseline float for this task" : `Baseline float: ${row.baselineFloat} d`}>{formatDays(row.totalFloat)}</td>
                  <td><span className={`margin-flag ${flagFor(row)}`}>{flagLabel(row)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && (
            <p className="calendar-copy">
              {allRows.length
                ? "No leaf task in this version carries a planned margin. Tick “Show tasks without margin” to list them."
                : "No task margins have been planned in this version yet. Set a margin percentage on a task, or use Replan to size reserves for the whole plan."}
            </p>
          )}
        </section>
      </>}
    </main>
  </div>;
}
