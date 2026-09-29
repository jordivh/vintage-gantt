import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  canManageMembers,
  COMPANY_ACTIVE,
  COMPANY_ADMIN,
  COMPANY_SCOPED_TABLES,
  COMPANY_USER,
  defaultCompanyName,
  memberAttachDecision,
  migrationSummaryLines,
  normalizeCompanyRole,
  planningTotals,
  planningTotalsDifferences,
  roleChangeDecision,
  rowsNeedingCompany,
  workspaceCounts,
  workspaceCountDifferences,
  type CompanyMigrationReport,
  type CompanyOwnedRow,
  type CompanyRole,
  type CompanyScopedTable,
  type WorkspaceSnapshot,
} from "../lib/company-scope";
import { companyRoleValidator } from "./schema";

/**
 * Company-based access.
 *
 * Everything in this app belongs to exactly one company. The company is always
 * derived from the signed-in account — a company id sent by the browser is never
 * accepted as proof of access — and every read and write path in `planner.ts`
 * goes through the helpers here.
 *
 * Convex has no row-level security, so the enforced layers are: the company link
 * stored on every record (`companyId`), the `by_company` indices every query
 * must go through, the session-derived company in these helpers, and the fact
 * that every mutation is transactional — a failed write changes nothing.
 */

export interface ViewerScope {
  userId: Id<"users">;
  /** null for an account that still has to be migrated; reads then fall back to its own rows. */
  companyId: Id<"companies"> | null;
  role: CompanyRole;
}

const currentAccount = async (ctx: QueryCtx | MutationCtx): Promise<Doc<"users"> | null> => {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  const user = await ctx.db.get(userId);
  return user ?? null;
};

/**
 * Who the caller is, resolved from the session only. Never takes an argument.
 */
export const viewerScope = async (ctx: QueryCtx | MutationCtx): Promise<ViewerScope | null> => {
  const user = await currentAccount(ctx);
  if (!user) return null;
  return { userId: user._id, companyId: user.companyId ?? null, role: normalizeCompanyRole(user.companyRole) };
};

const activeCompany = async (ctx: QueryCtx | MutationCtx, companyId: Id<"companies">) => {
  const company = await ctx.db.get(companyId);
  return company && company.status === COMPANY_ACTIVE ? company : null;
};

/** A readable, active company or null. Reads never create anything. */
export const readableCompanyId = async (ctx: QueryCtx | MutationCtx): Promise<Id<"companies"> | null> => {
  const scope = await viewerScope(ctx);
  if (!scope?.companyId) return null;
  const company = await activeCompany(ctx, scope.companyId);
  return company ? company._id : null;
};

/* ------------------------------------------------------------ record access */

type AnyCtx = QueryCtx | MutationCtx;

/** Rows of one table that belong to a company, through the company index. */
export const companyRows = async (
  ctx: AnyCtx,
  table: CompanyScopedTable,
  companyId: Id<"companies">,
): Promise<CompanyOwnedRow[]> =>
  (await (ctx.db as any)
    .query(table)
    .withIndex("by_company", (q: any) => q.eq("companyId", companyId))
    .collect()) as CompanyOwnedRow[];

/** Removes every row of a company-owned table (used by the whole-workspace save). */
export const deleteCompanyRows = async (
  ctx: MutationCtx,
  table: CompanyScopedTable,
  companyId: Id<"companies">,
): Promise<number> => {
  const rows = await companyRows(ctx, table, companyId);
  for (const row of rows) await ctx.db.delete(row._id as any);
  return rows.length;
};

/**
 * The index that starts with `ownerId` for each table. Not every table has a
 * plain `by_owner`: tasks, versions and baselines are indexed per project and
 * snapshots per baseline, so their owner prefix is the first column of those.
 */
const OWNER_INDEX: Record<CompanyScopedTable, string> = {
  projects: "by_owner",
  tasks: "by_owner_project",
  dependencies: "by_owner",
  calendars: "by_owner",
  calendarExceptions: "by_owner",
  resources: "by_owner",
  taskAssignments: "by_owner",
  planVersions: "by_owner_project",
  baselines: "by_owner_project",
  baselineTasks: "by_owner_baseline",
  seedRuns: "by_owner_seed",
};

/** Rows of one table written by a single account, before it had a company. */
export const rowsByOwner = async (
  ctx: AnyCtx,
  table: CompanyScopedTable,
  userId: Id<"users">,
): Promise<CompanyOwnedRow[]> =>
  (await (ctx.db as any)
    .query(table)
    .withIndex(OWNER_INDEX[table], (q: any) => q.eq("ownerId", userId))
    .collect()) as CompanyOwnedRow[];

