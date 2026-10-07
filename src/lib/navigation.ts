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

/** The company users screen. It is the account menu's admin-only entry. */
export const COMPANY_USERS_PATH = "/company/users";

/** The signed-in account's own settings, and the forced password change. */
export const MY_ACCOUNT_PATH = "/account";
export const CHANGE_PASSWORD_PATH = "/account/password";

export type AccountActionKey = "my-account" | "company-users" | "sign-out";

/**
 * The entries the shared header's account menu offers. My account is for every
 * signed-in account; Company users appears only for a company admin; Sign out is
 * always present. Nothing here affects planning rights: every active user in a
 * company sees and edits the same data.
 */
export function accountActions(canManageMembers: boolean): AccountActionKey[] {
  return canManageMembers
    ? ["my-account", "company-users", "sign-out"]
    : ["my-account", "sign-out"];
}
