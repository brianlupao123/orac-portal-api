import { hasPermission, roles } from "../permissions.js";
import {
  INTERNAL_WORK_REQUEST_STATUS,
  TECHNICIAN_APPROVAL,
  TECHNICIAN_APPROVAL_ACTION,
  TECHNICIAN_REGISTERED_AUDIT_ACTION,
  canReadRequest,
  isTechnicianRegistration,
  normaliseNationalId,
  parseTechnicianPayload,
  relationOf,
  toAuditSnapshot
} from "../internalWorkRequestRules.js";
import { NOT_FOUND, actorFor, deny, fail, historyEntry, readOnlyAuditor, requests, toView } from "./internalWorkRequestsController.js";

// Technician registration: the one Internal Work Request that changes another
// record. An Admin approving a Supervisor's NEW_TECHNICIAN_REGISTRATION request
// creates the technician account in req.db.users from the request's own
// payload, and completes the request, in a single step.
//
// It lives apart from internalWorkRequestsController.js on purpose: that file
// is pinned (tests/internalWorkRequestsIsolation.test.js) to never write to any
// business collection. Everything that creates an account is in this file.
//
// Guarantees:
//  - Admin only: the caller must hold both workInternalWorkRequest and
//    manageUsers, be the addressed recipient, and (once claimed) the assignee.
//  - The details come from the stored request, never from this call's body.
//  - They are validated again here, so a damaged stored payload cannot create
//    an account.
//  - One person, one account: a national ID already on any user (spacing,
//    dashes and case ignored) refuses the approval and changes nothing.
//  - All or nothing: if any step throws, the account, the request and the audit
//    and notification lists are restored.
//  - The national ID and phone number never enter an audit record.
//  - The new account has no email and no password, so it cannot sign in. An
//    Admin can add credentials later through the normal user screen.

export const approveTechnicianRegistration = (req, res) => {
  const actor = actorFor(req);
  if (!hasPermission(actor, "workInternalWorkRequest") || !hasPermission(actor, "manageUsers")) {
    return deny(res, actor, "approve technician registrations");
  }
  const record = requests(req.db).find((item) => item.id === req.params.id);
  if (!record || !canReadRequest(record, actor)) return fail(res, 404, NOT_FOUND);
  if (!isTechnicianRegistration(record)) return fail(res, 400, "This request is not a technician registration.");

  const relation = relationOf(record, actor);
  if (relation.isRequester || actor.role !== record.recipient_role) {
    return fail(res, 403, readOnlyAuditor(record, actor)
      ? "Admin audit access is read-only."
      : `Only the addressed ${record.recipient_role} recipient can approve this request.`);
  }
  if (!TECHNICIAN_APPROVAL.from.includes(record.status)) {
    const message = record.status === INTERNAL_WORK_REQUEST_STATUS.COMPLETED && record.registered_user_id
      ? "This registration has already been approved."
      : `A request that is ${record.status} cannot be approved.`;
    return fail(res, 409, message);
  }
  if (record.status !== INTERNAL_WORK_REQUEST_STATUS.SUBMITTED && !relation.isAssignee) {
    return fail(res, 403, "Only the assigned recipient can approve this request.");
  }

  const details = parseTechnicianPayload(record.payload);
  if (!details.ok) return fail(res, 409, "The registration details on this request are not valid. Reject it and ask for a new one.");
  const person = details.value;

  const idKey = normaliseNationalId(person.national_id);
  if ((req.db.users || []).some((user) => user.national_id && normaliseNationalId(user.national_id) === idKey)) {
    return fail(res, 409, "Someone with this national ID is already registered. Reject this request or check the registry.");
  }

  const timestamp = new Date().toISOString();
  const from = record.status;
  const user = {
    id: req.store.id("u"),
    name: `${person.first_name} ${person.last_name}`,
    email: null,
    role: roles.TECHNICIAN,
    is_active: true,
    client_id: null,
    trade: person.trade,
    worker_type: person.worker_type,
    national_id: person.national_id,
    phone_number: person.phone_number,
    password_hash: null,
    registered_via_request_id: record.id,
    created_at: timestamp
  };

  const before = { ...record, history: [...(record.history || [])] };
  const users = req.db.users;
  const userCount = users.length;
  const auditLogs = Array.isArray(req.db.audit_logs) ? req.db.audit_logs : null;
  const notifications = Array.isArray(req.db.notifications) ? req.db.notifications : null;
  const auditCount = auditLogs ? auditLogs.length : 0;
  const notificationCount = notifications ? notifications.length : 0;
  try {
    users.push(user);
    record.status = TECHNICIAN_APPROVAL.to;
    record.assigned_to_user_id = record.assigned_to_user_id || actor.id;
    record.acknowledged_at = record.acknowledged_at || timestamp;
    record.resolution_note = TECHNICIAN_APPROVAL.resolution_note;
    record.resolved_by_user_id = actor.id;
    record.resolved_at = timestamp;
    record.registered_user_id = user.id;
    record.updated_at = timestamp;
    record.history = [
      ...record.history,
      ...(from === INTERNAL_WORK_REQUEST_STATUS.SUBMITTED
        ? [historyEntry(actor, "acknowledge", from, INTERNAL_WORK_REQUEST_STATUS.ACKNOWLEDGED, "", timestamp)]
        : []),
      historyEntry(actor, TECHNICIAN_APPROVAL_ACTION,
        from === INTERNAL_WORK_REQUEST_STATUS.SUBMITTED ? INTERNAL_WORK_REQUEST_STATUS.ACKNOWLEDGED : from,
        TECHNICIAN_APPROVAL.to, TECHNICIAN_APPROVAL.resolution_note, timestamp)
    ];
    // Metadata only. No national ID, no phone number, no free text.
    req.store.audit(req.db, actor, "user", user.id, TECHNICIAN_REGISTERED_AUDIT_ACTION, null, {
      id: user.id,
      name: user.name,
      role: user.role,
      trade: user.trade,
      worker_type: user.worker_type,
      source_request_id: record.id,
      has_national_id: true
    });
    req.store.audit(req.db, actor, "internal_work_request", record.id, TECHNICIAN_APPROVAL.audit, toAuditSnapshot(before), toAuditSnapshot(record));
  } catch (error) {
    users.length = userCount;
    Object.keys(record).forEach((key) => delete record[key]);
    Object.assign(record, before);
    if (auditLogs) auditLogs.length = auditCount;
    if (notifications) notifications.length = notificationCount;
    throw error;
  }

  return res.json({
    success: true,
    data: {
      ...toView(record, req.db, actor, { includeHistory: true }),
      technician: { id: user.id, name: user.name, role: user.role, trade: user.trade, worker_type: user.worker_type }
    }
  });
};
