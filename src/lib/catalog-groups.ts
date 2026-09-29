/* --------------------------------------------------------------------------
 * Project catalog groups
 *
 * The three groups the projects overview shows (active projects, templates,
 * archived projects) and the collapsed/expanded state each one is remembered in.
 * Kept out of the screen so the rules stay testable: the display order, the
 * first-use defaults, and the fact that a partial or unreadable stored value
 * falls back per group instead of hiding a group by accident.
 * ------------------------------------------------------------------------ */

export type CatalogGroupKey = "active" | "template" | "archived";

/** Display order: active projects, then templates, then the archive. */
export const CATALOG_GROUP_ORDER: CatalogGroupKey[] = ["active", "template", "archived"];

/** Active projects and Templates open, the archive folded away, on first use. */
export const CATALOG_GROUP_DEFAULTS: Record<CatalogGroupKey, boolean> = { active: true, template: true, archived: false };

export const CATALOG_GROUP_STORAGE_KEY = "vintage-gantt-project-groups";

export interface GroupStorage {
  getItem: (key: string) => string | null;
  setItem?: (key: string, value: string) => void;
}

/** The browser's `localStorage`, or null when it is unavailable (e.g. no window). */
export function catalogGroupStorage(): GroupStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The remembered state per group; every unreadable or missing entry keeps its default. */
export function readCatalogGroups(storage?: GroupStorage | null): Record<CatalogGroupKey, boolean> {
  const fallback = { ...CATALOG_GROUP_DEFAULTS };
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(CATALOG_GROUP_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return fallback;
    const saved = parsed as Partial<Record<CatalogGroupKey, unknown>>;
    const next = { ...fallback };
    for (const key of CATALOG_GROUP_ORDER) {
      if (typeof saved[key] === "boolean") next[key] = saved[key];
    }
    return next;
  } catch {
    return fallback;
  }
}

/** Persists the state, so a refresh and a later session keep the catalog as it was. */
export function writeCatalogGroups(groups: Record<CatalogGroupKey, boolean>, storage?: GroupStorage | null): void {
  if (typeof storage?.setItem !== "function") return;
  try {
    storage.setItem(CATALOG_GROUP_STORAGE_KEY, JSON.stringify(groups));
  } catch {
    /* the preference is optional */
  }
}

/** The state after folding or unfolding one group; the others are untouched. */
export function toggleCatalogGroup(groups: Record<CatalogGroupKey, boolean>, key: CatalogGroupKey): Record<CatalogGroupKey, boolean> {
  return { ...groups, [key]: !groups[key] };
}
