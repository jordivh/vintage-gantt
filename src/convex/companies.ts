import { createAccount, getAuthUserId, invalidateSessions } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { sendTransactionalEmail } from "./email";
import { action, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { GenericActionCtx } from "convex/server";
import type { DataModel, Doc, Id } from "./_generated/dataModel";
import {
  canManageMembers,
  COMPANY_ACTIVE,
  COMPANY_ADMIN,
  COMPANY_SCOPED_TABLES,
  COMPANY_USER,
  defaultCompanyName,
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
import type { RegistrationErrorCode } from "../lib/auth-routes";
import { generateInvitationToken, hashInvitationToken } from "../lib/invitation-token";
import {
  ADMIN_ONLY_MESSAGE,
  INVITATION_ACCEPTED,
  INVITATION_PENDING,
  INVITATION_REVOKED,
  INVITATION_STATE_LABELS,
  INVITE_INVALID_EMAIL_MESSAGE,
  NOT_MEMBER_MESSAGE,
  REMOVED_ACCESS_MESSAGE,
  invitationAcceptHref,
  invitationDecision,
  invitationExpiry,
  invitationState,
  inviteDecision,
  normalizeEmail,
  removeMemberDecision,
  replaceableInvitations,
  transferAdminDecision,
  type InvitationErrorCode,
  type InvitationState,
} from "../lib/company-users";
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
  // A removed account has no access at all, to any company. Nothing it created
  // is deleted — only its access is gone.
  if (user.removedAt) return null;
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
    if (user.removedAt) throw new Error(REMOVED_ACCESS_MESSAGE);
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
    // A removed account has no company view at all.
    if (user.removedAt) return null;
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
      // A removed account is not part of the company any more.
      members: members
        .filter((member) => !member.removedAt)
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
      // A removed account is deliberately left without a company.
      if (account.companyId || account.removedAt) continue;
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
  // A removed account must never be given a fresh company: it is cut off until a
  // company admin adds it back.
  if (user.removedAt) throw new Error(REMOVED_ACCESS_MESSAGE);
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

/* ------------------------------------------------------------------ sign-up */

/** The id of the email + password provider configured in src/convex/auth.ts. */
const PASSWORD_PROVIDER_ID = "password";

/** An email address looks like an email address. */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Registration errors carry a code (never server text), so the screen can show
 * one English message per situation and the deployment's logs stay quiet about
 * what the database contains. The codes and their messages live in
 * `src/lib/auth-routes.ts`, shared with the screens.
 */
const registrationError = (code: RegistrationErrorCode) => new ConvexError({ code });

export interface RegisteredCompany {
  companyId: string;
  companyName: string;
  email: string;
  name: string;
}

/**
 * Registers a company together with its first account, in a single transaction.
 *
 * The account (user document + password account with its Scrypt hash) is created
 * through Convex Auth's own `createAccount`, which runs inside this mutation's
 * transaction. The company and the `company_admin` link are written right after.
 * Any failure — a rejected password, a rejected company name, a clash, or a
 * failed write — throws and rolls the whole transaction back, so a registration
 * either creates the company with its first company admin or creates nothing.
 *
 * An email address can never back two credential accounts: the check below runs
 * before any write and Convex Auth's `authAccounts` (provider + account id) stays
 * the single source of truth for which email is taken.
 */
export const registerCompany = mutation({
  args: {
    companyName: v.string(),
    name: v.string(),
    email: v.string(),
    password: v.string(),
  },
  handler: async (ctx, args): Promise<RegisteredCompany> => {
    const companyName = args.companyName.trim();
    const name = args.name.trim();
    const email = args.email.trim().toLowerCase();

    if (!name) throw registrationError("missing_name");
    if (!companyName) throw registrationError("missing_company");
    if (!EMAIL_PATTERN.test(email)) throw registrationError("invalid_email");
    if (args.password.length < 8) throw registrationError("weak_password");

    // One active account per email address, checked before anything is written:
    // once against the credential store Convex Auth uses, then against the
    // account table (an address that another provider already registered).
    const credential = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) =>
        q.eq("provider", PASSWORD_PROVIDER_ID).eq("providerAccountId", email),
      )
      .unique();
    if (credential) throw registrationError("email_taken");
    if (await findAccountByEmail(ctx, email)) throw registrationError("email_taken");

    // Creates the user document and its password account inside this
    // transaction; a throw below takes them back down with everything else.
    const created = await createAccount<DataModel>(
      ctx as unknown as GenericActionCtx<DataModel>,
      {
        provider: PASSWORD_PROVIDER_ID,
        account: { id: email, secret: args.password },
        profile: { email, name },
      },
    );
    const userId = created.user._id as Id<"users">;

    // The company, with this account as its first company admin.
    const companyId = await ctx.db.insert("companies", {
      name: companyName,
      status: COMPANY_ACTIVE,
      createdAt: new Date().toISOString(),
      createdByUserId: userId,
    });
    await ctx.db.patch(userId, { companyId, companyRole: COMPANY_ADMIN });

    return { companyId: companyId as string, companyName, email, name };
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

/**
 * Whether the signed-in account's access was removed. Kept apart from `current`
 * so the company view stays exactly the company's own data: a removed account
 * gets no company at all, and the store signs it out from this flag.
 */
export const access = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentAccount(ctx);
    if (!user) return null;
    return { removed: Boolean(user.removedAt) };
  },
});

