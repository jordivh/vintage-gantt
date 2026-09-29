/* --------------------------------------------------------------------------
 * One-way tokens.
 *
 * A link that carries a secret — an invitation, a password reset — holds one
 * opaque, unguessable value. Only its SHA-256 hash is ever stored, so a leaked
 * database row cannot be turned back into a working link; a link is checked by
 * hashing what arrives and looking that up. Kept isomorphic (Web Crypto works in
 * Convex's runtime and in Bun) so the backend, the tests and any client helper
 * share one definition.
 * ------------------------------------------------------------------------ */

const TOKEN_BYTES = 32;

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** A fresh, cryptographically random single-use value (64 hex characters). */
export function generateSecureToken(bytes: number = TOKEN_BYTES): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return toHex(buffer);
}

/** The value stored in the database: the SHA-256 hash of the token, never the token. */
export async function hashSecureToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

// Invitations and password resets share this implementation under their own names.
export const generateInvitationToken = generateSecureToken;
export const hashInvitationToken = hashSecureToken;
export const generateResetToken = generateSecureToken;
export const hashResetToken = hashSecureToken;
