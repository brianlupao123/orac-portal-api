import crypto from "node:crypto";

// One-time account setup / password reset tokens.
//
// - 256 bits from crypto.randomBytes.
// - Only a SHA-256 digest is stored on the user record (reset_token_hash). The
//   raw token exists only in the single response that hands it to an Admin.
//   A database or backup read therefore does not yield a usable link.
//   (SHA-256 is appropriate here because the input is a high-entropy random
//   value, unlike a human password.)
// - Single use, expires, and issuing a new token replaces the previous one.
// - Legacy plaintext `reset_token` values written by older builds are still
//   honoured until they expire, then cleared, so nothing is silently broken.

export const SETUP_TOKEN_TTL_MS = 30 * 60 * 1000;

const sha256Hex = (value) => crypto.createHash("sha256").update(String(value), "utf8").digest("hex");

export function issueSetupToken(user, now = Date.now()) {
  const token = crypto.randomBytes(32).toString("hex");
  user.reset_token_hash = sha256Hex(token);
  user.reset_token_expires_at = now + SETUP_TOKEN_TTL_MS;
  delete user.reset_token; // never keep a plaintext token beside the hash
  return { token, expiresAt: user.reset_token_expires_at };
}

export function clearSetupToken(user) {
  user.reset_token_hash = null;
  user.reset_token = null;
  user.reset_token_expires_at = null;
}

export function verifySetupToken(user, provided, now = Date.now()) {
  if (!user || typeof provided !== "string" || !provided) return false;
  if (!user.reset_token_expires_at || now > user.reset_token_expires_at) return false;

  if (typeof user.reset_token_hash === "string" && user.reset_token_hash) {
    const expected = Buffer.from(user.reset_token_hash, "utf8");
    const actual = Buffer.from(sha256Hex(provided), "utf8");
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  if (typeof user.reset_token === "string" && user.reset_token) {
    const expected = Buffer.from(user.reset_token, "utf8");
    const actual = Buffer.from(provided, "utf8");
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }
  return false;
}
