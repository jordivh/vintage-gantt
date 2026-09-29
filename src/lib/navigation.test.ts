import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { COMPANY_USERS_PATH, NAV_ITEMS, accountActions } from "./navigation";

/** Every screen that shows the planner chrome. Margin report shares it too, so
 *  it is checked alongside the five primary screens. */
const SCREENS: { file: string; activeKey: string }[] = [
  { file: "src/pages/Dashboard.tsx", activeKey: "planner" },
  { file: "src/pages/Projects.tsx", activeKey: "projects" },
  { file: "src/pages/Calendars.tsx", activeKey: "calendars" },
  { file: "src/pages/Resources.tsx", activeKey: "resources" },
  { file: "src/pages/Capacity.tsx", activeKey: "capacity" },
  { file: "src/pages/MarginReport.tsx", activeKey: "planner" },
];

const source = (file: string) => readFileSync(file, "utf8");

describe("main navigation", () => {
  test("lists exactly Planner, Projects, Calendars, Resources, Capacity in order", () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      "Planner",
      "Projects",
      "Calendars",
      "Resources",
      "Capacity",
    ]);
    expect(NAV_ITEMS.map((item) => item.path)).toEqual([
      "/dashboard",
      "/projects",
      "/calendars",
      "/resources",
      "/capacity",
    ]);
  });

  test("has no duplicate keys or paths", () => {
    expect(new Set(NAV_ITEMS.map((item) => item.key)).size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((item) => item.path)).size).toBe(NAV_ITEMS.length);
  });

  test("the shared AppBar renders the list, so the items live in one place", () => {
    const bar = source("src/components/AppBar.tsx");
    expect(bar).toContain("NAV_ITEMS.map(");
    // The bar must not hardcode its own copy of the items.
    expect(bar).not.toContain('label: "Capacity"');
  });

  test("every screen renders the shared AppBar with its own active key", () => {
    for (const { file, activeKey } of SCREENS) {
      const text = source(file);
      expect(text).toContain("<AppBar");
      expect(text).toContain(`activeKey="${activeKey}"`);
      // No screen may hand-roll its own navigation again.
      expect(text).not.toContain('className="topnav"');
      expect(text).not.toContain("planner-topbar");
    }
  });

  test("the five sections keep their documented names", () => {
    // BES-011 leaves these names in place; renaming one would break this test on
    // purpose, so a change is always a deliberate decision.
    expect(NAV_ITEMS.map((item) => item.label)).toEqual(["Planner", "Projects", "Calendars", "Resources", "Capacity"]);
  });
});

describe("the shared header's account area", () => {
  test("Company users is offered to a company admin only", () => {
    expect(accountActions(true)).toEqual(["company-users", "sign-out"]);
    expect(accountActions(false)).toEqual(["sign-out"]);
    expect(COMPANY_USERS_PATH).toBe("/company/users");
  });

  test("the bar shows the company context, the user's name, Company users and Sign out", () => {
    const bar = source("src/components/AppBar.tsx");
    expect(bar).toContain("accountActions(canManageMembers)");
    expect(bar).toContain("company-context");
    expect(bar).toContain("appbar-user-name");
    expect(bar).toContain("Company users");
    expect(bar).toContain('title="Sign out"');
    // The company is context, never a control: no selector in the header.
    expect(bar).not.toContain("<select");
  });

  test("no planning screen adds a role control or a per-project permission", () => {
    for (const { file } of SCREENS) {
      const text = source(file);
      expect(text).not.toContain("canManageMembers");
      expect(text).not.toContain("companyRole");
      expect(text).not.toContain("COMPANY_ADMIN");
    }
  });

  test("the company users route is registered behind the auth guard", () => {
    const router = source("src/main.tsx");
    expect(router).toContain('path="/company/users"');
    expect(router).toContain("<RequireAuth>");
  });
});
