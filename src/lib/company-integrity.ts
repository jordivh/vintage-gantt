/* --------------------------------------------------------------------------
 * Company isolation — the relation rules.
 *
 * Every company-owned record is stamped with the company of the account that
 * wrote it, and every read goes through that company's index, so one company can
 * never see another's rows. Relations are the remaining surface: they are plain
 * id strings, and an id only means something inside the company that owns it. A
 * relation that cannot be resolved inside its own company can therefore only
 * ever name another company's record, which is exactly what must never be
 * stored.
 *
 * Two halves, both pure so the client, the Convex backend and the tests share
 * one definition:
 *
 *   - `outsideCompanyReferences` — the gate. It answers "does this workspace
 *     refer to anything outside itself?", and the backend refuses to store a
 *     payload that does.
 *   - `normalizeWorkspaceRelations` — the repair at the client's save boundary.
 *     It drops link rows whose target no longer exists (an unreadable row is an
 *     inert row) and detaches a calendar from a parent that is gone, so an
 *     honest save is always relationally closed.
 *
 * References that legitimately outlive their target — a baseline snapshot whose
 * task has since been deleted, a plan version whose project was removed, a
 * worker's calendar after that calendar was deleted — are listed separately as
 * historical: they carry no access and are never a way into another company,
 * because a reader only ever resolves them inside the signed-in company.
 * ------------------------------------------------------------------------ */

/** A stored record only has to carry its own id to take part in a relation. */
export interface RelationRow {
  id?: unknown;
}

/** Relations are read by name, so one accessor keeps the rules declarative. */
const field = (row: RelationRow, name: string): unknown => (row as Record<string, unknown>)[name];

export interface WorkspaceRelationRows {
  projects?: readonly RelationRow[];
  tasks?: readonly RelationRow[];
  dependencies?: readonly RelationRow[];
  calendars?: readonly RelationRow[];
  exceptions?: readonly RelationRow[];
  resources?: readonly RelationRow[];
  assignments?: readonly RelationRow[];
  planVersions?: readonly RelationRow[];
  baselines?: readonly RelationRow[];
  baselineTasks?: readonly RelationRow[];
}

export type RelationTable = keyof WorkspaceRelationRows;

interface RelationRule {
  table: RelationTable;
  field: string;
  target: RelationTable;
  /** How a target that is not set is written. */
  missing: "empty" | "null" | "absent";
}

/**
 * Relations that must always resolve inside the company. The app itself never
 * writes one broken (deleting a project, a task, a calendar or a version takes
 * the rows that point at it along, and the client repairs the rest at the save
 * boundary), so a payload that breaks one did not come from the app.
 */
const STRICT_RULES: readonly RelationRule[] = [
  { table: "tasks", field: "projectId", target: "projects", missing: "empty" },
  { table: "planVersions", field: "projectId", target: "projects", missing: "empty" },
  { table: "baselines", field: "projectId", target: "projects", missing: "empty" },
  { table: "dependencies", field: "projectId", target: "projects", missing: "empty" },
  { table: "dependencies", field: "predecessorId", target: "tasks", missing: "empty" },
  { table: "dependencies", field: "successorId", target: "tasks", missing: "empty" },
  { table: "assignments", field: "taskId", target: "tasks", missing: "empty" },
  { table: "assignments", field: "resourceId", target: "resources", missing: "empty" },
  { table: "exceptions", field: "calendarId", target: "calendars", missing: "empty" },
  { table: "baselineTasks", field: "baselineId", target: "baselines", missing: "empty" },
  { table: "calendars", field: "parentCalendarId", target: "calendars", missing: "null" },
];

/**
 * Relations a record is allowed to outlive. None of them is a way in: a
 * historical reference is only ever followed inside the signed-in company.
 */
const HISTORICAL_RULES: readonly RelationRule[] = [
  { table: "tasks", field: "parentId", target: "tasks", missing: "null" },
  { table: "tasks", field: "versionId", target: "planVersions", missing: "absent" },
  { table: "baselines", field: "versionId", target: "planVersions", missing: "absent" },
  { table: "baselineTasks", field: "taskId", target: "tasks", missing: "absent" },
  { table: "resources", field: "calendarId", target: "calendars", missing: "empty" },
];

export interface ReferenceViolation {
  table: RelationTable;
  field: string;
  target: RelationTable;
  targetId: string;
  kind: "outside-company" | "historical";
}

