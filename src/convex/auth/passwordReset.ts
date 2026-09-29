import { Email } from "@convex-dev/auth/providers/Email";
import { RandomReader, generateRandomString } from "@oslojs/crypto/random";
import axios from "axios";

/**
 * The email a password reset sends.
 *
 * It uses the same delivery path as the sign-in code in `./emailOtp.ts`: a
 * 6-digit @oslojs token posted to freebuff's transactional mail service, which
 * the platform already provides. Nothing about a reset is stored in an
 * application table — the code lives in Convex Auth's own
 * `authVerificationCodes` table and only its SHA-256 hash is kept. The new
 * password is hashed by the `Password` provider (Scrypt) into `authAccounts`.
 */
export const passwordReset = Email({
  id: "password-reset",
  maxAge: 60 * 15, // 15 minutes
  async generateVerificationToken() {
    const random: RandomReader = {
      read(bytes: Uint8Array) {
        crypto.getRandomValues(bytes);
      },
    };
    return generateRandomString(random, "0123456789", 6);
  },
  async sendVerificationRequest({ identifier: email, token }) {
    try {
      await axios.post(
        "https://auth.freebuff.app/send_otp",
        {
          to: email,
          otp: token,
          appName: process.env.VLY_APP_NAME || "a freebuff.com application",
        },
        {
          headers: {
            "x-api-key": "fb_email_2crN1hqIArZP2bEfvjp5Qik4",
          },
        },
      );
    } catch (error) {
      throw new Error(JSON.stringify(error));
    }
  },
});
