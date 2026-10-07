// THIS FILE IS READ ONLY. Do not touch this file unless you are correctly adding a new auth provider in accordance to the vly auth documentation

import { convexAuth } from "@convex-dev/auth/server";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { Password } from "@convex-dev/auth/providers/Password";

// No email provider is configured on purpose: this product has no mail server.
// Accounts are created by a company admin with a temporary password, and a
// forgotten password is reset by that admin — nothing is ever mailed, so the
// emailed sign-in-code and password-reset providers are not registered here.

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Anonymous,
    // Email + password for company accounts. The provider hashes credentials
    // with Scrypt and keeps them in Convex Auth's own `authAccounts` table
    // (spread into the schema from `authTables`) — no password is ever written
    // to an application table and none is sent to the browser. The account and
    // its company are created together in `registerCompany` (see
    // src/convex/companies.ts), and additional accounts by `addCompanyUser`.
    Password({ id: "password" }),
  ],
});
