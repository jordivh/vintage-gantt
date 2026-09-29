import axios from "axios";

/**
 * Transactional email.
 *
 * Every link this app mails out — an invitation, a password reset — goes
 * through here. One place means one policy: the project's own email provider is
 * used when its key is configured, the platform's transactional mailer is the
 * fallback, and a delivery failure never carries the message body back out.
 * That last part matters because the body contains the single-use link, and an
 * error is a thing that gets logged.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const PLATFORM_MAIL_ENDPOINT = "https://auth.freebuff.app/send_otp";
const PLATFORM_MAIL_KEY = "fb_email_2crN1hqIArZP2bEfvjp5Qik4";

export interface TransactionalEmail {
  to: string;
  subject: string;
  html: string;
  /**
   * The plain value the platform mailer shows (a link). It is the same secret
   * the HTML carries, and it is never included in a thrown error.
   */
  value: string;
}

export type EmailProvider = "resend" | "platform";

/** Sends one email. Throws one fixed message on failure — never the provider's own. */
export async function sendTransactionalEmail(input: TransactionalEmail): Promise<EmailProvider> {
  const appName = process.env.VLY_APP_NAME || "Vintage GANTT";
  const apiKey = process.env.RESEND_API_KEY;
  try {
    if (apiKey) {
      await axios.post(
        RESEND_ENDPOINT,
        {
          from: process.env.INVITATION_FROM_EMAIL || `${appName} <onboarding@resend.dev>`,
          to: input.to,
          subject: input.subject,
          html: input.html,
        },
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      return "resend";
    }
    await axios.post(
      PLATFORM_MAIL_ENDPOINT,
      { to: input.to, otp: input.value, appName },
      { headers: { "x-api-key": PLATFORM_MAIL_KEY } },
    );
    return "platform";
  } catch {
    // Deliberately discards the provider's error: it can echo the request body,
    // which is the single-use link.
    throw new Error("The email could not be sent.");
  }
}
