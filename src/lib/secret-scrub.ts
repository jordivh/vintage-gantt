/* --------------------------------------------------------------------------
 * Secret scrubbing.
 *
 * A page URL can carry a value that must never leave the browser: an invitation
 * or password-reset link is `?token=…`, and a verification step is `?code=…`.
 * Error monitoring and logging both like to attach the current URL, and an error
 * message often embeds it. Everything that leaves this app for a log, a report
 * or a console passes through `scrubSecrets` first.
 *
 * Pure and total: any string in, the same string out with every secret query
 * parameter replaced by `[redacted]`.
 * ------------------------------------------------------------------------ */

/** Query parameters whose values are secrets, whatever else the URL carries. */
export const SECRET_PARAMETERS = [
  "token",
  "code",
  "otp",
  "password",
  "newPassword",
  "secret",
  "resetToken",
  "invitation",
] as const;

const REDACTED = "[redacted]";

/**
 * `?token=abc&x=1` → `?token=[redacted]&x=1`. Also matches the same parameter
 * inside a longer message (a stack trace, an error string) and in JSON such as
 * `"token":"abc"`, because both spellings reach the same sink.
 */
export function scrubSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const parameter of SECRET_PARAMETERS) {
    const query = new RegExp(`([?&]${parameter}=)[^&#\\s"'\\\\]*`, "gi");
    out = out.replace(query, `$1${REDACTED}`);
    const quoted = new RegExp(`(["']${parameter}["']\\s*:\\s*["'])[^"']*(["'])`, "gi");
    out = out.replace(quoted, `$1${REDACTED}$2`);
  }
  return out;
}

/** The same, for a value that may not be a string (an error, a URL object). */
export function scrubValue(value: unknown): string {
  return scrubSecrets(typeof value === "string" ? value : String(value ?? ""));
}
