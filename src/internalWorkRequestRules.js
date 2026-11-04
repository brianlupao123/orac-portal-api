// Internal Work Requests - pure domain rules (no I/O, no Express, no store).
//
// A controlled staff-to-staff request: a permitted requester addresses ONE
// recipient role, one eligible recipient claims it, and it is resolved with a
// recorded note. This is NOT a Client Service Request, chat, email or approval
// path. A request never moves stock or changes a quote, purchase order,
// dispatch card, invoice or timesheet.

import { hasPermission, roles } from "./permissions.js";
import { TECHNICIAN_TRADES } from "./trades.js";

const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
};

export const INTERNAL_WORK_REQUEST_STATUS = Object.freeze({
  SUBMITTED: "Submitted",
  ACKNOWLEDGED: "Acknowledged",
  IN_PROGRESS: "In Progress",
  COMPLETED: "Completed",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled"
});

const S = INTERNAL_WORK_REQUEST_STATUS;

export const INTERNAL_WORK_REQUEST_STATUSES = Object.freeze(Object.values(S));
export const INTERNAL_WORK_REQUEST_TERMINAL_STATUSES = Object.freeze([S.COMPLETED, S.REJECTED, S.CANCELLED]);
export const INTERNAL_WORK_REQUEST_PRIORITIES = Object.freeze(["Low", "Normal", "High", "Urgent"]);
export const INTERNAL_WORK_REQUEST_LIMITS = Object.freeze({ subject: 160, description: 2000, note: 1000, relatedId: 100 });
export const INTERNAL_WORK_REQUEST_CREATED_ACTION = "INTERNAL_WORK_REQUEST_CREATED";

// ---------------------------------------------------------------------------
// Lifecycle. Only these status changes exist. There is no reopen, reassignment
// or free-form status: callers name an ACTION and the server picks the status.
// ---------------------------------------------------------------------------
export const INTERNAL_WORK_REQUEST_ACTIONS = deepFreeze({
  acknowledge: { from: [S.SUBMITTED], to: S.ACKNOWLEDGED, audit: "INTERNAL_WORK_REQUEST_ACKNOWLEDGED", note: "none", verb: "acknowledged" },
  start: { from: [S.ACKNOWLEDGED], to: S.IN_PROGRESS, audit: "INTERNAL_WORK_REQUEST_STARTED", note: "optional", verb: "started" },
  complete: { from: [S.ACKNOWLEDGED, S.IN_PROGRESS], to: S.COMPLETED, audit: "INTERNAL_WORK_REQUEST_COMPLETED", note: "required", verb: "completed" },
  reject: { from: [S.SUBMITTED, S.ACKNOWLEDGED], to: S.REJECTED, audit: "INTERNAL_WORK_REQUEST_REJECTED", note: "required", verb: "rejected" },
  cancel: { from: [S.SUBMITTED, S.ACKNOWLEDGED], to: S.CANCELLED, audit: "INTERNAL_WORK_REQUEST_CANCELLED", note: "required", verb: "cancelled" }
});

// Acknowledge has its own endpoint (single claim); the rest go through /transition.
export const INTERNAL_WORK_REQUEST_TRANSITION_ACTIONS = Object.freeze(["start", "complete", "reject", "cancel"]);

export function findLifecycleAction(name) {
  // Own-property lookup: "constructor", "__proto__" etc. are never actions.
  return typeof name === "string" && Object.hasOwn(INTERNAL_WORK_REQUEST_ACTIONS, name) ? INTERNAL_WORK_REQUEST_ACTIONS[name] : null;
}

// ---------------------------------------------------------------------------
// Related records a request may point at. The record is resolved server-side
// against the REQUESTER's normal read rights (see the controller).
// ---------------------------------------------------------------------------
export const RELATED_ENTITY_TYPES = deepFreeze({
  quote: { label: "Quote", collection: "quotes" },
  purchase_order: { label: "Purchase order", collection: "purchase_orders" },
  dispatch_card: { label: "Dispatch card", collection: "dispatch_cards" },
  invoice: { label: "Invoice", collection: "invoices" },
  stock_item: { label: "Stock item", collection: "stock_items" }
});

