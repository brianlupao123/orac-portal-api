// V5 signature-evidence HTTP handlers. DARK: every handler refuses with
// 409 FEATURE_DISABLED unless ORAC_V5_COMMERCIAL_WORKFLOW is enabled.
//  - Client-site Supervisor = a NAMED CONTACT stored as evidence. No account, role,
//    login, OTP, portal action or impersonation exists anywhere in this file.
//  - Paper evidence is append-only. A correction changes the Timesheet hash, which
//    makes earlier evidence/confirmations non-current; nothing is deleted or edited.
//  - The ORAC Supervisor confirmation is in-system, by the existing Supervisor role,
//    scoped to the dispatch the Supervisor is assigned to.
// No rate, amount or cost is read or returned.
import { requirePermission, roles } from "../permissions.js";
import { v5Enabled, getV5Policy } from "../v5CommercialWorkflow.js";
import { isIsoDate } from "../timesheetModel.js";
import {
  V5_HASH_VERSION, V5_PAPER_ATTESTATION_TEXT, v5Context, v5SalesOwnerIds, isAssignedOracSupervisor, v5SheetBlockers, v5SignatureState,
  v5TimesheetHash, v5RecordHash, paperEvidenceMissing, v5ChannelRefusal
} from "../v5SignatureEvidence.js";
import { V5ClientSupervisorContactSchema, V5PaperSignatureSchema, V5SupervisorConfirmationSchema } from "../v5SignatureSchemas.js";

const getActor = (req) => (req.user?.id ? (req.db.users || []).find((user) => user.id === req.user.id) : null);
const off = (res, name) => res.status(409).json({ success: false, code: "FEATURE_DISABLED", message: `${name} is not enabled yet.` });
const today = () => new Date().toISOString().slice(0, 10);
const bad = (res, message, code, status = 400) => res.status(status).json({ success: false, ...(code ? { code } : {}), message });
const parse = (schema, body) => {
  const result = schema.safeParse(body ?? {});
  return result.success ? { data: result.data } : { error: result.error.issues.map((issue) => issue.message).join(" ") };
};

function v5Dispatch(req, res) {
  const dispatch = (req.db.dispatch_cards || []).find((item) => item.id === req.params.id);
  if (!dispatch) { res.status(404).json({ success: false, message: "Dispatch card not found." }); return null; }
  const quote = (req.db.quotes || []).find((item) => item.id === dispatch.quotation_id);
  if (!quote?.v5_commercial_workflow) { res.status(409).json({ success: false, message: "This dispatch is not linked to a V5 quotation revision." }); return null; }
  return { dispatch, quote };
}
function v5Sheet(req, res) {
  const sheet = (req.db.field_worksheets || []).find((item) => item.id === req.params.id);
  if (!sheet) { res.status(404).json({ success: false, message: "Timesheet not found." }); return null; }
  const { dispatch, quote } = v5Context(req.db, sheet);
  if (!dispatch) { res.status(404).json({ success: false, message: "Dispatch card not found." }); return null; }
  if (!quote?.v5_commercial_workflow) { res.status(409).json({ success: false, code: "NOT_V5_QUOTATION", message: "This Timesheet is not on a V5 quotation revision." }); return null; }
  return { sheet, dispatch, quote };
}

// Rate-free projection. Hours and evidence metadata only.
const publicContact = (c) => ({ id: c.id, quotation_id: c.quotation_id, dispatch_card_id: c.dispatch_card_id, name: c.name, title: c.title, phone: c.phone, email: c.email, source_reference: c.source_reference, status: c.status, authentication: c.authentication, created_at: c.created_at, withdrawn_at: c.withdrawn_at });
const publicState = (db, sheet) => {
  const s = v5SignatureState(db, sheet);
  return {
    timesheet_id: sheet.id, dispatch_card_id: sheet.dispatch_card_id, current_hash: s.current_hash, hash_basis: s.hash_basis,
    verified: s.verified, reasons: s.reasons, evidence: s.evidence, evidence_history: s.evidence_history,
    confirmation: s.confirmation, confirmation_history: s.confirmation_history
  };
};

