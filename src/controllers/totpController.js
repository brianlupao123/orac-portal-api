import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { generateToken, revokeSessions } from "../middleware/auth.js";
import { toPublicUser } from "../accountTokens.js";
import { requirePermission } from "../permissions.js";
import { totpRequiredFor, totpEnrollmentEnabled } from "../totpPolicy.js";
import {
  generateTotpSecret, encryptTotpSecret, decryptTotpSecret, matchTotp,
  digestOpaque, equalDigest
} from "../totp.js";

const CHALLENGE_TTL_MS = 5 * 60_000;
const ENROLLMENT_TTL_MS = 10 * 60_000;
const TICKET_TTL_MS = 30 * 60_000;
const RESET_REQUEST_TTL_MS = 30 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_ACCOUNT_FAILURES = 10;
const ACCOUNT_LOCK_MS = 15 * 60_000;
const INVALID_FACTOR = { success: false, message: "Verification failed or expired." };
const INVALID_ENROLLMENT = { success: false, message: "Enrollment credentials are invalid or expired." };
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString("hex"), 10);
const ANONYMOUS = { id: "anonymous" };

// Refused enrollment attempts are audited with a fixed reason code and persisted
// even though the response is a 4xx (persistenceMiddleware discards other
// non-2xx writes). Rows hold ids and reason codes only: never the email the
// caller typed, a password, ticket, enrollment id or code. The HTTP response is
// not changed by any of this.
function auditDenied(req, actor, entityId, action, reason) {
  req.store.audit(req.db, actor, "user", entityId, action, null, { reason });
  req.persistOnFailure = true;
}

function startDenialReason({ validShape, user, passwordMatches, authorization, ticket, email }) {
  if (!validShape) return "malformed_request";
  if (!user || !user.password_hash) return "unknown_account";
  if (!passwordMatches) return "bad_password";
  if (!authorization) return "no_ticket";
  if (Date.now() > authorization.expires_at) return "ticket_expired";
  if (!equalDigest(authorization.digest, digestOpaque(ticket))) return "bad_ticket";
  if (authorization.password_digest !== digestOpaque(user.password_hash) ||
      authorization.session_epoch !== (user.session_epoch || 0) ||
      authorization.role !== user.role || authorization.email !== email) return "ticket_stale";
  return null;
}

function confirmDenialReason({ user, pending, ticket, enrollmentId, email }) {
  if (!user) return "unknown_account";
  if (!pending) return "no_pending_enrollment";
  if (!ticket) return "no_ticket";
  if (user.totp.secret) return "already_enrolled";
  if (typeof enrollmentId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(enrollmentId)) return "malformed_request";
  if (!equalDigest(pending.digest, digestOpaque(enrollmentId))) return "bad_enrollment_id";
  if (!equalDigest(pending.ticket_digest, ticket.digest)) return "ticket_mismatch";
  if (Date.now() > pending.expires_at || Date.now() > ticket.expires_at) return "expired";
  if (pending.attempts >= MAX_ATTEMPTS) return "attempts_exhausted";
  if (pending.password_digest !== digestOpaque(user.password_hash || "") ||
      pending.session_epoch !== (user.session_epoch || 0) ||
      pending.role !== user.role || pending.email !== email) return "binding_stale";
  return null;
}

function account(db, id) {
  return db.users.find((item) => item.id === id && item.is_active);
}

export function beginTotpChallenge(user) {
  if (user.totp.locked_until && Date.now() >= user.totp.locked_until) {
    user.totp.failures = 0;
    user.totp.locked_until = null;
  }
  const challengeId = crypto.randomBytes(32).toString("base64url");
  user.totp.challenge = {
    digest: digestOpaque(challengeId),
    expires_at: Date.now() + CHALLENGE_TTL_MS,
    attempts: 0,
    password_version: user.password_changed_at || null,
    password_digest: digestOpaque(user.password_hash || ""),
    email: String(user.email || "").trim().toLowerCase(),
    role: user.role,
    session_epoch: user.session_epoch || 0
  };
  return { status: "verification_required", challenge_id: challengeId, expires_in_seconds: CHALLENGE_TTL_MS / 1000 };
}

