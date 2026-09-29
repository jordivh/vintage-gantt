export type NavKey = "planner" | "projects" | "calendars" | "resources" | "capacity";

/** The one and only source of truth for the primary navigation. Every screen
 *  renders <AppBar/>, which maps over this list, so the bar can never drift
 *  from screen to screen again: adding or reordering a screen happens here and
 *  nowhere else. */
export const NAV_ITEMS: { key: NavKey; label: string; path: string }[] = [
  { key: "planner", label: "Planner", path: "/dashboard" },
  { key: "projects", label: "Projects", path: "/projects" },
  { key: "calendars", label: "Calendars", path: "/calendars" },
  { key: "resources", label: "Resources", path: "/resources" },
  { key: "capacity", label: "Capacity", path: "/capacity" },
];

/** The company users screen. It is the account area's admin-only entry. */
export const COMPANY_USERS_PATH = "/company/users";

export type AccountActionKey = "company-users" | "sign-out";

/**
 * The entries the shared header's account area offers. Company users is the one
 * entry that depends on the account type — a regular user simply does not get
 * it. Sign out is always present, and nothing here affects planning rights:
 * every active user in a company sees and edits the same data.
 */
export function accountActions(canManageMembers: boolean): AccountActionKey[] {
  return canManageMembers ? ["company-users", "sign-out"] : ["sign-out"];
}