export interface ReferenceCount {
  table: RelationTable;
  field: string;
  target: RelationTable;
  count: number;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** The ids a set of rows offers as relation targets, per table. */
export function relationIndex(rows: WorkspaceRelationRows): Record<RelationTable, Set<string>> {
  const index = {
    projects: new Set<string>(),
    tasks: new Set<string>(),
    dependencies: new Set<string>(),
    calendars: new Set<string>(),
    exceptions: new Set<string>(),
    resources: new Set<string>(),
    assignments: new Set<string>(),
    planVersions: new Set<string>(),
    baselines: new Set<string>(),
    baselineTasks: new Set<string>(),
  } satisfies Record<RelationTable, Set<string>>;
  for (const table of Object.keys(index) as RelationTable[]) {
    for (const row of rows[table] ?? []) {
      const id = text(row.id);
      if (id) index[table].add(id);
    }
  }
  return index;
}

/** True when the reference is optional and simply not set. */
function isUnset(rule: RelationRule, raw: unknown): boolean {
  if (raw === undefined) return true;
  if (raw === null) return rule.missing === "null" || rule.missing === "absent";
  if (raw === "") return rule.missing !== "null";
  return false;
}

function collect(
  rows: WorkspaceRelationRows,
  rules: readonly RelationRule[],
  kind: ReferenceViolation["kind"],
): ReferenceViolation[] {
  const index = relationIndex(rows);
  const violations: ReferenceViolation[] = [];
  for (const rule of rules) {
    for (const row of rows[rule.table] ?? []) {
      const raw = field(row, rule.field);
      if (isUnset(rule, raw)) continue;
      const targetId = text(raw);
      if (!targetId || index[rule.target].has(targetId)) continue;
      violations.push({ table: rule.table, field: rule.field, target: rule.target, targetId, kind });
    }
  }
  return violations;
}

/**
 * Relations that point outside the workspace. Every one of them can only ever
 * name a record the company does not own (the only other rows in the database
 * belong to other companies), which is why the write path refuses them instead
 * of storing them.
 */
export function outsideCompanyReferences(rows: WorkspaceRelationRows): ReferenceViolation[] {
  return collect(rows, STRICT_RULES, "outside-company");
}

/** References to records this workspace used to have. Allowed, never a way in. */
export function historicalReferences(rows: WorkspaceRelationRows): ReferenceViolation[] {
  return collect(rows, HISTORICAL_RULES, "historical");
}

/** Violations grouped per table and field, for a report that carries no ids. */
export function referenceCounts(violations: readonly ReferenceViolation[]): ReferenceCount[] {
  const grouped = new Map<string, ReferenceCount>();
  for (const violation of violations) {
    const key = `${violation.table}.${violation.field}`;
    const entry = grouped.get(key);
    if (entry) entry.count += 1;
    else grouped.set(key, { table: violation.table, field: violation.field, target: violation.target, count: 1 });
  }
  return [...grouped.values()].sort(
    (a, b) => a.table.localeCompare(b.table) || a.field.localeCompare(b.field),
  );
}

/** Readable lines that name no record, only what kind of reference was refused. */
export function describeReferences(violations: readonly ReferenceViolation[]): string[] {
  return referenceCounts(violations).map(
    (entry) => `${entry.count} ${entry.table}.${entry.field} reference(s) do not belong to this company`,
  );
}

export interface NormalizedRelations<Rows extends WorkspaceRelationRows> {
  rows: Rows;
  /** Link rows removed because they pointed at something this workspace no longer has. */
  dropped: ReferenceCount[];
}

/**
 * Repairs a workspace so that every strict relation resolves inside it. The
 * client runs this at the save boundary: a link row whose target is gone can
 * never be read, so keeping it only risks naming another company's record.
 *
 * Only relations that carry no plan data are dropped (an assignment row, a
 * dependency row, a calendar exception, a pointer to a deleted project or
 * version). Dates, durations, work, margins and percentages are never touched.
 */
export function normalizeWorkspaceRelations<Rows extends WorkspaceRelationRows>(
  rows: Rows,
): NormalizedRelations<Rows> {
  const index = relationIndex(rows);
  const dropped: ReferenceViolation[] = [];
  const note = (table: RelationTable, field: string, target: RelationTable, targetId: string) =>
    dropped.push({ table, field, target, targetId, kind: "outside-company" });

  /** Does one strict reference of a row resolve inside this workspace? */
  const resolvable = (table: RelationTable, field: string, target: RelationTable, raw: unknown): boolean => {
    const rule = STRICT_RULES.find((candidate) => candidate.table === table && candidate.field === field);
    if (rule && isUnset(rule, raw)) return true;
    const targetId = text(raw);
    if (targetId && index[target].has(targetId)) return true;
    note(table, field, target, targetId);
    return false;
  };

  /** The same, against a set rebuilt after an earlier filter. */
  const inSet = (ids: Set<string>, raw: unknown, table: RelationTable, field: string, target: RelationTable): boolean => {
    const targetId = text(raw);
    if (targetId && ids.has(targetId)) return true;
    note(table, field, target, targetId);
    return false;
  };

  // Tasks first: a task is unreadable without its project, and the rest of the
  // workspace resolves against the tasks, versions and baselines that survive.
  const tasks = (rows.tasks ?? []).filter((row) => resolvable("tasks", "projectId", "projects", field(row, "projectId")));
  const taskIds = new Set(tasks.map((row) => text(row.id)).filter(Boolean));
  const planVersions = (rows.planVersions ?? []).filter((row) => resolvable("planVersions", "projectId", "projects", field(row, "projectId")));
  const baselines = (rows.baselines ?? []).filter((row) => resolvable("baselines", "projectId", "projects", field(row, "projectId")));
  const baselineIds = new Set(baselines.map((row) => text(row.id)).filter(Boolean));

  const calendars = (rows.calendars ?? []).map((row) => {
    const parentId = text(field(row, "parentCalendarId"));
    // A calendar that lost its parent simply falls back to its own week.
    if (!parentId || index.calendars.has(parentId)) return row;
    note("calendars", "parentCalendarId", "calendars", parentId);
    return { ...row, parentCalendarId: null };
  });

  const dependencies = (rows.dependencies ?? []).filter(
    (row) =>
      resolvable("dependencies", "projectId", "projects", field(row, "projectId")) &&
      inSet(taskIds, field(row, "predecessorId"), "dependencies", "predecessorId", "tasks") &&
      inSet(taskIds, field(row, "successorId"), "dependencies", "successorId", "tasks"),
  );
  const assignments = (rows.assignments ?? []).filter(
    (row) =>
      inSet(taskIds, field(row, "taskId"), "assignments", "taskId", "tasks") &&
      inSet(index.resources, field(row, "resourceId"), "assignments", "resourceId", "resources"),
  );
  const exceptions = (rows.exceptions ?? []).filter((row) =>
    resolvable("exceptions", "calendarId", "calendars", field(row, "calendarId")),
  );
  const baselineTasks = (rows.baselineTasks ?? []).filter((row) =>
    inSet(baselineIds, field(row, "baselineId"), "baselineTasks", "baselineId", "baselines"),
  );

  return {
    rows: { ...rows, tasks, calendars, dependencies, assignments, exceptions, planVersions, baselines, baselineTasks },
    dropped: referenceCounts(dropped),
  };
}

/**
 * The company-facing reading of a workspace: how many records of each kind it
 * holds, and whether anything in it points outside. Basis of the isolation
 * audit, the automated check that no company names another's data.
 */
export interface WorkspaceIsolationReport {
  projects: number;
  tasks: number;
  dependencies: number;
  calendars: number;
  exceptions: number;
  resources: number;
  assignments: number;
  planVersions: number;
  baselines: number;
  baselineTasks: number;
  /** References that can only name another company's row. Must stay empty. */
  outsideCompany: ReferenceCount[];
  /** References to records this workspace used to have. */
  historical: ReferenceCount[];
}

export function workspaceIsolationReport(rows: WorkspaceRelationRows): WorkspaceIsolationReport {
  return {
    projects: (rows.projects ?? []).length,
    tasks: (rows.tasks ?? []).length,
    dependencies: (rows.dependencies ?? []).length,
    calendars: (rows.calendars ?? []).length,
    exceptions: (rows.exceptions ?? []).length,
    resources: (rows.resources ?? []).length,
    assignments: (rows.assignments ?? []).length,
    planVersions: (rows.planVersions ?? []).length,
    baselines: (rows.baselines ?? []).length,
    baselineTasks: (rows.baselineTasks ?? []).length,
    outsideCompany: referenceCounts(outsideCompanyReferences(rows)),
    historical: referenceCounts(historicalReferences(rows)),
  };
}
