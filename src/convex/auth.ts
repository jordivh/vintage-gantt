// THIS FILE IS READ ONLY. Do not touch this file unless you are correctly adding a new auth provider in accordance to the vly auth documentation

import { convexAuth } from "@convex-dev/auth/server";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { Password } from "@convex-dev/auth/providers/Password";
import { emailOtp } from "./auth/emailOtp";
import { passwordReset } from "./auth/passwordReset";


export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    emailOtp,
    Anonymous,
    // Email + password for company accounts, and the password reset flow.
    // The provider hashes credentials with Scrypt and keeps them in Convex
    // Auth's own `authAccounts` table (spread into the schema from
    // `authTables`) — no password is ever written to an application table and
    // none is sent to the browser. The account and its company are created
    // together in `registerCompany` (see src/convex/companies.ts).
    Password({ id: "password", reset: passwordReset }),
  ],
});