export const verifyTotpLogin = (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { email, challenge_id, code, recovery_code } = req.body || {};
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  const user = req.db.users.find((item) => item.is_active && String(item.email || "").trim().toLowerCase() === normalized);
  const factor = user?.totp;
  const challenge = factor?.challenge;
  const provided = typeof challenge_id === "string" ? challenge_id : "";
  if (!user || !totpRequiredFor(user) || !factor?.secret || !challenge ||
      (factor.locked_until && Date.now() < factor.locked_until) ||
      Date.now() > challenge.expires_at || challenge.attempts >= MAX_ATTEMPTS ||
      challenge.password_version !== (user.password_changed_at || null) ||
      challenge.password_digest !== digestOpaque(user.password_hash || "") ||
      challenge.email !== String(user.email || "").trim().toLowerCase() ||
      challenge.role !== user.role ||
      challenge.session_epoch !== (user.session_epoch || 0) ||
      !equalDigest(challenge.digest, digestOpaque(provided))) {
    return res.status(401).json(INVALID_FACTOR);
  }

  let counter = null;
  let recoveryIndex = -1;
  if (typeof code === "string" && recovery_code === undefined) {
    counter = matchTotp(decryptTotpSecret(factor.secret), code, { lastCounter: factor.last_counter ?? -1 });
  } else if (typeof recovery_code === "string" && code === undefined && /^[A-Za-z0-9_-]{20,48}$/.test(recovery_code)) {
    const candidate = digestOpaque(recovery_code);
    recoveryIndex = (factor.recovery_hashes || []).findIndex((stored) => equalDigest(stored, candidate));
  }

  if (counter === null && recoveryIndex < 0) {
    challenge.attempts += 1;
    factor.failures = (factor.failures || 0) + 1;
    if (factor.failures >= MAX_ACCOUNT_FAILURES) factor.locked_until = Date.now() + ACCOUNT_LOCK_MS;
    if (challenge.attempts >= MAX_ATTEMPTS || factor.locked_until) factor.challenge = null;
    req.store.audit(req.db, user, "user", user.id, "TOTP_VERIFY_FAILED", null, { id: user.id });
    if (factor.locked_until) req.store.audit(req.db, user, "user", user.id, "TOTP_FACTOR_LOCKED", null, { id: user.id });
    req.persistOnFailure = true;
    return res.status(401).json(INVALID_FACTOR);
  }

  factor.challenge = null;
  factor.failures = 0;
  factor.locked_until = null;
  if (counter !== null) factor.last_counter = counter;
  if (recoveryIndex >= 0) {
    factor.recovery_hashes.splice(recoveryIndex, 1);
    // Recovery-code use ends all previous sessions, including stolen ones.
    factor.version = crypto.randomUUID();
    revokeSessions(user);
    req.store.audit(req.db, user, "user", user.id, "TOTP_RECOVERY_CODE_USED", null, { id: user.id });
  }
  req.store.audit(req.db, user, "user", user.id, "TOTP_VERIFY_SUCCEEDED", null, { id: user.id });
  const token = generateToken(user, { factorVerified: true });
  return res.json({ success: true, data: { user: toPublicUser(user), token } });
};

export const issueTotpEnrollmentTicket = (req, res) => {
  if (!totpEnrollmentEnabled()) return res.status(404).json({ success: false, message: "Route not available." });
  const actor = account(req.db, req.user?.id);
  try {
    requirePermission(actor, "manageUsers");
  } catch (error) {
    if (actor) auditDenied(req, actor, actor.id, "TOTP_ENROLLMENT_TICKET_DENIED", "permission");
    throw error;
  }
  const targetId = req.body?.user_id;
  const target = typeof targetId === "string" ? account(req.db, targetId) : null;
  // The submitted user_id is never recorded; an unknown target is logged as "unknown".
  const deny = (status, message, reason) => {
    auditDenied(req, actor, target?.id ?? "unknown", "TOTP_ENROLLMENT_TICKET_DENIED", reason);
    return res.status(status).json({ success: false, message });
  };
  if (!target || !target.password_hash) return deny(404, "Active account not found.", "target_not_found");
  if (actor.id === target.id) return deny(403, "An independent Admin must issue the enrollment ticket.", "self_issue");
  const review = "Independent credential review is required before enrollment.";
  if (!target.password_changed_by) return deny(409, review, "password_provenance_unrecorded");
  if (target.password_changed_by === actor.id) return deny(409, review, "issuer_set_password");
  if (target.setup_link_issued_by === actor.id) return deny(409, review, "issuer_issued_setup_link");
  if (target.totp?.secret) return deny(409, "Authenticator already enrolled.", "already_enrolled");
  const ticket = crypto.randomBytes(32).toString("base64url");
  target.totp_enrollment_ticket = {
    digest: digestOpaque(ticket),
    expires_at: Date.now() + TICKET_TTL_MS,
    issued_by: actor.id,
    password_digest: digestOpaque(target.password_hash),
    session_epoch: target.session_epoch || 0,
    role: target.role,
    email: String(target.email || "").trim().toLowerCase()
  };
  // Reissuing a ticket revokes an unfinished enrollment.
  if (target.totp?.pending) target.totp.pending = null;
  req.store.audit(req.db, actor, "user", target.id, "TOTP_ENROLLMENT_TICKET_ISSUED", null, { id: target.id });
  res.setHeader("Cache-Control", "no-store");
  return res.json({ success: true, data: { ticket, expires_in_seconds: TICKET_TTL_MS / 1000 } });
};

