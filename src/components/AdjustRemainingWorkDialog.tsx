import { useState } from "react";
import { addWorkingDays, type CalendarSystem } from "@/lib/scheduling-engine";
import { DISTRIBUTION_OPTIONS, normalizeDistribution, type Distribution, type PlannerTask } from "@/lib/planner-model";
import {
  adjustmentDefaults,
  displayHours,
  nextWorkingDayAfter,
  previewAdjustment,
  validateAdjustment,
  type AdjustmentContext,
  type AdjustmentInput,
} from "@/lib/remaining-work";

/**
 * The “Adjust remaining work” dialog. It shows the live consequences of the
 * draft before anything is written: the hours kept fixed, the remainder and its
 * hours per day, the new total workload and its deviation from the active
 * baseline, the finish move, the margin consumed, the days pushed to successors,
 * the new project finish and any day on which the resource becomes overloaded.
 */
export interface AdjustRemainingWorkDialogProps {
  task: PlannerTask;
  tasks: PlannerTask[];
  system: CalendarSystem;
  projectCalendarId?: string;
  isAvailable?: (date: string) => boolean;
  availableHours?: (date: string) => number;
  today: string;
  baselineWork?: number;
  onCancel: () => void;
  onApply: (input: AdjustmentInput) => void;
}

const formatDate = (date: string) =>
  date ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${date}T12:00:00`)) : "—";

export function AdjustRemainingWorkDialog({
  task,
  tasks,
  system,
  projectCalendarId,
  isAvailable,
  availableHours,
  today,
  baselineWork,
  onCancel,
  onApply,
}: AdjustRemainingWorkDialogProps) {
  const context: AdjustmentContext = { system, projectCalendarId, isAvailable, availableHours, today };
  // Recomputed on every dialog render — exactly when the draft changes — so the
  // figures can never lag a keystroke behind the fields.
  const defaults = adjustmentDefaults(task, context);
  const calendarId = task.calendarId ?? projectCalendarId ?? system.defaultCalendarId;

  const [keepUntil, setKeepUntil] = useState(defaults.keepUntil);
  const [remainingWork, setRemainingWork] = useState(String(defaults.remainingWork));
  const [finishMode, setFinishMode] = useState<"date" | "duration">("date");
  const [newFinish, setNewFinish] = useState(defaults.newFinish);
  const [durationDays, setDurationDays] = useState("");
  const [distribution, setDistribution] = useState<Distribution>(defaults.distribution);
  const [reason, setReason] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);

  const remainingStart = nextWorkingDayAfter(keepUntil, calendarId, system);
  const effectiveFinish = finishMode === "duration" && durationDays && remainingStart
    ? addWorkingDays(remainingStart, Math.max(1, Math.round(Number(durationDays) || 1)) - 1, calendarId, system)
    : newFinish;

  const draft: AdjustmentInput = {
    keepUntil,
    remainingWork: Number(String(remainingWork).replace(",", ".")) || 0,
    newFinish: effectiveFinish,
    distribution,
    reason,
  };

  const validation = validateAdjustment(task, draft, context);
  const preview = previewAdjustment(tasks, task.id, draft, context, baselineWork);

  const apply = () => {
    if (validation) { setDraftError(validation); return; }
    setDraftError(null);
    onApply(draft);
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="task-modal adjust-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <div>
            <div className="eyebrow">ADJUST REMAINING WORK</div>
            <h2>{task.name}</h2>
          </div>
          <button className="icon-button" onClick={onCancel} aria-label="Close">✕</button>
        </div>

        <div className="adjust-grid">
          <label>
            Keep current plan until
            <input type="date" value={keepUntil} min={task.start} max={task.finish} onChange={(event) => setKeepUntil(event.target.value)} />
            <small>Everything up to and including this date keeps its current hours.</small>
          </label>
          <label>
            Remaining work (h)
            <input type="number" min={0} step="0.5" value={remainingWork} onChange={(event) => setRemainingWork(event.target.value)} />
            <small>The hours planned after the keep-until date.</small>
          </label>

          <fieldset className="adjust-finish">
            <legend>New finish</legend>
            <div className="adjust-finish-modes">
              <label className={`adjust-choice ${finishMode === "date" ? "active" : ""}`}>
                <input type="radio" checked={finishMode === "date"} onChange={() => setFinishMode("date")} /> Date
              </label>
              <label className={`adjust-choice ${finishMode === "duration" ? "active" : ""}`}>
                <input type="radio" checked={finishMode === "duration"} onChange={() => { setFinishMode("duration"); if (!durationDays) setDurationDays("5"); }} /> Working days
              </label>
            </div>
            {finishMode === "date"
              ? <input type="date" value={newFinish} min={keepUntil} onChange={(event) => setNewFinish(event.target.value)} />
              : <input type="number" min={1} step="1" value={durationDays} placeholder="working days" onChange={(event) => setDurationDays(event.target.value)} />}
            {finishMode === "duration" && <small>Resolves to {formatDate(effectiveFinish)}.</small>}
          </fieldset>

          <label>
            Distribution
            <select value={distribution} onChange={(event) => setDistribution(normalizeDistribution(event.target.value))}>
              {DISTRIBUTION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="adjust-reason">
            Reason
            <input type="text" value={reason} placeholder="Why is the remaining work re-planned?" onChange={(event) => setReason(event.target.value)} />
          </label>
        </div>

        {preview && (
          <div className="adjust-preview">
            <div className="eyebrow">PREVIEW</div>
            <dl>
              <div><dt>Hours kept (fixed)</dt><dd>{displayHours(preview.fixedHours)} h over {preview.fixedDays} working day{preview.fixedDays === 1 ? "" : "s"}</dd></div>
              <div><dt>Remaining work</dt><dd>{displayHours(preview.remainingHours)} h over {preview.remainingDays} working day{preview.remainingDays === 1 ? "" : "s"} (≈ {displayHours(preview.hoursPerDay)} h/day)</dd></div>
              <div><dt>Total workload</dt><dd>{displayHours(preview.newWork)} h <small>from {displayHours(preview.oldWork)} h</small>{preview.workDeviation !== null && <small className={`deviation ${preview.workDeviation >= 0 ? "later" : "earlier"}`}> · baseline {preview.workDeviation >= 0 ? "+" : ""}{displayHours(preview.workDeviation)} h</small>}</dd></div>
              <div><dt>Finish</dt><dd>{formatDate(preview.oldFinish)} → {formatDate(preview.newFinish)}</dd></div>
              <div><dt>Margin consumed</dt><dd>{preview.marginConsumed} d{preview.marginReturned > 0 ? ` (${preview.marginReturned} d returned)` : ""}</dd></div>
              <div><dt>Days pushed to successors</dt><dd>{preview.daysPushed} d</dd></div>
              <div><dt>New project finish</dt><dd>{formatDate(preview.projectFinishAfter)} <small>from {formatDate(preview.projectFinishBefore)}</small></dd></div>
            </dl>
            {preview.overloadedDays.length > 0 && (
              <div className="adjust-overload" role="alert">
                <b>Overload warning</b>
                <ul>
                  {preview.overloadedDays.slice(0, 6).map((day) => (
                    <li key={day.date}>{formatDate(day.date)}: {displayHours(day.hours)} h planned, only {displayHours(day.available)} h available.</li>
                  ))}
                </ul>
                {preview.overloadedDays.length > 6 && <small>…and {preview.overloadedDays.length - 6} more days.</small>}
              </div>
            )}
          </div>
        )}

        {(draftError || validation) && <p className="adjust-error" role="alert">{draftError ?? validation}</p>}

        <div className="modal-actions">
          <button className="tool-button" onClick={onCancel}>Cancel</button>
          <button className="tool-button primary" disabled={Boolean(validation)} title={validation ?? undefined} onClick={apply}>Apply adjustment</button>
        </div>
      </div>
    </div>
  );
}
