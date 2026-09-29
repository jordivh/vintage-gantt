import { AuthShell } from "@/components/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import {
  AUTH_PATHS,
  authHref,
  EMAIL_PATTERN,
  normalizeEmail,
  registrationMessage,
  registrationMessageFor,
  resolveRedirectAfterAuth,
} from "@/lib/auth-routes";
import { useMutation } from "convex/react";
import { Building2, Loader2, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";

/**
 * Register a company: its name, and its first account — the company admin.
 *
 * The company and the account are created together by one backend mutation
 * (`companies.registerCompany`), in one transaction: if any part of it is
 * refused, nothing at all is written. The password is hashed by Convex Auth
 * into its own credential table; no password is stored in an application table
 * or in browser storage. Once the company exists this signs the new admin in,
 * and `AuthShell` opens their environment.
 */
export default function RegisterCompany() {
  const { signIn } = useAuth();
  const registerCompany = useMutation(api.companies.registerCompany);
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get("returnTo");
  const redirect = resolveRedirectAfterAuth(returnTo);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const companyName = String(form.get("companyName") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    const email = normalizeEmail(String(form.get("email") ?? ""));
    const password = String(form.get("password") ?? "");

    // Checked here as well as on the server so the very first answer is instant.
    if (!companyName) return setError(registrationMessageFor("missing_company"));
    if (!name) return setError(registrationMessageFor("missing_name"));
    if (!EMAIL_PATTERN.test(email)) return setError(registrationMessageFor("invalid_email"));
    if (password.length < 8) return setError(registrationMessageFor("weak_password"));

    setBusy(true);
    setError(null);
    try {
      // One transaction on the server: the company and its first account are
      // created together, or neither is. Any refusal throws with a code, and
      // the message names it — nothing about the database is echoed here.
      await registerCompany({ companyName, name, email, password });
    } catch (cause) {
      console.error("Company registration failed:", cause);
      setError(registrationMessage(cause));
      setBusy(false);
      return;
    }
    try {
      // The company exists now; signing in opens it through `AuthShell`.
      await signIn("password", { email, password, flow: "signIn" });
    } catch (cause) {
      console.error("Signing in as the new company admin failed:", cause);
      setError("Your company account was created. Please sign in with your new password.");
    }
    setBusy(false);
  };

  return (
    <AuthShell
      eyebrow="New company"
      title="Register your company"
      description="Create the company workspace and its first account. You become the company admin and can add the rest of your team afterwards."
      redirect={redirect}
      wide
      footer={
        <span>
          Already have an account?{" "}
          <Link to={authHref(AUTH_PATHS.signIn, undefined, returnTo ? { returnTo } : undefined)}>Sign in</Link>
        </span>
      }
    >
      <form className="auth-form" onSubmit={submit} noValidate>
        <label className="auth-field">
          <span>Company name</span>
          <Input
            name="companyName"
            type="text"
            autoComplete="organization"
            placeholder="Keystone Exhibit Co"
            disabled={busy}
            required
          />
        </label>
        <label className="auth-field">
          <span>Your name</span>
          <Input
            name="name"
            type="text"
            autoComplete="name"
            placeholder="Marta Visser"
            disabled={busy}
            required
          />
        </label>
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
            autoComplete="new-password"
            placeholder="At least 8 characters"
            disabled={busy}
            required
          />
          <span className="auth-hint">At least 8 characters. Stored only as a hash by the auth service.</span>
        </label>

        {error ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}

        <Button type="submit" className="auth-submit" disabled={busy}>
          {busy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Creating your company…
            </>
          ) : (
            <>
              <Building2 className="h-4 w-4" /> Create company account <UserPlus className="h-4 w-4" />
            </>
          )}
        </Button>
      </form>
    </AuthShell>
  );
}