export const beginTotpEnrollment = async (req, res) => {
  if (!totpEnrollmentEnabled()) return res.status(404).json({ success: false, message: "Route not available." });
  res.setHeader("Cache-Control", "no-store");
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const user = req.db.users.find((item) => item.is_active && String(item.email || "").trim().toLowerCase() === email);
  const password = req.body?.password;
  const ticket = req.body?.ticket;
  const validShape = typeof password === "string" && password.length > 0 && Buffer.byteLength(password) <= 72 &&
    typeof ticket === "string" && /^[A-Za-z0-9_-]{43}$/.test(ticket);
  const passwordMatches = await bcrypt.compare(validShape ? password : "invalid-password", user?.password_hash || DUMMY_PASSWORD_HASH);
  const authorization = user?.totp_enrollment_ticket;
  const refusal = startDenialReason({ validShape, user, passwordMatches, authorization, ticket, email });
  if (refusal) {
    // Unknown emails are not recorded: an unauthenticated caller could otherwise fill the audit log.
    if (user?.password_hash) auditDenied(req, ANONYMOUS, user.id, "TOTP_ENROLLMENT_START_DENIED", refusal);
    return res.status(401).json(INVALID_ENROLLMENT);
  }
  if (user.totp?.secret) {
    auditDenied(req, user, user.id, "TOTP_ENROLLMENT_START_DENIED", "already_enrolled");
    return res.status(409).json({ success: false, message: "Authenticator already enrolled." });
  }
  if (user.totp?.pending && Date.now() <= user.totp.pending.expires_at) {
    auditDenied(req, user, user.id, "TOTP_ENROLLMENT_START_DENIED", "enrollment_pending");
    return res.status(409).json({ success: false, message: "Enrollment is already pending." });
  }
  const secret = generateTotpSecret();
  const enrollmentId = crypto.randomBytes(32).toString("base64url");
  user.totp = {
    pending: {
      secret: encryptTotpSecret(secret), digest: digestOpaque(enrollmentId),
      ticket_digest: authorization.digest, expires_at: Date.now() + ENROLLMENT_TTL_MS, attempts: 0,
      password_digest: authorization.password_digest, session_epoch: authorization.session_epoch,
      role: authorization.role, email: authorization.email
    }
  };
  const label = encodeURIComponent(user.email);
  const uri = `otpauth://totp/ORAC-IOS:${label}?secret=${secret}&issuer=ORAC-IOS&algorithm=SHA1&digits=6&period=30`;
  req.store.audit(req.db, user, "user", user.id, "TOTP_ENROLLMENT_STARTED", null, { id: user.id });
  return res.json({ success: true, data: { enrollment_id: enrollmentId, otpauth_uri: uri, expires_in_seconds: ENROLLMENT_TTL_MS / 1000 } });
};