/* --------------------------------------------- company users & invitations */

/** Every member of a company whose access has not been removed. */
const activeMembers = async (ctx: QueryCtx | MutationCtx, companyId: Id<"companies">) =>
  (
    await ctx.db
      .query("users")
      .withIndex("by_company", (q) => q.eq("companyId", companyId as never))
      .collect()
  ).filter((member) => !member.removedAt);

const adminCountOf = (members: Doc<"users">[]) =>
  members.filter((member) => normalizeCompanyRole(member.companyRole) === COMPANY_ADMIN).length;

/** Only a company admin manages users and invitations; every rule below is enforced here. */
const requireCompanyAdmin = async (ctx: MutationCtx) => {
  const viewer = await requireCompany(ctx);
  if (!canManageMembers(viewer.role)) throw new Error(ADMIN_ONLY_MESSAGE);
  return viewer;
};

const membershipContext = (
  viewer: { userId: Id<"users">; role: CompanyRole },
  target: Doc<"users">,
  adminCount: number,
) => ({
  actorRole: viewer.role,
  actorUserId: viewer.userId as string,
  targetUserId: target._id as string,
  targetRole: normalizeCompanyRole(target.companyRole),
  adminCount,
  targetRemoved: Boolean(target.removedAt),
});

/** The single-use code an invitation failure carries (never server text). */
const invitationError = (code: InvitationErrorCode) => new ConvexError({ code });

/**
 * Creates an invitation for the signed-in admin's company. Any earlier pending
 * invitation for the same address is revoked first, so an address has at most
 * one working link — which is also what makes a resend safe. Only the hash of
 * the value is stored; the raw value is returned once, for the link.
 */
const createCompanyInvitation = async (
  ctx: MutationCtx,
  viewer: { userId: Id<"users">; companyId: Id<"companies">; role: CompanyRole },
  rawEmail: string,
) => {
  const email = normalizeEmail(rawEmail);
  if (!EMAIL_PATTERN.test(email)) throw new Error(INVITE_INVALID_EMAIL_MESSAGE);
  const credential = await ctx.db
    .query("authAccounts")
    .withIndex("providerAndAccountId", (q) => q.eq("provider", PASSWORD_PROVIDER_ID).eq("providerAccountId", email))
    .unique();
  const accountExists = Boolean(credential) || (await findAccountByEmail(ctx, email)) !== null;
  const decision = inviteDecision({ actorRole: viewer.role, email, accountExists });
  if (!decision.ok) throw new Error(decision.message ?? ADMIN_ONLY_MESSAGE);

  const nowIso = new Date().toISOString();
  const existing = await ctx.db
    .query("invitations")
    .withIndex("by_company_email", (q) => q.eq("companyId", viewer.companyId as never).eq("email", email))
    .collect();
  for (const row of replaceableInvitations(existing, email)) {
    await ctx.db.patch(row._id, { status: INVITATION_REVOKED, revokedAt: nowIso });
  }

  const token = generateInvitationToken();
  const tokenHash = await hashInvitationToken(token);
  const expiresAt = invitationExpiry(Date.now());
  const invitationId = await ctx.db.insert("invitations", {
    companyId: viewer.companyId,
    email,
    tokenHash,
    status: INVITATION_PENDING,
    invitedByUserId: viewer.userId,
    createdAt: nowIso,
    expiresAt,
  });
  return { invitationId: invitationId as string, email, token, expiresAt };
};

