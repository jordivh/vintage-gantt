import { AppBar } from "@/components/AppBar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  EMAIL_PATTERN,
  PASSWORD_MISMATCH_MESSAGE,
  PASSWORD_RULES_TEXT,
  normalizeEmail,
  passwordProblem,
  userCreatedMessage,
} from "@/lib/company-users";
import { useCalendarStore } from "@/lib/calendar-store";
import { COMPANY_ADMIN, COMPANY_ROLE_DESCRIPTIONS, COMPANY_ROLE_LABELS, COMPANY_USER, type CompanyRole } from "@/lib/company-scope";
import { ArrowLeft, KeyRound, Loader2, ShieldCheck, Trash2, UserCog, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";

/**
 * Company users — the admin-only screen for the accounts in this company.
 *
 * There is no email here: an admin creates an account directly with a temporary
 * password, resets a password when somebody forgets theirs, removes a user or
 * hands over company admin. Every action goes through a server check that the
 * caller is a company admin of this company, so opening the URL by hand changes
 * nothing.
 */
export default function CompanyUsers() {
  const navigate = useNavigate();
  const {
    company,
    canManageMembers,
    addCompanyUser,
    resetCompanyUserPassword,
    removeCompanyMember,
    setCompanyMemberRole,
    transferCompanyAdmin,
  } = useCalendarStore();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const [resetTarget, setResetTarget] = useState<{ userId: string; name: string } | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetConfirm, setResetConfirm] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  // A regular user never sees this screen as a management screen. Nothing is
  // requested from the server for them, and the backend refuses regardless.
  if (!canManageMembers) {
    return (
      <div className="planner-shell">
        <AppBar activeKey="planner" label="Company users" />
        <main className="projects-screen">
          <button className="link-button" onClick={() => navigate("/dashboard")}><ArrowLeft size={14} /> Back to planner</button>
          <section className="project-catalog-card company-users-card">
            <h2>Company users</h2>
            <p className="calendar-copy">Only a company admin can manage the user accounts of this company.</p>
          </section>
        </main>
      </div>
    );
  }

  const members = company?.members ?? [];
  const activeCount = members.length;
  const adminCount = members.filter((member) => member.role === COMPANY_ADMIN).length;

  const submitAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const address = normalizeEmail(email);
    if (!name.trim()) return setMessage({ text: "Enter a name.", error: true });
    if (!EMAIL_PATTERN.test(address)) return setMessage({ text: "Enter a valid email address.", error: true });
    const weak = passwordProblem(password);
    if (weak) return setMessage({ text: weak, error: true });
    if (password !== confirm) return setMessage({ text: PASSWORD_MISMATCH_MESSAGE, error: true });

    setBusy(true);
    const result = await addCompanyUser({ name, email: address, password });
    setBusy(false);
    if (result.ok) {
      setName("");
      setEmail("");
      setPassword("");
      setConfirm("");
      setMessage({ text: userCreatedMessage(address), error: false });
    } else {
      setMessage({ text: result.message ?? "Could not create the account.", error: true });
    }
  };

  const changeRole = async (userId: string, role: CompanyRole) => {
    const result = await setCompanyMemberRole(userId, role);
    setMessage(result.ok ? null : { text: result.message ?? "Could not change this account type.", error: true });
  };

  const remove = async (userId: string, memberName: string) => {
    const result = await removeCompanyMember(userId);
    setMessage(result.ok
      ? { text: `${memberName} no longer has access. Their projects and planning data are untouched.`, error: false }
      : { text: result.message ?? "Could not remove this account.", error: true });
  };

  const transfer = async (userId: string, memberName: string) => {
    const result = await transferCompanyAdmin(userId);
    setMessage(result.ok
      ? { text: `${memberName} is now the company admin and you are a regular user.`, error: false }
      : { text: result.message ?? "Could not transfer company admin.", error: true });
  };

  const openReset = (userId: string, memberName: string) => {
    setResetTarget({ userId, name: memberName });
    setResetPassword("");
    setResetConfirm("");
    setResetError(null);
  };

  const submitReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!resetTarget || resetBusy) return;
    const weak = passwordProblem(resetPassword);
    if (weak) return setResetError(weak);
    if (resetPassword !== resetConfirm) return setResetError(PASSWORD_MISMATCH_MESSAGE);
    setResetBusy(true);
    const result = await resetCompanyUserPassword(resetTarget.userId, resetPassword);
    setResetBusy(false);
    if (!result.ok) {
      setResetError(result.message ?? "Could not reset this password.");
      return;
    }
    setMessage({ text: `A new temporary password was set for ${resetTarget.name}. They are signed out everywhere and must change it at their next sign-in.`, error: false });
    setResetTarget(null);
  };

  return (
    <div className="planner-shell">
      <AppBar activeKey="planner" label="Company users" />
      <main className="projects-screen">
        <button className="link-button" onClick={() => navigate("/dashboard")}><ArrowLeft size={14} /> Back to planner</button>

        <div className="projects-heading">
          <div>
            <div className="eyebrow">COMPANY ADMIN</div>
            <h2>Company users</h2>
            <p>
              Accounts of {company?.company?.name ?? "your company"}.
              Company admins and users have identical rights for projects, planning, resources, calendars and capacity — the difference is only here.
            </p>
          </div>
          <div className="company-users-meta">
            <span><b>{activeCount}</b> active {activeCount === 1 ? "user" : "users"}</span>
            <span><b>{adminCount}</b> {adminCount === 1 ? "admin" : "admins"}</span>
          </div>
        </div>

        {message && <p className={message.error ? "scope-notice error" : "scope-notice"} role="status">{message.text}</p>}

        <section className="project-catalog-card company-users-card">
          <div className="company-users-head">
            <div>
              <div className="eyebrow">ADD A USER</div>
              <p className="calendar-copy">
                Create the account here, then share the temporary password with the person in a secure way.
                The account is active at once and must set its own password at the first sign-in. No email is sent.
              </p>
            </div>
          </div>
          <form className="company-users-form" onSubmit={submitAdd} noValidate>
            <label className="company-users-field">
              <span>Name</span>
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Marta Visser" autoComplete="off" disabled={busy} required />
            </label>
            <label className="company-users-field">
              <span>Email address</span>
              <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" autoComplete="off" disabled={busy} required />
            </label>
            <label className="company-users-field">
              <span>Temporary password</span>
              <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Temporary password" autoComplete="new-password" disabled={busy} required />
              <span className="company-users-rule">{PASSWORD_RULES_TEXT} The person has to change it at the first sign-in.</span>
            </label>
            <label className="company-users-field">
              <span>Confirm password</span>
              <Input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} placeholder="The same password again" autoComplete="new-password" disabled={busy} required />
            </label>
            <div>
              <button type="submit" className="tool-button primary" disabled={busy}>
                {busy ? <Loader2 size={15} className="animate-spin" /> : <UserPlus size={15} />} Add user
              </button>
            </div>
          </form>
        </section>

        <section className="project-catalog-card company-users-card">
          <div className="eyebrow">ACTIVE USERS</div>
          <table className="project-table company-users-table">
            <thead>
              <tr><th>Name</th><th>Email</th><th>Account type</th><th className="company-users-actions-head">Actions</th></tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.userId}>
                  <td><b>{member.name || "Account"}</b>{member.isSelf ? <span className="company-self-tag"> (you)</span> : null}</td>
                  <td className="company-users-email">{member.email || "—"}</td>
                  <td>
                    <span className={`role-chip${member.role === COMPANY_ADMIN ? " admin" : ""}`}>{COMPANY_ROLE_LABELS[member.role]}</span>
                  </td>
                  <td>
                    <div className="company-row-actions">
                      <button type="button" className="tool-button" title="Set a new temporary password and sign this user out everywhere" onClick={() => openReset(member.userId, member.name || member.email)}>
                        <KeyRound size={14} /> Reset password
                      </button>
                      {member.role !== COMPANY_ADMIN && (
                        <button type="button" className="tool-button" title="Make this account a company admin" onClick={() => void changeRole(member.userId, COMPANY_ADMIN)}>
                          <ShieldCheck size={14} /> Make admin
                        </button>
                      )}
                      {member.role === COMPANY_ADMIN && adminCount > 1 && !member.isSelf && (
                        <button type="button" className="tool-button" title="Make this account a regular user" onClick={() => void changeRole(member.userId, COMPANY_USER)}>
                          <UserCog size={14} /> Make user
                        </button>
                      )}
                      {!member.isSelf && member.role !== COMPANY_ADMIN && (
                        <button type="button" className="tool-button" title="Give company admin to this user and step down" onClick={() => void transfer(member.userId, member.name || member.email)}>
                          <ShieldCheck size={14} /> Transfer admin
                        </button>
                      )}
                      {!member.isSelf && (
                        <button type="button" className="tool-button danger" title="Remove this account's access" onClick={() => void remove(member.userId, member.name || member.email)}>
                          <Trash2 size={14} /> Remove
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="calendar-copy">{COMPANY_ROLE_DESCRIPTIONS.user}</p>
        </section>
      </main>

      <Dialog open={resetTarget !== null} onOpenChange={(open) => { if (!open) setResetTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset password</DialogTitle>
            <DialogDescription>
              Set a new temporary password for {resetTarget?.name}. Their open sessions are signed out and they must change the password at the next sign-in.
            </DialogDescription>
          </DialogHeader>
          <form className="company-users-form" onSubmit={submitReset} noValidate>
            <label className="company-users-field">
              <span>Temporary password</span>
              <Input type="password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} autoComplete="new-password" disabled={resetBusy} required />
              <span className="company-users-rule">{PASSWORD_RULES_TEXT}</span>
            </label>
            <label className="company-users-field">
              <span>Confirm password</span>
              <Input type="password" value={resetConfirm} onChange={(event) => setResetConfirm(event.target.value)} autoComplete="new-password" disabled={resetBusy} required />
            </label>
            {resetError ? <p className="auth-error" role="alert">{resetError}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setResetTarget(null)} disabled={resetBusy}>Cancel</Button>
              <Button type="submit" disabled={resetBusy || !resetPassword || !resetConfirm}>
                {resetBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} Reset password
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
