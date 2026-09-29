/**
 * Secret scrubbing — no single-use value may leave through a log or a report.
 *
 * A page URL can carry an invitation or reset value, and an error message often
 * embeds that URL. Everything that leaves the app passes through `scrubSecrets`.
 */
import { describe, expect, test } from "bun:test";
import { SECRET_PARAMETERS, scrubSecrets, scrubValue } from "./secret-scrub";

describe("secret scrubbing", () => {
  test("a reset or invitation value in a URL is redacted", () => {
    expect(scrubSecrets("https://app.example/auth/reset?token=deadbeef")).toBe("https://app.example/auth/reset?token=[redacted]");
    expect(scrubSecrets("https://app.example/auth/accept?token=deadbeef")).toBe("https://app.example/auth/accept?token=[redacted]");
  });

  test("other query parameters are left alone", () => {
    expect(scrubSecrets("https://app.example/auth/reset?email=a%40b.c&token=deadbeef&sent=1")).toBe(
      "https://app.example/auth/reset?email=a%40b.c&token=[redacted]&sent=1",
    );
  });

  test("every secret parameter is covered, wherever it appears in the text", () => {
    for (const parameter of SECRET_PARAMETERS) {
      expect(scrubSecrets(`see ?${parameter}=secret-value now`)).toBe(`see ?${parameter}=[redacted] now`);
      expect(scrubSecrets(`{"${parameter}":"secret-value"}`)).toBe(`{"${parameter}":"[redacted]"}`);
    }
  });

  test("a URL inside an error message is redacted too", () => {
    const message = "Failed to fetch https://app.example/auth/reset?token=abc123: network error";
    const scrubbed = scrubSecrets(message);
    expect(scrubbed.includes("abc123")).toBe(false);
    expect(scrubbed.includes("[redacted]")).toBe(true);
  });

  test("an empty or secret-free string is returned unchanged", () => {
    expect(scrubSecrets("")).toBe("");
    expect(scrubSecrets("nothing here")).toBe("nothing here");
    expect(scrubValue(undefined)).toBe("");
  });
});
