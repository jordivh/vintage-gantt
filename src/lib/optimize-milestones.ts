/**
 * The "Fixed date" milestones the user chose in the optimization settings dialog,
 * remembered per project.
 *
 * The selection is a view preference, not part of the plan: it belongs to the
 * browser and never to the workspace, so switching projects or reloading the page
 * cannot change a plan, and a colleague never inherits someone else's checkbox.
 * It is kept as one JSON object keyed by project id, so "the last selection per
 * project" is remembered for every project at once.
 *
 * The store is injectable so the behaviour can be tested without a browser, and
 * a browser without a working storage (private mode, disabled cookies) is simply
 * treated as "nothing remembered yet" instead of breaking the dialog.
 */

import type { PlannerTask } from "./planner-model";

export const FIXED_MILESTONES_STORAGE_KEY = "vintage-gantt.optimize-fixed-milestones";

/** One row of the settings dialog: a milestone of the open project and its box. */
export interface MilestoneChoice {
  taskId: string;
  name: string;
  /** The milestone's current date, shown next to its name. */
  date: string;
  /** Whether "Fixed date" is ticked — remembered from the last run for this project. */
  fixed: boolean;
}

/**
 * The dialog's list: every milestone of the open project, in plan order, each
 * pre-ticked from the project's remembered selection. A remembered id that is no
 * longer a milestone of the project (it was deleted, or turned into a task) simply
 * has no row, and an unremembered milestone starts unticked.
 *
 * This is a pure read: opening or cancelling the dialog cannot write anything.
 */
export function fixedMilestoneChoices(
  milestones: readonly PlannerTask[],
  remembered: readonly string[],
): MilestoneChoice[] {
  const fixed = new Set(remembered);
  return milestones
    .map((milestone) => ({
      taskId: milestone.id,
      name: milestone.name,
      date: milestone.start,
      fixed: fixed.has(milestone.id),
    }))
    .sort((left, right) => left.date.localeCompare(right.date) || left.taskId.localeCompare(right.taskId));
}

export interface MilestoneSelectionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The browser's local storage, or null when there is none to write to. */
export function browserMilestoneStore(): MilestoneSelectionStore | null {
  try {
    const storage = globalThis.localStorage as MilestoneSelectionStore | undefined;
    return typeof storage?.getItem === "function" && typeof storage?.setItem === "function" ? storage : null;
  } catch {
    // Reading localStorage itself can throw when it is blocked by the browser.
    return null;
  }
}

const readAll = (store: MilestoneSelectionStore | null): Record<string, string[]> => {
  if (!store) return {};
  try {
    const raw = store.getItem(FIXED_MILESTONES_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, string[]> = {};
    for (const [projectId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) result[projectId] = value.filter((item): item is string => typeof item === "string");
    }
    return result;
  } catch {
    // Unreadable or corrupt storage means "no remembered selection".
    return {};
  }
};

/**
 * The milestones remembered as fixed for this project. A project that was never
 * optimized remembers nothing, so the dialog starts with no box ticked.
 */
export function loadFixedMilestones(
  projectId: string,
  store: MilestoneSelectionStore | null = browserMilestoneStore(),
): string[] {
  return readAll(store)[projectId] ?? [];
}

/**
 * Remembers the selection made for this project, in its own list, so another
 * project's selection is untouched.
 */
export function saveFixedMilestones(
  projectId: string,
  milestoneIds: readonly string[],
  store: MilestoneSelectionStore | null = browserMilestoneStore(),
): void {
  if (!store) return;
  try {
    const all = readAll(store);
    all[projectId] = [...milestoneIds];
    store.setItem(FIXED_MILESTONES_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // A full or blocked storage must never break the optimization itself.
  }
}