export const RELATED_ENTITY_TYPE_CODES = Object.freeze(Object.keys(RELATED_ENTITY_TYPES));

export function findRelatedEntityType(code) {
  return typeof code === "string" && Object.hasOwn(RELATED_ENTITY_TYPES, code) ? RELATED_ENTITY_TYPES[code] : null;
}

export function relatedEntityLabel(type, record) {
  if (!record) return null;
  switch (type) {
    case "quote": return record.quote_number || record.id;
    case "purchase_order": return record.po_reference || record.id;
    case "dispatch_card": return record.dispatch_number || record.id;
    case "invoice": return record.invoice_number || record.id;
    case "stock_item": return [record.item_code, record.item_name].filter(Boolean).join(" - ") || record.id;
    default: return record.id || null;
  }
}

const find = (list, id) => (id ? (list || []).find((item) => item.id === id) || null : null);

// The client a related record belongs to, derived from data ORAC already holds.
// Stock items have no client. Never taken from the caller.
export function relatedClientId(type, record, db) {
  if (!record) return null;
  switch (type) {
    case "quote": return record.client_id || null;
    case "purchase_order": return find(db.quotes, record.quotation_id)?.client_id || null;
    case "dispatch_card": return find(db.quotes, record.quotation_id)?.client_id || null;
    case "invoice": {
      const job = find(db.dispatch_cards, record.dispatch_card_id);
      return find(db.quotes, job?.quotation_id)?.client_id || null;
    }
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// PAIRING POLICY - PROPOSED, OWNER DECISION REQUIRED.
// Which sender role may raise which request type, addressed to which recipient
// role. This is the ONLY place the matrix lives. It is deliberately narrow: a
// pairing that is not listed here does not exist. Admin is recipient/auditor
// only. Client Viewer appears nowhere. See ROLE_PAIRING_OWNER_DECISIONS.md.
// ---------------------------------------------------------------------------
const { ADMIN, MANAGEMENT, SALES, FINANCE, OPERATIONS, SUPERVISOR, TECHNICIAN } = roles;

export const INTERNAL_WORK_REQUEST_POLICY = deepFreeze({
  STOCK_AVAILABILITY: {
    label: "Stock availability",
    related_required: false,
    related_entity_types: ["quote"],
    pairings: { [SALES]: [OPERATIONS] }
  },
  STOCK_FULFILMENT: {
    label: "Stock fulfilment",
    related_required: true,
    related_entity_types: ["quote", "dispatch_card", "stock_item"],
    pairings: { [SALES]: [OPERATIONS], [OPERATIONS]: [OPERATIONS] }
  },
  PO_AMENDMENT_CONFIRMATION: {
    label: "PO amendment confirmation",
    related_required: true,
    related_entity_types: ["purchase_order", "quote", "invoice"],
    pairings: { [FINANCE]: [SALES, OPERATIONS] }
  },
  MATERIAL_RECONCILIATION: {
    label: "Material reconciliation",
    related_required: true,
    related_entity_types: ["dispatch_card", "purchase_order", "stock_item"],
    pairings: { [OPERATIONS]: [FINANCE] }
  },
  FIELD_CLARIFICATION: {
    label: "Field clarification",
    related_required: true,
    related_entity_types: ["dispatch_card"],
    pairings: { [TECHNICIAN]: [OPERATIONS], [SUPERVISOR]: [OPERATIONS] }
  },
  COMMERCIAL_CLARIFICATION: {
    label: "Commercial clarification",
    related_required: true,
    related_entity_types: ["quote", "purchase_order"],
    pairings: { [OPERATIONS]: [SALES, FINANCE] }
  },
  ADMINISTRATIVE_SUPPORT: {
    label: "Administrative support",
    related_required: false,
    related_entity_types: [],
    pairings: {
      [SALES]: [ADMIN, MANAGEMENT],
      [FINANCE]: [ADMIN, MANAGEMENT],
      [OPERATIONS]: [ADMIN, MANAGEMENT],
      [SUPERVISOR]: [ADMIN, MANAGEMENT],
      [TECHNICIAN]: [ADMIN, MANAGEMENT],
      [MANAGEMENT]: [ADMIN]
    }
  },
  // A Supervisor asks Admin to add a new artisan/contractor to the Technician
  // Registry. The structured details travel in `payload`; subject and
  // description are generated by the server. Approval is its own endpoint (see
  // technicianRegistrationController.js) because it is the one request that
  // creates an account.
  NEW_TECHNICIAN_REGISTRATION: {
    label: "New technician registration",
    related_required: false,
    related_entity_types: [],
    pairings: { [SUPERVISOR]: [ADMIN] }
  }
});

export const INTERNAL_WORK_REQUEST_TYPE_CODES = Object.freeze(Object.keys(INTERNAL_WORK_REQUEST_POLICY));

export function findRequestType(code) {
  return typeof code === "string" && Object.hasOwn(INTERNAL_WORK_REQUEST_POLICY, code) ? INTERNAL_WORK_REQUEST_POLICY[code] : null;
}

export function recipientsFor(type, senderRole) {
  const policy = findRequestType(type);
  return policy && typeof senderRole === "string" && Object.hasOwn(policy.pairings, senderRole) ? [...policy.pairings[senderRole]] : [];
}

export function isPairingAllowed(type, senderRole, recipientRole) {
  return recipientsFor(type, senderRole).includes(recipientRole);
}

export const requestTypesFor = (senderRole) => INTERNAL_WORK_REQUEST_TYPE_CODES.filter((code) => recipientsFor(code, senderRole).length > 0);

// Flat rows, used by tests and documentation so the matrix is enumerable.
export function pairingRows() {
  const rows = [];
  for (const type of INTERNAL_WORK_REQUEST_TYPE_CODES) {
    for (const [sender, recipients] of Object.entries(INTERNAL_WORK_REQUEST_POLICY[type].pairings)) {
      for (const recipient of recipients) rows.push({ type, sender, recipient });
    }
  }
  return rows;
}

export const policySenderRoles = () => [...new Set(pairingRows().map((row) => row.sender))];
export const policyRecipientRoles = () => [...new Set(pairingRows().map((row) => row.recipient))];

// ---------------------------------------------------------------------------
// New technician registration: payload rules (pure).
// ---------------------------------------------------------------------------
export const NEW_TECHNICIAN_REGISTRATION = "NEW_TECHNICIAN_REGISTRATION";
export const TECHNICIAN_APPROVAL_ACTION = "approve_registration";
export const WORKER_TYPES = Object.freeze(["permanent", "contractor"]);
export const TECHNICIAN_PAYLOAD_KEYS = Object.freeze(["first_name", "last_name", "national_id", "trade", "worker_type", "phone_number"]);
export const TECHNICIAN_REGISTRATION_LIMITS = Object.freeze({ name: 50, nationalId: 20, phone: 20 });

// The one approval path. Distinct from the generic lifecycle table above: it
// may start from any open status and always ends Completed.
export const TECHNICIAN_APPROVAL = deepFreeze({
  from: [S.SUBMITTED, S.ACKNOWLEDGED, S.IN_PROGRESS],
  to: S.COMPLETED,
  audit: "INTERNAL_WORK_REQUEST_COMPLETED",
  resolution_note: "Approved and added to the Technician Registry."
});

export const TECHNICIAN_REGISTERED_AUDIT_ACTION = "TECHNICIAN_REGISTERED_FROM_REQUEST";
export const isTechnicianRegistration = (record) => record?.request_type === NEW_TECHNICIAN_REGISTRATION;

// Used only to detect a duplicate person: "63-123456 a 42" and "63123456A42" are the same ID.
export const normaliseNationalId = (value) => String(value ?? "").replace(/[\s-]+/g, "").toUpperCase();

const collapse = (value) => String(value).trim().replace(/\s+/g, " ");
const NAME_PATTERN = /^[\p{L}][\p{L}\p{M}'. -]*$/u;
const NATIONAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]*[A-Za-z0-9]$/;
const PHONE_PATTERN = /^\+?[0-9][0-9 ()-]*[0-9]$/;

// Shape, limits and the allow-lists. Returns a normalised copy, or a message.
export function parseTechnicianPayload(input) {
  const body = input && typeof input === "object" && !Array.isArray(input) ? input : null;
  if (!body) return { ok: false, message: "Technician details are required." };
  const unknown = Object.keys(body).filter((key) => !TECHNICIAN_PAYLOAD_KEYS.includes(key));
  if (unknown.length > 0) return { ok: false, message: `Unexpected technician detail: ${unknown[0]}.` };
  for (const key of TECHNICIAN_PAYLOAD_KEYS) {
    if (typeof body[key] !== "string") return { ok: false, message: `Technician ${key.replace(/_/g, " ")} is required.` };
  }
  const { name: nameMax, nationalId: idMax, phone: phoneMax } = TECHNICIAN_REGISTRATION_LIMITS;
  const first_name = collapse(body.first_name);
  const last_name = collapse(body.last_name);
  for (const [label, value] of [["First name", first_name], ["Last name", last_name]]) {
    if (!value || value.length > nameMax || !NAME_PATTERN.test(value)) {
      return { ok: false, message: `${label} is required (letters only, up to ${nameMax} characters).` };
    }
  }
  const national_id = collapse(body.national_id);
  if (national_id.length < 6 || national_id.length > idMax || !NATIONAL_ID_PATTERN.test(national_id)) {
    return { ok: false, message: `National ID must be 6 to ${idMax} letters, digits, spaces or dashes.` };
  }
  if (!TECHNICIAN_TRADES.includes(body.trade)) {
    return { ok: false, message: `Trade must be one of: ${TECHNICIAN_TRADES.join(", ")}.` };
  }
  if (!WORKER_TYPES.includes(body.worker_type)) {
    return { ok: false, message: `Worker type must be one of: ${WORKER_TYPES.join(", ")}.` };
  }
  const phone_number = collapse(body.phone_number);
  const digits = phone_number.replace(/\D/g, "");
  if (phone_number.length > phoneMax || digits.length < 7 || !PHONE_PATTERN.test(phone_number)) {
    return { ok: false, message: `Phone number must have 7 or more digits (up to ${phoneMax} characters).` };
  }
  return { ok: true, value: { first_name, last_name, national_id, trade: body.trade, worker_type: body.worker_type, phone_number } };
}

// Generated text. The national ID is deliberately never part of it: subject and
// description are copied into lists and notifications; the ID stays in the payload.
export function technicianRegistrationText(payload) {
  const name = `${payload.first_name} ${payload.last_name}`;
  return {
    subject: `Register technician: ${name} (${payload.trade})`,
    description: `Please add ${name} to the Technician Registry as a ${payload.worker_type} ${payload.trade}.`
  };
}

// ---------------------------------------------------------------------------
// Body parsing (shape and limits only; pairing and related-record checks need
// the actor and the database, so the controller performs them).
// ---------------------------------------------------------------------------
const text = (value) => (value === undefined || value === null ? "" : value);

function parseTechnicianRegistrationCreate(body) {
  // Subject and description are generated, so a caller cannot put the ID (or
  // anything else) into the free text that lists and notifications reuse.
  if (body.subject !== undefined || body.description !== undefined) {
    return { ok: false, message: "A technician registration does not take a subject or description; they are generated from the details." };
  }
  const details = parseTechnicianPayload(body.payload);
  if (!details.ok) return details;
  const priority = body.priority === undefined || body.priority === null ? "Normal" : body.priority;
  if (!INTERNAL_WORK_REQUEST_PRIORITIES.includes(priority)) {
    return { ok: false, message: `Priority must be one of: ${INTERNAL_WORK_REQUEST_PRIORITIES.join(", ")}.` };
  }
  if (body.recipient_role !== undefined && body.recipient_role !== null && typeof body.recipient_role !== "string") {
    return { ok: false, message: "Recipient role must be text." };
  }
  if ((body.related_entity_type ?? null) !== null || (body.related_entity_id ?? null) !== null) {
    return { ok: false, message: "A technician registration cannot reference another record." };
  }
  const { subject, description } = technicianRegistrationText(details.value);
  return {
    ok: true,
    value: {
      request_type: NEW_TECHNICIAN_REGISTRATION,
      subject,
      description,
      priority,
      recipient_role: body.recipient_role ? body.recipient_role : null,
      related_entity_type: null,
      related_entity_id: null,
      payload: details.value
    }
  };
}

export function parseCreateBody(input) {
  // Whitelist: nothing else in the body is ever read (sender, role, client,
  // status, assignee, history and timestamps are always server-owned).
  const body = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const { subject: subjectMax, description: descriptionMax, relatedId: relatedIdMax } = INTERNAL_WORK_REQUEST_LIMITS;

  if (typeof body.request_type !== "string" || !findRequestType(body.request_type)) {
    return { ok: false, message: `Request type must be one of: ${INTERNAL_WORK_REQUEST_TYPE_CODES.join(", ")}.` };
  }
  if (body.request_type === NEW_TECHNICIAN_REGISTRATION) {
    return parseTechnicianRegistrationCreate(body);
  }
  if (body.payload !== undefined) return { ok: false, message: "Only a technician registration request carries technician details." };
  if (typeof text(body.subject) !== "string" || typeof text(body.description) !== "string") {
    return { ok: false, message: "Subject and description must be text." };
  }
  const subject = String(text(body.subject)).trim();
  const description = String(text(body.description)).trim();
  if (!subject || subject.length > subjectMax) return { ok: false, message: `A subject of up to ${subjectMax} characters is required.` };
  if (!description || description.length > descriptionMax) return { ok: false, message: `A description of up to ${descriptionMax} characters is required.` };

  const priority = body.priority === undefined || body.priority === null ? "Normal" : body.priority;
  if (!INTERNAL_WORK_REQUEST_PRIORITIES.includes(priority)) {
    return { ok: false, message: `Priority must be one of: ${INTERNAL_WORK_REQUEST_PRIORITIES.join(", ")}.` };
  }

  if (body.recipient_role !== undefined && body.recipient_role !== null && typeof body.recipient_role !== "string") {
    return { ok: false, message: "Recipient role must be text." };
  }
  const relatedType = body.related_entity_type ?? null;
  const relatedId = body.related_entity_id ?? null;
  if ((relatedType !== null && typeof relatedType !== "string") || (relatedId !== null && typeof relatedId !== "string")) {
    return { ok: false, message: "Related record type and id must be text." };
  }
  if ((relatedType === null) !== (relatedId === null)) {
    return { ok: false, message: "A related record needs both a type and an id." };
  }
  if (relatedType !== null && (!findRelatedEntityType(relatedType) || !relatedId.trim() || relatedId.length > relatedIdMax)) {
    return { ok: false, message: "The related record is not valid." };
  }

  return {
    ok: true,
    value: {
      request_type: body.request_type,
      subject,
      description,
      priority,
      recipient_role: body.recipient_role ? body.recipient_role : null,
      related_entity_type: relatedType,
      related_entity_id: relatedId === null ? null : relatedId.trim()
    }
  };
}

export function parseTransitionBody(input) {
  const body = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (body.action === "acknowledge") return { ok: false, message: "Use the acknowledge endpoint to claim a request." };
  if (typeof body.action !== "string" || !INTERNAL_WORK_REQUEST_TRANSITION_ACTIONS.includes(body.action)) {
    return { ok: false, message: `Action must be one of: ${INTERNAL_WORK_REQUEST_TRANSITION_ACTIONS.join(", ")}.` };
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") return { ok: false, message: "Note must be text." };
  const note = String(text(body.note)).trim();
  if (note.length > INTERNAL_WORK_REQUEST_LIMITS.note) return { ok: false, message: `Note cannot exceed ${INTERNAL_WORK_REQUEST_LIMITS.note} characters.` };
  return { ok: true, value: { action: body.action, note } };
}

// ---------------------------------------------------------------------------
// Participation. Existence and content are revealed only to participants.
// ---------------------------------------------------------------------------
export function relationOf(record, actor) {
  const isRequester = record.created_by_user_id === actor.id;
  const isAssignee = Boolean(record.assigned_to_user_id) && record.assigned_to_user_id === actor.id;
  const isResolver = Boolean(record.resolved_by_user_id) && record.resolved_by_user_id === actor.id;
  // The person who raised a request is never its recipient, even when they
  // hold the recipient role (e.g. Operations -> Operations).
  const holdsRecipientRole = actor.role === record.recipient_role && !isRequester;
  return { isRequester, isAssignee, isResolver, holdsRecipientRole };
}

const asOutboxUser = (actor) => hasPermission(actor, "viewInternalWorkRequestOutbox");
const asInboxUser = (actor) => hasPermission(actor, "viewInternalWorkRequestInbox");

export function isAuditReader(actor) {
  return hasPermission(actor, "auditInternalWorkRequests");
}

export function canReadRequest(record, actor) {
  if (!record || !actor?.is_active) return false;
  const relation = relationOf(record, actor);
  if (relation.isRequester && asOutboxUser(actor)) return true;
  if ((relation.isAssignee || relation.isResolver) && asInboxUser(actor)) return true;
  if (relation.holdsRecipientRole && record.status === S.SUBMITTED && asInboxUser(actor)) return true;
  return isAuditReader(actor);
}

// True when the request belongs in this actor's team inbox. The creator's own
// request never appears there.
export function belongsInInbox(record, actor) {
  if (!record || !actor?.is_active || !asInboxUser(actor)) return false;
  const relation = relationOf(record, actor);
  if (relation.isRequester) return false;
  return (relation.holdsRecipientRole && record.status === S.SUBMITTED) || relation.isAssignee || relation.isResolver;
}

export const belongsInOutbox = (record, actor) => Boolean(record && actor?.is_active && asOutboxUser(actor) && record.created_by_user_id === actor.id);

// A registration is finished only by approving it (which creates the account),
// so "complete" is never offered for this type. Reject and cancel are unchanged.
function technicianRegistrationActions(record, relation, worker, requester) {
  const actions = [];
  switch (record.status) {
    case S.SUBMITTED:
      if (worker) actions.push(TECHNICIAN_APPROVAL_ACTION, "acknowledge", "reject");
      if (requester) actions.push("cancel");
      break;
    case S.ACKNOWLEDGED:
      if (worker && relation.isAssignee) actions.push(TECHNICIAN_APPROVAL_ACTION, "start", "reject");
      if (requester) actions.push("cancel");
      break;
    case S.IN_PROGRESS:
      if (worker && relation.isAssignee) actions.push(TECHNICIAN_APPROVAL_ACTION);
      break;
    default:
      break;
  }
  return actions;
}

// The actions this actor may take right now. The UI renders buttons from this
// list; the server re-validates every action independently.
export function allowedActionsFor(record, actor) {
  if (!record || !actor?.is_active) return [];
  const relation = relationOf(record, actor);
  // A recipient must still hold the recipient role today (fail closed if an
  // account's role changed after it claimed the request).
  const worker = hasPermission(actor, "workInternalWorkRequest") && actor.role === record.recipient_role && !relation.isRequester;
  const requester = relation.isRequester && asOutboxUser(actor);
  const actions = [];
  if (isTechnicianRegistration(record)) return technicianRegistrationActions(record, relation, worker, requester);
  switch (record.status) {
    case S.SUBMITTED:
      if (worker) actions.push("acknowledge", "reject");
      if (requester) actions.push("cancel");
      break;
    case S.ACKNOWLEDGED:
      if (worker && relation.isAssignee) actions.push("start", "complete", "reject");
      if (requester) actions.push("cancel");
      break;
    case S.IN_PROGRESS:
      if (worker && relation.isAssignee) actions.push("complete");
      break;
    default:
      break;
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Audit projection. audit_logs is readable by Admin, Management and Finance
// through the generic collection route, so an audit entry must NEVER carry the
// subject, description or any note. Metadata only; the words stay on the
// participant-scoped record.
// ---------------------------------------------------------------------------
export function toAuditSnapshot(record) {
  return {
    id: record.id,
    request_type: record.request_type,
    priority: record.priority,
    status: record.status,
    created_by_user_id: record.created_by_user_id,
    created_by_role: record.created_by_role,
    recipient_role: record.recipient_role,
    assigned_to_user_id: record.assigned_to_user_id ?? null,
    related_entity_type: record.related_entity_type ?? null,
    related_entity_id: record.related_entity_id ?? null,
    client_id: record.client_id ?? null,
    has_resolution_note: Boolean(record.resolution_note),
    created_at: record.created_at,
    updated_at: record.updated_at,
    resolved_at: record.resolved_at ?? null
  };
}
