import { generateToken } from "../middleware/auth.js";
import { config } from "../config.js";
import bcrypt from "bcrypt";
import crypto from "node:crypto";
import { verifyResetToken, clearResetToken, toPublicUser } from "../accountTokens.js";
import { verifySetupToken, clearSetupToken } from "../setupTokens.js";

// Compared against when the account does not exist or is inactive, so the work
// done (and the response time) does not reveal whether an email has an account.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString("hex"), 10);
const INVALID_LOGIN = { success: false, message: "Invalid credentials." };

export const loginDemoUser = async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = req.body.password;
  // A malformed/incomplete stored record must not turn a login attempt into a
  // 500. Treat missing email values as non-matches and continue with the same
  // generic invalid-credentials response.
  const user = req.db.users.find((item) => String(item?.email || "").trim().toLowerCase() === email && item.is_active);

  if (config.requirePassword || password) {
    if (!password) {
      // Decided before any lookup, so it says nothing about whether the account exists.
      return res.status(400).json({ success: false, message: "Password is required." });
    }
    // Asynchronous compare: a synchronous bcrypt call blocks the whole server
    // for its duration, which makes unauthenticated login attempts a cheap way
    // to stall every other user.
    const storedHash = user?.password_hash || DUMMY_PASSWORD_HASH;
    const matches = await bcrypt.compare(String(password), storedHash);
    if (!user || !user.password_hash || !matches) {
      return res.status(401).json(INVALID_LOGIN);
    }
  } else if (!user) {
    // Local development only: no password supplied and none required.
    return res.status(401).json(INVALID_LOGIN);
  }

  const token = generateToken(user);
  res.json({
    success: true,
    data: {
      user: toPublicUser(user),
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
  res.json({ success: true, data: toPublicUser(user) });
};

// -- Forgot / Reset Password ------------------------------------------------
// No owner-approved delivery adapter exists. A reset request therefore has
// generic anti-enumeration behaviour but deliberately issues no reset token
// until a secure delivery path is implemented. Tokens and reset links must
// never be logged, returned, or placed in audit records.

function findUserByEmail(req, email) {
  const normalized = String(email || "").trim().toLowerCase();
  return req.db.users.find((u) => String(u?.email || "").trim().toLowerCase() === normalized);
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
  const password = String(new_password);
  if (password.length < 10) {
    return res.status(400).json({ success: false, message: "Password must be at least 10 characters." });
  }
  // bcrypt only uses the first 72 bytes; refuse longer input instead of silently truncating it.
  if (Buffer.byteLength(password) > 72) {
    return res.status(400).json({ success: false, message: "Password must be at most 72 bytes." });
  }

  const user = findUserByEmail(req, email);
  if (!user || !user.is_active || !(verifyResetToken(user, token) || verifySetupToken(user, token))) {
    return res.status(400).json({ success: false, message: "Reset link is invalid or has expired." });
  }

  const before = { id: user.id, email: user.email };
  user.password_hash = bcrypt.hashSync(password, 10);
  // Ends every session issued before this moment (checked in middleware/auth.js).
  user.password_changed_at = new Date().toISOString();
  clearResetToken(user);
  clearSetupToken(user);

  req.store.audit(req.db, user, "user", user.id, "PASSWORD_RESET_COMPLETED", before, { id: user.id, email: user.email });

  return res.json({ success: true, message: "Password updated. You can now sign in." });
};
