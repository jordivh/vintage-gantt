import { AppBar } from "@/components/AppBar";
import { useCalendarStore } from "@/lib/calendar-store";
import { COMPANY_ADMIN, COMPANY_ROLE_DESCRIPTIONS, COMPANY_ROLE_LABELS, COMPANY_USER, type CompanyRole } from "@/lib/company-scope";
import { ArrowLeft, Loader2, MailPlus, Send, ShieldCheck, Trash2, UserCog } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";

const formatDate = (iso: string | undefined) => {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

/**
 * Company users — the admin-only screen for the accounts in this company.
 *
 * It shows the active users and the pending invitations and is the only place
 * from which an invitation is created, resent or revoked and a user removed or
 * promoted. Every action goes through a server check that the caller is a
 * company admin of this company, so opening the URL by hand changes nothing.
 */
export default function CompanyUsers() {
  const navigate = useNavigate();
  const {
    company,
    canManageMembers,
    pendingInvitations,
    inviteCompanyMember,
    resendCompanyInvitation,
    revokeCompanyInvitation,
    removeCompanyMember,
    setCompanyMemberRole,
    transferCompanyAdmin,
  } = useCalendarStore();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

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
            <p className="calendar-copy">Only a company admin can manage the users and invitations of this company.</p>
          </section>
        </main>
      </div>
    );
  }

  const members = company?.members ?? [];
  const activeCount = members.length;
  const adminCount = members.filter((member) => member.role === COMPANY_ADMIN).length;

  const submitInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const address = email.trim();
    if (!address || busy) return;
    setBusy(true);
    const result = await inviteCompanyMember(address);
    setBusy(false);
    if (result.ok) {
      setEmail("");
      setMessage({ text: result.message ?? "Invitation sent.", error: false });
    } else {
      setMessage({ text: result.message ?? "Could not send the invitation.", error: true });
    }
  };

  const changeRole = async (userId: string, role: CompanyRole) => {
    const result = await setCompanyMemberRole(userId, role);
    setMessage(result.ok ? null : { text: result.message ?? "Could not change this account type.", error: true });
  };

  const remove = async (userId: string, name: string) => {
    const result = await removeCompanyMember(userId);
    setMessage(result.ok
      ? { text: `${name} no longer has access. Their projects and planning data are untouched.`, error: false }
      : { text: result.message ?? "Could not remove this account.", error: true });
  };

  const transfer = async (userId: string, name: string) => {
    const result = await transferCompanyAdmin(userId);
    setMessage(result.ok
      ? { text: `${name} is now the company admin and you are a regular user.`, error: false }
      : { text: result.message ?? "Could not transfer company admin.", error: true });
  };

  const resend = async (address: string) => {
    const result = await resendCompanyInvitation(address);
    setMessage(result.ok
      ? { text: result.message ?? `Invitation sent to ${address}.`, error: false }
      : { text: result.message ?? "Could not resend the invitation.", error: true });
  };

  const revoke = async (invitationId: string, address: string) => {
    const result = await revokeCompanyInvitation(invitationId);
    setMessage(result.ok
      ? { text: `The invitation for ${address} was revoked.`, error: false }
      : { text: result.message ?? "Could not revoke the invitation.", error: true });
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
              Accounts and invitations of {company?.company?.name ?? "your company"}.
              Company admins and users have identical rights for projects, planning, resources, calendars and capacity — the difference is only here.
            </p>
          </div>
          <div className="company-users-meta">
            <span><b>{activeCount}</b> active {activeCount === 1 ? "user" : "users"}</span>
            <span><b>{adminCount}</b> {adminCount === 1 ? "admin" : "admins"}</span>
            <span><b>{pendingInvitations.length}</b> pending</span>
          </div>
        </div>

        {message && <p className={message.error ? "scope-notice error" : "scope-notice"} role="status">{message.text}</p>}

        <section className="project-catalog-card company-users-card">
          <div className="company-users-head">
            <div>
              <div className="eyebrow">INVITE A USER</div>
              <p className="calendar-copy">We email a single-use acceptance link. It expires after seven days, and resending replaces the previous link.</p>
            </div>
          </div>
          <form className="company-users-invite" onSubmit={submitInvite}>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@example.com"
              aria-label="Email address to invite"
              disabled={busy}
            />
            <button type="submit" className="tool-button primary" disabled={busy || !email.trim()}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <MailPlus size={15} />} Send invitation
            </button>
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

        <section className="project-catalog-card company-users-card">
          <div className="eyebrow">PENDING INVITATIONS</div>
          {pendingInvitations.length === 0 ? (
            <p className="calendar-copy">No pending invitations.</p>
          ) : (
            <table className="project-table company-users-table">
              <thead>
                <tr><th>Email</th><th>Invited</th><th>Expires</th><th>Status</th><th className="company-users-actions-head">Actions</th></tr>
              </thead>
              <tbody>
                {pendingInvitations.map((invitation) => (
                  <tr key={invitation.id}>
                    <td className="company-users-email">{invitation.email}</td>
                    <td>{formatDate(invitation.createdAt)}</td>
                    <td>{formatDate(invitation.expiresAt)}</td>
                    <td><span className="role-chip">{invitation.stateLabel}</span></td>
                    <td>
                      <div className="company-row-actions">
                        <button type="button" className="tool-button" title="Send a fresh link; the previous one stops working" onClick={() => void resend(invitation.email)}>
                          <Send size={14} /> Resend
                        </button>
                        <button type="button" className="tool-button danger" title="Revoke this invitation" onClick={() => void revoke(invitation.id, invitation.email)}>
                          <Trash2 size={14} /> Revoke
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </div>
  );
}