export const confirmTotpEnrollment = (req, res) => {
  if (!totpEnrollmentEnabled()) return res.status(404).json({ success: false, message: "Route not available." });
  res.setHeader("Cache-Control", "no-store");
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const user = req.db.users.find((item) => item.is_active && String(item.email || "").trim().toLowerCase() === email);
  const pending = user?.totp?.pending;
  const ticket = user?.totp_enrollment_ticket;
  const enrollmentId = req.body?.enrollment_id;
  const refusal = confirmDenialReason({ user, pending, ticket, enrollmentId, email });
  if (refusal) {
    if (user) auditDenied(req, ANONYMOUS, user.id, "TOTP_ENROLLMENT_CONFIRM_DENIED", refusal);
    return res.status(400).json(INVALID_FACTOR);
  }
  const counter = matchTotp(decryptTotpSecret(pending.secret), req.body?.code, { lastCounter: -1 });
  if (counter === null) {
    pending.attempts += 1;
    if (pending.attempts >= MAX_ATTEMPTS) user.totp.pending = null;
    req.store.audit(req.db, user, "user", user.id, "TOTP_ENROLLMENT_CONFIRM_FAILED", null, { id: user.id, reason: "bad_code" });
    req.persistOnFailure = true;
    return res.status(400).json(INVALID_FACTOR);
  }
  const recoveryCodes = Array.from({ length: 10 }, () => crypto.randomBytes(18).toString("base64url"));
  user.totp = {
    secret: pending.secret,
    last_counter: counter,
    recovery_hashes: recoveryCodes.map(digestOpaque),
    version: crypto.randomUUID(),
    enrolled_at: new Date().toISOString(),
    challenge: null
  };
  user.totp_enrollment_ticket = null;
  revokeSessions(user);
  req.store.audit(req.db, user, "user", user.id, "TOTP_ENROLLED", null, { id: user.id });
  return res.json({ success: true, data: { recovery_codes: recoveryCodes } });
};

// D2 Corrected: Admin-initiated TOTP factor reset.
// - Any Admin can directly reset a non-Admin user's TOTP factor after verifying their identity.
// - An Admin's factor CANNOT be reset directly: resetTotpFactor refuses Admin targets with 403
//   (reason: "admin_requires_approval_workflow").
// - Admin targets require a two-step dual-authorization workflow with TWO distinct authenticated Admins:
//   1. requestTotpFactorReset: Admin A (requester) initiates a reset request. A cryptographic
//      request_id is generated, bound to target state, and stored with a 30-minute TTL.
//   2. approveTotpFactorReset: Admin B (approver) authenticates with their own bearer credentials,
//      presents the request_id, and approves the reset. The approver cannot be Admin A (no self-approval)
//      and cannot be the target Admin (no target self-reset).
//   On approval, the factor is wiped, active sessions revoked, and distinct audit rows are written.

export const resetTotpFactor = (req, res) => {
  if (!totpEnrollmentEnabled()) return res.status(404).json({ success: false, message: "Route not available." });
  const actor = account(req.db, req.user?.id);
  try {
    requirePermission(actor, "manageUsers");
  } catch (error) {
    if (actor) auditDenied(req, actor, actor.id, "TOTP_FACTOR_RESET_DENIED", "permission");
    throw error;
  }
  const targetId = req.body?.user_id;
  const target = typeof targetId === "string" ? account(req.db, targetId) : null;
  const deny = (status, message, reason) => {
    auditDenied(req, actor, target?.id ?? "unknown", "TOTP_FACTOR_RESET_DENIED", reason);
    return res.status(status).json({ success: false, message });
  };
  if (!target) return deny(404, "Active account not found.", "target_not_found");
  if (actor.id === target.id) return deny(403, "An Admin cannot reset their own factor.", "self_reset");
  if (!target.totp?.secret) return deny(409, "The account has no enrolled authenticator.", "not_enrolled");

  // Admin targets cannot be reset directly by a single request, even if approver_id is provided.
  if (target.role === "Admin") {
    return deny(403, "Admin factor reset requires independent dual-authorization request and approval.", "admin_requires_approval_workflow");
  }

  // Clear non-Admin factor and stale tickets.
  target.totp = null;
  target.totp_enrollment_ticket = null;
  if (target.totp_factor_reset_request) target.totp_factor_reset_request = null;
  revokeSessions(target);
  req.store.audit(req.db, actor, "user", target.id, "TOTP_FACTOR_RESET", null, { id: target.id, reset_by: actor.id });
  return res.json({ success: true, message: "Authenticator factor has been reset. The user must re-enroll." });
};

