import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

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
    }).index("email", ["email"]), // index for the email. do not remove or modify

    projects: defineTable({
      ownerId: v.id("users"), id: v.string(), name: v.string(), status: v.string(), startDate: v.string(),
      schedulingDirection: v.string(), calendarId: v.string(),      createdAt: v.string(), updatedAt: v.string(),
      seedKey: v.optional(v.string()),
      kind: v.optional(v.union(v.literal("project"), v.literal("template"))), // Omitted on legacy rows means "project".
      isBuiltin: v.optional(v.boolean()),
      hidden: v.optional(v.boolean()),
    }).index("by_owner", ["ownerId"]).index("by_owner_seed", ["ownerId", "seedKey"]),
    tasks: defineTable({
      ownerId: v.id("users"), id: v.string(), projectId: v.string(), parentId: v.union(v.string(), v.null()), sortOrder: v.number(),
      name: v.string(), duration: v.number(), durationUnit: v.string(), start: v.string(), finish: v.string(),
      work: v.optional(v.number()),
      isMilestone: v.boolean(), predecessors: v.string(), resource: v.string(), percent: v.number(), notes: v.string(),
      color: v.string(), collapsed: v.optional(v.boolean()), versionId: v.optional(v.string()),
      marginPct: v.optional(v.number()), marginDaysOriginal: v.optional(v.number()), marginDaysConsumed: v.optional(v.number()),
      totalFloat: v.optional(v.number()), isCritical: v.optional(v.boolean()),
      startOffsetDays: v.optional(v.number()),
      finishOffsetDays: v.optional(v.number()),
      startConstraint: v.optional(v.string()),
      startConstraintActive: v.optional(v.boolean()),
      constraintOffsetDays: v.optional(v.number()),
    }).index("by_owner_project", ["ownerId", "projectId"]).index("by_owner_project_version", ["ownerId", "projectId", "versionId"]),
    dependencies: defineTable({ ownerId: v.id("users"), id: v.string(), projectId: v.string(), predecessorId: v.string(), successorId: v.string(), type: v.string(), lagDays: v.number() }).index("by_owner", ["ownerId"]),
    calendars: defineTable({ ownerId: v.id("users"), id: v.string(), name: v.string(), type: v.string(), parentCalendarId: v.union(v.string(), v.null()), isDefault: v.boolean(), workingDays: v.optional(v.array(v.number())) }).index("by_owner", ["ownerId"]),
    calendarExceptions: defineTable({ ownerId: v.id("users"), id: v.string(), calendarId: v.string(), startDate: v.string(), endDate: v.string(), label: v.string(), type: v.string(), isWorkingDay: v.boolean(), source: v.string() }).index("by_owner", ["ownerId"]),
    resources: defineTable({ ownerId: v.id("users"), id: v.string(), name: v.string(), role: v.string(), email: v.string(), colour: v.string(), hoursPerWeek: v.number(), isActive: v.boolean(), calendarId: v.string() }).index("by_owner", ["ownerId"]),
    taskAssignments: defineTable({ ownerId: v.id("users"), id: v.string(), taskId: v.string(), resourceId: v.string() }).index("by_owner", ["ownerId"]),
    planVersions: defineTable({ ownerId: v.id("users"), id: v.string(), projectId: v.string(), name: v.string(), isActive: v.boolean(), createdAt: v.string(), mode: v.optional(v.string()), modeHistory: v.optional(v.array(v.object({ at: v.string(), from: v.string(), to: v.string() }))), history: v.optional(v.array(v.object({ at: v.string(), type: v.string(), from: v.optional(v.string()), to: v.optional(v.string()), baselineId: v.optional(v.string()), name: v.optional(v.string()) }))) }).index("by_owner_project", ["ownerId", "projectId"]),
    baselines: defineTable({ ownerId: v.id("users"), id: v.string(), projectId: v.string(), versionId: v.string(), name: v.string(), note: v.optional(v.string()), createdAt: v.string(), captureDate: v.optional(v.string()) }).index("by_owner_project", ["ownerId", "projectId"]),
    baselineTasks: defineTable({ ownerId: v.id("users"), id: v.string(), baselineId: v.string(), taskId: v.string(), startDate: v.string(), finishDate: v.string(), durationDays: v.number(), marginPct: v.number(), marginDaysOriginal: v.number(), marginDaysConsumed: v.number(), predecessors: v.optional(v.string()), totalFloat: v.optional(v.number()), startConstraint: v.optional(v.string()) }).index("by_owner_baseline", ["ownerId", "baselineId"]),
    seedRuns: defineTable({ ownerId: v.id("users"), seedKey: v.string(), executedAt: v.string() }).index("by_owner_seed", ["ownerId", "seedKey"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
