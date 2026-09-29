import { AuthShell } from "@/components/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/convex/_generated/api";
import { AUTH_PATHS, authHref, normalizeEmail, resolveRedirectAfterAuth } from "@/lib/auth-routes";
import { useAction } from "convex/react";
import { KeyRound, Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

/**
 * Ask for a password reset link.
 *
 * The answer is always the same — "if an account exists …" — whether the address
 * has an account or not, and the request itself always reports success. Nothing
 * here reveals an account, and the link is sent by email, never shown.
 */
export default function ForgotPassword() {
  const requestReset = useAction(api.passwordRecovery.requestReset);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get("returnTo");
  const redirect = resolveRedirectAfterAuth(returnTo);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState(searchParams.get("email") ?? "");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const address = normalizeEmail(email);
    if (!address) return;
    setBusy(true);
    try {
      // The action answers `{ ok: true }` whatever the address and whatever
      // happens while sending, so there is nothing here to branch on.
      await requestReset({
        email: address,
        origin: typeof window === "undefined" ? undefined : window.location.origin,
      });
    } catch {
      // Even an unexpected failure gets the same neutral answer, and the error is
      // never logged: it could carry the address or the link.
      console.warn("Password reset request did not complete.");
    }
    setBusy(false);
    // The next screen always says the same thing: if an account exists for the
    // address, a link has been sent. Whether it was is not visible here.
    navigate(
      authHref(AUTH_PATHS.reset, address, { ...(returnTo ? { returnTo } : {}), sent: "1" }),
      { replace: true },
    );
  };

  return (
    <AuthShell
      eyebrow="Password reset"
      title="Forgot your password?"
      description="Enter your email address and we will send you a link to set a new password."
      redirect={redirect}
      footer={
        <span>
          Remembered it?{" "}
          <Link to={authHref(AUTH_PATHS.signIn, undefined, returnTo ? { returnTo } : undefined)}>Back to sign in</Link>
        </span>
      }
    >
      <form className="auth-form" onSubmit={submit} noValidate>
        <label className="auth-field">
          <span>Email address</span>
          <Input
            name="email"
            type="email"
            autoComplete="email"
            placeholder="name@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
            required
          />
        </label>

        <Button type="submit" className="auth-submit" disabled={busy || !normalizeEmail(email)}>
          {busy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Sending…
            </>
          ) : (
            <>
              <KeyRound className="h-4 w-4" /> Send reset link
            </>
          )}
        </Button>
      </form>
    </AuthShell>
  );
}
