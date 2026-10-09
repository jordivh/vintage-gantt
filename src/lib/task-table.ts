import { pruneDeadPredecessors, type PlannerTask } from "./planner-model";

/** Linear descendant walk shared by insertion and deletion. */
export function taskSubtreeIds(tasks: Pick<PlannerTask, "id" | "parentId">[], roots: string[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const task of tasks) if (task.parentId) {
    const list = children.get(task.parentId) ?? [];
    list.push(task.id);
    children.set(task.parentId, list);
  }
  const ids = new Set<string>();
  const pending = [...roots];
  for (let i = 0; i < pending.length; i++) {
    const id = pending[i];
    if (ids.has(id)) continue;
    ids.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  return ids;
}

export function insertTaskBelow(tasks: PlannerTask[], clickedId: string, fresh: PlannerTask): PlannerTask[] {
  const clicked = tasks.find((task) => task.id === clickedId);
  if (!clicked) return tasks;
  const subtree = taskSubtreeIds(tasks, [clickedId]);
  const index = tasks.reduce((last, task, i) => subtree.has(task.id) ? i + 1 : last, 0);
  return [...tasks.slice(0, index), { ...fresh, parentId: clicked.parentId, versionId: clicked.versionId }, ...tasks.slice(index)];
}

export function removeTaskSubtrees(tasks: PlannerTask[], roots: string[]) {
  const ids = taskSubtreeIds(tasks, roots);
  const removed = tasks.filter(task => ids.has(task.id));
  const survivors = pruneDeadPredecessors(tasks.filter(task => !ids.has(task.id))).tasks;
  // Scheduling is only needed if a surviving link changed or a summary lost a child.
  const original = new Map(tasks.map(task => [task.id, task]));
  const parents = new Set(removed.map(task => task.parentId).filter(Boolean));
  const needsScheduling = survivors.some(task => parents.has(task.id) || task.predecessors !== original.get(task.id)?.predecessors);
  return { ids, removed, survivors, needsScheduling };
}

/** Restore deleted rows in their original order without dropping later edits/new rows. */
export function restoreDeletedTasks(before: PlannerTask[], optimistic: PlannerTask[], current: PlannerTask[]): PlannerTask[] {
  const remaining = new Map(current.map(task => [task.id, task]));
  const cleaned = new Map(optimistic.map(task => [task.id, task]));
  const restored: PlannerTask[] = [];
  for (const task of before) {
    const live = remaining.get(task.id);
    if (!cleaned.has(task.id)) {
      restored.push(live ?? task);
    } else if (live) {
      const predecessorUnchanged = live.predecessors === cleaned.get(task.id)?.predecessors;
      restored.push(predecessorUnchanged ? { ...live, predecessors: task.predecessors } : live);
    }
    remaining.delete(task.id);
  }
  restored.push(...remaining.values());
  return restored;
}

/** Equal vertical offsets, clamped to a shared range; never copy horizontal offsets. */
export function syncVerticalScroll(source: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">, target: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">) {
  const top = Math.max(0, Math.min(source.scrollTop, source.scrollHeight - source.clientHeight, target.scrollHeight - target.clientHeight));
  if (source.scrollTop !== top) source.scrollTop = top;
  if (target.scrollTop !== top) target.scrollTop = top;
}

export const MIN_COLUMN_WIDTH = 48;
export const columnWidth = (value: number) => Math.max(MIN_COLUMN_WIDTH, Math.round(value));
const widthKey = (userId: string) => `vintage-gantt-column-widths:${userId}`;
type WidthStorage = Pick<Storage, "getItem" | "setItem">;

export function readColumnWidths(storage: WidthStorage, userId: string): Record<string, number> {
  if (!userId) return {};
  try {
    const saved = JSON.parse(storage.getItem(widthKey(userId)) ?? "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])).map(([key, value]) => [key, columnWidth(value)]));
  } catch { return {}; }
}

export function writeColumnWidths(storage: WidthStorage, userId: string, widths: Record<string, number>) {
  if (!userId) return;
  try { storage.setItem(widthKey(userId), JSON.stringify(widths)); } catch { /* Optional view preference, not workspace data. */ }
}
