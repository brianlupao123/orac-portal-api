import { requirePermission, roles } from "../permissions.js";
import { issueSetupToken } from "../setupTokens.js";

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
  const body = req.body || {};
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const requestedRole = body.requested_role;
  const reason = String(body.reason || "").trim();

  if (!name || !email) {
    return res.status(400).json({ success: false, message: "Name and email are required." });
  }
  if (name.length > 120 || email.length > 254 || reason.length > 1000 || !email.includes("@")) {
    return res.status(400).json({
      success: false,
      message: "Name (120), email (254) or reason (1000 characters) is too long, or the email is not valid."
    });
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
  const existingUser = req.db.users.find((u) => String(u?.email || "").trim().toLowerCase() === email);
  if (existingUser) {
    return res.json(genericAcceptedResponse);
  }

  const existingPending = req.db.access_requests.find(
    (r) => String(r?.email || "").trim().toLowerCase() === email && r.status === "Pending"
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
  const body = req.body || {};
  const finalRole = body.role === undefined || body.role === null || body.role === ""
    ? request.requested_role
    : body.role;
  if (typeof finalRole !== "string" || !Object.values(roles).includes(finalRole)) {
    return res.status(400).json({
      success: false,
      message: `role must be one of: ${Object.values(roles).join(", ")}.`
    });
  }

  // GAP FIX (Chat E): same rule as adminController.createUser/updateUser —
  // approving into Client Viewer with no client_id, or a client_id that
  // doesn't match a real client, produces a silently broken account (the
  // client-scope middleware fails closed and shows that user nothing).
  // Checked before the request is mutated or the user is created.
  let clientId = null;
  if (finalRole === roles.CLIENT_VIEWER) {
    clientId = typeof body.client_id === "string" && body.client_id ? body.client_id : null;
    const client = clientId && (req.db.clients || []).find((c) => c.id === clientId);
    if (!client) {
      return res.status(400).json({
        success: false,
        message: clientId
          ? "client_id does not match an existing client."
          : "client_id is required when approving into Client Viewer."
      });
    }
    if (client.is_active === false) {
      return res.status(400).json({ success: false, message: "That client is inactive." });
    }
  }
  if (req.db.users.some((u) => String(u.email || "").toLowerCase() === request.email.toLowerCase())) {
    return res.status(409).json({ success: false, message: "An account with this email already exists." });
  }

  const before = { ...request };

  const user = {
    id: req.store.id("u"),
    name: request.name,
    email: request.email,
    role: finalRole,
    is_active: true,
    client_id: clientId,
    password_hash: null,
    created_at: new Date().toISOString()
  };
  req.db.users.push(user);

  request.status = "Approved";
  request.reviewed_by = actor.id;
  request.reviewed_at = new Date().toISOString();
  request.approved_role = finalRole;
  request.created_user_id = user.id;

  req.store.audit(req.db, actor, "access_request", request.id, "ACCESS_REQUEST_APPROVED", before, request);
  req.store.audit(req.db, actor, "user", user.id, "ACCESS_REQUEST_USER_CREATED", null, { id: user.id, email: user.email, role: user.role });

  const { password_hash, reset_token, reset_token_hash, reset_token_expires_at, ...safeUser } = user;
  res.json({ success: true, data: { user: safeUser, setup_link_required: true } });
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
  const reason = typeof (req.body || {}).reason === "string" ? req.body.reason.trim() : "";
  request.rejection_reason = reason.slice(0, 500);

  req.store.audit(req.db, actor, "access_request", request.id, "ACCESS_REQUEST_REJECTED", before, request);

  res.json({ success: true, data: request });
};

export const issueAccessRequestSetupLink = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageUsers");

  const request = req.db.access_requests.find((r) => r.id === req.params.id);
  if (!request) return res.status(404).json({ success: false, message: "Access request not found." });
  if (request.status !== "Approved") {
    return res.status(409).json({ success: false, message: "A setup link can only be issued for an approved request." });
  }
  const user = req.db.users.find((u) => u.id === request.created_user_id)
    || req.db.users.find((u) => String(u.email || "").toLowerCase() === request.email.toLowerCase() && !u.password_hash);
  if (!user) return res.status(404).json({ success: false, message: "The account for this request was not found." });
  if (!user.is_active) return res.status(409).json({ success: false, message: "That account is inactive." });
  if (user.password_hash) {
    return res.status(409).json({ success: false, message: "This account has already set a password. A setup link cannot be reissued for it." });
  }

  const { token, expiresAt } = issueSetupToken(user);
  request.setup_link_issue_count = (request.setup_link_issue_count || 0) + 1;
  request.setup_link_last_issued_at = new Date().toISOString();
  req.store.audit(req.db, actor, "access_request", request.id, "ACCESS_REQUEST_SETUP_LINK_ISSUED", null, {
    user_id: user.id,
    expires_at: new Date(expiresAt).toISOString(),
    issue_count: request.setup_link_issue_count
  });

  res.set("Cache-Control", "no-store");
  res.json({
    success: true,
    data: {
      email: user.email,
      setup_path: `/reset-password#email=${encodeURIComponent(user.email)}&token=${token}`,
      expires_at: new Date(expiresAt).toISOString(),
      single_use: true
    }
  });
};

export { REQUESTABLE_ROLES };
