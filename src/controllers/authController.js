import { generateToken } from "../middleware/auth.js";
import { config } from "../config.js";
import bcrypt from "bcrypt";
import crypto from "node:crypto";

// ── Unchanged from the current file ──────────────────────────────────────
export const loginDemoUser = (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = req.body.password;
  const user = req.db.users.find((item) => item.email.toLowerCase() === email && item.is_active);

  if (!user) {
    return res.status(401).json({ success: false, message: "User not found or inactive." });
  }

  if (config.isProduction || password) {
    if (!password) {
      return res.status(401).json({ success: false, message: "Password is required." });
    }
    const valid = Boolean(user.password_hash) && bcrypt.compareSync(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ success: false, message: "Invalid credentials." });
    }
  }

  const token = generateToken(user);

  const { password_hash, password: ignoredPassword, ...publicUser } = user;
  res.json({
    success: true,
    data: {
      user: publicUser,
      token,
      note: "JWT Login successful"
    }
  });
};

export const getMe = (req, res) => {
  const user = req.db.users.find((item) => item.id === req.user.id);
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found." });
  }
  const { password_hash, password: ignoredPassword, ...publicUser } = user;
  res.json({ success: true, data: publicUser });
};

// ── NEW: Forgot / Reset Password ─────────────────────────────────────────
//
// IMPORTANT — read before merging:
// This writes reset_token / reset_token_expires_at onto req.db.users[i].
// If STORE_DRIVER=postgres in production, confirm postgresStore.js either
// (a) persists arbitrary object properties on the users row, or (b) has
// explicit reset_token / reset_token_expires_at columns added via a
// migration. This file cannot verify that — postgresStore.js was not
// available when this was written. Test locally with the JSON store first
// (STORE_DRIVER unset / not "postgres"), then confirm on Postgres before
// relying on it in production.
//
// No email service exists yet. Rather than silently failing, the reset
// link is written to the audit log (visible to Admin/Management/Finance
// via GET /audit_logs) and logged server-side, so an admin can retrieve
// and hand it to the user manually until real email delivery is wired in.

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

function findUserByEmail(req, email) {
  const normalized = String(email || "").trim().toLowerCase();
  return req.db.users.find((u) => u.email.toLowerCase() === normalized);
}

export const requestPasswordReset = (req, res) => {
  const email = req.body.email;
  if (!email) {
    return res.status(400).json({ success: false, message: "Email is required." });
  }

  const user = findUserByEmail(req, email);

  // Always respond the same way whether or not the account exists, so this
  // endpoint can't be used to discover which emails have accounts.
  const genericResponse = {
    success: true,
    message: "If that email has an account, a reset link has been issued."
  };

  if (!user || !user.is_active) {
    return res.json(genericResponse);
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + RESET_TOKEN_TTL_MS;

  user.reset_token = token;
  user.reset_token_expires_at = expiresAt;

  // Interim delivery mechanism — see note above. The reset link format
  // matches ResetPassword.jsx's expected query params exactly.
  // Uses FRONTEND_BASE_URL directly rather than a `config.*` field, since
  // config.js's exact exports weren't available when this was written —
  // set FRONTEND_BASE_URL as an env var (e.g. your Render static site URL)
  // if you want the logged link to be clickable as-is.
  const frontendBase = process.env.FRONTEND_BASE_URL || "";
  const resetLink = `${frontendBase}/reset-password?email=${encodeURIComponent(user.email)}&token=${token}`;
  console.log(`[PASSWORD RESET] ${user.email}: ${resetLink} (expires in 30 min)`);
  req.store.audit(req.db, user, "user", user.id, "PASSWORD_RESET_REQUESTED", null, { email: user.email, expires_at: expiresAt });

  return res.json(genericResponse);
};

export const resetPassword = (req, res) => {
  const { email, token, new_password } = req.body;

  if (!email || !token || !new_password) {
    return res.status(400).json({ success: false, message: "Email, token, and new password are required." });
  }
  if (String(new_password).length < 10) {
    return res.status(400).json({ success: false, message: "Password must be at least 10 characters." });
  }

  const user = findUserByEmail(req, email);
  if (!user || !user.reset_token || !user.reset_token_expires_at) {
    return res.status(400).json({ success: false, message: "Reset link is invalid or has expired." });
  }
  if (Date.now() > user.reset_token_expires_at) {
    return res.status(400).json({ success: false, message: "Reset link is invalid or has expired." });
  }

  const providedBuf = Buffer.from(String(token));
  const storedBuf = Buffer.from(String(user.reset_token));
  const tokenMatches =
    providedBuf.length === storedBuf.length && crypto.timingSafeEqual(providedBuf, storedBuf);

  if (!tokenMatches) {
    return res.status(400).json({ success: false, message: "Reset link is invalid or has expired." });
  }

  const before = { id: user.id, email: user.email };
  user.password_hash = bcrypt.hashSync(new_password, 10);
  user.reset_token = null;
  user.reset_token_expires_at = null;

  req.store.audit(req.db, user, "user", user.id, "PASSWORD_RESET_COMPLETED", before, { id: user.id, email: user.email });

  return res.json({ success: true, message: "Password updated. You can now sign in." });
};
