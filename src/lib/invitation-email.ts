/* --------------------------------------------------------------------------
 * The invitation email.
 *
 * A purpose-built message, not a sign-in or verification template: it names the
 * company and the person who invited them, carries one call-to-action button,
 * and states how long the link lives and that it works once.
 *
 * The link appears exactly once, inside the button's `href`, so a mail client
 * never shows it as a verification code or a block of text. Pure, so the exact
 * wording and structure are unit tested.
 * ------------------------------------------------------------------------ */

import { INVITATION_TTL_DAYS } from "./company-users";

/** The wording on the one button. */
export const INVITATION_BUTTON_LABEL = "Accept the invitation";

export interface InvitationEmailInput {
  /** The inviting company, as its admins see it. */
  companyName: string;
  /** The person who sent it, when a name is known. */
  inviterName: string;
  /** The acceptance link — the only place the single-use value appears. */
  link: string;
  /** When the link stops working (ISO date-time). */
  expiresAt: string;
  /** The link's lifetime in days, for the sentence that states it. */
  ttlDays?: number;
}

/** A readable date for the expiry sentence, e.g. "6 October 2026". */
const readableDate = (iso: string): string => {
  const parsed = Date.parse(iso);
  if (!iso || Number.isNaN(parsed)) return "";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(parsed));
};

export function invitationEmailSubject(companyName: string): string {
  return companyName ? `You are invited to join ${companyName} on Vintage GANTT` : "You are invited to join Vintage GANTT";
}

/**
 * The invitation message. One button, the company, the inviter, the expiry and
 * the single-use rule — and nothing that looks like a verification code.
 */
export function invitationEmail(input: InvitationEmailInput): { subject: string; html: string } {
  const company = input.companyName || "a company";
  const invited = input.inviterName ? `${input.inviterName} invited you` : "You have been invited";
  const days = input.ttlDays ?? INVITATION_TTL_DAYS;
  const until = readableDate(input.expiresAt);
  const before = `This invitation link works once, and stops working on ${until || `${days} days from now`}${until ? ` (${days} days from now)` : ""}.`;

  const html = [
    `<div style="margin:0;padding:24px;background:#f4eddf;font-family:Georgia,'Times New Roman',serif;color:#4c3b2c;">`,
    `<div style="max-width:520px;margin:0 auto;background:#fbf7ee;border:1px solid #d4c3aa;border-radius:4px;padding:26px;">`,
    `<p style="margin:0 0 6px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#927b61;">Vintage GANTT</p>`,
    `<h1 style="margin:0 0 16px;font-size:22px;font-weight:normal;color:#3f3025;">${invited} to join ${company}</h1>`,
    `<p style="margin:0 0 22px;font-size:14px;line-height:1.6;color:#6b5948;">${company} uses Vintage GANTT to plan its projects. Accept the invitation to create your own account and join the company.</p>`,
    `<p style="margin:0 0 22px;"><a href="${input.link}" style="display:inline-block;padding:12px 22px;background:#745842;color:#fff9ef;text-decoration:none;border-radius:3px;font-family:Helvetica,Arial,sans-serif;font-size:14px;">${INVITATION_BUTTON_LABEL}</a></p>`,
    `<p style="margin:0 0 10px;font-size:12px;line-height:1.6;color:#8b765d;">${before}</p>`,
    `<p style="margin:0;font-size:12px;line-height:1.6;color:#8b765d;">If you were not expecting this invitation, you can ignore this email — nothing happens until the link above is used.</p>`,
    `</div>`,
    `</div>`,
  ].join("");

  return { subject: invitationEmailSubject(input.companyName), html };
}