/** The same rows, typed per table so callers keep the schema's types. */
export const companyTable = async <K extends CompanyScopedTable>(
  ctx: AnyCtx,
  table: K,
  companyId: Id<"companies">,
): Promise<Doc<K>[]> => (await companyRows(ctx, table, companyId)) as unknown as Doc<K>[];

export const snapshotByCompany = async (ctx: AnyCtx, companyId: Id<"companies">): Promise<WorkspaceSnapshot> => {
  const entries = await Promise.all(
    COMPANY_SCOPED_TABLES.map(async (table) => [table, await companyRows(ctx, table, companyId)] as const),
  );
  return Object.fromEntries(entries) as WorkspaceSnapshot;
};

export const snapshotByOwner = async (ctx: AnyCtx, userId: Id<"users">): Promise<WorkspaceSnapshot> => {
  const entries = await Promise.all(
    COMPANY_SCOPED_TABLES.map(async (table) => [table, await rowsByOwner(ctx, table, userId)] as const),
  );
  return Object.fromEntries(entries) as WorkspaceSnapshot;
};

/* --------------------------------------------------------------- migration */

export interface MigrationStatus {
  hasCompany: boolean;
  companyId: string | null;
  companyName: string | null;
  role: CompanyRole;
  /** Records that would receive a company link when the migration runs. */
  rowsToLink: number;
  rowsToLinkPerTable: Record<string, number>;
  counts: ReturnType<typeof workspaceCounts>;
  totals: ReturnType<typeof planningTotals>;
}

/** What the migration would touch, without touching anything. */
export const migrationStatus = query({
  args: {},
  handler: async (ctx): Promise<MigrationStatus | null> => {
    const user = await currentAccount(ctx);
    if (!user) return null;
    const role = normalizeCompanyRole(user.companyRole);
    if (user.companyId) {
      const company = await ctx.db.get(user.companyId);
      const snapshot = await snapshotByCompany(ctx, user.companyId);
      return {
        hasCompany: true,
        companyId: user.companyId,
        companyName: company?.name ?? null,
        role,
        rowsToLink: 0,
        rowsToLinkPerTable: {},
        counts: workspaceCounts(snapshot),
        totals: planningTotals(snapshot),
      };
    }
    const snapshot = await snapshotByOwner(ctx, user._id);
    const rowsToLinkPerTable: Record<string, number> = {};
    let rowsToLink = 0;
    for (const table of COMPANY_SCOPED_TABLES) {
      const missing = rowsNeedingCompany(snapshot[table] ?? []).length;
      if (missing) rowsToLinkPerTable[table] = missing;
      rowsToLink += missing;
    }
    return {
      hasCompany: false,
      companyId: null,
      companyName: null,
      role,
      rowsToLink,
      rowsToLinkPerTable,
      counts: workspaceCounts(snapshot),
      totals: planningTotals(snapshot),
    };
  },
});

/**
 * Read-only audit of the migration, for every account in the deployment. Internal
 * on purpose: it reports workspace sizes across companies, so only the CLI or the
 * Convex dashboard may call it.
 */
export const migrationPreview = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("users").collect();
    const accountsWithoutCompany = [];
    const accountsWithCompany = [];
    for (const account of accounts) {
      const snapshot = account.companyId
        ? await snapshotByCompany(ctx, account.companyId)
        : await snapshotByOwner(ctx, account._id);
      const rowsToLinkPerTable: Record<string, number> = {};
      let rowsToLink = 0;
      if (!account.companyId) {
        for (const table of COMPANY_SCOPED_TABLES) {
          const missing = rowsNeedingCompany(snapshot[table] ?? []).length;
          if (missing) rowsToLinkPerTable[table] = missing;
          rowsToLink += missing;
        }
      }
      const entry = {
        userId: account._id as string,
        email: account.email ?? null,
        name: account.name ?? null,
        isAnonymous: account.isAnonymous ?? false,
        companyId: (account.companyId as string | undefined) ?? null,
        rowsToLink,
        rowsToLinkPerTable,
        counts: workspaceCounts(snapshot),
        totals: planningTotals(snapshot),
      };
      if (account.companyId) accountsWithCompany.push(entry);
      else accountsWithoutCompany.push(entry);
    }
    const companies = await ctx.db.query("companies").collect();
    return {
      companies: companies.map((company) => ({ id: company._id as string, name: company.name, status: company.status, createdAt: company.createdAt })),
      accountsWithoutCompany,
      accountsWithCompany,
    };
  },
});

