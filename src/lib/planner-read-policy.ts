import type { ReadCoverage } from "./workspace-changes";
export interface ReadProject { id: string; status: string; kind?: string }
export interface ReadVersion { id: string; projectId: string; isActive: boolean }
export function plannerReadPolicy(path: string, projects: ReadProject[], versions: ReadVersion[], projectId: string, versionId: string, expanded: string[] = []) {
  const planning = path === "/dashboard" || path === "/reports/margins";
  const portfolio = path === "/projects";
  const capacity = path === "/capacity";
  const calendarEdit = path === "/calendars" || path === "/resources";
  const workspace = planning || portfolio || capacity || calendarEdit;
  const requests: ReadCoverage[] = [];
  for (const project of projects) {
    const regular = (project.kind ?? (project.status === "template" ? "template" : "project")) === "project";
    const needed = calendarEdit ? regular : (planning || portfolio || capacity) && regular && (project.status !== "archived" || portfolio);
    const selected = planning && project.id === projectId;
    if (!needed && !selected && !expanded.includes(project.id)) continue;
    const active = versions.find(version => version.projectId === project.id && version.isActive)?.id;
    const versionIds = [...new Set([...(active ? [active] : []), ...(selected && versionId ? [versionId] : [])])].sort();
    requests.push({ projectId: project.id, versionIds, allVersions: calendarEdit || expanded.includes(project.id) });
  }
  return { workspace, planning, catalog: workspace, calendars: workspace, people: planning || capacity || calendarEdit, requests };
}