// ---- named client-site Supervisor contact (evidence only) --------------------
export function createV5ClientSupervisorContact(req, res) {
  const actor = getActor(req); requirePermission(actor, "manageV5ClientSupervisorContacts");
  if (!v5Enabled()) return off(res, "V5 client Supervisor contacts");
  const scope = v5Dispatch(req, res); if (!scope) return;
  const parsed = parse(V5ClientSupervisorContactSchema, req.body); if (parsed.error) return bad(res, parsed.error);
  const b = parsed.data;
  const contacts = (req.db.v5_client_supervisor_contacts ||= []);
  const rec = {
    id: req.store.id("v5csc"), quotation_id: scope.quote.id, dispatch_card_id: b.dispatch_scoped ? scope.dispatch.id : null,
    name: b.name, title: b.title || null, phone: b.phone || null, email: b.email || null, source_reference: b.source_reference,
    status: "active", authentication: "none_evidence_only", created_by: actor.id, created_at: new Date().toISOString(), withdrawn_at: null, withdrawn_by: null
  };
  contacts.push(rec);
  req.store.audit(req.db, actor, "v5_client_supervisor_contact", rec.id, "V5_CLIENT_SUPERVISOR_CONTACT_RECORDED", null, rec);
  res.status(201).json({ success: true, data: publicContact(rec) });
}
export function listV5ClientSupervisorContacts(req, res) {
  requirePermission(getActor(req), "viewV5SignatureEvidence");
  if (!v5Enabled()) return off(res, "V5 client Supervisor contacts");
  const scope = v5Dispatch(req, res); if (!scope) return;
  const rows = (req.db.v5_client_supervisor_contacts || [])
    .filter((c) => c.quotation_id === scope.quote.id && (!c.dispatch_card_id || c.dispatch_card_id === scope.dispatch.id))
    .map(publicContact);
  res.json({ success: true, data: rows });
}
export function withdrawV5ClientSupervisorContact(req, res) {
  const actor = getActor(req); requirePermission(actor, "manageV5ClientSupervisorContacts");
  if (!v5Enabled()) return off(res, "V5 client Supervisor contacts");
  const rec = (req.db.v5_client_supervisor_contacts || []).find((c) => c.id === req.params.id);
  if (!rec) return res.status(404).json({ success: false, message: "Client Supervisor contact not found." });
  if (rec.status === "withdrawn") return res.json({ success: true, data: publicContact(rec) });
  const before = { ...rec };
  // Evidence already recorded keeps its own snapshot of the contact; only future use stops.
  rec.status = "withdrawn"; rec.withdrawn_at = new Date().toISOString(); rec.withdrawn_by = actor.id;
  req.store.audit(req.db, actor, "v5_client_supervisor_contact", rec.id, "V5_CLIENT_SUPERVISOR_CONTACT_WITHDRAWN", before, rec);
  res.json({ success: true, data: publicContact(rec) });
}

// ---- read: current hash and evidence state ------------------------------------
export function getV5SignatureState(req, res) {
  const actor = getActor(req); requirePermission(actor, "viewV5SignatureEvidence");
  if (!v5Enabled()) return off(res, "V5 signature evidence");
  const scope = v5Sheet(req, res); if (!scope) return;
  if (actor.role === roles.SUPERVISOR && !isAssignedOracSupervisor(scope.dispatch, actor.id)) {
    return res.status(403).json({ success: false, message: "A Supervisor may view V5 evidence only for an assigned dispatch." });
  }
  res.json({ success: true, data: publicState(req.db, scope.sheet) });
}

// ---- record paper evidence (append-only) ---------------------------------------
export function recordV5PaperSignature(req, res) {
  const actor = getActor(req); requirePermission(actor, "recordV5PaperSignature");
  if (!v5Enabled()) return off(res, "V5 paper-signature evidence");
  const scope = v5Sheet(req, res); if (!scope) return;
  const { sheet, dispatch, quote } = scope;
  const parsed = parse(V5PaperSignatureSchema, req.body); if (parsed.error) return bad(res, parsed.error, "PAPER_EVIDENCE_INCOMPLETE");
  const b = parsed.data;

  if (!getV5Policy(req.db).client_signature_methods.includes("paper_attested")) return bad(res, "Paper-attested signatures are not enabled for the pilot.", "METHOD_NOT_ENABLED", 409);
  const blockers = v5SheetBlockers(req.db, sheet);
  if (blockers.length) return bad(res, `This Timesheet cannot carry V5 evidence yet (${blockers.join(", ")}).`, "TIMESHEET_NOT_ELIGIBLE", 409);

  const contact = (req.db.v5_client_supervisor_contacts || []).find((c) => c.id === b.client_supervisor_contact_id);
  if (!contact || contact.quotation_id !== quote.id || (contact.dispatch_card_id && contact.dispatch_card_id !== dispatch.id)) {
    return bad(res, "The client Supervisor contact is not recorded for this quotation and dispatch.", "CONTACT_OUT_OF_SCOPE", 409);
  }
  if (contact.status !== "active") return bad(res, "The client Supervisor contact has been withdrawn.", "CONTACT_WITHDRAWN", 409);
  const custodian = (req.db.users || []).find((u) => u.id === b.custodian_user_id && u.is_active !== false);
  if (!custodian) return bad(res, "The custodian must be an active ORAC user.", "PAPER_EVIDENCE_INCOMPLETE");
  const channelRefusal = v5ChannelRefusal(req.db, b.source_channel);
  if (channelRefusal) return bad(res, channelRefusal, "PAPER_EVIDENCE_INCOMPLETE");
  if (!isIsoDate(b.received_date) || b.received_date > today() || b.received_date < sheet.work_date) {
    return bad(res, "Received date must be a real date, not in the future and not before the work date.", "PAPER_EVIDENCE_INCOMPLETE");
  }

  const hash = v5TimesheetHash(sheet);
  const prior = (req.db.v5_paper_signatures || []).filter((r) => r.sheet_id === sheet.id);
  const latest = prior[prior.length - 1] || null;
  if (latest && latest.hours_hash === hash && !b.replacement_reason) {
    return bad(res, "Current paper evidence already exists for these hours. State a replacement_reason to record a corrected evidence entry.", "EVIDENCE_ALREADY_CURRENT", 409);
  }

  const now = new Date().toISOString();
  const rec = {
    id: req.store.id("v5sig"), sheet_id: sheet.id, dispatch_card_id: dispatch.id, quotation_id: quote.id,
    hash_version: V5_HASH_VERSION, hours_hash: hash,
    paper: {
      worker_signed: true, client_supervisor_signed: true,
      worker_name_on_paper: b.worker_name_on_paper, client_supervisor_name_on_paper: b.client_supervisor_name_on_paper,
      attestation: { attested: true, statement: V5_PAPER_ATTESTATION_TEXT, attested_by: actor.id, attested_at: now }
    },
    client_supervisor_contact: {
      contact_id: contact.id, name: contact.name, title: contact.title, phone: contact.phone, email: contact.email,
      source_reference: contact.source_reference, quotation_id: contact.quotation_id, dispatch_card_id: contact.dispatch_card_id,
      authentication: "none_evidence_only"
    },
    evidence_reference: b.evidence_reference, source_channel: b.source_channel, custodian_user_id: custodian.id,
    received_date: b.received_date, scan_hash: b.scan_hash.toLowerCase(),
    replaces_evidence_id: latest ? latest.id : null, replacement_reason: b.replacement_reason || null,
    recorded_by: actor.id, recorded_at: now
  };
  const missing = paperEvidenceMissing(rec, req.db);
  if (missing.length) return bad(res, `Paper evidence is incomplete: ${missing.join(", ")}.`, "PAPER_EVIDENCE_INCOMPLETE");
  rec.record_hash = v5RecordHash(rec);
  (req.db.v5_paper_signatures ||= []).push(rec);
  req.store.audit(req.db, actor, "v5_paper_signature", rec.id, "V5_PAPER_SIGNATURE_RECORDED", null, rec);
  res.status(201).json({ success: true, data: publicState(req.db, sheet) });
}