/** Links every record of an account to its company. Add-only: nothing is deleted or rewritten. */
const linkRecordsToCompany = async (ctx: MutationCtx, userId: Id<"users">, companyId: Id<"companies">) => {
  const rowsLinkedPerTable: Record<string, number> = {};
  let rowsLinked = 0;
  for (const table of COMPANY_SCOPED_TABLES) {
    const rows = rowsNeedingCompany(await rowsByOwner(ctx, table, userId));
    for (const row of rows) await ctx.db.patch(row._id as any, { companyId } as any);
    if (rows.length) rowsLinkedPerTable[table] = rows.length;
    rowsLinked += rows.length;
  }
  return { rowsLinked, rowsLinkedPerTable };
};

/**
 * The migration: gives an account its own company and links all of its existing
 * records to it. Idempotent and add-only — it writes the company link and
 * nothing else, so no date, duration, dependency, workload, margin, version,
 * baseline or capacity figure can change.
 *
 * Record counts and key planning totals are captured before and after inside the
 * same transaction. A difference aborts the mutation, which rolls back every
 * write, and reports the difference instead of deleting or recreating anything.
 */
export const provisionCompanyForUser = async (
  ctx: MutationCtx,
  user: Doc<"users">,
): Promise<CompanyMigrationReport> => {
  const now = new Date().toISOString();
  const before = await snapshotByOwner(ctx, user._id);
  const beforeCounts = workspaceCounts(before);
  const beforeTotals = planningTotals(before);
  const companyName = defaultCompanyName(user);
  const companyId = await ctx.db.insert("companies", {
    name: companyName,
    status: COMPANY_ACTIVE,
    createdAt: now,
    createdByUserId: user._id,
  });
  await ctx.db.patch(user._id, { companyId, companyRole: COMPANY_ADMIN });
  const { rowsLinked, rowsLinkedPerTable } = await linkRecordsToCompany(ctx, user._id, companyId);
  const after = await snapshotByCompany(ctx, companyId);
  const afterCounts = workspaceCounts(after);
  const afterTotals = planningTotals(after);
  const mismatch = [
    ...workspaceCountDifferences(beforeCounts, afterCounts),
    ...planningTotalsDifferences(beforeTotals, afterTotals),
  ];
  const report: CompanyMigrationReport = {
    created: true,
    companyId,
    companyName,
    role: COMPANY_ADMIN,
    rowsLinked,
    rowsLinkedPerTable,
    counts: { before: beforeCounts, after: afterCounts },
    totals: { before: beforeTotals, after: afterTotals },
    mismatch,
  };
  // Throwing rolls the whole mutation back, so a mismatch can never leave the
  // workspace half-migrated (and never rewrites or removes a record).
  if (mismatch.length) throw new Error(migrationSummaryLines(report).join(" "));
  return report;
};

/**
 * Gives the signed-in account its company (creating it once) and returns the
 * audit report. Safe to call on every sign-in.
 */
export const ensureCompany = mutation({
  args: {},
  handler: async (ctx): Promise<CompanyMigrationReport> => {
    const user = await currentAccount(ctx);
    if (!user) throw new Error("You must be signed in to access planner data.");
    if (user.companyId) {
      const company = await activeCompany(ctx, user.companyId);
      if (!company) throw new Error("This company is not active. Ask your company admin for access.");
      const snapshot = await snapshotByCompany(ctx, company._id);
      const counts = workspaceCounts(snapshot);
      const totals = planningTotals(snapshot);
      return {
        created: false,
        companyId: company._id,
        companyName: company.name,
        role: normalizeCompanyRole(user.companyRole),
        rowsLinked: 0,
        rowsLinkedPerTable: {},
        counts: { before: counts, after: counts },
        totals: { before: totals, after: totals },
        mismatch: [],
      };
    }
    return provisionCompanyForUser(ctx, user);
  },
});

/** The company behind the signed-in account, plus the account type. */
export const current = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentAccount(ctx);
    if (!user) return null;
    if (!user.companyId) return null;
    const company = await ctx.db.get(user.companyId);
    if (!company) return null;
    const role = normalizeCompanyRole(user.companyRole);
    const members = await ctx.db
      .query("users")
      .withIndex("by_company", (q) => q.eq("companyId", user.companyId as never))
      .collect();
    return {
      company: { id: company._id as string, name: company.name, status: company.status, createdAt: company.createdAt },
      role,
      canManageMembers: canManageMembers(role),
      members: members
        .map((member) => ({
          userId: member._id as string,
          name: member.name ?? "",
          email: member.email ?? "",
          role: normalizeCompanyRole(member.companyRole),
          isSelf: member._id === user._id,
        }))
        .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === COMPANY_ADMIN ? -1 : 1)),
    };
  },
});

