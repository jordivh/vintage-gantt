import { AuthShell } from "@/components/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import {
  AUTH_PATHS,
  authHref,
  normalizeEmail,
  resolveRedirectAfterAuth,
  SIGN_IN_ERROR,
} from "@/lib/auth-routes";
import { ArrowRight, Loader2, LockKeyhole } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";

interface AuthProps {
  redirectAfterAuth?: string;
}

/**
 * Sign in with the email address and password of a company account.
 *
 * Every failure worth reporting says the same thing: a wrong password, an
 * address that has no account at all, and a temporarily rate-limited address
 * are indistinguishable here, so this screen never reveals whether an email
 * address exists. Expanding the environment happens through `AuthShell` as soon
 * as the session is established, and the session survives a page refresh
 * because Convex Auth keeps its access and refresh tokens in the browser.
 */
function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const { signIn } = useAuth();
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get("returnTo");
  const redirect = resolveRedirectAfterAuth(returnTo, redirectAfterAuth ?? undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = normalizeEmail(String(form.get("email") ?? ""));
    const password = String(form.get("password") ?? "");
    setError(null);
    if (!email || !password) {
      setError(SIGN_IN_ERROR);
      return;
    }
    setBusy(true);
    try {
      await signIn("password", { email, password, flow: "signIn" });
      // Signed in: `AuthShell` opens the requested page (or the dashboard).
    } catch {
      // Never the error object: it can carry the submitted credentials.
      console.error("Password sign-in failed.");
      setError(SIGN_IN_ERROR);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      eyebrow="Company workspace"
      title="Sign in"
      description="Open your company's planning environment with your email address and password."
      redirect={redirect}
      footer={
        <>
          <span>
            No account yet?{" "}
            <Link to={authHref(AUTH_PATHS.register, undefined, returnTo ? { returnTo } : undefined)}>
              Register your company
            </Link>
          </span>
          <span>
            <Link to={authHref(AUTH_PATHS.forgot)}>Forgot your password?</Link>
          </span>
        </>
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
            disabled={busy}
            required
          />
        </label>
        <label className="auth-field">
          <span>Password</span>
          <Input
            name="password"
            type="password"
            autoComplete="current-password"
            placeholder="Your password"
            disabled={busy}
            required
          />
        </label>

        {error ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}

        <Button type="submit" className="auth-submit" disabled={busy}>
          {busy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Signing in…
            </>
          ) : (
            <>
              <LockKeyhole className="h-4 w-4" /> Sign in <ArrowRight className="h-4 w-4" />
            </>
          )}
        </Button>
      </form>
    </AuthShell>
  );
}

export default function AuthPage(props: AuthProps) {
  return <Auth {...props} />;
}
