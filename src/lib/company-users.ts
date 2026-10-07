/* --------------------------------------------------------------------------
 * Company users — the rules for the accounts in a company.
 *
 * Pure on purpose: the Convex backend makes its access decisions with these
 * functions and the screens render their messages from the same place, so a
 * rule can never drift between the two and every branch is unit tested.
 *
 * There is no email in this product. A company admin creates an account directly
 * with a temporary password and hands it to the person; the first sign-in forces
 * a new password; and a forgotten password is reset by the admin, in the same
 * way. One company has many accounts, exactly one kind of account —
 * `company_admin` — manages them, an account always belongs to exactly one
 * company, and an account that was removed never comes back on its own.
 * ------------------------------------------------------------------------ */

import { EMAIL_PATTERN, normalizeEmail } from "./auth-routes";
import {
  COMPANY_ADMIN,
  canManageMembers,
  normalizeCompanyRole,
  type CompanyRole,
} from "./company-scope";

export { EMAIL_PATTERN, normalizeEmail };

/* --------------------------------------------------------------- messages */

/** Every failure an admin or account holder may see, and nothing that names another company. */
export const ADMIN_ONLY_MESSAGE = "Only a company admin can manage user accounts.";
export const REMOVED_ACCESS_MESSAGE = "Your access to this company has been removed. Ask your company admin for access.";
export const NOT_MEMBER_MESSAGE = "That account is not part of this company.";
export const ALREADY_REMOVED_MESSAGE = "That account has already been removed.";
export const LAST_ADMIN_MESSAGE = "A company always needs at least one company admin.";
export const SELF_REMOVE_MESSAGE = "You cannot remove your own account. Transfer company admin to another user first.";
export const ALREADY_ADMIN_MESSAGE = "That account is already a company admin.";
export const TARGET_REMOVED_MESSAGE = "That account has been removed from this company.";

/** One message for a taken address, wherever the account it belongs to lives. */
export const EMAIL_TAKEN_MESSAGE = "An account already uses this email address.";
export const INVALID_EMAIL_MESSAGE = "Enter a valid email address.";
export const SAME_EMAIL_MESSAGE = "That is already your email address.";
export const MISSING_NAME_MESSAGE = "Enter a name.";

/** The admin is told what to do with the temporary password, never shown it back later. */
export const USER_CREATED_NOTICE =
  "Account created. Share the temporary password with the person in a secure way; they must change it at their first sign-in.";
export const PASSWORD_RESET_NOTICE =
  "The temporary password was set. The user is signed out everywhere and must change it at their next sign-in.";

/** Shown to an account that must set a new password before it can go on. */
export const MUST_CHANGE_PASSWORD_MESSAGE = "Set a new password before you continue.";

/* ------------------------------------------------------- password policy */

/** The one password rule of the product, shown next to every password field. */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_RULES_TEXT = `At least ${PASSWORD_MIN_LENGTH} characters.`;
export const WEAK_PASSWORD_MESSAGE = `Use a password of at least ${PASSWORD_MIN_LENGTH} characters.`;
export const PASSWORD_MISMATCH_MESSAGE = "The two passwords do not match.";
export const PASSWORD_UNCHANGED_MESSAGE =
  "The new password must be different from the temporary password.";
export const CURRENT_PASSWORD_WRONG_MESSAGE = "Your current password is incorrect.";

/** The message for a password that does not follow the rule, or null when it does. */
export function passwordProblem(password: string): string | null {
  return password.length >= PASSWORD_MIN_LENGTH ? null : WEAK_PASSWORD_MESSAGE;
}

/** True when the account still has to replace the password an admin set for it. */
export function mustChangePassword(record: { mustChangePassword?: unknown } | null | undefined): boolean {
  return record?.mustChangePassword === true;
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

export interface AddUserRequest {
  actorRole: unknown;
  email: string;
  /** True when any account anywhere already uses the address. */
  accountExists: boolean;
}

/**
 * Whether the actor may create an account. Admin-only; the address must be a
 * valid email and must not be taken anywhere in the application. The refusal for
 * a taken address is deliberately generic: it names no company.
 */
export function addUserDecision(request: AddUserRequest): { ok: boolean; message?: string } {
  if (!canManageMembers(request.actorRole)) return { ok: false, message: ADMIN_ONLY_MESSAGE };
  if (!EMAIL_PATTERN.test(normalizeEmail(request.email))) return { ok: false, message: INVALID_EMAIL_MESSAGE };
  if (request.accountExists) return { ok: false, message: EMAIL_TAKEN_MESSAGE };
  return { ok: true };
}

/** Admin-only: an admin may reset the password of an account in their own company. */
export function resetPasswordDecision(input: { actorRole: unknown; sameCompany: boolean }): {
  ok: boolean;
  message?: string;
} {
  if (!canManageMembers(input.actorRole)) return { ok: false, message: ADMIN_ONLY_MESSAGE };
  if (!input.sameCompany) return { ok: false, message: NOT_MEMBER_MESSAGE };
  return { ok: true };
}

/** The address to store: normalised, and validated for the common shapes. */
export function normalizeAccountEmail(value: string): string {
  return normalizeEmail(value);
}

/** A readable line for the admin's confirmation, naming the address only. */
export function userCreatedMessage(email: string): string {
  return `Account created for ${normalizeEmail(email)}. ${USER_CREATED_NOTICE}`;
}
