import crypto from "node:crypto";

// Password-setup / reset tokens.
//
// The raw token is returned ONLY from issueResetToken() so a future,
// owner-approved delivery adapter can send it. It is never stored: the user
// record keeps a SHA-256 digest under the existing `reset_token` field name, so
// every existing redaction of `reset_token` (admin, audit, collection reads)
// keeps covering it. Tokens are 256-bit random, single-use and expire.
export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // unchanged from the previous behaviour
const HASH_PREFIX = "sha256:";

export function hashToken(rawToken) {
  return HASH_PREFIX + crypto.createHash("sha256").update(String(rawToken)).digest("hex");
}

export function issueResetToken(user, now = Date.now()) {
  const token = crypto.randomBytes(32).toString("hex");
  user.reset_token = hashToken(token);
  user.reset_token_expires_at = now + RESET_TOKEN_TTL_MS;
  return { token, expiresAt: user.reset_token_expires_at };
}

export function verifyResetToken(user, providedToken, now = Date.now()) {
  if (!user || !user.reset_token || !user.reset_token_expires_at) return false;
  if (now > user.reset_token_expires_at) return false;
  const stored = String(user.reset_token);
  // Tokens issued before this change were stored raw (no prefix). They expire
  // within 30 minutes of issue, so this branch disappears on its own.
  const candidate = stored.startsWith(HASH_PREFIX) ? hashToken(providedToken) : String(providedToken);
  const a = Buffer.from(candidate);
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function clearResetToken(user) {
  user.reset_token = null;
  user.reset_token_expires_at = null;
}

// The only shape of a user record that may leave the API to a browser.
// Add a newly approved public field here explicitly; auth material stays
// private even if a new field is added to the stored user record later.
const PUBLIC_USER_FIELDS = [
  "id", "name", "email", "role", "is_active", "client_id", "trade",
  "national_id", "employee_code", "worker_type", "phone_number",
  "registered_via_request_id", "created_at", "password_changed_at",
  "can_confirm_timesheets"
];
export function toPublicUser(user) {
  return Object.fromEntries(PUBLIC_USER_FIELDS.filter((key) => Object.hasOwn(user, key)).map((key) => [key, user[key]]));
}
