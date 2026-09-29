/* --------------------------------------------------------------------------
 * Company users — the rules for invitations and for managing the accounts in a
 * company.
 *
 * Pure on purpose: the Convex backend makes its access decisions with these
 * functions and the screens render their messages from the same place, so a
 * rule can never drift between the two and every branch is unit tested.
 *
 * One company has many accounts. Exactly one kind of account — `company_admin`
 * — manages users and invitations; for projects, planning, resources, calendars
 * and capacity the two kinds are identical. A company always keeps at least one
 * company admin, an account that was removed never comes back on its own, and an
 * invitation is a single-use value that expires.
 * ------------------------------------------------------------------------ */

import { normalizeEmail } from "./auth-routes";
import { COMPANY_ADMIN, canManageMembers, normalizeCompanyRole, type CompanyRole } from "./company-scope";

export { normalizeEmail };

/* --------------------------------------------------------------- messages */

/** Every failure an invitee may see, and nothing that names another company. */
export const ADMIN_ONLY_MESSAGE = "Only a company admin can manage users and invitations.";
export const REMOVED_ACCESS_MESSAGE = "Your access to this company has been removed. Ask your company admin for access.";
export const NOT_MEMBER_MESSAGE = "That account is not part of this company.";
export const ALREADY_REMOVED_MESSAGE = "That account has already been removed.";
export const LAST_ADMIN_MESSAGE = "A company always needs at least one company admin.";
export const SELF_REMOVE_MESSAGE = "You cannot remove your own account. Transfer company admin to another user first.";
export const ALREADY_ADMIN_MESSAGE = "That account is already a company admin.";
export const TARGET_REMOVED_MESSAGE = "That account has been removed from this company.";
export const INVITE_INVALID_EMAIL_MESSAGE = "Enter a valid email address.";
export const INVITE_ACCOUNT_EXISTS_MESSAGE = "An account already uses this email address.";
export const INVITE_SENT_MESSAGE = "Invitation sent.";
export const INVITATION_SENT_NOTICE = "Invitation created. We sent an email with the acceptance link.";

/* ------------------------------------------------------------ invitations */

export const INVITATION_STATUSES = ["pending", "accepted", "revoked"] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const INVITATION_PENDING: InvitationStatus = "pending";
export const INVITATION_ACCEPTED: InvitationStatus = "accepted";
export const INVITATION_REVOKED: InvitationStatus = "revoked";

/** The stored status plus the one that is derived from the expiry date. */
export const INVITATION_STATES = ["pending", "accepted", "revoked", "expired"] as const;
export type InvitationState = (typeof INVITATION_STATES)[number];

export const INVITATION_STATE_LABELS: Record<InvitationState, string> = {
  pending: "Pending",
  accepted: "Accepted",
  revoked: "Revoked",
  expired: "Expired",
};

/** A link is valid for a week; a shorter life limits what a leaked link can do. */
export const INVITATION_TTL_DAYS = 7;
export const INVITATION_TTL_MS = INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000;

/** The screen an invitation link opens. */
export const INVITATION_ACCEPT_PATH = "/auth/accept";

export interface InvitationLike {
  status?: unknown;
  expiresAt?: unknown;
  acceptedAt?: unknown;
  revokedAt?: unknown;
}

export function isInvitationStatus(value: unknown): value is InvitationStatus {
  return typeof value === "string" && (INVITATION_STATUSES as readonly string[]).includes(value);
}

/** The expiry an invitation created at `nowMs` gets. */
export function invitationExpiry(nowMs: number, ttlMs: number = INVITATION_TTL_MS): string {
  return new Date(nowMs + ttlMs).toISOString();
}

/**
 * The effective state of an invitation at `nowMs`. `expired` is derived: a
 * `pending` row whose expiry has passed can never be used. `null` means the
 * record is not an invitation at all (a forged or unknown token).
 */
export function invitationState(record: InvitationLike | null | undefined, nowMs: number): InvitationState | null {
  const status = record?.status;
  if (!isInvitationStatus(status)) return null;
  if (status === INVITATION_ACCEPTED) return "accepted";
  if (status === INVITATION_REVOKED) return "revoked";
  const expiresAt = typeof record?.expiresAt === "string" ? record.expiresAt : "";
  const expiry = Date.parse(expiresAt);
  if (!expiresAt || Number.isNaN(expiry) || expiry <= nowMs) return "expired";
  return "pending";
}

/** True only while the invitation can still be accepted. */
export function isUsableInvitation(record: InvitationLike | null | undefined, nowMs: number): boolean {
  return invitationState(record, nowMs) === "pending";
}

/** The generic sentence for each failed acceptance; none names a person or company. */
export const INVITATION_ERROR_MESSAGES: Record<string, string> = {
  invalid: "This invitation link is not valid. Ask your company admin for a new invitation.",
  expired: "This invitation has expired. Ask your company admin for a new invitation.",
  used: "This invitation has already been used. Sign in instead, or ask your company admin for a new invitation.",
  revoked: "This invitation was revoked. Ask your company admin for a new invitation.",
  taken: "An account already uses this email address. Sign in instead.",
  missing_name: "Enter your name.",
  weak_password: "Use a password of at least 8 characters.",
  fallback: "We could not accept this invitation. Ask your company admin for a new invitation.",
};

