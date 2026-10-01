import { hasPermission } from "../permissions.js";
import { isClientViewer, scopeByClient } from "../middleware/clientScope.js";
import {
  SERVICE_REQUEST_LIMITS,
  SERVICE_REQUEST_STATUS,
  SERVICE_REQUEST_STATUSES,
  SERVICE_REQUEST_URGENCIES,
  buildLeadFromRequest,
  findTriageDecision,
  isRealCalendarDate,
  resolveOwnedReferences,
  toClientView,
  toTriageView
} from "../serviceRequestRules.js";

// Client Service Requests: Client Viewer request -> Sales/Operations triage ->
// one explicit lead. Handlers only mutate req.db and call req.store.audit();
// persistence is the store's job (one request, one write). Nothing here creates
// a quote, PO, dispatch, invoice or email. Notifications come only from the committed
// audit event (see notifications.js).

// Same reload-per-request source of truth as auth.js: the account in req.db.
const actorFor = (req) => req.db?.users?.find((user) => user.id === req.user?.id);
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const deny = (res, actor, what) => fail(res, 403, `Role ${actor?.role || "Unknown"} cannot ${what}.`);
const requests = (db) => (Array.isArray(db.service_requests) ? db.service_requests : (db.service_requests = []));
const optionalText = (value) => (value === undefined || value === null ? "" : value);

export const createServiceRequest = (req, res) => {
  const actor = actorFor(req);
  if (!hasPermission(actor, "createServiceRequest")) return deny(res, actor, "create service requests");
  // A Client Viewer without a client fails closed before anything is read.
  if (!isClientViewer(actor) || !actor.client_id) return fail(res, 403, "Your account is not linked to a client.");

  const client = (req.db.clients || []).find((item) => item.id === actor.client_id);
  if (!client || client.is_active === false) return fail(res, 403, "Your client account is not active.");

  // Whitelist: nothing else in the body is ever read.
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const title = String(optionalText(body.title)).trim();
  const serviceNeed = String(optionalText(body.service_need)).trim();
  const urgency = body.urgency === undefined || body.urgency === null ? "standard" : body.urgency;
  const mineSiteId = body.mine_site_id || null;
  const equipmentTagId = body.equipment_tag_id || null;
  const requestedDate = body.requested_date || null;

  if (!title || title.length > SERVICE_REQUEST_LIMITS.title) return fail(res, 400, "A title of up to 160 characters is required.");
  if (!serviceNeed || serviceNeed.length > SERVICE_REQUEST_LIMITS.serviceNeed) return fail(res, 400, "A service need of up to 2000 characters is required.");
  if (!SERVICE_REQUEST_URGENCIES.includes(urgency)) return fail(res, 400, "Urgency must be standard, planned_shutdown or urgent_downtime.");
  if (typeof (mineSiteId ?? "") !== "string" || typeof (equipmentTagId ?? "") !== "string") return fail(res, 400, "Invalid mine site or equipment tag.");
  if (requestedDate !== null && !isRealCalendarDate(requestedDate)) return fail(res, 400, "Requested date must be a valid YYYY-MM-DD date.");

  const references = resolveOwnedReferences(req.db, actor.client_id, { mine_site_id: mineSiteId, equipment_tag_id: equipmentTagId });
  if (!references.ok) return fail(res, 400, references.message);

  const timestamp = new Date().toISOString();
  const record = {
    id: req.store.id("sr"),
    client_id: actor.client_id,
    created_by_user_id: actor.id,
    title,
    service_need: serviceNeed,
    urgency,
    mine_site_id: mineSiteId,
    equipment_tag_id: equipmentTagId,
    requested_date: requestedDate,
    status: SERVICE_REQUEST_STATUS.SUBMITTED,
    triaged_by_user_id: null,
    triaged_at: null,
    triage_note: "",
    converted_lead_id: null,
    converted_by_user_id: null,
    converted_at: null,
    created_at: timestamp,
    updated_at: timestamp
  };

  requests(req.db).push(record);
  req.store.audit(req.db, actor, "service_request", record.id, "SERVICE_REQUEST_CREATED", null, record);
  return res.status(201).json({ success: true, data: toClientView(record, req.db) });
};

export const listOwnServiceRequests = (req, res) => {
  const actor = actorFor(req);
  if (!hasPermission(actor, "viewOwnServiceRequests")) return deny(res, actor, "view service requests");
  if (!isClientViewer(actor) || !actor.client_id) return fail(res, 403, "Your account is not linked to a client.");

  const own = scopeByClient(req.db.service_requests || [], actor, (item) => item.client_id)
    .filter((item) => item.client_id === actor.client_id)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)));
  return res.json({ success: true, data: own.map((item) => toClientView(item, req.db)) });
};

