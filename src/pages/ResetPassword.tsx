import { AuthShell } from "@/components/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { AUTH_PATHS, authHref, resolveRedirectAfterAuth } from "@/lib/auth-routes";
import {
  PASSWORD_MISMATCH_ERROR,
  RESET_LINK_ERROR,
  RESET_REQUEST_NOTICE,
  passwordProblem,
  resetErrorMessage,
} from "@/lib/password-reset";
import { useMutation } from "convex/react";
import { CheckCircle2, Loader2, LockKeyhole, MailCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";

/**
 * Set a new password from a reset link.
 *
 * The link carries one single-use value; it is never shown, logged or echoed in
 * an error. A link that is wrong, expired or already used reads exactly the
 * same here, and a successful reset replaces the password, spends the link and
 * drops the account's other sessions — the account keeps its company and role.
 */
export default function ResetPassword() {
  const { signIn } = useAuth();
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get("returnTo");
  const redirect = resolveRedirectAfterAuth(returnTo);
  const token = searchParams.get("token") ?? "";
  const requested = searchParams.get("sent") === "1";
  const completeReset = useMutation(api.passwordRecovery.completeReset);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    const confirm = String(form.get("confirm") ?? "");
    const weak = passwordProblem(password);
    if (weak) return setError(weak);
    if (password !== confirm) return setError(PASSWORD_MISMATCH_ERROR);

    setBusy(true);
    setError(null);
    let address = "";
    try {
      const result = await completeReset({ token, password });
      address = result.email;
    } catch (cause) {
      // Never the error object: it can carry the link's value.
      console.error("Password reset failed.");
      setError(resetErrorMessage(cause));
      setBusy(false);
      return;
    }
    // The link has been spent; take its value out of the address bar and history.
    if (typeof window !== "undefined") window.history.replaceState(null, "", AUTH_PATHS.reset);
    try {
      // Signed in with the new password: `AuthShell` opens the environment.
      await signIn("password", { email: address, password, flow: "signIn" });
    } catch {
      setFinished(true);
    }
    setBusy(false);
  };

  const forgotLink = (
    <Link to={authHref(AUTH_PATHS.forgot, undefined, returnTo ? { returnTo } : undefined)}>Request a new link</Link>
  );

  const description = finished
    ? "Your password has been changed. Sign in with your new password."
    : token
      ? "Choose a new password. The link can be used once and then stops working."
      : requested
        ? RESET_REQUEST_NOTICE
        : RESET_LINK_ERROR;

  return (
    <AuthShell
      eyebrow="Password reset"
      title={finished ? "Password changed" : token ? "Choose a new password" : requested ? "Check your email" : "Reset link"}
      description={description}
      redirect={redirect}
      footer={
        <>
          <span>{forgotLink}</span>
          <span>
            <Link to={authHref(AUTH_PATHS.signIn, undefined, returnTo ? { returnTo } : undefined)}>Back to sign in</Link>
          </span>
        </>
      }
    >
      {finished ? (
        <p className="auth-hint" role="status">
          <CheckCircle2 size={15} /> You can now sign in with your new password.
        </p>
      ) : !token ? (
        <p className="auth-hint" role="status">
          {requested ? <MailCheck size={15} /> : null}
          {requested
            ? "Follow the link in the email to set a new password. Nothing else is needed here."
            : "Open the link from your reset email, or request a new one."}
        </p>
      ) : (
        <form className="auth-form" onSubmit={submit} noValidate>
          <label className="auth-field">
            <span>New password</span>
            <Input
              name="password"
              type="password"
              autoComplete="new-password"
              placeholder="At least 8 characters"
              disabled={busy}
              required
            />
            <span className="auth-hint">At least 8 characters. Stored only as a hash by the auth service.</span>
          </label>
          <label className="auth-field">
            <span>Repeat the new password</span>
            <Input
              name="confirm"
              type="password"
              autoComplete="new-password"
              placeholder="The same password again"
              disabled={busy}
              required
            />
          </label>

          {error ? (
            <p className="auth-error" role="alert">{error}</p>
          ) : null}

          <Button type="submit" className="auth-submit" disabled={busy}>
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Saving…
              </>
            ) : (
              <>
                <LockKeyhole className="h-4 w-4" /> Set new password
              </>
            )}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
