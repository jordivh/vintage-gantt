/**
 * The transactional email channel.
 *
 * One channel carries every link the app mails out, so its behaviour is worth
 * pinning down: it must refuse to pretend it sent something, it must retry only
 * what is worth retrying, and no log line may ever contain the single-use link.
 *
 * The network is stubbed, so nothing here leaves the machine.
 */
import { describe, expect, test } from "bun:test";
import { EMAIL_MAX_ATTEMPTS, EMAIL_NOT_CONFIGURED_MESSAGE, emailConfigured, sendTransactionalEmail } from "../convex/email";

const EMAIL_VARS = ["RESEND_API_KEY", "RESEND_EMAIL_FROM", "INVITATION_FROM_EMAIL"] as const;
const SENDER = "Vintage GANTT <no-reply@vintagegantt.example>";
const LINK = "https://app.vintagegantt.example/auth/reset?token=super-secret-value";

/** Runs `run` with exactly the given mail variables set, then restores them. */
async function withMailEnv(vars: Partial<Record<(typeof EMAIL_VARS)[number], string>>, run: () => Promise<void> | void) {
  const saved = EMAIL_VARS.map((key) => [key, process.env[key]] as const);
  for (const key of EMAIL_VARS) delete process.env[key];
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  try {
    await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Collects everything the channel logs while `run` executes. */
async function loggedLines(run: () => Promise<void>) {
  const lines: string[] = [];
  const error = console.error;
  const warn = console.warn;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await run();
  } finally {
    console.error = error;
    console.warn = warn;
  }
  return lines;
}

interface StubResponse {
  status: number;
  ok: boolean;
  text: () => Promise<string>;
}

const reply = (status: number, body = ""): StubResponse => ({ status, ok: status >= 200 && status < 300, text: async () => body });

/** A fetch that answers with the given responses in order, recording each call. */
function stubFetch(responses: StubResponse[]) {
  const calls: { url: string; body: Record<string, unknown>; authorization: string }[] = [];
  let index = 0;
  const fetchImpl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) as Record<string, unknown>, authorization: init.headers.Authorization });
    return responses[Math.min(index++, responses.length - 1)];
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, attempts: () => index };
}

const noSleep = async () => {};

const mail = { to: "marta@keystone.example", subject: "Set a new password", html: `<p><a href="${LINK}">Set a new password</a></p>` };

