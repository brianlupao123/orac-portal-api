import { hasPermission } from "../permissions.js";
import { isClientViewer } from "../middleware/clientScope.js";
import { collectionGuards, scopeOperationalData } from "./coreController.js";
import {
  INTERNAL_WORK_REQUEST_ACTIONS,
  INTERNAL_WORK_REQUEST_CREATED_ACTION,
  INTERNAL_WORK_REQUEST_LIMITS,
  INTERNAL_WORK_REQUEST_POLICY,
  INTERNAL_WORK_REQUEST_PRIORITIES,
  INTERNAL_WORK_REQUEST_STATUS,
  INTERNAL_WORK_REQUEST_STATUSES,
  NEW_TECHNICIAN_REGISTRATION,
  RELATED_ENTITY_TYPES,
  TECHNICIAN_REGISTRATION_LIMITS,
  WORKER_TYPES,
  allowedActionsFor,
  belongsInInbox,
  belongsInOutbox,
  canReadRequest,
  findLifecycleAction,
  findRelatedEntityType,
  findRequestType,
  isAuditReader,
  isPairingAllowed,
  isTechnicianRegistration,
  parseCreateBody,
  parseTransitionBody,
  recipientsFor,
  relatedClientId,
  relatedEntityLabel,
  relationOf,
  requestTypesFor,
  toAuditSnapshot
} from "../internalWorkRequestRules.js";
import { TECHNICIAN_TRADES } from "../trades.js";

// Internal Work Requests: a controlled staff-to-staff request. Handlers only
// mutate req.db and call req.store.audit(); persistence is the store's job (one
// mutating request holds the store lock, so a claim cannot be won twice).
// Nothing here moves stock, edits a quote/PO/dispatch/invoice/timesheet, sends
// email. Notifications come only from the committed audit event (see notifications.js).

// Same reload-per-request source of truth as auth.js: the account in req.db.
// Deliberately NOT coreController.getActor(), which falls back to users[0].
export const actorFor = (req) => req.db?.users?.find((user) => user.id === req.user?.id);
export const fail = (res, status, message) => res.status(status).json({ success: false, message });
export const deny = (res, actor, what) => fail(res, 403, `Role ${actor?.role || "Unknown"} cannot ${what}.`);
export const requests = (db) => (Array.isArray(db.internal_work_requests) ? db.internal_work_requests : (db.internal_work_requests = []));
const lookup = (list, id) => (id ? (list || []).find((item) => item.id === id) || null : null);
export const NOT_FOUND = "Internal work request not found.";
const UNAVAILABLE_RELATED = "The selected related record is not available to you.";
const AUDIT_READ_ONLY = "Admin audit access is read-only.";

// True when the caller can read this request ONLY through Admin audit access.
export const readOnlyAuditor = (record, actor) => {
  if (!isAuditReader(actor)) return false;
  const relation = relationOf(record, actor);
  return !relation.isRequester && !relation.isAssignee && !relation.isResolver;
};

const canUseAnyPart = (actor) =>
  hasPermission(actor, "viewInternalWorkRequestOutbox") ||
  hasPermission(actor, "viewInternalWorkRequestInbox") ||
  hasPermission(actor, "auditInternalWorkRequests");

// Can this actor read this collection through the generic routes today?
const canReadCollection = (actor, collection) =>
  Boolean(actor?.is_active) && !isClientViewer(actor) && Boolean(collectionGuards[collection]?.includes(actor.role));

/**
 * Resolves a related record against ACTOR's normal read rights: the collection
 * guard for that record type, then the Technician/Supervisor assignment scope.
 * Missing, archived, wrongly-typed and not-permitted records give the same
 * answer, so a caller cannot probe for records it may not read.
 */
export function resolveRelatedEntity(db, actor, type, id) {
  const unavailable = { ok: false };
  const descriptor = findRelatedEntityType(type);
  if (!descriptor || typeof id !== "string" || !id) return unavailable;
  if (!canReadCollection(actor, descriptor.collection)) return unavailable;
  const record = (db[descriptor.collection] || []).find((item) => item.id === id);
  if (!record || record.is_active === false) return unavailable;
  if (scopeOperationalData([record], descriptor.collection, actor, db).length !== 1) return unavailable;
  return { ok: true, record, label: relatedEntityLabel(type, record), client_id: relatedClientId(type, record, db) };
}

