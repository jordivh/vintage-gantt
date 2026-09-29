/* --------------------------------------------------------------------------
 * Invitation tokens.
 *
 * An invitation link carries one opaque, unguessable value. Only its SHA-256
 * hash is ever stored, so a leaked database row cannot be turned back into a
 * working link, and a link is checked by hashing what arrives and looking that
 * up. Kept isomorphic (Web Crypto works in Convex's runtime and in Bun) so the
 * backend, the tests and any client helper share one definition.
 * ------------------------------------------------------------------------ */

const TOKEN_BYTES = 32;

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** A fresh, cryptographically random single-use value (64 hex characters). */
export function generateInvitationToken(bytes: number = TOKEN_BYTES): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return toHex(buffer);
}

/** The value stored in the database: the SHA-256 hash of the token, never the token. */
export async function hashInvitationToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}
