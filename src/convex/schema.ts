import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";
import { COMPANY_ROLES, COMPANY_STATUSES } from "../lib/company-scope";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

// The company account types: exactly two, and they differ only for user and
// invitation management (see src/lib/company-scope.ts).
export const companyRoleValidator = v.union(
  v.literal(COMPANY_ROLES[0]),
  v.literal(COMPANY_ROLES[1]),
);
export type CompanyRoleValue = Infer<typeof companyRoleValidator>;

export const companyStatusValidator = v.union(
  v.literal(COMPANY_STATUSES[0]),
  v.literal(COMPANY_STATUSES[1]),
);

// The link every company-owned record carries. Optional so rows written before
// the company migration still load; the migration (and every write path) fills
// it in from the signed-in user, never from the browser.
const companyId = v.optional(v.id("companies"));

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove

      // Every account belongs to exactly one company. Assigned by the server on
      // first sign-in (see src/convex/companies.ts) and never accepted from the
      // browser as proof of access.
      companyId: v.optional(v.id("companies")),
      // "company_admin" | "user". Absent means plain user.
      companyRole: v.optional(companyRoleValidator),
      // Set by a company admin when the account is removed from the company.
      // The account keeps no access from then on, but nothing it created is
      // deleted. Optional so existing accounts are simply active.
      removedAt: v.optional(v.string()),
    }).index("email", ["email"]) // index for the email. do not remove or modify
      .index("by_company", ["companyId"]), // index for the company. do not remove

    // A company owns one workspace: its projects, plans, calendars, people and
    // capacity all hang off this record.
    companies: defineTable({
      name: v.string(),
      status: companyStatusValidator,
      createdAt: v.string(),
      createdByUserId: v.optional(v.id("users")),
    }).index("by_name", ["name"]),

    // A single-use invitation to join a company. Only the SHA-256 hash of the
    // link's value is stored, so a database row can never be replayed as a
    // working link. `expired` is derived from `expiresAt`; the stored status is
    // one of pending / accepted / revoked.
    invitations: defineTable({
      companyId: v.id("companies"),
      email: v.string(),
      tokenHash: v.string(),
      status: v.union(v.literal("pending"), v.literal("accepted"), v.literal("revoked")),
      invitedByUserId: v.id("users"),
      createdAt: v.string(),
      expiresAt: v.string(),
      acceptedAt: v.optional(v.string()),
      acceptedByUserId: v.optional(v.id("users")),
      revokedAt: v.optional(v.string()),
    })
      .index("by_company", ["companyId"])
      .index("by_token", ["tokenHash"])
      .index("by_company_email", ["companyId", "email"]),

    projects: defineTable({
      ownerId: v.id("users"), companyId, id: v.string(), name: v.string(), status: v.string(), startDate: v.string(),
      schedulingDirection: v.string(), calendarId: v.string(),      createdAt: v.string(), updatedAt: v.string(),
      seedKey: v.optional(v.string()),
      kind: v.optional(v.union(v.literal("project"), v.literal("template"))), // Omitted on legacy rows means "project".
      client: v.optional(v.string()),
      isBuiltin: v.optional(v.boolean()),
      hidden: v.optional(v.boolean()),
    }).index("by_owner", ["ownerId"]).index("by_owner_seed", ["ownerId", "seedKey"]).index("by_company", ["companyId"]).index("by_company_seed", ["companyId", "seedKey"]),
    tasks: defineTable({
      ownerId: v.id("users"), companyId, id: v.string(), projectId: v.string(), parentId: v.union(v.string(), v.null()), sortOrder: v.number(),
      name: v.string(), duration: v.number(), durationUnit: v.string(), start: v.string(), finish: v.string(),
      work: v.optional(v.number()),
      distribution: v.optional(v.string()),
      isMilestone: v.boolean(), predecessors: v.string(), resource: v.string(), percent: v.number(), notes: v.string(),
      color: v.string(), collapsed: v.optional(v.boolean()), versionId: v.optional(v.string()),
      marginPct: v.optional(v.number()), marginDaysOriginal: v.optional(v.number()), marginDaysConsumed: v.optional(v.number()),
      totalFloat: v.optional(v.number()), isCritical: v.optional(v.boolean()),
      startOffsetDays: v.optional(v.number()),
      finishOffsetDays: v.optional(v.number()),
      startConstraint: v.optional(v.string()),
      startConstraintActive: v.optional(v.boolean()),
      constraintOffsetDays: v.optional(v.number()),
    }).index("by_owner_project", ["ownerId", "projectId"]).index("by_owner_project_version", ["ownerId", "projectId", "versionId"]).index("by_company", ["companyId"]).index("by_company_project", ["companyId", "projectId"]),
    dependencies: defineTable({ ownerId: v.id("users"), companyId, id: v.string(), projectId: v.string(), predecessorId: v.string(), successorId: v.string(), type: v.string(), lagDays: v.number() }).index("by_owner", ["ownerId"]).index("by_company", ["companyId"]),
    calendars: defineTable({ ownerId: v.id("users"), companyId, id: v.string(), name: v.string(), type: v.string(), parentCalendarId: v.union(v.string(), v.null()), isDefault: v.boolean(), workingDays: v.optional(v.array(v.number())) }).index("by_owner", ["ownerId"]).index("by_company", ["companyId"]),
    calendarExceptions: defineTable({ ownerId: v.id("users"), companyId, id: v.string(), calendarId: v.string(), startDate: v.string(), endDate: v.string(), label: v.string(), type: v.string(), isWorkingDay: v.boolean(), source: v.string() }).index("by_owner", ["ownerId"]).index("by_company", ["companyId"]),
    resources: defineTable({ ownerId: v.id("users"), companyId, id: v.string(), name: v.string(), role: v.string(), email: v.string(), colour: v.string(), hoursPerWeek: v.number(), isActive: v.boolean(), calendarId: v.string() }).index("by_owner", ["ownerId"]).index("by_company", ["companyId"]),
    taskAssignments: defineTable({ ownerId: v.id("users"), companyId, id: v.string(), taskId: v.string(), resourceId: v.string() }).index("by_owner", ["ownerId"]).index("by_company", ["companyId"]),
    planVersions: defineTable({ ownerId: v.id("users"), companyId, id: v.string(), projectId: v.string(), name: v.string(), isActive: v.boolean(), createdAt: v.string(), mode: v.optional(v.string()), modeHistory: v.optional(v.array(v.object({ at: v.string(), from: v.string(), to: v.string() }))), history: v.optional(v.array(v.object({ at: v.string(), type: v.string(), from: v.optional(v.string()), to: v.optional(v.string()), baselineId: v.optional(v.string()), name: v.optional(v.string()) }))) }).index("by_owner_project", ["ownerId", "projectId"]).index("by_company", ["companyId"]).index("by_company_project", ["companyId", "projectId"]),
    baselines: defineTable({ ownerId: v.id("users"), companyId, id: v.string(), projectId: v.string(), versionId: v.string(), name: v.string(), note: v.optional(v.string()), createdAt: v.string(), captureDate: v.optional(v.string()) }).index("by_owner_project", ["ownerId", "projectId"]).index("by_company", ["companyId"]).index("by_company_project", ["companyId", "projectId"]),
    baselineTasks: defineTable({ ownerId: v.id("users"), companyId, id: v.string(), baselineId: v.string(), taskId: v.string(), startDate: v.string(), finishDate: v.string(), durationDays: v.number(), marginPct: v.number(), marginDaysOriginal: v.number(), marginDaysConsumed: v.number(), predecessors: v.optional(v.string()), totalFloat: v.optional(v.number()), startConstraint: v.optional(v.string()) }).index("by_owner_baseline", ["ownerId", "baselineId"]).index("by_company", ["companyId"]),
    seedRuns: defineTable({ ownerId: v.id("users"), companyId, seedKey: v.string(), executedAt: v.string() }).index("by_owner_seed", ["ownerId", "seedKey"]).index("by_company", ["companyId"]).index("by_company_seed", ["companyId", "seedKey"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
