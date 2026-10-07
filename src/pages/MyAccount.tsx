import { AppBar } from "@/components/AppBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  CURRENT_PASSWORD_WRONG_MESSAGE,
  EMAIL_PATTERN,
  PASSWORD_MISMATCH_MESSAGE,
  PASSWORD_RULES_TEXT,
  normalizeEmail,
  passwordProblem,
} from "@/lib/company-users";
import { useCalendarStore } from "@/lib/calendar-store";
import { useAuth } from "@/hooks/use-auth";
import { ArrowLeft, Check, Loader2, Mail, UserRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";

type Notice = { text: string; error: boolean } | null;

/**
 * My account — the signed-in user's own settings: name, email address and
 * password. Changing the email or the password needs the current password; no
 * confirmation email is ever sent, and the other open sessions of the account
 * are signed out while this device stays signed in.
 */
export default function MyAccount() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { changeOwnName, changeOwnEmail, changeOwnPassword } = useCalendarStore();

  const [name, setName] = useState(user?.name ?? "");
  const [nameBusy, setNameBusy] = useState(false);
  const [nameNotice, setNameNotice] = useState<Notice>(null);

  const [newEmail, setNewEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailNotice, setEmailNotice] = useState<Notice>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState<Notice>(null);

  const submitName = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (nameBusy) return;
    if (!name.trim()) return setNameNotice({ text: "Enter a name.", error: true });
    setNameBusy(true);
    const result = await changeOwnName(name);
    setNameBusy(false);
    setNameNotice(result.ok ? { text: "Your name was saved.", error: false } : { text: result.message ?? "Could not save your name.", error: true });
  };

  const submitEmail = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (emailBusy) return;
    const address = normalizeEmail(newEmail);
    if (!EMAIL_PATTERN.test(address)) return setEmailNotice({ text: "Enter a valid email address.", error: true });
    if (!emailPassword) return setEmailNotice({ text: CURRENT_PASSWORD_WRONG_MESSAGE, error: true });
    setEmailBusy(true);
    const result = await changeOwnEmail({ currentPassword: emailPassword, email: address });
    setEmailBusy(false);
    if (result.ok) {
      setNewEmail("");
      setEmailPassword("");
      setEmailNotice({ text: `Your email address is now ${address}. Sign in with it from now on.`, error: false });
    } else {
      setEmailNotice({ text: result.message ?? "Could not change your email address.", error: true });
    }
  };

  const submitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (passwordBusy) return;
    if (!currentPassword) return setPasswordNotice({ text: CURRENT_PASSWORD_WRONG_MESSAGE, error: true });
    const weak = passwordProblem(newPassword);
    if (weak) return setPasswordNotice({ text: weak, error: true });
    if (newPassword !== confirmPassword) return setPasswordNotice({ text: PASSWORD_MISMATCH_MESSAGE, error: true });
    setPasswordBusy(true);
    const result = await changeOwnPassword({ currentPassword, newPassword });
    setPasswordBusy(false);
    if (result.ok) {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordNotice({ text: "Your password was changed. You stay signed in here; other sessions were signed out.", error: false });
    } else {
      setPasswordNotice({ text: result.message ?? "Could not change your password.", error: true });
    }
  };

  return (
    <div className="planner-shell">
      <AppBar activeKey="planner" label="My account" />
      <main className="projects-screen">
        <button className="link-button" onClick={() => navigate("/dashboard")}><ArrowLeft size={14} /> Back to planner</button>

        <div className="projects-heading">
          <div>
            <div className="eyebrow">MY ACCOUNT</div>
            <h2>My account</h2>
            <p>Your name, your email address and your password. Nothing here changes your company or your planning rights.</p>
          </div>
        </div>

        <section className="project-catalog-card company-users-card">
          <div className="eyebrow">YOUR NAME</div>
          <p className="calendar-copy">This is the name other users see next to your planning activity.</p>
          <form className="company-users-form" onSubmit={submitName} noValidate>
            <label className="company-users-field">
              <span>Name</span>
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" disabled={nameBusy} />
            </label>
            {nameNotice ? <p className={nameNotice.error ? "scope-notice error" : "scope-notice"} role="status">{nameNotice.text}</p> : null}
            <div>
              <Button type="submit" disabled={nameBusy}>
                {nameBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserRound className="h-4 w-4" />} Save name
              </Button>
            </div>
          </form>
        </section>

        <section className="project-catalog-card company-users-card">
          <div className="eyebrow">EMAIL ADDRESS</div>
          <p className="calendar-copy">You sign in with this address. Changing it needs your current password; no confirmation email is sent.</p>
          <form className="company-users-form" onSubmit={submitEmail} noValidate>
            <label className="company-users-field">
              <span>Current address</span>
              <Input value={user?.email ?? ""} readOnly />
            </label>
            <label className="company-users-field">
              <span>New email address</span>
              <Input type="email" value={newEmail} onChange={(event) => setNewEmail(event.target.value)} placeholder="name@example.com" autoComplete="off" disabled={emailBusy} />
            </label>
            <label className="company-users-field">
              <span>Your current password</span>
              <Input type="password" value={emailPassword} onChange={(event) => setEmailPassword(event.target.value)} autoComplete="current-password" disabled={emailBusy} />
            </label>
            {emailNotice ? <p className={emailNotice.error ? "scope-notice error" : "scope-notice"} role="status">{emailNotice.text}</p> : null}
            <div>
              <Button type="submit" disabled={emailBusy || !newEmail || !emailPassword}>
                {emailBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />} Change email
              </Button>
            </div>
          </form>
        </section>

        <section className="project-catalog-card company-users-card">
          <div className="eyebrow">PASSWORD</div>
          <p className="calendar-copy">{PASSWORD_RULES_TEXT} Other sessions of your account are signed out; this device stays signed in.</p>
          <form className="company-users-form" onSubmit={submitPassword} noValidate>
            <label className="company-users-field">
              <span>Current password</span>
              <Input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" disabled={passwordBusy} />
            </label>
            <label className="company-users-field">
              <span>New password</span>
              <Input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" disabled={passwordBusy} />
            </label>
            <label className="company-users-field">
              <span>Confirm new password</span>
              <Input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" disabled={passwordBusy} />
            </label>
            {passwordNotice ? <p className={passwordNotice.error ? "scope-notice error" : "scope-notice"} role="status">{passwordNotice.text}</p> : null}
            <div>
              <Button type="submit" disabled={passwordBusy || !currentPassword || !newPassword || !confirmPassword}>
                {passwordBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Change password
              </Button>
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}
