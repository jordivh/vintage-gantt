/**
 * Password recovery — the behaviour, through the real Convex functions.
 *
 * A valid link sets a new password and retires the old one; a link is single
 * use, expires, and is replaced by a newer request; a weaker password is refused
 * without spending the link; the account keeps its company and role; and only
 * the link's hash is ever stored.
 *
 * The file lives outside `src/convex` on purpose: that directory must only hold
 * deployable modules.
 */
import { describe, expect, test } from "bun:test";
import { createAccount, retrieveAccount } from "@convex-dev/auth/server";
import type { GenericActionCtx } from "convex/server";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import type { DataModel, Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { hashSecureToken } from "./invitation-token";
import { resetExpiry } from "./password-reset";

const modules = {
  "./passwordRecovery.ts": () => import("../convex/passwordRecovery"),
  "./auth.ts": () => import("../convex/auth"),
  "./auth/emailOtp.ts": () => import("../convex/auth/emailOtp"),
  "./auth/passwordReset.ts": () => import("../convex/auth/passwordReset"),
  "./_generated/api.ts": () => import("../convex/_generated/api"),
  "./_generated/server.ts": () => import("../convex/_generated/server"),
};

const EMAIL = "marta@keystone.example";
const OLD_PASSWORD = "oldpassword123";
const NEW_PASSWORD = "newpassword456";

/** Runs something that must be refused, and returns the refusal message. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

/** One company, one account with a password, and the working old password. */
async function setup() {
  const t = convexTest(schema, modules);
  const companyId = await t.run((ctx) =>
    ctx.db.insert("companies", { name: "Keystone", status: "active", createdAt: new Date().toISOString() }),
  );
  const userId = await t.run(async (ctx) => {
    const created = await createAccount(ctx as unknown as GenericActionCtx<DataModel>, {
      provider: "password",
      account: { id: EMAIL, secret: OLD_PASSWORD },
      profile: { email: EMAIL, name: "Marta" },
    });
    return created.user._id as Id<"users">;
  });
  await t.run((ctx) => ctx.db.patch(userId, { companyId, companyRole: "company_admin" }));
  return { t, userId, companyId };
}

type Harness = Awaited<ReturnType<typeof setup>>;

/** Whether the account's stored credential still matches this password. */
async function passwordWorks(harness: Harness, password: string): Promise<boolean> {
  try {
    const result = await harness.t.run(async (ctx) =>
      retrieveAccount(ctx as unknown as GenericActionCtx<DataModel>, {
        provider: "password",
        account: { id: EMAIL, secret: password },
      }),
    );
    return result !== null;
  } catch {
    return false;
  }
}

/** Issues a reset link the way the request action does, from a known value. */
async function issue(harness: Harness, token: string, expiresAt: string) {
  const tokenHash = await hashSecureToken(token);
  return await harness.t.mutation(internal.passwordRecovery.issueResetToken, { email: EMAIL, tokenHash, expiresAt });
}

describe("password recovery — a valid link", () => {
  test("sets the new password and retires the old one", async () => {
    const harness = await setup();
    const token = "reset-value-valid";
    await issue(harness, token, resetExpiry(Date.now()));
    expect(await passwordWorks(harness, OLD_PASSWORD)).toBe(true);

    const result = await harness.t.mutation(api.passwordRecovery.completeReset, { token, password: NEW_PASSWORD });

    expect(result.ok).toBe(true);
    expect(result.email).toBe(EMAIL);
    expect(await passwordWorks(harness, NEW_PASSWORD)).toBe(true);
    expect(await passwordWorks(harness, OLD_PASSWORD)).toBe(false);
  });

  test("the account keeps its company and its role", async () => {
    const harness = await setup();
    const token = "reset-value-company";
    await issue(harness, token, resetExpiry(Date.now()));
    await harness.t.mutation(api.passwordRecovery.completeReset, { token, password: NEW_PASSWORD });

    const after = await harness.t.run((ctx) => ctx.db.get(harness.userId));
    expect(after?.companyId).toBe(harness.companyId);
    expect(after?.companyRole).toBe("company_admin");
    expect(after?.email).toBe(EMAIL);
  });

  test("drops the account's existing sessions", async () => {
    const harness = await setup();
    await harness.t.run((ctx) =>
      ctx.db.insert("authSessions", { userId: harness.userId, expirationTime: Date.now() + 60_000 }),
    );
    const token = "reset-value-sessions";
    await issue(harness, token, resetExpiry(Date.now()));
    await harness.t.mutation(api.passwordRecovery.completeReset, { token, password: NEW_PASSWORD });

    const sessions = await harness.t.run((ctx) =>
      ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", harness.userId)).collect(),
    );
    expect(sessions.length).toBe(0);
  });

  test("only the link's hash is stored, never the value", async () => {
    const harness = await setup();
    const token = "reset-value-hash";
    await issue(harness, token, resetExpiry(Date.now()));

    const rows = await harness.t.run((ctx) => ctx.db.query("passwordResets").collect());
    expect(rows.length).toBe(1);
    expect(rows[0].tokenHash).toBe(await hashSecureToken(token));
    expect(JSON.stringify(rows[0]).includes(token)).toBe(false);
  });
});

describe("password recovery — refusals", () => {
  test("a link works once; reusing it changes nothing", async () => {
    const harness = await setup();
    const token = "reset-value-once";
    await issue(harness, token, resetExpiry(Date.now()));
    await harness.t.mutation(api.passwordRecovery.completeReset, { token, password: NEW_PASSWORD });

    const message = await refusal(() =>
      harness.t.mutation(api.passwordRecovery.completeReset, { token, password: "anotherpassword789" }),
    );
    expect(message.length).toBeGreaterThan(0);
    expect(await passwordWorks(harness, NEW_PASSWORD)).toBe(true);
    expect(await passwordWorks(harness, "anotherpassword789")).toBe(false);
  });

  test("an expired link is refused and changes nothing", async () => {
    const harness = await setup();
    const token = "reset-value-expired";
    await issue(harness, token, new Date(Date.now() - 1_000).toISOString());

    const message = await refusal(() =>
      harness.t.mutation(api.passwordRecovery.completeReset, { token, password: NEW_PASSWORD }),
    );
    expect(message.length).toBeGreaterThan(0);
    expect(await passwordWorks(harness, OLD_PASSWORD)).toBe(true);
    expect(await passwordWorks(harness, NEW_PASSWORD)).toBe(false);
  });

  test("an unknown value is refused", async () => {
    const harness = await setup();
    const message = await refusal(() =>
      harness.t.mutation(api.passwordRecovery.completeReset, { token: "not-a-real-value", password: NEW_PASSWORD }),
    );
    expect(message.length).toBeGreaterThan(0);
    expect(await passwordWorks(harness, OLD_PASSWORD)).toBe(true);
  });

  test("a weak password is refused and the link stays usable", async () => {
    const harness = await setup();
    const token = "reset-value-weak";
    await issue(harness, token, resetExpiry(Date.now()));

    const message = await refusal(() =>
      harness.t.mutation(api.passwordRecovery.completeReset, { token, password: "short" }),
    );
    expect(message.length).toBeGreaterThan(0);

    const accepted = await harness.t.mutation(api.passwordRecovery.completeReset, { token, password: NEW_PASSWORD });
    expect(accepted.ok).toBe(true);
    expect(await passwordWorks(harness, NEW_PASSWORD)).toBe(true);
  });
});

describe("password recovery — issuing a link", () => {
  test("a new request replaces the previous link, leaving one working", async () => {
    const harness = await setup();
    await issue(harness, "reset-value-first", resetExpiry(Date.now()));
    await issue(harness, "reset-value-second", resetExpiry(Date.now()));

    const refused = await refusal(() =>
      harness.t.mutation(api.passwordRecovery.completeReset, { token: "reset-value-first", password: NEW_PASSWORD }),
    );
    expect(refused.length).toBeGreaterThan(0);

    const accepted = await harness.t.mutation(api.passwordRecovery.completeReset, {
      token: "reset-value-second",
      password: NEW_PASSWORD,
    });
    expect(accepted.ok).toBe(true);
  });

  test("an address without an account stores no link at all", async () => {
    const harness = await setup();
    const tokenHash = await hashSecureToken("whatever");
    const issued = await harness.t.mutation(internal.passwordRecovery.issueResetToken, {
      email: "nobody@example.com",
      tokenHash,
      expiresAt: resetExpiry(Date.now()),
    });
    expect(issued.issued).toBe(false);
    expect((await harness.t.run((ctx) => ctx.db.query("passwordResets").collect())).length).toBe(0);
  });
});

/**
 * The request action itself: it answers one constant sentence either way, it only
 * ever tries to mail an address that really has an account, and a failure to send
 * is recorded for the operator instead of being swallowed.
 *
 * The mail channel is left unconfigured here, so the send path stops before any
 * network call and the failure it reports is the configuration one.
 */
describe("password recovery — the request action", () => {
  const MAIL_VARS = ["RESEND_API_KEY", "RESEND_EMAIL_FROM", "INVITATION_FROM_EMAIL"] as const;

  async function loggedWhile(run: () => Promise<void>) {
    const saved = MAIL_VARS.map((key) => [key, process.env[key]] as const);
    for (const key of MAIL_VARS) delete process.env[key];
    const lines: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    try {
      await run();
    } finally {
      console.error = error;
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    return lines;
  }

  test("answers the same neutral sentence for a known and an unknown address", async () => {
    const harness = await setup();
    const known = await harness.t.action(api.passwordRecovery.requestReset, { email: EMAIL, origin: "https://app.vintagegantt.example" });
    const unknown = await harness.t.action(api.passwordRecovery.requestReset, { email: "nobody@nowhere.example", origin: "https://app.vintagegantt.example" });
    expect(known).toEqual({ ok: true });
    expect(unknown).toEqual({ ok: true });
    expect(JSON.stringify(known)).toBe(JSON.stringify(unknown));
  });

  test("tries to mail a real account, never an unknown address, and logs the failure", async () => {
    const harness = await setup();

    const unknownLines = await loggedWhile(async () => {
      await harness.t.action(api.passwordRecovery.requestReset, { email: "nobody@nowhere.example" });
    });
    // No account, no link, no send attempted: nothing to report.
    expect(unknownLines.length).toBe(0);

    const knownLines = await loggedWhile(async () => {
      await harness.t.action(api.passwordRecovery.requestReset, { email: EMAIL, origin: "https://app.vintagegantt.example" });
    });
    // The operator learns why nothing was delivered…
    const output = knownLines.join("\n");
    expect(output).toContain("could not be emailed");
    expect(output).toContain("RESEND_API_KEY");
    // …and the log carries no link, no token and no password.
    expect(output).not.toContain("token=");
    expect(output).not.toContain(OLD_PASSWORD);

    // The link itself was stored (hashed) and is waiting to be used.
    expect((await harness.t.run((ctx) => ctx.db.query("passwordResets").collect())).length).toBe(1);
  });
});