// ---------------------------------------------------------------------------
// Views. Built field by field so a future field on the stored record is never
// exposed by accident.
// ---------------------------------------------------------------------------
export function toView(record, db, actor, { includeHistory = false } = {}) {
  let related = null;
  if (record.related_entity_type) {
    const resolved = resolveRelatedEntity(db, actor, record.related_entity_type, record.related_entity_id);
    related = {
      type: record.related_entity_type,
      type_label: RELATED_ENTITY_TYPES[record.related_entity_type]?.label || record.related_entity_type,
      // A viewer who may not read that record type sees its kind, not its identity.
      id: resolved.ok ? record.related_entity_id : null,
      label: resolved.ok ? resolved.label : null,
      viewable: resolved.ok
    };
  }
  const relation = relationOf(record, actor);
  const view = {
    id: record.id,
    request_type: record.request_type,
    request_type_label: INTERNAL_WORK_REQUEST_POLICY[record.request_type]?.label || record.request_type,
    subject: record.subject,
    description: record.description,
    priority: record.priority,
    status: record.status,
    created_by_user_id: record.created_by_user_id,
    created_by_name: lookup(db.users, record.created_by_user_id)?.name || null,
    created_by_role: record.created_by_role,
    recipient_role: record.recipient_role,
    assigned_to_user_id: record.assigned_to_user_id ?? null,
    assigned_to_name: lookup(db.users, record.assigned_to_user_id)?.name || null,
    related_entity: related,
    client_id: canReadCollection(actor, "clients") ? record.client_id ?? null : null,
    resolution_note: record.resolution_note ?? null,
    resolved_by_user_id: record.resolved_by_user_id ?? null,
    resolved_by_name: lookup(db.users, record.resolved_by_user_id)?.name || null,
    acknowledged_at: record.acknowledged_at ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at,
    resolved_at: record.resolved_at ?? null,
    viewer: {
      is_requester: relation.isRequester,
      is_assignee: relation.isAssignee,
      is_audit_only: !relation.isRequester && !relation.isAssignee && !relation.isResolver && !(relation.holdsRecipientRole && record.status === INTERNAL_WORK_REQUEST_STATUS.SUBMITTED)
    },
    allowed_actions: allowedActionsFor(record, actor)
  };
  if (isTechnicianRegistration(record)) {
    // Built field by field. Only participants reach this view (canReadRequest).
    const payload = record.payload || {};
    view.payload = {
      first_name: payload.first_name ?? null,
      last_name: payload.last_name ?? null,
      national_id: payload.national_id ?? null,
      trade: payload.trade ?? null,
      worker_type: payload.worker_type ?? null,
      phone_number: payload.phone_number ?? null
    };
    view.registered_user_id = record.registered_user_id ?? null;
  }
  if (includeHistory) {
    view.history = (record.history || []).map((entry) => ({
      at: entry.at,
      actor_user_id: entry.actor_user_id,
      actor_name: lookup(db.users, entry.actor_user_id)?.name || null,
      actor_role: entry.actor_role,
      action: entry.action,
      from_status: entry.from_status,
      to_status: entry.to_status,
      note: entry.note || ""
    }));
  }
  return view;
}

// Applies one mutation together with its audit event. If the mutation or the
// audit hook throws, the record and the audit/notification lists are restored,
// so a failed action can never leave a half-written request.
export function commit(req, actor, record, auditAction, mutate) {
  const before = { ...record, history: [...(record.history || [])] };
  const auditLogs = Array.isArray(req.db.audit_logs) ? req.db.audit_logs : null;
  const notifications = Array.isArray(req.db.notifications) ? req.db.notifications : null;
  const auditCount = auditLogs ? auditLogs.length : 0;
  const notificationCount = notifications ? notifications.length : 0;
  try {
    mutate();
    req.store.audit(req.db, actor, "internal_work_request", record.id, auditAction, toAuditSnapshot(before), toAuditSnapshot(record));
  } catch (error) {
    Object.keys(record).forEach((key) => delete record[key]);
    Object.assign(record, before);
    if (auditLogs) auditLogs.length = auditCount;
    if (notifications) notifications.length = notificationCount;
    throw error;
  }
}

