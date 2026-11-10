import test from "node:test";
import assert from "node:assert/strict";
import { issueResetToken, verifyResetToken, clearResetToken, hashToken, toPublicUser, RESET_TOKEN_TTL_MS } from "../src/accountTokens.js";
import { verifySetupToken } from "../src/setupTokens.js";

test("issued token is stored only as a sha256 digest; raw token verifies", () => {
  const user = { id: "u1" };
  const { token, expiresAt } = issueResetToken(user, 1000);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.notEqual(user.reset_token, token);
  assert.equal(user.reset_token, hashToken(token));
  assert.ok(user.reset_token.startsWith("sha256:"));
  assert.equal(expiresAt, 1000 + RESET_TOKEN_TTL_MS);
  assert.equal(JSON.stringify(user).includes(token), false, "raw token must not appear anywhere on the record");
  assert.equal(verifyResetToken(user, token, 2000), true);
});
test("wrong token, expired token, missing fields and cleared token are rejected", () => {
  const user = { id: "u1" };
  const { token } = issueResetToken(user, 0);
  assert.equal(verifyResetToken(user, "nope", 1), false);
  assert.equal(verifyResetToken(user, token, RESET_TOKEN_TTL_MS + 1), false);
  assert.equal(verifyResetToken(user, token, RESET_TOKEN_TTL_MS), true, "valid up to and including the expiry instant");
  assert.equal(verifyResetToken(null, token), false);
  assert.equal(verifyResetToken({ id: "x" }, token), false);
  clearResetToken(user);
  assert.equal(user.reset_token, null);
  assert.equal(verifyResetToken(user, token, 1), false, "single use: cleared token cannot be replayed");
});
test("legacy raw tokens issued before the change still verify until they expire", () => {
  const user = { reset_token: "legacyrawtoken", reset_token_expires_at: 5000 };
  assert.equal(verifyResetToken(user, "legacyrawtoken", 1000), true);
  assert.equal(verifyResetToken(user, "legacyrawtokeX", 1000), false);
  assert.equal(verifyResetToken(user, "legacyrawtoken", 6000), false);
});
test("two issues produce different tokens", () => {
  const a = issueResetToken({}), b = issueResetToken({});
  assert.notEqual(a.token, b.token);
});

test("a stored password-reset hash cannot be replayed as a setup or reset token", () => {
  const user = { id: "u1" };
  const { token } = issueResetToken(user, 1_000);
  assert.equal(verifyResetToken(user, token, 2_000), true);
  assert.equal(verifySetupToken(user, user.reset_token, 2_000), false);
  assert.equal(verifyResetToken(user, user.reset_token, 2_000), false);
});
test("toPublicUser strips every secret and keeps the rest; does not mutate input", () => {
  const u = { id: "1", email: "a@b.co", role: "Admin", password_hash: "h", password: "p", reset_token: "t", reset_token_expires_at: 1, totp: { secret: "encrypted-seed", recovery_hashes: ["hash"] }, future_auth_secret: "must-never-leak", client_id: "c" };
  const pub = toPublicUser(u);
  assert.deepEqual(Object.keys(pub).sort(), ["client_id", "email", "id", "role"]);
  assert.equal(u.password_hash, "h");
});
