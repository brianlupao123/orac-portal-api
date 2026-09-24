import { requirePermission } from "../permissions.js";
import crypto from "node:crypto";
import bcrypt from "bcrypt";

// ── Why this exists instead of open self-signup ──────────────────────────
// This system's entire permission model assumes roles are assigned by an
// Admin (see adminController.createUser, gated on "manageUsers"). A public
// signup form that lets a new visitor pick their own role — including
// "Admin" — would bypass that model entirely. This flow keeps the same
// safety property while still giving people a way in without an admin
// creating every account by hand up front:
//
//   1. Anyone can submit a request (name, email, requested role, reason).
//   2. Only an Admin can approve it — and the Admin sets the ACTUAL role
//      at approval time, which does not have to match what was requested.
//   3. Approval creates a real user record and issues a password-reset
//      token immediately, the same mechanism as "Forgot password", so the
//      new user sets their own password rather than being told one.

function getActor(req) {
  return req.db.users.find((u) => u.id === req.user.id);
}

const REQUESTABLE_ROLES = [
  "Management", "Sales", "Finance", "Operations",
  "Technician", "Supervisor", "Client Viewer"
  // "Admin" is intentionally excluded — nobody can request their way into
  // Admin. An existing Admin must promote someone to Admin explicitly via
  // PATCH /admin/users/:id.
];

export const createAccessRequest = (req, res) => {
  const body = req.body;
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const requestedRole = body.requested_role;
  const reason = String(body.reason || "").trim();

  if (!name || !email) {
    return res.status(400).json({ success: false, message: "Name and email are required." });
  }
  if (!REQUESTABLE_ROLES.includes(requestedRole)) {
    return res.status(400).json({
      success: false,
      message: `requested_role must be one of: ${REQUESTABLE_ROLES.join(", ")}.`
    });
  }

  // This public endpoint must not reveal whether an email already has an
  // account or a pending request.
  const genericAcceptedResponse = { success: true, data: { status: "Pending" } };
  const existingUser = req.db.users.find((u) => u.email.toLowerCase() === email);
  if (existingUser) {
    return res.json(genericAcceptedResponse);
  }

  const existingPending = req.db.access_requests.find(
    (r) => r.email.toLowerCase() === email && r.status === "Pending"
  );
  if (existingPending) {
    return res.json(genericAcceptedResponse);
  }

  const request = {
    id: req.store.id("areq"),
    name,
    email,
    requested_role: requestedRole,
    reason,
    status: "Pending",
    created_at: new Date().toISOString(),
    reviewed_by: null,
    reviewed_at: null
  };

  req.db.access_requests.push(request);
  req.store.audit(req.db, null, "access_request", request.id, "ACCESS_REQUEST_CREATED", null, request);

  res.json(genericAcceptedResponse);
};

export const approveAccessRequest = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageUsers"); // same permission createUser already requires

  const request = req.db.access_requests.find((r) => r.id === req.params.id);
  if (!request) return res.status(404).json({ success: false, message: "Access request not found." });
  if (request.status !== "Pending") {
    return res.status(400).json({ success: false, message: `Request is already ${request.status}.` });
  }

  // The Admin decides the real role here — req.body.role, not
  // request.requested_role. They're allowed to differ.
  const finalRole = req.body.role || request.requested_role;

  const before = { ...request };

  const user = {
    id: req.store.id("u"),
    name: request.name,
    email: request.email,
    role: finalRole,
    is_active: true,
    client_id: req.body.client_id || null,
    password_hash: null, // set via the reset-password flow below, not chosen here
    created_at: new Date().toISOString()
  };
  req.db.users.push(user);

  // Issue a reset token immediately so the new user can set their own
  // password, reusing the exact same mechanism as "Forgot password"
  // rather than inventing a second token system.
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + 30 * 60 * 1000;
  user.reset_token = token;
  user.reset_token_expires_at = expiresAt;

  // FIX: this previously console.log'd the full set-password link, token
  // included, directly contradicting this codebase's own stated rule (see
  // authController.js's Forgot/Reset Password comment): "Tokens and reset
  // links must never be logged, returned, or placed in audit records." No
  // owner-approved delivery adapter exists yet, so — consistent with how
  // requestPasswordReset already behaves — the token is generated and
  // stored on the user record (so the reset flow works once a secure
  // delivery path exists) but is not logged or returned here. The audit
  // entries below already omit it correctly.

  request.status = "Approved";
  request.reviewed_by = actor.id;
  request.reviewed_at = new Date().toISOString();

  req.store.audit(req.db, actor, "access_request", request.id, "ACCESS_REQUEST_APPROVED", before, request);
  req.store.audit(req.db, actor, "user", user.id, "ACCESS_REQUEST_USER_CREATED", null, { id: user.id, email: user.email, role: user.role });

  const { password_hash, reset_token, reset_token_expires_at, ...safeUser } = user;
  res.json({ success: true, data: { user: safeUser, set_password_link_logged: false } });
};

export const rejectAccessRequest = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageUsers");

  const request = req.db.access_requests.find((r) => r.id === req.params.id);
  if (!request) return res.status(404).json({ success: false, message: "Access request not found." });
  if (request.status !== "Pending") {
    return res.status(400).json({ success: false, message: `Request is already ${request.status}.` });
  }

  const before = { ...request };
  request.status = "Rejected";
  request.reviewed_by = actor.id;
  request.reviewed_at = new Date().toISOString();
  request.rejection_reason = String(req.body.reason || "").trim();

  req.store.audit(req.db, actor, "access_request", request.id, "ACCESS_REQUEST_REJECTED", before, request);

  res.json({ success: true, data: request });
};

export { REQUESTABLE_ROLES };
