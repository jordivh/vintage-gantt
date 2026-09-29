import { scrubSecrets } from "../lib/secret-scrub";

/**
 * Transactional email — the one channel.
 *
 * Every link this app mails out (a password reset, a company invitation, and
 * anything added later) goes through here, so there is exactly one place that
 * knows how mail leaves the system and exactly one failure policy.
 *
 * Three rules hold this together:
 *
 * 1. There is no pretend-success. When the provider is not configured, no mail
 *    is sent and that is said out loud in the server log with the variable that
 *    is missing. The previous fallback posted to the platform's development OTP
 *    mailer, which answers `HTTP 200 {"message":"Email sent"}` for any address at
 *    all — including one that cannot exist — so it reported success while
 *    delivering nothing, and hid the misconfiguration.
 * 2. A real failure reaches the log with the provider's status and message, and
 *    never with the message body. That body carries the single-use link, so every
 *    string that leaves this module passes through `scrubSecrets` first.
 * 3. Transient failures (a timeout, a rate limit, a provider hiccup) are retried;
 *    a refusal that will never succeed is not.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** Attempts per send, and the first backoff step (doubled each retry). */
export const EMAIL_MAX_ATTEMPTS = 3;
export const EMAIL_RETRY_BASE_MS = 250;

/** Thrown when no provider is configured. Never shown to a visitor. */
export const EMAIL_NOT_CONFIGURED_MESSAGE =
  "Transactional email is not configured. Set RESEND_API_KEY and RESEND_EMAIL_FROM on the deployment.";

export interface TransactionalEmail {
  to: string;
  subject: string;
  /**
   * The message. It is the only place the single-use link appears, and it is
   * never included in a logged or thrown error.
   */
  html: string;
}

export type EmailProvider = "resend";

export interface SendResult {
  provider: EmailProvider;
  /** The provider's message id, for finding the delivery in its dashboard. */
  id: string | null;
}

/** The verified sender. `onboarding@resend.dev` only reaches the account owner. */
const senderAddress = () => (process.env.RESEND_EMAIL_FROM || process.env.INVITATION_FROM_EMAIL || "").trim();

/** True when a key and a verified sender are both present. */
export const emailConfigured = () => Boolean(process.env.RESEND_API_KEY && senderAddress());

/** 429 and 5xx (and a request that never got an answer) are worth another try. */
const isTransient = (status: number) => status === 0 || status === 408 || status === 429 || status >= 500;

/** The provider's status and message, scrubbed of anything secret before it is logged. */
const describeFailure = (status: number, body: string) => {
  const detail = scrubSecrets(body).replace(/\s+/g, " ").trim().slice(0, 300);
  return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
};

export interface SendOptions {
  /** Injected in tests; the deployment uses the platform's `fetch`. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Sends one email and returns the provider's id. Throws one fixed message on
 * failure, after logging the real reason (never the body).
 */
export async function sendTransactionalEmail(input: TransactionalEmail, options: SendOptions = {}): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = senderAddress();
  if (!apiKey || !from) {
    // No silent fallback and no silent success: the operator sees exactly what is
    // missing. The caller keeps the visitor's answer neutral either way.
    const missing = [!apiKey && "RESEND_API_KEY", !from && "RESEND_EMAIL_FROM"].filter(Boolean).join(" and ");
    console.error(`[vintage-gantt] transactional email is not configured: missing on this deployment — ${missing}. No email was sent.`);
    throw new Error(EMAIL_NOT_CONFIGURED_MESSAGE);
  }

  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastFailure = "no attempt was made";

  for (let attempt = 1; attempt <= EMAIL_MAX_ATTEMPTS; attempt += 1) {
    let status = 0;
    let body = "";
    try {
      const response = await doFetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: input.to, subject: input.subject, html: input.html }),
      });
      status = response.status;
      body = await response.text().catch(() => "");
      if (response.ok) {
        let id: string | null = null;
        try {
          id = (JSON.parse(body) as { id?: string }).id ?? null;
        } catch {
          id = null;
        }
        return { provider: "resend", id };
      }
      lastFailure = describeFailure(status, body);
    } catch (error) {
      // A transport failure has no status; its message is scrubbed like any other.
      lastFailure = scrubSecrets(error instanceof Error ? error.message : String(error));
    }

    if (!isTransient(status) || attempt === EMAIL_MAX_ATTEMPTS) break;
    console.warn(`[vintage-gantt] transactional email failed (${lastFailure}); retrying (attempt ${attempt + 1} of ${EMAIL_MAX_ATTEMPTS}).`);
    await sleep(EMAIL_RETRY_BASE_MS * 2 ** (attempt - 1));
  }

  console.error(`[vintage-gantt] transactional email could not be sent: ${lastFailure}`);
  throw new Error("The email could not be sent.");
}
