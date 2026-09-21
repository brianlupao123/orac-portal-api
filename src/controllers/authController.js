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

// ── Forgot / Reset Password ──────────────────────────────────────────────
// No owner-approved delivery adapter exists. A reset request therefore has
// generic anti-enumeration behaviour but deliberately issues no reset token
// until a secure delivery path is implemented. Tokens and reset links must
// never be logged, returned, or placed in audit records.

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
    message: "If that email has an account, its recovery request has been received."
  };

  if (!user || !user.is_active) {
    return res.json(genericResponse);
  }

  req.store.audit(req.db, user, "user", user.id, "PASSWORD_RESET_REQUESTED", null, { delivery: "not_configured" });

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
