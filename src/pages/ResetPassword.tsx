import { AuthShell } from "@/components/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { useAuth } from "@/hooks/use-auth";
import {
  AUTH_PATHS,
  authHref,
  normalizeEmail,
  resetSentNotice,
  resolveRedirectAfterAuth,
  RESET_CODE_ERROR,
} from "@/lib/auth-routes";
import { Loader2, LockKeyhole } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";

/**
 * Set a new password with the 6-digit code from the reset email.
 *
 * A code that is wrong, expired or belongs to another address reads the same
 * here, and a successful reset replaces the password in Convex Auth's own
 * credential table, signs the visitor in and drops their other sessions. The
 * password is never written to an application table or to browser storage.
 */
export default function ResetPassword() {
  const { signIn } = useAuth();
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get("returnTo");
  const redirect = resolveRedirectAfterAuth(returnTo);
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const address = normalizeEmail(email);
  const sent = searchParams.get("sent") === "1";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("newPassword") ?? "");
    setError(null);
    if (!address || code.length !== 6 || newPassword.length < 8) {
      setError(RESET_CODE_ERROR);
      return;
    }
    setBusy(true);
    try {
      await signIn("password", { email: address, code, newPassword, flow: "reset-verification" });
      // Signed in with the new password: `AuthShell` opens the environment.
    } catch (cause) {
      console.error("Password reset failed:", cause);
      setError(RESET_CODE_ERROR);
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      eyebrow="Password reset"
      title="Choose a new password"
      description={
        address && sent
          ? resetSentNotice(address)
          : "Enter the code from your reset email, then choose a new password."
      }
      redirect={redirect}
      footer={
        <>
          <span>
            Code expired or never arrived?{" "}
            <Link to={authHref(AUTH_PATHS.forgot, address, returnTo ? { returnTo } : undefined)}>
              Send a new code
            </Link>
          </span>
          <span>
            <Link to={authHref(AUTH_PATHS.signIn, undefined, returnTo ? { returnTo } : undefined)}>Back to sign in</Link>
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
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
            required
          />
        </label>

        <div className="auth-field">
          <span>Reset code</span>
          <div className="auth-code">
            <InputOTP
              value={code}
              onChange={setCode}
              maxLength={6}
              disabled={busy}
              onKeyDown={(event) => {
                if (event.key === "Enter" && code.length === 6 && !busy) {
                  (event.target as HTMLElement).closest("form")?.requestSubmit();
                }
              }}
            >
              <InputOTPGroup>
                {Array.from({ length: 6 }).map((_, index) => (
                  <InputOTPSlot key={index} index={index} />
                ))}
              </InputOTPGroup>
            </InputOTP>
          </div>
        </div>

        <label className="auth-field">
          <span>New password</span>
          <Input
            name="newPassword"
            type="password"
            autoComplete="new-password"
            placeholder="At least 8 characters"
            disabled={busy}
            required
          />
          <span className="auth-hint">At least 8 characters.</span>
        </label>

        {error ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}

        <Button type="submit" className="auth-submit" disabled={busy || code.length !== 6}>
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
    </AuthShell>
  );
}
