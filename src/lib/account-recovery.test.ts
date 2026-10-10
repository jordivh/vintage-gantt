/**
 * Owner recovery — the way back into a company whose last admin lost the password.
 *
 * There is no email service, so a forgotten password is normally reset by another
 * company admin. SIATEC had exactly one account, so no admin was left who could do
 * that, and no one could sign in at all. `recoverAccountAccess` is the one escape
 * hatch: internal (CLI / dashboard only, never the browser), it replaces the
 * password credential of one address with a temporary password.
 *
 * These cases run that mutation against the database and then use the temporary
 * password through the app's own sign-in check — the same `changeOwnPassword` call
 * a real session makes, which verifies the password with Convex Auth exactly as a
 * sign-in does. So "recovered" means the account can actually get back in.
 *
 * What is deliberately not asserted here: that a browser cannot reach it. That is
 * Convex's own internal/public split, enforced by the server, and `convex-test`
 * does not reproduce it (its function proxy resolves an internal function even
 * through the public api), so a test would prove nothing. The claim rests on the
 * export being an `internalMutation` in src/convex/companies.ts.
 */
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { CURRENT_PASSWORD_WRONG_MESSAGE, NO_ACCOUNT_FOR_EMAIL_MESSAGE } from "./company-users";

const modules = {
  "./planner.ts": () => import("../convex/planner"),
  "./companies.ts": () => import("../convex/companies"),
  "./auth.ts": () => import("../convex/auth"),
  "./_generated/api.ts": () => import("../convex/_generated/api"),
  "./_generated/server.ts": () => import("../convex/_generated/server"),
};

const NOW = "2026-10-09T09:00:00.000Z";
const EMAIL = "jordi.vanhyfte@siatec.be";
const OTHER_ADMIN = "colleague@siatec.be";
const TEMPORARY = "temporary-password-1";

type Test = ReturnType<typeof convexTest>;

/** The password credential an account signs in with, as `registerCompany` leaves it. */
const credential = (t: Test, userId: Id<"users">, email: string) =>
  t.run((ctx) =>
    ctx.db.insert("authAccounts", {
      userId,
      provider: "password",
      providerAccountId: email,
      secret: "scrypt-hash-of-the-lost-password",
    }),
  );

/** A company row plus an account in it, without going through registration. */
const company = async (t: Test, members: { email: string; role: "company_admin" | "user"; removedAt?: string }[]) => {
  const companyId = await t.run((ctx) => ctx.db.insert("companies", { name: "SIATEC", status: "active", createdAt: NOW }));
  const ids: Id<"users">[] = [];
  for (const member of members) {
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { name: member.email, email: member.email, companyId, companyRole: member.role, removedAt: member.removedAt }),
    );
    await credential(t, userId, member.email);
    ids.push(userId);
  }
  return { companyId, ids };
};

const recover = (t: Test, email: string, password: string) =>
  t.mutation(internal.companies.recoverAccountAccess, { email, password });

const account = (t: Test, userId: Id<"users">) => t.run((ctx) => ctx.db.get(userId));

const count = async (t: Test, table: "authAccounts" | "tasks") =>
  (await t.run((ctx) => ctx.db.query(table).collect())).length;

