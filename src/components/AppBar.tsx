import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router";
import { Building2, LogOut, Search, UserRound, Users } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import {
  COMPANY_USERS_PATH,
  MY_ACCOUNT_PATH,
  NAV_ITEMS,
  accountActions,
  type NavKey,
} from "@/lib/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCalendarStore } from "@/lib/calendar-store";
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

/**
 * The one header every screen shares.
 *
 * Left to right: the brand and breadcrumb, the five primary sections, the global
 * search, and the account area. The account area shows the company this account
 * belongs to as read-only context — there is no company selector anywhere — and
 * a user menu with My account, Company users (a company admin only) and Sign out.
 * Everyone in the company sees and edits the same planning data, so nothing else
 * in the header depends on the account type.
 */
export function AppBar({ activeKey, label, searchValue, onSearchChange, onSearchKeyDown }: AppBarProps) {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { company, canManageMembers } = useCalendarStore();
  const [localSearch, setLocalSearch] = useState("");

  const signOutAndLeave = async () => {
    await signOut();
    navigate(AUTH_PATHS.signIn, { replace: true });
  };

  const account = accountActions(canManageMembers);
  const controlled = searchValue !== undefined;
  const value = controlled ? searchValue : localSearch;
  const activeLabel = label ?? NAV_ITEMS.find((item) => item.key === activeKey)?.label ?? "";
  const companyName = company?.company.name ?? "";
  const displayName = user?.name ?? "Account";

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
          type="button"
          className="eyebrow breadcrumb-button"
          onClick={() => navigate("/projects")}
          title="Back to the project catalog"
        ><span className="breadcrumb-root">My dashboard / </span>{activeLabel}</button>
      </div>

      <nav className="topnav segmented" aria-label="Main navigation">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
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

        {/* Read-only company context: the company this account belongs to. It is
            text, not a control — a company can never be chosen or changed here. */}
        {companyName && (
          <span className="company-context" title={`Your company: ${companyName}`}>
            <Building2 size={14} />
            <span className="company-context-name">{companyName}</span>
          </span>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="appbar-user" title={displayName}>
              <span className="avatar" aria-hidden="true">{displayName.slice(0, 1) || "M"}</span>
              <span className="appbar-user-name">{displayName}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span>{displayName}</span>
              {user?.email ? <span className="text-xs font-normal text-muted-foreground">{user.email}</span> : null}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => navigate(MY_ACCOUNT_PATH)}>
              <UserRound size={15} /> My account
            </DropdownMenuItem>
            {account.includes("company-users") && (
              <DropdownMenuItem onSelect={() => navigate(COMPANY_USERS_PATH)}>
                <Users size={15} /> Company users
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void signOutAndLeave()}>
              <LogOut size={15} /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

export default AppBar;
