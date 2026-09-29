import { AuthShell } from "@/components/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { AUTH_PATHS, authHref, normalizeEmail, resolveRedirectAfterAuth } from "@/lib/auth-routes";
import { KeyRound, Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

/**
 * Ask for a password reset code.
 *
 * The answer is always the same — "if an account exists …" — whether the
 * address has an account or not, because sending a code for an unknown address
 * fails on the server and that failure must not say anything. The code itself
 * is sent by the auth service to the address, never shown here.
 */
export default function ForgotPassword() {
  const { signIn } = useAuth();
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
      await signIn("password", { email: address, flow: "reset" });
    } catch (cause) {
      // Unknown address, delivery problem or rate limit: the next screen says
      // the same thing either way, so nothing is revealed here.
      console.warn("Password reset request did not send a code:", cause);
    } finally {
      setBusy(false);
    }
    // The next screen always says the same thing: if an account exists for the
    // address, a code has been sent. Whether it was is not visible here.
    navigate(
      authHref(AUTH_PATHS.reset, address, { ...(returnTo ? { returnTo } : {}), sent: "1" }),
      { replace: true },
    );
  };

  return (
    <AuthShell
      eyebrow="Password reset"
      title="Forgot your password?"
      description="Enter your email address and we will send a 6-digit code to set a new password."
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
              <KeyRound className="h-4 w-4" /> Send reset code
            </>
          )}
        </Button>
      </form>
    </AuthShell>
  );
}