export const requestTotpFactorReset = (req, res) => {
  if (!totpEnrollmentEnabled()) return res.status(404).json({ success: false, message: "Route not available." });
  const actor = account(req.db, req.user?.id);
  try {
    requirePermission(actor, "manageUsers");
  } catch (error) {
    if (actor) auditDenied(req, actor, actor.id, "TOTP_FACTOR_RESET_REQUEST_DENIED", "permission");
    throw error;
  }
  const targetId = req.body?.user_id;
  const target = typeof targetId === "string" ? account(req.db, targetId) : null;
  const deny = (status, message, reason) => {
    auditDenied(req, actor, target?.id ?? "unknown", "TOTP_FACTOR_RESET_REQUEST_DENIED", reason);
    return res.status(status).json({ success: false, message });
  };
  if (!target || !target.password_hash) return deny(404, "Active account not found.", "target_not_found");
  if (target.role !== "Admin") return deny(400, "Reset request workflow is only for Admin accounts. Non-Admin factors can be reset directly.", "target_not_admin");
  if (actor.id === target.id) return deny(403, "An Admin cannot request their own factor reset.", "self_request");
  if (!target.totp?.secret) return deny(409, "The account has no enrolled authenticator.", "not_enrolled");

  const requestId = crypto.randomBytes(32).toString("base64url");
  target.totp_factor_reset_request = {
    digest: digestOpaque(requestId),
    requested_by: actor.id,
    expires_at: Date.now() + RESET_REQUEST_TTL_MS,
    session_epoch: target.session_epoch || 0,
    password_digest: digestOpaque(target.password_hash),
    email: String(target.email || "").trim().toLowerCase(),
    target_id: target.id
  };

  req.store.audit(req.db, actor, "user", target.id, "TOTP_FACTOR_RESET_REQUESTED", null, { id: target.id, requested_by: actor.id });
  res.setHeader("Cache-Control", "no-store");
  return res.json({ success: true, data: { request_id: requestId, expires_in_seconds: RESET_REQUEST_TTL_MS / 1000 } });
};

export const approveTotpFactorReset = (req, res) => {
  if (!totpEnrollmentEnabled()) return res.status(404).json({ success: false, message: "Route not available." });
  const actor = account(req.db, req.user?.id);
  try {
    requirePermission(actor, "manageUsers");
  } catch (error) {
    if (actor) auditDenied(req, actor, actor.id, "TOTP_FACTOR_RESET_APPROVAL_DENIED", "permission");
    throw error;
  }
  const targetId = req.body?.user_id;
  const requestId = req.body?.request_id;
  const target = typeof targetId === "string" ? account(req.db, targetId) : null;
  const deny = (status, message, reason) => {
    auditDenied(req, actor, target?.id ?? "unknown", "TOTP_FACTOR_RESET_APPROVAL_DENIED", reason);
    return res.status(status).json({ success: false, message });
  };
  if (!target) return deny(404, "Active account not found.", "target_not_found");
  if (actor.id === target.id) return deny(403, "An Admin cannot approve their own factor reset.", "target_approval");
  if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(requestId)) {
    return deny(400, "Invalid reset request identifier.", "malformed_request_id");
  }
  const pending = target.totp_factor_reset_request;
  if (!pending) return deny(404, "No pending factor reset request found for this account.", "no_pending_request");
  if (actor.id === pending.requested_by) {
    return deny(403, "An independent Admin must approve the factor reset. The requesting Admin cannot approve.", "self_approval");
  }
  if (Date.now() > pending.expires_at) {
    target.totp_factor_reset_request = null;
    return deny(400, "Factor reset request has expired.", "request_expired");
  }
  if (!equalDigest(pending.digest, digestOpaque(requestId))) {
    return deny(400, "Factor reset request identifier does not match.", "bad_request_id");
  }
  if (pending.session_epoch !== (target.session_epoch || 0) ||
      pending.password_digest !== digestOpaque(target.password_hash || "") ||
      pending.email !== String(target.email || "").trim().toLowerCase() ||
      pending.target_id !== target.id) {
    target.totp_factor_reset_request = null;
    return deny(409, "Account state changed since reset request was created.", "request_stale");
  }

  // Single-use: consume the pending request immediately.
  const requestedBy = pending.requested_by;
  target.totp_factor_reset_request = null;
  target.totp = null;
  target.totp_enrollment_ticket = null;
  if (target.totp?.pending) target.totp.pending = null;
  revokeSessions(target);

  req.store.audit(req.db, actor, "user", target.id, "TOTP_FACTOR_RESET_APPROVED", null, { id: target.id, requested_by: requestedBy, approved_by: actor.id });
  req.store.audit(req.db, actor, "user", target.id, "TOTP_FACTOR_RESET", null, { id: target.id, reset_by: actor.id, requested_by: requestedBy });
  res.setHeader("Cache-Control", "no-store");
  return res.json({ success: true, message: "Authenticator factor has been reset. The user must re-enroll." });
};