/** A refusal message, or "" when the call unexpectedly succeeded. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

describe("owner recovery", () => {
  test("the recovered account signs in with the temporary password and must then choose its own", async () => {
    const t = convexTest(schema, modules);
    const { ids } = await company(t, [{ email: EMAIL, role: "company_admin" }]);
    const admin = ids[0];

    const report = await recover(t, EMAIL, TEMPORARY);
    expect(report.ok).toBe(true);
    expect(report.email).toBe(EMAIL);
    expect(report.companyName).toBe("SIATEC");
    // It was already the admin, and it was never removed: nothing else changed.
    expect(report.grantedAdmin).toBe(false);
    expect(report.reinstated).toBe(false);
    expect(report.role).toBe("company_admin");

    const recovered = await account(t, admin);
    expect(recovered?.mustChangePassword).toBe(true);

    // The temporary password really opens the account: the app's own check passes
    // with it, so a sign-in with it does too.
    await t.withIdentity({ subject: admin }).mutation(api.companies.changeOwnPassword, {
      currentPassword: TEMPORARY,
      newPassword: "own-password-of-jordi",
    });
    expect((await account(t, admin))?.mustChangePassword).toBe(false);

    // The password that was lost is gone for good.
    const refused = await refusal(() =>
      t.withIdentity({ subject: admin }).mutation(api.companies.changeOwnPassword, {
        currentPassword: "the-lost-password",
        newPassword: "another-password-of-jordi",
      }),
    );
    expect(refused).toBe(CURRENT_PASSWORD_WRONG_MESSAGE);
  });

  test("a company left without an admin gets one back, and the mark of a removal is lifted", async () => {
    const t = convexTest(schema, modules);
    const { ids } = await company(t, [
      { email: EMAIL, role: "user" },
      { email: OTHER_ADMIN, role: "user" },
    ]);
    const jordi = ids[0];

    await t.run((ctx) => ctx.db.patch(jordi, { removedAt: NOW }));
    // A removed account sees nothing of its company.
    expect(await t.withIdentity({ subject: jordi }).query(api.companies.current, {})).toBeNull();

    const report = await recover(t, EMAIL, TEMPORARY);
    expect(report.reinstated).toBe(true);
    expect(report.grantedAdmin).toBe(true);
    expect(report.role).toBe("company_admin");

    const recovered = await account(t, jordi);
    expect(recovered?.removedAt).toBeUndefined();
    expect(recovered?.companyRole).toBe("company_admin");
    // Signs in, belongs to the company again, and can manage its accounts.
    const current = await t.withIdentity({ subject: jordi }).query(api.companies.current, {});
    expect(current?.company.name).toBe("SIATEC");
    expect(current?.canManageMembers).toBe(true);
  });

  test("an account that is not an admin stays one when the company already has an admin", async () => {
    const t = convexTest(schema, modules);
    const { ids } = await company(t, [
      { email: EMAIL, role: "user" },
      { email: OTHER_ADMIN, role: "company_admin" },
    ]);

    const report = await recover(t, EMAIL, TEMPORARY);
    expect(report.otherActiveAdmins).toBe(1);
    expect(report.grantedAdmin).toBe(false);
    expect((await account(t, ids[0]))?.companyRole).toBe("user");
  });

  test("the address is matched however it is typed", async () => {
    const t = convexTest(schema, modules);
    await company(t, [{ email: EMAIL, role: "company_admin" }]);
    const report = await recover(t, "  Jordi.VanHyfte@SIATEC.BE  ", TEMPORARY);
    expect(report.email).toBe(EMAIL);
  });

  test("nothing else in the workspace is read or written", async () => {
    const t = convexTest(schema, modules);
    const { companyId, ids } = await company(t, [{ email: EMAIL, role: "company_admin" }]);
    const project = await t.run((ctx) =>
      ctx.db.insert("projects", {
        ownerId: ids[0],
        companyId,
        id: "proj-1",
        name: "Factory line",
        status: "active",
        startDate: "2026-10-01",
        schedulingDirection: "forward",
        calendarId: "cal-1",
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );

    await recover(t, EMAIL, TEMPORARY);

    const after = await t.run((ctx) => ctx.db.get(project));
    expect(after?.name).toBe("Factory line");
    expect(after?.updatedAt).toBe(NOW);
    expect(await count(t, "tasks")).toBe(0);
  });

  test("refuses an unknown address, a weak password and an account without a company", async () => {
    const t = convexTest(schema, modules);
    await company(t, [{ email: EMAIL, role: "company_admin" }]);
    const stranger = await t.run((ctx) => ctx.db.insert("users", { name: "Stranger", email: "stranger@example.com" }));
    await credential(t, stranger, "stranger@example.com");

    expect(await refusal(() => recover(t, "nobody@siatec.be", TEMPORARY))).toBe(NO_ACCOUNT_FOR_EMAIL_MESSAGE);
    expect(await refusal(() => recover(t, "not-an-address", TEMPORARY))).toContain("valid email");
    expect(await refusal(() => recover(t, EMAIL, "short"))).toContain("10 characters");
    expect(await refusal(() => recover(t, "stranger@example.com", TEMPORARY))).toContain("no company yet");
  });

  test("a failed recovery changes nothing", async () => {
    const t = convexTest(schema, modules);
    const { ids } = await company(t, [{ email: EMAIL, role: "company_admin" }]);
    const before = await account(t, ids[0]);
    const beforeCredential = await t.run((ctx) => ctx.db.query("authAccounts").collect());

    await refusal(() => recover(t, EMAIL, "short"));

    expect(await account(t, ids[0])).toEqual(before);
    expect(await t.run((ctx) => ctx.db.query("authAccounts").collect())).toEqual(beforeCredential);
  });
});