/** Admin-only: invite an email address to the admin's company. */
export const inviteMember = mutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireCompanyAdmin(ctx);
    return await createCompanyInvitation(ctx, viewer, args.email);
  },
});

/** Admin-only: replace a pending invitation with a fresh link. */
export const resendInvitation = mutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireCompanyAdmin(ctx);
    return await createCompanyInvitation(ctx, viewer, args.email);
  },
});

/** Admin-only: a revoked link can never be accepted again. */
export const revokeInvitation = mutation({
  args: { invitationId: v.id("invitations") },
  handler: async (ctx, args) => {
    const viewer = await requireCompanyAdmin(ctx);
    const invitation = await ctx.db.get(args.invitationId);
    if (!invitation || (invitation.companyId as string) !== (viewer.companyId as string)) {
      throw new Error(NOT_MEMBER_MESSAGE);
    }
    if (invitation.status === INVITATION_PENDING) {
      await ctx.db.patch(invitation._id, { status: INVITATION_REVOKED, revokedAt: new Date().toISOString() });
    }
    return { ok: true };
  },
});

/** Pending invitations of the caller's company. Admin-only; nothing for regular users. */
export const pendingInvitations = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentAccount(ctx);
    if (!user || user.removedAt || !user.companyId) return null;
    if (!canManageMembers(user.companyRole)) return null;
    const now = Date.now();
    const rows = await ctx.db
      .query("invitations")
      .withIndex("by_company", (q) => q.eq("companyId", user.companyId as never))
      .collect();
    return rows
      .map((row) => {
        const state = invitationState(row, now) as InvitationState;
        return {
          id: row._id as string,
          email: row.email,
          state,
          stateLabel: INVITATION_STATE_LABELS[state],
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
        };
      })
      .filter((row) => row.state === "pending")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
});

/**
 * Admin-only: removes a regular user's access. Nothing the account created is
 * deleted — only its access is withdrawn, and its sessions are invalidated so
 * the change takes effect at once. A company always keeps one admin.
 */
export const removeMember = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const viewer = await requireCompanyAdmin(ctx);
    const target = await ctx.db.get(args.userId);
    if (!target || !target.companyId || (target.companyId as string) !== (viewer.companyId as string)) {
      throw new Error(NOT_MEMBER_MESSAGE);
    }
    const members = await activeMembers(ctx, viewer.companyId);
    const decision = removeMemberDecision(membershipContext(viewer, target, adminCountOf(members)));
    if (!decision.ok) throw new Error(decision.message ?? ADMIN_ONLY_MESSAGE);
    await ctx.db.patch(target._id, { removedAt: new Date().toISOString() });
    await invalidateSessions(ctx as unknown as GenericActionCtx<DataModel>, { userId: target._id });
    return { ok: true };
  },
});

/**
 * Admin-only: hands company admin to another active user and steps down. One
 * transaction, so the company is never left without an admin in between.
 */
export const transferAdmin = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const viewer = await requireCompanyAdmin(ctx);
    const target = await ctx.db.get(args.userId);
    if (!target || !target.companyId || (target.companyId as string) !== (viewer.companyId as string)) {
      throw new Error(NOT_MEMBER_MESSAGE);
    }
    const members = await activeMembers(ctx, viewer.companyId);
    const decision = transferAdminDecision(membershipContext(viewer, target, adminCountOf(members)));
    if (!decision.ok) throw new Error(decision.message ?? ADMIN_ONLY_MESSAGE);
    await ctx.db.patch(target._id, { companyRole: COMPANY_ADMIN });
    await ctx.db.patch(viewer.userId, { companyRole: COMPANY_USER });
    return { ok: true };
  },
});