describe("transactional email", () => {
  test("refuses to send, and says so, when the provider is not configured", async () => {
    await withMailEnv({}, async () => {
      const { fetchImpl, attempts } = stubFetch([reply(200, "{}")]);
      const lines = await loggedLines(async () => {
        let message = "";
        try {
          await sendTransactionalEmail(mail, { fetchImpl, sleep: noSleep });
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toBe(EMAIL_NOT_CONFIGURED_MESSAGE);
      });
      // Nothing was attempted over the network, and the log names what is missing.
      expect(attempts()).toBe(0);
      expect(lines.join("\n")).toContain("RESEND_API_KEY");
      expect(lines.join("\n")).toContain("No email was sent");
      expect(emailConfigured()).toBe(false);
    });
  });

  test("names the missing sender when only the key is set", async () => {
    await withMailEnv({ RESEND_API_KEY: "re_test_key" }, async () => {
      const lines = await loggedLines(async () => {
        await expect(sendTransactionalEmail(mail, { sleep: noSleep })).rejects.toBeDefined();
      });
      expect(lines.join("\n")).toContain("RESEND_EMAIL_FROM");
      expect(emailConfigured()).toBe(false);
    });
  });

  test("sends from the verified sender and reports the provider's id", async () => {
    await withMailEnv({ RESEND_API_KEY: "re_test_key", RESEND_EMAIL_FROM: SENDER }, async () => {
      const { calls, fetchImpl } = stubFetch([reply(200, '{"id":"msg_123"}')]);
      const result = await sendTransactionalEmail(mail, { fetchImpl, sleep: noSleep });
      expect(result).toEqual({ provider: "resend", id: "msg_123" });
      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe("https://api.resend.com/emails");
      expect(calls[0].authorization).toBe("Bearer re_test_key");
      expect(calls[0].body.from).toBe(SENDER);
      expect(calls[0].body.to).toBe("marta@keystone.example");
      // The link travels in the message — that is the only thing it is for.
      expect(String(calls[0].body.html)).toContain(LINK);
      expect(emailConfigured()).toBe(true);
    });
  });

  test("retries a rate limit and a server error, and succeeds", async () => {
    await withMailEnv({ RESEND_API_KEY: "re_test_key", RESEND_EMAIL_FROM: SENDER }, async () => {
      const { attempts, fetchImpl } = stubFetch([reply(429, '{"message":"rate limited"}'), reply(500, "upstream"), reply(200, '{"id":"msg_after_retry"}')]);
      const result = await sendTransactionalEmail(mail, { fetchImpl, sleep: noSleep });
      expect(result.id).toBe("msg_after_retry");
      expect(attempts()).toBe(3);
    });
  });

  test("gives up after the retry budget on a repeated server error", async () => {
    await withMailEnv({ RESEND_API_KEY: "re_test_key", RESEND_EMAIL_FROM: SENDER }, async () => {
      const { attempts, fetchImpl } = stubFetch([reply(503, "unavailable")]);
      const lines = await loggedLines(async () => {
        await expect(sendTransactionalEmail(mail, { fetchImpl, sleep: noSleep })).rejects.toBeDefined();
      });
      expect(attempts()).toBe(EMAIL_MAX_ATTEMPTS);
      expect(lines.join("\n")).toContain("HTTP 503");
    });
  });

  test("does not retry a permanent refusal", async () => {
    await withMailEnv({ RESEND_API_KEY: "re_test_key", RESEND_EMAIL_FROM: SENDER }, async () => {
      const { attempts, fetchImpl } = stubFetch([reply(422, '{"message":"domain is not verified"}')]);
      const lines = await loggedLines(async () => {
        await expect(sendTransactionalEmail(mail, { fetchImpl, sleep: noSleep })).rejects.toBeDefined();
      });
      expect(attempts()).toBe(1);
      expect(lines.join("\n")).toContain("HTTP 422");
      expect(lines.join("\n")).toContain("domain is not verified");
    });
  });

  test("retries a transport failure", async () => {
    await withMailEnv({ RESEND_API_KEY: "re_test_key", RESEND_EMAIL_FROM: SENDER }, async () => {
      let attempts = 0;
      const fetchImpl = (async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("socket hang up");
        return reply(200, '{"id":"msg_second"}');
      }) as unknown as typeof fetch;
      const result = await sendTransactionalEmail(mail, { fetchImpl, sleep: noSleep });
      expect(result.id).toBe("msg_second");
      expect(attempts).toBe(2);
    });
  });

  test("never logs the link, even when the provider echoes it back", async () => {
    await withMailEnv({ RESEND_API_KEY: "re_test_key", RESEND_EMAIL_FROM: SENDER }, async () => {
      // A provider that repeats the request body in its error is exactly the case
      // that must not reach a log: that body is the message, and the message is the link.
      const { fetchImpl } = stubFetch([reply(400, `{"message":"invalid html: ${LINK}"}`)]);
      const lines = await loggedLines(async () => {
        let message = "";
        try {
          await sendTransactionalEmail(mail, { fetchImpl, sleep: noSleep });
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        // The thrown message is fixed, and the log is scrubbed.
        expect(message).toBe("The email could not be sent.");
      });
      const output = lines.join("\n");
      expect(output).toContain("HTTP 400");
      expect(output).not.toContain("super-secret-value");
      expect(output).toContain("[redacted]");
    });
  });
});
