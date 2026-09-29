import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router";
import { ChevronDown, CircleHelp, Loader2, LogOut, Search, X } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { NAV_ITEMS, type NavKey } from "@/lib/navigation";
import { useCalendarStore } from "@/lib/calendar-store";
import { COMPANY_ROLE_DESCRIPTIONS, COMPANY_ROLE_LABELS, type CompanyRole } from "@/lib/company-scope";
import { AUTH_PATHS } from "@/lib/auth-routes";

export { NAV_ITEMS };
export type { NavKey };

type AppBarProps = {
  /** Which item in NAV_ITEMS lights up on this screen. */
  activeKey: NavKey;
  /** Breadcrumb tail. Defaults to the active item's label. */
  label?: string;
  /** Live search bindings. The Planner controls these so its grid and project
   *  list filter as you type and its keyboard shortcuts keep working. */
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  onSearchKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
};

/** Logo, breadcrumb, the single primary navigation, the one global search field
 *  and the account menu — identical on every screen. */
export function AppBar({ activeKey, label, searchValue, onSearchChange, onSearchKeyDown }: AppBarProps) {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { company, companyRole, canManageMembers, addCompanyMember, setCompanyMemberRole } = useCalendarStore();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [localSearch, setLocalSearch] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [memberBusy, setMemberBusy] = useState(false);
  const [memberMessage, setMemberMessage] = useState<{ text: string; error: boolean } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const inviteMember = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const email = memberEmail.trim();
    if (!email || memberBusy) return;
    setMemberBusy(true);
    const result = await addCompanyMember(email);
    setMemberBusy(false);
    if (result.ok) {
      setMemberEmail("");
      setMemberMessage({ text: `${email} can now plan in ${company?.company.name ?? "this company"}.`, error: false });
    } else {
      setMemberMessage({ text: result.message ?? "Could not add this account.", error: true });
    }
  };

  const changeMemberRole = async (userId: string, role: CompanyRole) => {
    const result = await setCompanyMemberRole(userId, role);
    setMemberMessage(result.ok ? null : { text: result.message ?? "Could not change this account type.", error: true });
  };

  // Clears the session (the auth service drops its access and refresh tokens)
  // and replaces this protected page in history with the sign-in screen, so
  // going back cannot land on it again.
  const signOutAndLeave = async () => {
    setUserMenuOpen(false);
    await signOut();
    navigate(AUTH_PATHS.signIn, { replace: true });
  };

  const controlled = searchValue !== undefined;
  const value = controlled ? searchValue : localSearch;
  const activeLabel = label ?? NAV_ITEMS.find((item) => item.key === activeKey)?.label ?? "";

  useEffect(() => {
    if (!userMenuOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setUserMenuOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [userMenuOpen]);

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    onSearchKeyDown?.(event);
    // Outside the Planner the bar has no results of its own, so Enter opens the
    // Planner with the query applied; the Planner reads ?q= on mount.
    if (event.key === "Enter" && !controlled) {
      navigate(value ? `/dashboard?q=${encodeURIComponent(value)}` : "/dashboard");
    }
  };

  return (
    <header className="planner-appbar">
      <div className="brand-lockup">
        <div className="brand-mark">⌁</div>
        <button
          className="eyebrow breadcrumb-button"
          onClick={() => navigate("/projects")}
          title="Back to the project catalog"
        >My dashboard / {activeLabel}</button>
      </div>

      <nav className="topnav segmented" aria-label="Main navigation">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            className={`segment${item.key === activeKey ? " active" : ""}`}
            aria-current={item.key === activeKey ? "page" : undefined}
            onClick={() => navigate(item.path)}
          >{item.label}</button>
        ))}
      </nav>

      <div className="appbar-right">
        <div className="search-box appbar-search">
          <Search size={15} />
          <input
            autoComplete="off"
            placeholder="Search projects and tasks"
            aria-label="Search projects and tasks"
            value={value}
            title={controlled ? "Filter the task grid and the project list" : "Type and press Enter to search in the Planner"}
            onChange={(event) => (controlled ? onSearchChange?.(event.target.value) : setLocalSearch(event.target.value))}
            onKeyDown={handleSearchKeyDown}
          />
        </div>
        <div className="toolbar-popover-wrap" ref={menuRef}>
          <button
            className="avatar-menu"
            title={user?.name ?? "Account"}
            aria-haspopup="menu"
            aria-expanded={userMenuOpen}
            onClick={() => setUserMenuOpen((open) => !open)}
          >
            <span className="avatar">{user?.name?.slice(0, 1) ?? "M"}</span>
            <ChevronDown size={13} />
          </button>
          {userMenuOpen && (
            <div className="toolbar-popover overflow-popover user-popover">
              <div className="popover-heading">
                <b>{user?.name ?? "Account"}</b>
                <button onClick={() => setUserMenuOpen(false)}><X size={14} /></button>
              </div>
              <div className="user-save-state"><span className="live-dot" /> Saved just now</div>
              {company && (
                <div className="company-block">
                  <div className="popover-heading"><span>COMPANY</span></div>
                  <div className="company-name">
                    <b>{company.company.name}</b>
                    <span className={`role-chip${companyRole === "company_admin" ? " admin" : ""}`}>{COMPANY_ROLE_LABELS[companyRole]}</span>
                  </div>
                  <p className="company-hint">
                    {canManageMembers ? COMPANY_ROLE_DESCRIPTIONS.company_admin : COMPANY_ROLE_DESCRIPTIONS.user}
                  </p>
                  <div className="company-members">
                    {company.members.map((member) => (
                      <div className="company-member" key={member.userId}>
                        <span className="company-member-name" title={member.email || member.name}>
                          {member.name || member.email || "Account"}{member.isSelf ? " (you)" : ""}
                        </span>
                        {canManageMembers ? (
                          <select
                            value={member.role}
                            aria-label={`Account type of ${member.name || member.email}`}
                            onChange={(event) => void changeMemberRole(member.userId, event.target.value as CompanyRole)}
                          >
                            <option value="company_admin">{COMPANY_ROLE_LABELS.company_admin}</option>
                            <option value="user">{COMPANY_ROLE_LABELS.user}</option>
                          </select>
                        ) : (
                          <span className="company-member-role">{COMPANY_ROLE_LABELS[member.role]}</span>
                        )}
                      </div>
                    ))}
                  </div>
                  {canManageMembers && (
                    <form className="company-invite" onSubmit={inviteMember}>
                      <input
                        value={memberEmail}
                        onChange={(event) => setMemberEmail(event.target.value)}
                        placeholder="Add member by email"
                        aria-label="Add member by email"
                        disabled={memberBusy}
                      />
                      <button type="submit" disabled={memberBusy || !memberEmail.trim()}>
                        {memberBusy ? <Loader2 size={13} className="animate-spin" /> : "Add"}
                      </button>
                    </form>
                  )}
                  {memberMessage && (
                    <p className={memberMessage.error ? "company-message error" : "company-message"}>{memberMessage.text}</p>
                  )}
                </div>
              )}
              <button title="Help"><CircleHelp size={14} /> Help</button>
            </div>
          )}
        </div>
        <button
          className="icon-button"
          title="Sign out"
          aria-label="Sign out"
          onClick={() => void signOutAndLeave()}
        ><LogOut size={17} /></button>
      </div>
    </header>
  );
}

export default AppBar;
