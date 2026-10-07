/**
 * Session handling — what a live, ended or missing session may read.
 *
 * A live session reads its company's data. The same session loses everything the
 * moment the account is removed, and a direct call with no session reads nothing
 * at all — so a protected link opened after the session ends shows no data.
 */
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = {
  "./planner.ts": () => import("../convex/planner"),
  "./companies.ts": () => import("../convex/companies"),
  "./auth.ts": () => import("../convex/auth"),
  "./_generated/api.ts": () => import("../convex/_generated/api"),
  "./_generated/server.ts": () => import("../convex/_generated/server"),
};

describe("session handling — no session", () => {
  test("a direct protected read with no session returns nothing", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.planner.getState, {})).toBeNull();
    expect(await t.query(api.companies.current, {})).toBeNull();
    expect(await t.query(api.companies.access, {})).toBeNull();
  });
});

describe("session handling — removal during an active session", () => {
  test("the same session loses its company and its data at once", async () => {
    const t = convexTest(schema, modules);
    const adminId = await t.run((ctx) => ctx.db.insert("users", { name: "Alpha admin", email: "admin@alpha.example" }));
    await t.withIdentity({ subject: adminId }).mutation(api.companies.ensureCompany, {});
    const admin = await t.run((ctx) => ctx.db.get(adminId));
    const companyId = admin?.companyId;
    if (!companyId) throw new Error("setup failed: the admin has no company");
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { name: "Alpha user", email: "user@alpha.example", companyId, companyRole: "user" }),
    );
    await t.withIdentity({ subject: adminId }).mutation(api.planner.initializeWorkspace, {});

    // A live session reads the company's workspace.
    expect((await t.withIdentity({ subject: userId }).query(api.companies.access, {}))?.removed).toBe(false);
    expect((await t.withIdentity({ subject: userId }).query(api.companies.current, {}))?.company?.id).toBe(companyId);
    expect((await t.withIdentity({ subject: userId }).query(api.planner.getState, {}))?.projects?.length).toBeGreaterThan(0);

    // Removed while the session is live.
    await t.withIdentity({ subject: adminId }).mutation(api.companies.removeMember, { userId });

    // The next request on the same session: nothing, and the shell is told to leave.
    expect(await t.withIdentity({ subject: userId }).query(api.planner.getState, {})).toBeNull();
    expect(await t.withIdentity({ subject: userId }).query(api.companies.current, {})).toBeNull();
    expect((await t.withIdentity({ subject: userId }).query(api.companies.access, {}))?.removed).toBe(true);
  });
});
