export const workspaceTables = ["projects", "tasks", "dependencies", "calendars", "exceptions", "resources", "assignments", "planVersions", "baselines", "baselineTasks"] as const;
export type WorkspaceTable = typeof workspaceTables[number];
export type WorkspaceRow = { id: string; [key: string]: unknown };
export type Workspace = Partial<Record<WorkspaceTable, readonly WorkspaceRow[]>>;
export interface WorkspaceChange { table: WorkspaceTable; id: string; before: WorkspaceRow | null; after: WorkspaceRow | null }
export interface ReadCoverage { projectId: string; versionIds: string[]; allVersions: boolean }
export interface WorkspaceGuard { projectId: string; fingerprint: string; scope?: { versionIds: string[]; allVersions: boolean; baselineIds: string[] } }

export function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

export function workspaceChanges(before: Workspace, after: Workspace): WorkspaceChange[] {
  return workspaceTables.flatMap(table => {
    const old = new Map((before[table] ?? []).map(row => [row.id, row]));
    const next = new Map((after[table] ?? []).map(row => [row.id, row]));
    return [...new Set([...old.keys(), ...next.keys()])].flatMap(id => {
      const left = old.get(id) ?? null;
      const right = next.get(id) ?? null;
      return canonical(left) === canonical(right) ? [] : [{ table, id, before: left, after: right }];
    });
  });
}

/** Complete inputs used by this project's scheduling, margins and capacity.
 * Other projects are guarded separately when an operation actually uses them.
 */
export function projectInputs(state: Workspace, projectId: string): Workspace {
  const tasks = (state.tasks ?? []).filter(row => row.projectId === projectId);
  const taskIds = new Set(tasks.map(row => row.id));
  const baselines = (state.baselines ?? []).filter(row => row.projectId === projectId);
  const baselineIds = new Set(baselines.map(row => row.id));
  return {
    projects: (state.projects ?? []).filter(row => row.id === projectId), tasks,
    dependencies: (state.dependencies ?? []).filter(row => row.projectId === projectId),
    planVersions: (state.planVersions ?? []).filter(row => row.projectId === projectId), baselines,
    assignments: (state.assignments ?? []).filter(row => taskIds.has(row.taskId as string)),
    baselineTasks: (state.baselineTasks ?? []).filter(row => baselineIds.has(row.baselineId as string)),
    calendars: state.calendars ?? [], exceptions: state.exceptions ?? [], resources: state.resources ?? [],
  };
}

export async function fingerprint(state: Workspace): Promise<string> {
  const sorted = Object.fromEntries(workspaceTables.map(table => [table, [...(state[table] ?? [])].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)]));
  const bytes = new TextEncoder().encode(canonical(sorted));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
}

export function affectedProjects(state: Workspace, changes: readonly WorkspaceChange[]): string[] {
  const ids = new Set<string>();
  for (const change of changes) for (const row of [change.before, change.after]) {
    if (!row) continue;
    if (change.table === "projects") ids.add(row.id);
    if (typeof row.projectId === "string") ids.add(row.projectId);
    if (typeof row.taskId === "string") {
      const task = state.tasks?.find(task => task.id === row.taskId);
      if (typeof task?.projectId === "string") ids.add(task.projectId);
    }
    if (typeof row.baselineId === "string") {
      const baseline = state.baselines?.find(baseline => baseline.id === row.baselineId);
      if (typeof baseline?.projectId === "string") ids.add(baseline.projectId);
    }
    if (["calendars", "exceptions", "resources"].includes(change.table)) {
      for (const project of state.projects ?? []) ids.add(project.id);
    }
  }
  return [...ids].sort();
}

export async function changeRequest(before: Workspace, after: Workspace, coverage?: readonly ReadCoverage[]) {
  const changes = workspaceChanges(before, after);
  const guards = await Promise.all(affectedProjects(before, changes).map(async projectId => {
    const loaded = coverage?.find(item => item.projectId === projectId);
    return { projectId, fingerprint: await fingerprint(projectInputs(before, projectId)), ...(loaded ? { scope: { versionIds: loaded.versionIds, allVersions: loaded.allVersions, baselineIds: (before.baselineTasks ?? []).map(row => row.baselineId as string) } } : {}) };
  }));
  return { changes, guards };
}
