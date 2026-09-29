import { invalidateSessions, modifyAccountCredentials } from "@convex-dev/auth/server";
import type { GenericActionCtx } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { DataModel } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action, internalMutation, mutation } from "./_generated/server";
import { EMAIL_PATTERN, normalizeEmail } from "../lib/auth-routes";
import { generateSecureToken, hashSecureToken } from "../lib/invitation-token";
import {
  passwordProblem,
  passwordResetHref,
  resetDecision,
  resetExpiry,
} from "../lib/password-reset";
import { sendTransactionalEmail } from "./email";

/**
 * Password recovery.
 *
 * The request is answered with one constant sentence whether or not the address
 * has an account; only a real account gets a link, and that link is one personal
 * single-use value whose hash — never the value — is stored. Completing a reset
 * replaces the credential in Convex Auth's own table and drops every existing
 * session, so the old password and the link both stop working. Nothing in here
 * touches the account's company or role.
 */

const PASSWORD_PROVIDER_ID = "password";

/** The message an email carries. It names no account and echoes no address. */
const resetEmailHtml = (link: string, expiresAt: string) => {
  const until = expiresAt ? expiresAt.slice(0, 16).replace("T", " ") : "";
  return [
    "<p>Someone asked to set a new password for your Vintage GANTT account.</p>",
    `<p><a href="${link}">Set a new password</a></p>`,
    `<p>This link can be used once${until ? ` and expires on ${until} UTC` : ""}. If you did not ask for it, you can ignore this email — your password stays the same.</p>`,
  ].join("");
};

/** The app's own origin for the link; the caller's origin wins when it is a real URL. */
const appOrigin = (requested?: string): string => {
  if (requested && /^https?:\/\//i.test(requested)) return requested;
  return (process.env.VLY_APP_URL ?? process.env.SITE_URL ?? "").replace(/\/+$/, "");
};

/**
 * Stores one reset link for an account, replacing every earlier one so an
 * account has at most one working link. An address without a password account
 * stores nothing — the caller still answers the same way.
 */
export const issueResetToken = internalMutation({
  args: { email: v.string(), tokenHash: v.string(), expiresAt: v.string() },
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    const account = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) => q.eq("provider", PASSWORD_PROVIDER_ID).eq("providerAccountId", email))
      .unique();
    if (!account) return { issued: false, email };
    const previous = await ctx.db
      .query("passwordResets")
      .withIndex("by_user", (q) => q.eq("userId", account.userId))
      .collect();
    for (const row of previous) await ctx.db.delete(row._id);
    await ctx.db.insert("passwordResets", {
      userId: account.userId,
      email,
      tokenHash: args.tokenHash,
      createdAt: new Date().toISOString(),
      expiresAt: args.expiresAt,
    });
    return { issued: true, email };
  },
});

/**
 * Requests a reset link. Always answers `{ ok: true }`, whatever the address and
 * whatever happens while sending — so a visitor can never tell whether the
 * address exists. The raw value is created here and only ever leaves through the
 * email; it is never returned, logged or included in an error.
 */
export const requestReset = action({
  args: { email: v.string(), origin: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    try {
      const email = normalizeEmail(args.email);
      if (!EMAIL_PATTERN.test(email)) return { ok: true };
      const token = generateSecureToken();
      const tokenHash = await hashSecureToken(token);
      const expiresAt = resetExpiry(Date.now());
      const issued: { issued: boolean; email: string } = await ctx.runMutation(
        internal.passwordRecovery.issueResetToken,
        { email, tokenHash, expiresAt },
      );
      if (!issued.issued) return { ok: true };
      const link = passwordResetHref(token, appOrigin(args.origin));
      await sendTransactionalEmail({
        to: issued.email,
        subject: "Set a new password for Vintage GANTT",
        html: resetEmailHtml(link, expiresAt),
        value: link,
      });
    } catch {
      // Neutral by design: the answer is the same and nothing is logged.
    }
    return { ok: true };
  },
});

/**
 * Completes a reset with a link's value and a new password.
 *
 * A wrong, expired or already-spent link fails with one generic code and changes
 * nothing. On success the credential is replaced, the link is spent together
 * with any other outstanding link, and every session is dropped — so neither the
 * old password nor the link works afterwards. The account keeps its company and
 * its role; only the password changed.
 */
export const completeReset = mutation({
  args: { token: v.string(), password: v.string() },
  handler: async (ctx, args): Promise<{ ok: true; email: string }> => {
    const token = args.token.trim();
    const tokenHash = token ? await hashSecureToken(token) : "";
    const row = tokenHash
      ? await ctx.db.query("passwordResets").withIndex("by_token", (q) => q.eq("tokenHash", tokenHash)).unique()
      : null;
    const decision = resetDecision(row, Date.now());
    if (!decision.ok || !row) throw new ConvexError({ code: decision.code ?? "invalid" });

    const problem = passwordProblem(args.password);
    if (problem) throw new ConvexError({ code: "weak_password" });

    const email = normalizeEmail(row.email);
    const account = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) => q.eq("provider", PASSWORD_PROVIDER_ID).eq("providerAccountId", email))
      .unique();
    if (!account) throw new ConvexError({ code: "invalid" });

    await modifyAccountCredentials(ctx as unknown as GenericActionCtx<DataModel>, {
      provider: PASSWORD_PROVIDER_ID,
      account: { id: email, secret: args.password },
    });

    // Single use: spend this link and remove any other outstanding one.
    const nowIso = new Date().toISOString();
    await ctx.db.patch(row._id, { usedAt: nowIso });
    const others = await ctx.db
      .query("passwordResets")
      .withIndex("by_user", (q) => q.eq("userId", row.userId))
      .collect();
    for (const other of others) if (other._id !== row._id) await ctx.db.delete(other._id);

    await invalidateSessions(ctx as unknown as GenericActionCtx<DataModel>, { userId: row.userId });
    return { ok: true, email };
  },
});