/** What an invitation email needs, and only for the admin of that invitation's company. */
export const invitationForDelivery = internalQuery({
  args: { tokenHash: v.string(), viewerId: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    const invitation = await ctx.db
      .query("invitations")
      .withIndex("by_token", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (!invitation || invitationState(invitation, Date.now()) !== "pending") return null;
    if (!args.viewerId) return null;
    const viewer = await ctx.db.get(args.viewerId);
    if (!viewer || viewer.removedAt || !viewer.companyId || (viewer.companyId as string) !== (invitation.companyId as string)) return null;
    if (!canManageMembers(viewer.companyRole)) return null;
    const company = await ctx.db.get(invitation.companyId);
    return {
      email: invitation.email,
      companyName: company?.name ?? "",
      inviterName: viewer.name ?? "",
      expiresAt: invitation.expiresAt,
    };
  },
});

const invitationEmailHtml = (input: { link: string; companyName: string; inviterName: string; expiry: string }) => {
  const company = input.companyName || "a company";
  const invitation = input.inviterName ? `${input.inviterName} invited you` : "You have been invited";
  const until = input.expiry ? input.expiry.slice(0, 10) : "";
  return [
    `<p>${invitation} to join <strong>${company}</strong> on Vintage GANTT.</p>`,
    `<p><a href="${input.link}">Accept the invitation</a></p>`,
    `<p>This link works once${until ? ` and expires on ${until}` : ""}.</p>`,
  ].join("");
};

/**
 * Sends (or resends) the email for an invitation. An action because sending mail
 * is network I/O. It only ever mails the address stored on a pending invitation
 * of the caller's own company, and refuses when the link is no longer valid.
 */
export const sendInvitationEmail = action({
  args: { token: v.string(), link: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ ok: boolean; email: string; provider: string }> => {
    const viewerId = await getAuthUserId(ctx);
    if (!viewerId) throw new Error(ADMIN_ONLY_MESSAGE);
    const tokenHash = await hashInvitationToken(args.token);
    const target: { email: string; companyName: string; inviterName: string; expiresAt: string } | null =
      await ctx.runQuery(internal.companies.invitationForDelivery, {
        tokenHash,
        viewerId: viewerId as Id<"users">,
      });
    if (!target) throw new Error("This invitation is no longer valid.");
    const link = args.link && args.link.startsWith("http") ? args.link : invitationAcceptHref(args.token);
    // The recipient is always the address stored on the invitation, never one
    // supplied by the caller, and the link is never returned or logged.
    const sent = await sendTransactionalEmail({
      to: target.email,
      subject: `Join ${target.companyName || "Vintage GANTT"} on Vintage GANTT`,
      html: invitationEmailHtml({ link, companyName: target.companyName, inviterName: target.inviterName, expiry: target.expiresAt }),
    });
    return { ok: true, email: target.email, provider: sent.provider };
  },
});

/**
 * Accepts an invitation: the invited person sets a name and a password and
 * becomes a regular user of the inviting company. A used, expired, revoked or
 * unknown link fails with one generic code and never creates an account. The
 * account and the company link are written in this one transaction, so an
 * acceptance either completes or changes nothing.
 */
export const acceptInvitation = mutation({
  args: { token: v.string(), name: v.string(), password: v.string() },
  handler: async (ctx, args) => {
    const token = args.token.trim();
    const tokenHash = token ? await hashInvitationToken(token) : "";
    const invitation = tokenHash
      ? await ctx.db.query("invitations").withIndex("by_token", (q) => q.eq("tokenHash", tokenHash)).unique()
      : null;
    const decision = invitationDecision(invitation, Date.now());
    if (!decision.ok || !invitation) throw invitationError(decision.code ?? "invalid");

    const name = args.name.trim();
    if (!name) throw invitationError("missing_name");
    if (args.password.length < 8) throw invitationError("weak_password");

    const email = normalizeEmail(invitation.email);
    // If the address gained an account since the invitation was sent, refuse and
    // burn the link rather than touching that existing account.
    const credential = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) => q.eq("provider", PASSWORD_PROVIDER_ID).eq("providerAccountId", email))
      .unique();
    if (credential || (await findAccountByEmail(ctx, email))) {
      await ctx.db.patch(invitation._id, { status: INVITATION_REVOKED, revokedAt: new Date().toISOString() });
      throw invitationError("taken");
    }

    const created = await createAccount<DataModel>(ctx as unknown as GenericActionCtx<DataModel>, {
      provider: PASSWORD_PROVIDER_ID,
      account: { id: email, secret: args.password },
      profile: { email, name },
    });
    const userId = created.user._id as Id<"users">;
    await ctx.db.patch(userId, { companyId: invitation.companyId, companyRole: COMPANY_USER });
    await ctx.db.patch(invitation._id, {
      status: INVITATION_ACCEPTED,
      acceptedAt: new Date().toISOString(),
      acceptedByUserId: userId,
    });
    return { ok: true, email };
  },
});