export const listServiceRequestTriageQueue = (req, res) => {
  const actor = actorFor(req);
  if (!hasPermission(actor, "triageServiceRequests")) return deny(res, actor, "view the service request triage queue");

  const status = req.query?.status;
  if (status !== undefined && (typeof status !== "string" || !SERVICE_REQUEST_STATUSES.includes(status))) {
    return fail(res, 400, `Status must be one of: ${SERVICE_REQUEST_STATUSES.join(", ")}.`);
  }

  const queue = (req.db.service_requests || [])
    .filter((item) => status === undefined || item.status === status)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
  return res.json({ success: true, data: queue.map((item) => toTriageView(item, req.db)) });
};

export const triageServiceRequest = (req, res) => {
  const actor = actorFor(req);
  if (!hasPermission(actor, "triageServiceRequests")) return deny(res, actor, "triage service requests");

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const decision = findTriageDecision(body.decision);
  if (!decision) return fail(res, 400, "Decision must be acknowledge, accept or decline.");
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.trim().length > SERVICE_REQUEST_LIMITS.note)) {
    return fail(res, 400, "Note must be text of up to 1000 characters.");
  }

  const record = (req.db.service_requests || []).find((item) => item.id === req.params.id);
  if (!record) return fail(res, 404, "Service request not found.");
  if (!decision.from.includes(record.status)) {
    return fail(res, 409, `A request that is ${record.status} cannot be moved to ${decision.to}.`);
  }

  const timestamp = new Date().toISOString();
  const before = { ...record };
  record.status = decision.to;
  record.triaged_by_user_id = actor.id;
  record.triaged_at = timestamp;
  if (body.note !== undefined) record.triage_note = body.note.trim();
  record.updated_at = timestamp;

  req.store.audit(req.db, actor, "service_request", record.id, decision.action, before, { ...record });
  return res.json({ success: true, data: toTriageView(record, req.db) });
};

export const convertServiceRequestToLead = (req, res) => {
  const actor = actorFor(req);
  if (!hasPermission(actor, "convertServiceRequest")) return deny(res, actor, "convert service requests");

  const record = (req.db.service_requests || []).find((item) => item.id === req.params.id);
  if (!record) return fail(res, 404, "Service request not found.");
  if (record.converted_lead_id || record.status === SERVICE_REQUEST_STATUS.CONVERTED) {
    return fail(res, 409, "This service request has already been converted to a lead.");
  }
  if (record.status !== SERVICE_REQUEST_STATUS.ACCEPTED) {
    return fail(res, 409, `Only an Accepted request can be converted; this request is ${record.status}.`);
  }
  if (!(req.db.clients || []).some((item) => item.id === record.client_id)) {
    return fail(res, 409, "The client for this request no longer exists.");
  }

  // Everything is validated; from here the changes are applied together and
  // undone if anything (e.g. the audit hook) throws, so a failed conversion
  // can never leave a lead without its request update or audit trail.
  const timestamp = new Date().toISOString();
  const lead = buildLeadFromRequest(record, req.db, req.store.id("lead"), timestamp);
  const before = { ...record };
  const leads = Array.isArray(req.db.leads) ? req.db.leads : (req.db.leads = []);
  const auditLogs = Array.isArray(req.db.audit_logs) ? req.db.audit_logs : null;
  const leadCount = leads.length;
  const auditCount = auditLogs ? auditLogs.length : 0;

  try {
    leads.push(lead);
    record.status = SERVICE_REQUEST_STATUS.CONVERTED;
    record.converted_lead_id = lead.id;
    record.converted_by_user_id = actor.id;
    record.converted_at = timestamp;
    record.updated_at = timestamp;
    req.store.audit(req.db, actor, "service_request", record.id, "SERVICE_REQUEST_CONVERTED_TO_LEAD", before, { ...record });
    req.store.audit(req.db, actor, "lead", lead.id, "LEAD_CREATED_FROM_SERVICE_REQUEST", null, lead);
  } catch (error) {
    leads.length = leadCount;
    if (auditLogs) auditLogs.length = auditCount;
    Object.keys(record).forEach((key) => delete record[key]);
    Object.assign(record, before);
    throw error;
  }

  return res.status(201).json({ success: true, data: { service_request: toTriageView(record, req.db), lead } });
};
