import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { totpRequiredFor } from "../totpPolicy.js";

function sessionEpoch(user) {
  return Number.isSafeInteger(user?.session_epoch) && user.session_epoch >= 0 ? user.session_epoch : 0;
}

export function revokeSessions(user) {
  user.session_epoch = sessionEpoch(user) + 1;
}

export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "Unauthorized. Token missing." });
  }

  const token = authHeader.split(" ")[1];
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
    // Token claims are a login-time snapshot. Re-load the account for every
    // request so deactivation and role/client-scope changes take effect at once.
    const user = req.db?.users?.find((item) => item.id === payload.id);
    if (!user || !user.is_active) {
      return res.status(401).json({ success: false, message: "Unauthorized. Account is inactive." });
    }

    // Old tokens without an epoch remain valid only until the first account
    // security change. Unlike iat, this also catches same-second changes.
    if ((payload.session_epoch ?? 0) !== sessionEpoch(user)) {
      return res.status(401).json({ success: false, message: "Unauthorized. Session is no longer valid." });
    }

    if (totpRequiredFor(user) && (!user.totp?.secret || typeof user.totp.version !== "string" ||
        payload.factor_verified !== true ||
        payload.factor_version !== user.totp.version)) {
      return res.status(401).json({ success: false, message: "Unauthorized. Additional verification required." });
    }

    // A password change or reset ends every session issued before it.
    if (user.password_changed_at) {
      const changedAt = Math.floor(Date.parse(user.password_changed_at) / 1000);
      if (Number.isFinite(changedAt) && !(payload.iat >= changedAt)) {
        return res.status(401).json({ success: false, message: "Unauthorized. Session is no longer valid." });
      }
    }

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      client_id: user.client_id,
      is_active: true
    };
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: "Unauthorized. Token invalid." });
  }
}

export function generateToken(user, { factorVerified = false } = {}) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, is_active: user.is_active,
      session_epoch: sessionEpoch(user),
      ...(factorVerified ? { factor_verified: true, factor_version: user.totp?.version } : {}) },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}
