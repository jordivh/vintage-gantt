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