// ---- assigned ORAC Supervisor confirmation -------------------------------------
export function confirmV5Timesheet(req, res) {
  const actor = getActor(req); requirePermission(actor, "confirmV5Timesheet");
  if (!v5Enabled()) return off(res, "V5 Supervisor confirmation");
  const scope = v5Sheet(req, res); if (!scope) return;
  const { sheet, dispatch, quote } = scope;
  if (!isAssignedOracSupervisor(dispatch, actor.id)) return res.status(403).json({ success: false, message: "Only the Supervisor assigned to this dispatch can confirm its Timesheets." });
  if (v5SalesOwnerIds(req.db, quote).has(actor.id)) return res.status(403).json({ success: false, code: "SALES_OWNER_SEPARATION", message: "The Sales owner of this quotation cannot confirm its Timesheets." });
  const parsed = parse(V5SupervisorConfirmationSchema, req.body); if (parsed.error) return bad(res, parsed.error);
  const b = parsed.data;

  const state = v5SignatureState(req.db, sheet);
  if (state.sheet_blockers.length) return bad(res, `This Timesheet cannot be confirmed yet (${state.sheet_blockers.join(", ")}).`, "TIMESHEET_NOT_ELIGIBLE", 409);
  if (!state.evidence) return bad(res, "There is no current, complete paper evidence for these hours.", "NO_CURRENT_PAPER_EVIDENCE", 409);
  if (b.hours_hash.toLowerCase() !== state.current_hash || b.evidence_id !== state.evidence.id) {
    return bad(res, "The hours or evidence changed since you opened this Timesheet. Re-read the current evidence and confirm again.", "STALE_HASH", 409);
  }
  const ev = state.evidence;
  if (ev.recorded_by === actor.id || ev.custodian_user_id === actor.id) return res.status(403).json({ success: false, code: "SEPARATION_OF_DUTIES", message: "The person who recorded or holds the paper evidence cannot confirm it." });
  if (sheet.technician_id === actor.id || sheet.created_by === actor.id || sheet.submitted_by === actor.id) {
    return res.status(403).json({ success: false, code: "SEPARATION_OF_DUTIES", message: "The person who entered or submitted this Timesheet cannot confirm it." });
  }
  if (state.confirmation) return bad(res, "This evidence is already confirmed.", "ALREADY_CONFIRMED", 409);

  const now = new Date().toISOString();
  const rec = {
    id: req.store.id("v5cnf"), sheet_id: sheet.id, dispatch_card_id: dispatch.id, quotation_id: quote.id,
    evidence_id: ev.id, hours_hash: state.current_hash, supervisor_id: actor.id,
    assignment_snapshot: { assigned_supervisor_id: dispatch.assigned_supervisor_id || null, supervisor_id: dispatch.supervisor_id || null },
    attested: true, confirmed_at: now
  };
  rec.record_hash = v5RecordHash(rec);
  (req.db.v5_supervisor_confirmations ||= []).push(rec);
  req.store.audit(req.db, actor, "v5_supervisor_confirmation", rec.id, "V5_SUPERVISOR_CONFIRMED", null, rec);
  res.status(201).json({ success: true, data: publicState(req.db, sheet) });
}