export const historyEntry = (actor, action, from, to, note, at) => ({
  at, actor_user_id: actor.id, actor_role: actor.role, action, from_status: from, to_status: to, note
});

const compareCreatedAsc = (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id));
const compareCreatedDesc = (a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id));

function statusFilter(req) {
  const status = req.query?.status;
  if (status === undefined) return { ok: true, status };
  if (typeof status !== "string" || !INTERNAL_WORK_REQUEST_STATUSES.includes(status)) {
    return { ok: false, message: `Status must be one of: ${INTERNAL_WORK_REQUEST_STATUSES.join(", ")}.` };
  }
  return { ok: true, status };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
export const getInternalWorkRequestOptions = (req, res) => {
  const actor = actorFor(req);
  if (!hasPermission(actor, "createInternalWorkRequest")) return deny(res, actor, "raise internal work requests");
  const types = requestTypesFor(actor.role).map((code) => {
    const policy = INTERNAL_WORK_REQUEST_POLICY[code];
    const entry = {
      request_type: code,
      label: policy.label,
      related_required: policy.related_required,
      recipients: recipientsFor(code, actor.role),
      related_entity_types: policy.related_entity_types
        .filter((type) => canReadCollection(actor, RELATED_ENTITY_TYPES[type].collection))
        .map((type) => ({ type, label: RELATED_ENTITY_TYPES[type].label }))
    };
    // The form for this type is built from server data: trade and worker-type
    // choices and limits are never hard-coded in the client.
    if (code === NEW_TECHNICIAN_REGISTRATION) {
      entry.technician_registration = { trades: [...TECHNICIAN_TRADES], worker_types: [...WORKER_TYPES], limits: { ...TECHNICIAN_REGISTRATION_LIMITS } };
    }
    return entry;
  });
  return res.json({
    success: true,
    data: { types, priorities: [...INTERNAL_WORK_REQUEST_PRIORITIES], limits: { ...INTERNAL_WORK_REQUEST_LIMITS } }
  });
};

export const createInternalWorkRequest = (req, res) => {
  const actor = actorFor(req);
  if (!hasPermission(actor, "createInternalWorkRequest")) return deny(res, actor, "raise internal work requests");

  const parsed = parseCreateBody(req.body);
  if (!parsed.ok) return fail(res, 400, parsed.message);
  const input = parsed.value;
  const policy = findRequestType(input.request_type);

  // Sender/recipient allow-list. Sender identity and role come from the session.
  const recipients = recipientsFor(input.request_type, actor.role);
  if (recipients.length === 0) return deny(res, actor, `raise ${policy.label} requests`);
  let recipientRole = input.recipient_role;
  if (recipientRole === null) {
    if (recipients.length !== 1) return fail(res, 400, `Choose the recipient role: ${recipients.join(" or ")}.`);
    recipientRole = recipients[0];
  }
  if (!isPairingAllowed(input.request_type, actor.role, recipientRole)) {
    return deny(res, actor, `send ${policy.label} requests to ${recipientRole}`);
  }

  // Related record: allow-listed for the type and readable by THIS requester.
  let relatedType = null;
  let relatedId = null;
  let clientId = null;
  if (input.related_entity_type !== null) {
    if (!policy.related_entity_types.includes(input.related_entity_type)) {
      return fail(res, 400, `A ${policy.label} request cannot reference that kind of record.`);
    }
    const related = resolveRelatedEntity(req.db, actor, input.related_entity_type, input.related_entity_id);
    if (!related.ok) return fail(res, 400, UNAVAILABLE_RELATED);
    relatedType = input.related_entity_type;
    relatedId = input.related_entity_id;
    clientId = related.client_id;
  } else if (policy.related_required) {
    return fail(res, 400, `A ${policy.label} request needs a related record.`);
  }

  const timestamp = new Date().toISOString();
  const record = {
    id: req.store.id("iwr"),
    request_type: input.request_type,
    subject: input.subject,
    description: input.description,
    priority: input.priority,
    status: INTERNAL_WORK_REQUEST_STATUS.SUBMITTED,
    created_by_user_id: actor.id,
    created_by_role: actor.role,
    recipient_role: recipientRole,
    assigned_to_user_id: null,
    acknowledged_at: null,
    related_entity_type: relatedType,
    related_entity_id: relatedId,
    client_id: clientId,
    resolution_note: null,
    resolved_by_user_id: null,
    history: [historyEntry(actor, "submit", null, INTERNAL_WORK_REQUEST_STATUS.SUBMITTED, "", timestamp)],
    created_at: timestamp,
    updated_at: timestamp,
    resolved_at: null
  };
  // Only a technician registration carries a payload (and, once approved, the
  // id of the account it created). Every other request keeps its exact shape.
  if (input.request_type === NEW_TECHNICIAN_REGISTRATION) {
    record.payload = input.payload;
    record.registered_user_id = null;
  }

  const list = requests(req.db);
  const count = list.length;
  const auditLogs = Array.isArray(req.db.audit_logs) ? req.db.audit_logs : null;
  const auditCount = auditLogs ? auditLogs.length : 0;
  try {
    list.push(record);
    req.store.audit(req.db, actor, "internal_work_request", record.id, INTERNAL_WORK_REQUEST_CREATED_ACTION, null, toAuditSnapshot(record));
  } catch (error) {
    list.length = count;
    if (auditLogs) auditLogs.length = auditCount;
    throw error;
  }
  return res.status(201).json({ success: true, data: toView(record, req.db, actor, { includeHistory: true }) });
};

// Server-scoped: only the caller's own requests. No query parameter can widen it.
export const listInternalWorkRequestOutbox = (req, res) => {
  const actor = actorFor(req);
  if (!hasPermission(actor, "viewInternalWorkRequestOutbox")) return deny(res, actor, "view internal work request outbox");
  const filter = statusFilter(req);
  if (!filter.ok) return fail(res, 400, filter.message);
  const items = requests(req.db)
    .filter((record) => belongsInOutbox(record, actor))
    .filter((record) => filter.status === undefined || record.status === filter.status)
    .sort(compareCreatedDesc);
  return res.json({ success: true, data: items.map((record) => toView(record, req.db, actor)) });
};

// Server-scoped from the CURRENT session role: unclaimed requests addressed to
// that role, plus the ones this user claimed or resolved. Nothing in the query
// string (role, office, user) is ever read.
export const listInternalWorkRequestInbox = (req, res) => {
  const actor = actorFor(req);
  if (!hasPermission(actor, "viewInternalWorkRequestInbox")) return deny(res, actor, "view the internal work request inbox");
  const filter = statusFilter(req);
  if (!filter.ok) return fail(res, 400, filter.message);
  const items = requests(req.db)
    .filter((record) => belongsInInbox(record, actor))
    .filter((record) => filter.status === undefined || record.status === filter.status)
    .sort(compareCreatedAsc);
  return res.json({ success: true, data: items.map((record) => toView(record, req.db, actor)) });
};

// Participant-scoped. A request the caller may not read is indistinguishable
// from one that does not exist.
export const getInternalWorkRequest = (req, res) => {
  const actor = actorFor(req);
  if (!canUseAnyPart(actor)) return deny(res, actor, "view internal work requests");
  const record = requests(req.db).find((item) => item.id === req.params.id);
  if (!record || !canReadRequest(record, actor)) return fail(res, 404, NOT_FOUND);
  return res.json({ success: true, data: toView(record, req.db, actor, { includeHistory: true }) });
};

export const acknowledgeInternalWorkRequest = (req, res) => {
  const actor = actorFor(req);
  if (!hasPermission(actor, "workInternalWorkRequest")) return deny(res, actor, "acknowledge internal work requests");
  const record = requests(req.db).find((item) => item.id === req.params.id);
  if (!record) return fail(res, 404, NOT_FOUND);
  const relation = relationOf(record, actor);

  // Only someone who may already see the request (the requester, a member of the
  // addressed role, or a read-only Admin auditor) learns that it exists; every
  // other caller gets the same 404 as for an unknown id.
  if (relation.isRequester) return fail(res, 403, "You cannot acknowledge a request you raised.");
  if (actor.role !== record.recipient_role) {
    if (!canReadRequest(record, actor)) return fail(res, 404, NOT_FOUND);
    return fail(res, 403, readOnlyAuditor(record, actor) ? AUDIT_READ_ONLY : `Only the addressed ${record.recipient_role} recipient can acknowledge this request.`);
  }
  if (record.status !== INTERNAL_WORK_REQUEST_STATUS.SUBMITTED) {
    const message = record.status === INTERNAL_WORK_REQUEST_STATUS.ACKNOWLEDGED || record.status === INTERNAL_WORK_REQUEST_STATUS.IN_PROGRESS
      ? "This request has already been acknowledged."
      : `A request that is ${record.status} cannot be acknowledged.`;
    return fail(res, 409, message);
  }

  const action = INTERNAL_WORK_REQUEST_ACTIONS.acknowledge;
  const timestamp = new Date().toISOString();
  commit(req, actor, record, action.audit, () => {
    record.status = action.to;
    record.assigned_to_user_id = actor.id;
    record.acknowledged_at = timestamp;
    record.updated_at = timestamp;
    record.history = [...record.history, historyEntry(actor, "acknowledge", INTERNAL_WORK_REQUEST_STATUS.SUBMITTED, action.to, "", timestamp)];
  });
  return res.json({ success: true, data: toView(record, req.db, actor, { includeHistory: true }) });
};

export const transitionInternalWorkRequest = (req, res) => {
  const actor = actorFor(req);
  if (!canUseAnyPart(actor)) return deny(res, actor, "use internal work requests");

  const parsed = parseTransitionBody(req.body);
  if (!parsed.ok) return fail(res, 400, parsed.message);
  const { action: actionName, note } = parsed.value;
  const action = findLifecycleAction(actionName);

  const record = requests(req.db).find((item) => item.id === req.params.id);
  if (!record || !canReadRequest(record, actor)) return fail(res, 404, NOT_FOUND);
  const relation = relationOf(record, actor);

  // 1. Who may take this action (403). Admin audit access is read-only.
  if (actionName === "cancel") {
    if (!relation.isRequester) return fail(res, 403, readOnlyAuditor(record, actor) ? AUDIT_READ_ONLY : "Only the requester can cancel this request.");
  } else {
    const recipient = hasPermission(actor, "workInternalWorkRequest") && actor.role === record.recipient_role && !relation.isRequester;
    if (!recipient) return fail(res, 403, readOnlyAuditor(record, actor) ? AUDIT_READ_ONLY : `Only the addressed ${record.recipient_role} recipient can ${actionName} this request.`);
  }

  // 1b. A registration is finished by approving it, which creates the account;
  // completing it by hand would close the request with nobody registered.
  if (actionName === "complete" && isTechnicianRegistration(record)) {
    return fail(res, 400, "Approve this request to add the technician to the registry. It cannot be completed any other way.");
  }

  // 2. Input the action needs (400).
  if (action.note === "required" && !note) {
    return fail(res, 400, actionName === "complete" ? "A resolution note is required to complete a request." : `A reason is required to ${actionName} a request.`);
  }

  // 3. Is the request in a state that allows it (409)?
  if (!action.from.includes(record.status)) {
    const hint = actionName === "start" || actionName === "complete" ? " Acknowledge it first." : "";
    const why = record.status === INTERNAL_WORK_REQUEST_STATUS.IN_PROGRESS && actionName === "cancel" ? " Work has already progressed." : "";
    return fail(res, 409, `A request that is ${record.status} cannot be ${action.verb}.${hint}${why}`);
  }

  // 4. Once claimed, only the assignee works it (403).
  const needsAssignee = actionName === "start" || actionName === "complete" ||
    (actionName === "reject" && record.status === INTERNAL_WORK_REQUEST_STATUS.ACKNOWLEDGED);
  if (needsAssignee && !relation.isAssignee) return fail(res, 403, `Only the assigned recipient can ${actionName} this request.`);

  const timestamp = new Date().toISOString();
  const from = record.status;
  commit(req, actor, record, action.audit, () => {
    record.status = action.to;
    record.updated_at = timestamp;
    if (action.note === "required") {
      record.resolution_note = note;
      record.resolved_by_user_id = actor.id;
      record.resolved_at = timestamp;
    }
    record.history = [...record.history, historyEntry(actor, actionName, from, action.to, note, timestamp)];
  });
  return res.json({ success: true, data: toView(record, req.db, actor, { includeHistory: true }) });
};