export const INVITATION_ERROR_CODES = ["invalid", "expired", "used", "revoked", "taken", "missing_name", "weak_password"] as const;
export type InvitationErrorCode = (typeof INVITATION_ERROR_CODES)[number];

export interface InvitationDecision {
  ok: boolean;
  state: InvitationState | null;
  code: InvitationErrorCode | null;
  message: string;
}

/** Whether an invitation may be accepted, and the generic message when it may not. */
export function invitationDecision(record: InvitationLike | null | undefined, nowMs: number): InvitationDecision {
  const state = invitationState(record, nowMs);
  if (state === "pending") return { ok: true, state, code: null, message: "" };
  const code: InvitationErrorCode =
    state === "accepted" ? "used" : state === "expired" ? "expired" : state === "revoked" ? "revoked" : "invalid";
  return { ok: false, state, code, message: INVITATION_ERROR_MESSAGES[code] };
}

/** Reads the code an invitation failure threw (`new ConvexError({ code })`). */
export function invitationErrorCode(error: unknown): InvitationErrorCode | null {
  if (!error || typeof error !== "object" || !("data" in error)) return null;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object" || !("code" in data)) return null;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" && (INVITATION_ERROR_CODES as readonly string[]).includes(code)
    ? (code as InvitationErrorCode)
    : null;
}

/** The English message for a failed acceptance, with a safe fallback. */
export function invitationErrorMessage(error: unknown): string {
  const code = invitationErrorCode(error);
  return code ? INVITATION_ERROR_MESSAGES[code] : INVITATION_ERROR_MESSAGES.fallback;
}

/** The acceptance link for an invitation token, on the app's own origin. */
export function invitationAcceptHref(token: string, origin = ""): string {
  const base = origin && origin !== "null" ? origin.replace(/\/+$/, "") : "";
  return `${base}${INVITATION_ACCEPT_PATH}?token=${encodeURIComponent(token)}`;
}

/* --------------------------------------------------------- access decisions */

export interface MembershipContext {
  actorRole: unknown;
  actorUserId: string;
  targetUserId: string;
  targetRole: unknown;
  /** How many active (not removed) company admins the company has. */
  adminCount: number;
  targetRemoved: boolean;
}

/** Only an admin may manage users; every rule below starts with that. */
export function membershipDecisionError(context: MembershipContext): string | null {
  if (!canManageMembers(context.actorRole)) return ADMIN_ONLY_MESSAGE;
  if (context.targetRemoved) return ALREADY_REMOVED_MESSAGE;
  return null;
}

/** Whether the actor may remove the target account. Data is never deleted. */
export function removeMemberDecision(context: MembershipContext): { ok: boolean; message?: string } {
  const base = membershipDecisionError(context);
  if (base) return { ok: false, message: base };
  const role: CompanyRole = normalizeCompanyRole(context.targetRole);
  if (context.targetUserId === context.actorUserId) return { ok: false, message: SELF_REMOVE_MESSAGE };
  if (role === COMPANY_ADMIN && context.adminCount <= 1) return { ok: false, message: LAST_ADMIN_MESSAGE };
  return { ok: true };
}

/** Whether the actor may hand company admin to the target account. */
export function transferAdminDecision(context: MembershipContext): { ok: boolean; message?: string } {
  const base = membershipDecisionError(context);
  if (base) return { ok: false, message: base };
  if (context.targetUserId === context.actorUserId) return { ok: false, message: ALREADY_ADMIN_MESSAGE };
  if (normalizeCompanyRole(context.targetRole) === COMPANY_ADMIN) return { ok: false, message: ALREADY_ADMIN_MESSAGE };
  if (context.adminCount < 1) return { ok: false, message: LAST_ADMIN_MESSAGE };
  return { ok: true };
}

/** An invitation target must be an email address without an account. */
export function inviteDecision(input: { actorRole: unknown; email: string; accountExists: boolean }): { ok: boolean; message?: string } {
  if (!canManageMembers(input.actorRole)) return { ok: false, message: ADMIN_ONLY_MESSAGE };
  if (!input.email) return { ok: false, message: INVITE_INVALID_EMAIL_MESSAGE };
  if (input.accountExists) return { ok: false, message: INVITE_ACCOUNT_EXISTS_MESSAGE };
  return { ok: true };
}

/** A pending invitation a resend must replace, so only one link ever works. */
export function replaceableInvitations<T extends { status?: unknown; email?: unknown }>(
  rows: readonly T[],
  email: string,
): T[] {
  const target = normalizeEmail(email);
  return rows.filter((row) => normalizeEmail(String(row.email ?? "")) === target && row.status === INVITATION_PENDING);
}
