import { AuthShell } from "@/components/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { AUTH_PATHS, resolveRedirectAfterAuth } from "@/lib/auth-routes";
import { INVITATION_ERROR_MESSAGES, invitationErrorMessage } from "@/lib/company-users";
import { useMutation } from "convex/react";
import { Loader2, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";

/**
 * Accept an invitation: the invited person sets a name and a password and
 * becomes a regular user of the inviting company.
 *
 * The link carries one single-use value. A used, expired, revoked or unknown
 * link fails with one generic message and never creates an account, and no
 * failure here says anything about the company, its users or its data.
 */
export default function AcceptInvitation() {
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get("returnTo");
  const token = searchParams.get("token") ?? "";
  const { signIn } = useAuth();
  const acceptInvitation = useMutation(api.companies.acceptInvitation);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : INVITATION_ERROR_MESSAGES.invalid);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (!name) return setError(INVITATION_ERROR_MESSAGES.missing_name);
    if (password.length < 8) return setError(INVITATION_ERROR_MESSAGES.weak_password);

    setBusy(true);
    setError(null);
    let email = "";
    try {
      const result = await acceptInvitation({ token, name, password });
      email = result.email;
    } catch (cause) {
      // Never the error object: it can carry the invitation value or the password.
      console.error("Accepting the invitation failed.");
      setError(invitationErrorMessage(cause));
      setBusy(false);
      return;
    }
    try {
      // The account exists now; signing in opens the company environment.
      await signIn("password", { email, password, flow: "signIn" });
    } catch {
      console.error("Signing in after accepting the invitation failed.");
      setError("Your account is ready. Please sign in with your email address and password.");
    }
    setBusy(false);
  };

  return (
    <AuthShell
      eyebrow="Invitation"
      title="Join your company"
      description="Set your name and a password to become a user of the company that invited you."
      redirect={resolveRedirectAfterAuth(returnTo)}
      footer={
        <span>
          Already have an account? <Link to={AUTH_PATHS.signIn}>Sign in</Link>
        </span>
      }
    >
      <form className="auth-form" onSubmit={submit} noValidate>
        <label className="auth-field">
          <span>Your name</span>
          <Input name="name" type="text" autoComplete="name" placeholder="Marta Visser" disabled={busy || !token} required />
        </label>
        <label className="auth-field">
          <span>Password</span>
          <Input name="password" type="password" autoComplete="new-password" placeholder="At least 8 characters" disabled={busy || !token} required />
          <span className="auth-hint">At least 8 characters. Stored only as a hash by the auth service.</span>
        </label>

        {error ? (
          <p className="auth-error" role="alert">{error}</p>
        ) : null}

        <Button type="submit" className="auth-submit" disabled={busy || !token}>
          {busy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Joining…
            </>
          ) : (
            <>
              <UserPlus className="h-4 w-4" /> Join the company
            </>
          )}
        </Button>
      </form>
    </AuthShell>
  );
}