/**
 * Applies the migration to every account that still needs a company: one company
 * per account, every existing record linked to it, with the before/after counts
 * and planning totals of each account in the returned report. Internal, so only
 * the CLI or the Convex dashboard can run it.
 *
 * The whole run is one transaction: a mismatch on any account throws, which
 * rolls every write back and reports the difference instead of rewriting data.
 */
export const migrateWorkspaces = internalMutation({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("users").collect();
    const reports = [];
    for (const account of accounts) {
      if (account.companyId) continue;
      reports.push({ userId: account._id as string, email: account.email ?? null, ...(await provisionCompanyForUser(ctx, account)) });
    }
    return {
      migrated: reports.length,
      totalRowsLinked: reports.reduce((sum, report) => sum + report.rowsLinked, 0),
      mismatch: reports.flatMap((report) => report.mismatch),
      reports,
    };
  },
});

/* ------------------------------------------------- user / invitation management */

/**
 * The identity a write must have. Mutations may create the company, so a new
 * record can never slip in without one.
 */
export const requireCompany = async (
  ctx: MutationCtx,
): Promise<{ userId: Id<"users">; companyId: Id<"companies">; role: CompanyRole }> => {
  const user = await currentAccount(ctx);
  if (!user) throw new Error("You must be signed in to access planner data.");
  if (user.companyId) {
    const company = await activeCompany(ctx, user.companyId);
    if (!company) throw new Error("This company is not active. Ask your company admin for access.");
    return { userId: user._id, companyId: company._id, role: normalizeCompanyRole(user.companyRole) };
  }
  const report = await provisionCompanyForUser(ctx, user);
  return { userId: user._id, companyId: report.companyId as Id<"companies">, role: report.role };
};

const findAccountByEmail = async (ctx: MutationCtx, email: string) => {
  const exact = await ctx.db.query("users").withIndex("email", (q) => q.eq("email", email)).first();
  if (exact) return exact;
  const accounts = await ctx.db.query("users").collect();
  return accounts.find((account) => (account.email ?? "").trim().toLowerCase() === email) ?? null;
};

/**
 * Adds an existing account to the caller's company. This is the only kind of
 * action restricted to company admins: projects, planning, resources, calendars
 * and capacity work identically for both account types.
 */
export const addMemberByEmail = mutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireCompany(ctx);
    const email = args.email.trim().toLowerCase();
    if (!email) throw new Error("Enter the email address of the account to add.");
    const target = await findAccountByEmail(ctx, email);
    if (!target) throw new Error(`No account found for ${email}.`);
    const decision = memberAttachDecision({
      actorRole: viewer.role,
      existingCompanyId: target.companyId ? (target.companyId as string) : null,
      companyId: viewer.companyId as string,
    });
    if (!decision.ok) throw new Error(decision.message ?? "Could not add this account.");
    await ctx.db.patch(target._id, { companyId: viewer.companyId, companyRole: COMPANY_USER });
    return { ok: true, userId: target._id as string };
  },
});

/** Changes an account type. A company always keeps at least one company admin. */
export const setMemberRole = mutation({
  args: { userId: v.id("users"), role: companyRoleValidator },
  handler: async (ctx, args) => {
    const viewer = await requireCompany(ctx);
    const target = await ctx.db.get(args.userId);
    if (!target || !target.companyId || (target.companyId as string) !== (viewer.companyId as string)) {
      throw new Error("That account is not part of this company.");
    }
    const members = await ctx.db
      .query("users")
      .withIndex("by_company", (q) => q.eq("companyId", viewer.companyId as never))
      .collect();
    const adminCount = members.filter((member) => normalizeCompanyRole(member.companyRole) === COMPANY_ADMIN).length;
    const decision = roleChangeDecision({
      actorUserId: viewer.userId as string,
      actorRole: viewer.role,
      targetUserId: target._id as string,
      nextRole: args.role,
      adminCount,
    });
    if (!decision.ok) throw new Error(decision.message ?? "Could not change this account type.");
    await ctx.db.patch(target._id, { companyRole: args.role });
    return { ok: true };
  },
});
