import { AppBar } from "@/components/AppBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  CURRENT_PASSWORD_WRONG_MESSAGE,
  PASSWORD_MISMATCH_MESSAGE,
  PASSWORD_RULES_TEXT,
  passwordProblem,
} from "@/lib/company-users";
import { useCalendarStore } from "@/lib/calendar-store";
import { useAuth } from "@/hooks/use-auth";
import { Loader2, LockKeyhole } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";

/**
 * Change password — the one screen an account with a temporary password may use.
 *
 * An account created by a company admin, or whose password the admin reset, has
 * to set its own password before it can open anything else. The current (that
 * is, temporary) password is required, the new one must follow the password rule
 * and differ from the temporary one, and the account then continues into the
 * planner. No email is involved anywhere.
 */
export default function ChangePassword() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { changeOwnPassword, mustChangePassword } = useCalendarStore();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (!currentPassword) return setError(CURRENT_PASSWORD_WRONG_MESSAGE);
    const weak = passwordProblem(newPassword);
    if (weak) return setError(weak);
    if (newPassword !== confirmPassword) return setError(PASSWORD_MISMATCH_MESSAGE);
    setBusy(true);
    setError(null);
    const result = await changeOwnPassword({ currentPassword, newPassword });
    setBusy(false);
    if (!result.ok) {
      setError(result.message ?? "Could not change your password.");
      return;
    }
    navigate("/dashboard", { replace: true });
  };

  return (
    <div className="planner-shell">
      <AppBar activeKey="planner" label="Change password" />
      <main className="projects-screen">
        <div className="projects-heading">
          <div>
            <div className="eyebrow">{mustChangePassword ? "FIRST SIGN-IN" : "MY ACCOUNT"}</div>
            <h2>Change password</h2>
            <p>
              {mustChangePassword
                ? "You signed in with a temporary password. Set your own password to continue."
                : "Choose a new password. Other sessions of your account are signed out; this device stays signed in."}
              {user?.email ? ` Signed in as ${user.email}.` : ""}
            </p>
          </div>
        </div>

        <section className="project-catalog-card company-users-card">
          <form className="company-users-form" onSubmit={submit} noValidate>
            <label className="company-users-field">
              <span>Current password</span>
              <Input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" disabled={busy} required />
            </label>
            <label className="company-users-field">
              <span>New password</span>
              <Input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" disabled={busy} required />
              <span className="company-users-rule">{PASSWORD_RULES_TEXT} It must differ from your current password.</span>
            </label>
            <label className="company-users-field">
              <span>Confirm new password</span>
              <Input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" disabled={busy} required />
            </label>

            {error ? <p className="auth-error" role="alert">{error}</p> : null}

            <div>
              <Button type="submit" disabled={busy || !currentPassword || !newPassword || !confirmPassword}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LockKeyhole className="h-4 w-4" />} Set new password
              </Button>
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}
