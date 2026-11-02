// Timesheet workflow HTTP handlers (contract steps 3-9). Every handler is DARK:
// it refuses with 409 FEATURE_DISABLED unless its flag is enabled. No stock
// movement is ever created here; no rate field is ever read or returned except
// by the Finance/Admin variance handlers (hours only).
import { requirePermission, roles } from "../permissions.js";
function getActor(req) {
  return req.user?.id ? req.db.users.find((user) => user.id === req.user.id) : null;
}
import { evaluateForDb, clientForWorksheet } from "../timesheetEligibility.js";
import {
  flag, getPolicy, validatePolicyPatch, validateAuthorityInput, evaluatePaperCapture, findDuplicates,
  computeVariance, activeOverride, voidStaleOverrides, overrideRefusal, secondApprovalRequired,
  poPosition, paperSamplingPlan, businessDaysBetween, reminderStage, anyActiveAuthority, workDateValidity, swapRevisionIfEligible, resolveAuthorityGate
} from "../timesheetWorkflow.js";
import { createHash } from "node:crypto";
import { v5Enabled, allocatedMaterialsByQuoteLine } from "../v5CommercialWorkflow.js";
import { v5VerifiedHoursByQuoteLine } from "../v5SignatureEvidence.js";

const off = (res, name) => res.status(409).json({ success: false, code: "FEATURE_DISABLED", message: `${name} is not enabled yet.` });
const today = () => new Date().toISOString().slice(0, 10);
const RATE_FREE_FIELDS = ["id", "dispatch_card_id", "technician_id", "worker_name", "worker_type", "work_date", "hours", "hours_breakdown", "status", "submitted_at", "revision_number", "superseded_by", "invoice_locked", "duplicate_conflict", "internal_exception_flag"];

// ---- Admin policy -----------------------------------------------------------
export function getTimesheetPolicy(req, res) {
  requirePermission(getActor(req), "manageTimesheetAuthority");
  res.json({ success: true, data: getPolicy(req.db) });
}
export function updateTimesheetPolicy(req, res) {
  const actor = getActor(req); requirePermission(actor, "manageTimesheetAuthority");
  const errors = validatePolicyPatch(req.body);
  if (errors.length) return res.status(400).json({ success: false, message: errors.join(" ") });
  const before = { ...getPolicy(req.db) };
  req.db.company_profile = { ...(req.db.company_profile || {}), timesheet_policy: { ...getPolicy(req.db), ...req.body } };
  req.store.audit(req.db, actor, "company_profile", "timesheet_policy", "TIMESHEET_POLICY_UPDATED", before, req.db.company_profile.timesheet_policy);
  res.json({ success: true, data: req.db.company_profile.timesheet_policy });
}

// ---- Step 4: authority records ---------------------------------------------
export function listTimesheetAuthorities(req, res) {
  requirePermission(getActor(req), "manageTimesheetAuthority");
  res.json({ success: true, data: req.db.timesheet_authorities || [] });
}
export function createTimesheetAuthority(req, res) {
  const actor = getActor(req); requirePermission(actor, "manageTimesheetAuthority");
  if (!flag("AUTHORITY")) return off(res, "Authoriser records");
  const b = req.body;
  const errors = validateAuthorityInput(req.db, b, today());
  if (errors.length) return res.status(400).json({ success: false, message: errors.join(" ") });
  const rec = {
    id: req.store.id("tsa"), kind: b.kind, client_id: b.client_id, user_id: b.user_id, title: b.title || null,
    site_ids: b.site_ids || [], evidence_reference: b.evidence_reference.trim(), start_date: b.start_date, end_date: b.end_date || null,
    escalation_contact: b.escalation_contact || null, delegate_for_authority_id: b.kind === "delegate" ? b.delegate_for_authority_id : null,
    status: "active", appointed_by: actor.id, appointed_at: new Date().toISOString(), revoked_at: null
  };
  const user = req.db.users.find((u) => u.id === b.user_id); if (user) user.can_confirm_timesheets = true;
  req.db.timesheet_authorities.push(rec);
  req.store.audit(req.db, actor, "timesheet_authority", rec.id, "TIMESHEET_AUTHORITY_APPOINTED", null, rec);
  res.status(201).json({ success: true, data: rec });
}
export function revokeTimesheetAuthority(req, res) {
  const actor = getActor(req); requirePermission(actor, "manageTimesheetAuthority");
  const rec = (req.db.timesheet_authorities || []).find((a) => a.id === req.params.id);
  if (!rec) return res.status(404).json({ success: false, message: "Authority record not found." });
  const before = { ...rec }; rec.status = "revoked"; rec.revoked_at = new Date().toISOString(); rec.revoked_by = actor.id;
  // Revoke dependent delegates too. Past confirmations keep their stored snapshot.
  for (const d of req.db.timesheet_authorities) if (d.delegate_for_authority_id === rec.id && d.status === "active") { d.status = "revoked"; d.revoked_at = rec.revoked_at; d.revoked_by = actor.id; }
  if (!req.db.timesheet_authorities.some((a) => a.user_id === rec.user_id && a.status === "active")) {
    const u = req.db.users.find((x) => x.id === rec.user_id); if (u) u.can_confirm_timesheets = false;
  }
  req.store.audit(req.db, actor, "timesheet_authority", rec.id, "TIMESHEET_AUTHORITY_REVOKED", before, rec);
  res.json({ success: true, data: rec });
}
export function setClientCutover(req, res) {
  const actor = getActor(req); requirePermission(actor, "manageTimesheetAuthority");
  const client = (req.db.clients || []).find((c) => c.id === req.params.id);
  if (!client) return res.status(404).json({ success: false, message: "Client not found." });
  const date = req.body.timesheet_cutover_date;
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return res.status(400).json({ success: false, message: "Cutover date must be YYYY-MM-DD or null." });
  const confirmed = (req.db.field_worksheets || []).some((w) => w.client_acknowledgement?.authority_snapshot?.active && clientForWorksheet(req.db, w)?.id === client.id);
  if (confirmed && date !== client.timesheet_cutover_date) return res.status(409).json({ success: false, message: "Cutover is one-way: client-confirmed records already exist for this client." });
  const before = { timesheet_cutover_date: client.timesheet_cutover_date || null };
  client.timesheet_cutover_date = date;
  req.store.audit(req.db, actor, "client", client.id, "CLIENT_TIMESHEET_CUTOVER_SET", before, { timesheet_cutover_date: date });
  res.json({ success: true, data: { id: client.id, timesheet_cutover_date: date } });
}

// ---- Step 3: rate-free read ---------------------------------------------------
export function listTimesheetsRateFree(req, res) {
  requirePermission(getActor(req), "viewTimesheetsRateFree");
  if (!flag("SALES_ACCESS")) return off(res, "Rate-free Timesheet access");
  const rows = (req.db.field_worksheets || []).map((w) => {
    const out = {}; for (const k of RATE_FREE_FIELDS) if (w[k] !== undefined) out[k] = w[k];
    const e = evaluateForDb(req.db, w); out.eligible = e.eligible; out.ineligible_reason = e.reason;
    const c = clientForWorksheet(req.db, w); out.client_name = c?.name || null;
    return out;
  });
  res.json({ success: true, data: rows });
}

// Read-only V5 bridge. It neither creates an invoice nor reads a rate: it
// tells Sales and Finance whether the verified daily source is complete enough
// to be priced against the quotation in a later, separately approved phase.
export function getV5BillingReadiness(req, res) {
  requirePermission(getActor(req), "viewV5BillingReadiness");
  if (!v5Enabled()) return off(res, "V5 billing readiness");
  const dispatch = (req.db.dispatch_cards || []).find((item) => item.id === req.params.id);
  if (!dispatch) return res.status(404).json({ success: false, message: "Dispatch card not found." });
  const quote = (req.db.quotes || []).find((item) => item.id === dispatch.quotation_id);
  if (!quote?.v5_commercial_workflow) {
    return res.status(409).json({ success: false, message: "This dispatch is not linked to a V5 quotation revision." });
  }
  // Only V5-verified Timesheets count: paper evidence AND assigned ORAC Supervisor confirmation on the same current hash.
  const hours = v5VerifiedHoursByQuoteLine(req.db, dispatch.id);
  const materials = allocatedMaterialsByQuoteLine(req.db, dispatch.id);
  const lines = (req.db.quote_lines || [])
    .filter((line) => line.quotation_id === quote.id)
    .map((line) => ({
      quote_line_id: line.id,
      description: line.description,
      pricing_basis: line.pricing_basis || null,
      canonical_hours: hours.by_quote_line[line.id]?.hours || 0,
      source_timesheet_ids: hours.by_quote_line[line.id]?.source_ids || [],
      allocated_material_quantity: materials.by_quote_line[line.id]?.quantity || 0,
      source_material_usage_ids: materials.by_quote_line[line.id]?.source_material_usage_ids || []
    }));
  const mappedHours = lines.reduce((sum, line) => sum + line.canonical_hours, 0);
  const blockers = [];
  if (hours.unmapped.hours > 0) blockers.push("Verified Timesheets have no quotation-line link.");
  if (mappedHours <= 0) blockers.push("No V5-verified canonical Timesheet hours are available.");
  if (quote.commercial_acceptance_status !== "po_verified") blockers.push("The V5 quotation is not accepted by a verified purchase order.");
  if (materials.unallocated.length > 0) blockers.push("Material usage requires a controlled material-line allocation or amendment.");
  res.json({
    success: true,
    data: {
      dispatch_card_id: dispatch.id,
      quotation_id: quote.id,
      quotation_number: quote.quote_number || quote.id,
      commercial_acceptance_status: quote.commercial_acceptance_status || "pending",
      lines,
      unmapped: hours.unmapped,
      unallocated_material_usage: materials.unallocated,
      verification: {
        definition: "paper_evidence_and_assigned_supervisor_confirmation_on_same_current_hash",
        unverified_hours: hours.unverified.hours,
        unverified_timesheets: hours.unverified.items
      },
      canonical_hours_total: Number((mappedHours + hours.unmapped.hours).toFixed(2)),
      ready_for_pricing_review: blockers.length === 0,
      blockers
    }
  });
}

// ---- Step 5: paper capture + custody ------------------------------------------
export function capturePaperTimesheet(req, res) {
  const actor = getActor(req); requirePermission(actor, "captureTimesheetPaper");
  if (!flag("PAPER_CAPTURE")) return off(res, "Paper capture");
  const b = req.body;
  const job = req.db.dispatch_cards.find((d) => d.id === b.dispatch_card_id);
  if (!job) return res.status(404).json({ success: false, message: "Dispatch card not found." });
  const check = evaluatePaperCapture(req.db, null, b, actor);
  if (check.blocked.length) return res.status(409).json({ success: false, code: "CAPTURE_BLOCKED", message: check.blocked.join(" ") });
  const now = new Date().toISOString();
  const candidate = {
    id: req.store.id("ws"), dispatch_card_id: job.id, technician_id: b.technician_id || null, worker_name: b.worker_name || null,
    worker_type: b.worker_type || "technician", work_date: b.work_date, hours: b.hours, timesheet_version: 2,
    hours_breakdown: b.hours_breakdown, activity: b.activity || "", materials_used: [], evidence_files: [], tools_used: "", outcomes: "", challenges: ""
  };
  const dups = findDuplicates(req.db, candidate);
  if (dups.length) return res.status(409).json({ success: false, code: "DUPLICATE_TIMESHEET", message: "A client-confirmed, captured, approved or submitted Timesheet already exists for this worker, date and dispatch.", existing_ids: dups.map((d) => d.id) });
  const validity = workDateValidity(req.db, candidate);
  if (validity.blocks) return res.status(409).json({ success: false, code: "OUT_OF_VALIDITY", message: validity.issues.join(" ") });
  const sum = ["normal", "ot_15", "ot_20"].reduce((s, c) => s + Number(b.hours_breakdown?.[c] || 0), 0);
  if (!(Math.abs(sum - Number(b.hours)) < 0.005)) return res.status(400).json({ success: false, message: "Classified hours (Normal/1.5/2.0) must add up to total hours. Start/end times never decide classes." });
  const complete = check.complete;
  Object.assign(candidate, {
    status: complete ? "Captured_From_Signed_Paper" : "Draft",
    created_by: actor.id, created_at: now, updated_at: now, submitted_by: null, supervisor_comment: "",
    signatures: { employee: { name: b.signatory_name_on_paper || b.worker_name || "Worker (per signed paper)", date: b.work_date, method: "paper_scan" } },
    signed_copy_image: b.scan_reference || b.scan_hash || null,
    paper_capture: {
      captured_by: actor.id, captured_by_name: actor.name || null, captured_at: now, reason_code: b.reason_code, reason_text: b.reason_text || null,
      source_channel: b.source_channel, client_paper_reference: b.client_paper_reference, received_date: b.received_date,
      custodian_user_id: b.custodian_user_id, custody_location: b.custody_location, retention_category: b.retention_category,
      scan_hash: b.scan_hash, signatory_name_as_written: b.signatory_name_on_paper || null, signatory_authenticated: false,
      finance_sampling: check.sampled, missing_fields: check.missing
    },
    paper_evidence: { complete }
  });
  if (b.revises_worksheet_id) { candidate.revises_worksheet_id = b.revises_worksheet_id; }
  req.db.field_worksheets.push(candidate);
  req.store.audit(req.db, actor, "field_worksheet", candidate.id, complete ? "TIMESHEET_PAPER_CAPTURED" : "TIMESHEET_PAPER_CAPTURE_INCOMPLETE", null, candidate);
  if (complete) swapRevisionIfEligible(req.db, req.store, actor, candidate);
  // Deliberately NO material or stock handling: capture creates zero stock movements.
  res.status(201).json({ success: true, data: candidate, missing: check.missing });
}
export function logPaperCustody(req, res) {
  const actor = getActor(req); requirePermission(actor, "logPaperCustody");
  if (!flag("PAPER_CAPTURE")) return off(res, "Paper custody log");
  const b = req.body;
  if (!b.from || !b.to || !b.paper_reference) return res.status(400).json({ success: false, message: "from, to and paper_reference are required." });
  const rec = { id: req.store.id("cust"), paper_reference: b.paper_reference, from: b.from, to: b.to, at: b.at || new Date().toISOString(), note: b.note || null, logged_by: actor.id };
  req.db.timesheet_paper_custody.push(rec);
  req.store.audit(req.db, actor, "timesheet_paper_custody", rec.id, "TIMESHEET_PAPER_CUSTODY_LOGGED", null, rec);
  res.status(201).json({ success: true, data: rec });
}

// ---- Step 8: batch confirmation ----------------------------------------------
export function batchConfirmTimesheets(req, res) {
  const actor = getActor(req); requirePermission(actor, "acknowledgeWorksheet");
  if (!flag("BATCH_CONFIRM")) return off(res, "Batch confirmation");
  const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids)] : [];
  if (!ids.length || ids.length > 50) return res.status(400).json({ success: false, message: "Select between 1 and 50 Timesheets explicitly. Nothing is pre-selected." });
  if (req.body.acknowledgement !== true) return res.status(400).json({ success: false, message: "Explicit confirmation is required." });
  const sheets = ids.map((id) => req.db.field_worksheets.find((w) => w.id === id));
  const dispatches = new Set(sheets.filter(Boolean).map((w) => w.dispatch_card_id));
  if (dispatches.size > 1) return res.status(400).json({ success: false, message: "A batch must be for a single dispatch." });
  const results = ids.map((id, i) => {
    const ws = sheets[i];
    if (!ws || clientForWorksheet(req.db, ws)?.id !== actor.client_id) return { id, ok: false, code: "NOT_FOUND_OR_OUT_OF_SCOPE" };
    if (ws.status !== "Submitted") return { id, ok: false, code: "NOT_AWAITING_CONFIRMATION" };
    if (ws.duplicate_conflict || ws.internal_exception_flag || (ws.hours_breakdown?.ot_15 || 0) + (ws.hours_breakdown?.ot_20 || 0) > 0 || (ws.warnings || []).length)
      return { id, ok: false, code: "OPEN_INDIVIDUALLY", message: "This record has overtime, a warning or an exception and must be opened and confirmed on its own." };
    const gate = resolveAuthorityGate(req.db, actor, ws);
    if (!gate.ok) return { id, ok: false, code: "AUTHORITY_REQUIRED", message: gate.message };
    const before = { ...ws }; const at = new Date().toISOString();
    ws.status = "Client_Acknowledged";
    ws.client_acknowledgement = { id: req.store.id("wsack"), signer_name: req.body.signer_name, signer_role: req.body.signer_role, acknowledged_by_user_id: actor.id,
      acknowledged_at: at, evidence_reference: req.store.id("evd"), batch: true, ...(gate.snapshot ? { authority_snapshot: gate.snapshot } : {}) };
    ws.updated_at = at;
    req.store.audit(req.db, actor, "field_worksheet", ws.id, "WORKSHEET_CLIENT_ACKNOWLEDGED", before, ws);
    swapRevisionIfEligible(req.db, req.store, actor, ws);
    return { id, ok: true };
  });
  res.json({ success: true, results, confirmed: results.filter((r) => r.ok).length });
}

// ---- Step 8: ageing reminders (idempotent per record per stage) -------------------
export function runTimesheetReminders(req, res) {
  const actor = getActor(req); requirePermission(actor, "runTimesheetReminders");
  if (!flag("REMINDERS")) return off(res, "Timesheet reminders");
  const policy = getPolicy(req.db); const now = today(); const emitted = [];
  for (const ws of req.db.field_worksheets || []) {
    if (ws.status !== "Submitted" || ws.superseded_by) continue;
    const client = clientForWorksheet(req.db, ws);
    const since = String(ws.submitted_at || ws.updated_at || "").slice(0, 10); if (!since) continue;
    const age = businessDaysBetween(since, now, policy.business_holidays);
    const stage = reminderStage(age, policy.reminder_business_days);
    if (stage === 0 || (ws.reminder_stage || 0) >= stage) continue;
    const paused = client ? !anyActiveAuthority(req.db, client.id, now) : false;
    const action = paused ? "TIMESHEET_AWAITING_AUTHORITY" : stage >= policy.reminder_business_days.length ? "TIMESHEET_ESCALATION" : "TIMESHEET_REMINDER";
    ws.reminder_stage = stage;
    req.store.audit(req.db, actor, "field_worksheet", ws.id, action, null, { id: ws.id, dispatch_card_id: ws.dispatch_card_id, stage, age_business_days: age });
    emitted.push({ id: ws.id, action, stage }); // no deemed approval at any age
  }
  res.json({ success: true, emitted });
}

// ---- Step 7: variance -------------------------------------------------------------
export function getInvoiceVariance(req, res) {
  requirePermission(getActor(req), "viewInvoiceVariance");
  if (!flag("INVOICE_VARIANCE")) return off(res, "Invoice variance control");
  const variance = computeVariance(req.db, req.params.id);
  voidStaleOverrides(req.db, req.params.id, variance, new Date().toISOString());
  res.json({ success: true, data: { ...variance, override: activeOverride(req.db, req.params.id, variance), po_position: poPosition(req.db, req.params.id) } });
}

// Finance sampling list: paper-captured records per capturer for one month (YYYY-MM). Read-only, hours only.
export function getPaperSampling(req, res) {
  requirePermission(getActor(req), "viewPaperSampling");
  if (!flag("PAPER_CAPTURE")) return off(res, "Paper capture");
  const month = String(req.query?.month || "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ success: false, message: "month must be YYYY-MM." });
  res.json({ success: true, data: { month, rule: { percent: getPolicy(req.db).paper_sampling_percent, minimum: getPolicy(req.db).paper_sampling_minimum }, capturers: paperSamplingPlan(req.db, month) } });
}
export function requestVarianceOverride(req, res) {
  const actor = getActor(req); requirePermission(actor, "overrideInvoiceVariance");
  if (!flag("INVOICE_VARIANCE")) return off(res, "Invoice variance control");
  const b = req.body;
  if (!b.reason_code || !b.reason_text?.trim() || !b.evidence_reference?.trim()) return res.status(400).json({ success: false, message: "Reason code, reason text and evidence reference are required." });
  const refusal = overrideRefusal(req.db, req.params.id, actor, { invoiceCreatorId: b.invoice_creator_id || null });
  if (refusal) return res.status(403).json({ success: false, message: refusal });
  const variance = computeVariance(req.db, req.params.id);
  if (!variance.blocked) return res.status(400).json({ success: false, message: "There is no blocking variance to override." });
  const diff = Math.max(...variance.blocks.map((x) => Number(x.difference || x.billed)));
  const rec = { id: req.store.id("tsvo"), dispatch_card_id: req.params.id, variance_hash: variance.hash, reason_code: b.reason_code, reason_text: b.reason_text,
    evidence_reference: b.evidence_reference, requested_by: actor.id, requested_at: new Date().toISOString(), second_approval_required: secondApprovalRequired(req.db, diff),
    second_approved_by: null, voided_at: null };
  if (!rec.second_approval_required) rec.second_approved_by = "not_required";
  req.db.timesheet_variance_overrides.push(rec);
  req.store.audit(req.db, actor, "timesheet_variance_override", rec.id, "VARIANCE_OVERRIDE_REQUESTED", null, rec);
  res.status(201).json({ success: true, data: rec });
}
export function approveVarianceOverride(req, res) {
  const actor = getActor(req); requirePermission(actor, "overrideInvoiceVariance");
  if (!flag("INVOICE_VARIANCE")) return off(res, "Invoice variance control");
  const rec = (req.db.timesheet_variance_overrides || []).find((o) => o.id === req.params.id);
  if (!rec || rec.voided_at) return res.status(404).json({ success: false, message: "Override not found or voided." });
  if (rec.requested_by === actor.id) return res.status(403).json({ success: false, message: "The requester cannot give the second approval." });
  const refusal = overrideRefusal(req.db, rec.dispatch_card_id, actor);
  if (refusal) return res.status(403).json({ success: false, message: refusal });
  const variance = computeVariance(req.db, rec.dispatch_card_id);
  if (variance.hash !== rec.variance_hash) { rec.voided_at = new Date().toISOString(); rec.voided_reason = "Hours changed."; return res.status(409).json({ success: false, message: "Hours changed; override voided." }); }
  rec.second_approved_by = actor.id; rec.second_approved_at = new Date().toISOString();
  req.store.audit(req.db, actor, "timesheet_variance_override", rec.id, "VARIANCE_OVERRIDE_APPROVED", null, rec);
  res.json({ success: true, data: rec });
}
export function resolvePostInvoiceRevision(req, res) {
  const actor = getActor(req); requirePermission(actor, "resolvePostInvoiceRevision");
  if (!flag("INVOICE_VARIANCE")) return off(res, "Post-invoice revision");
  const rev = (req.db.field_worksheets || []).find((w) => w.id === req.params.id && w.post_invoice);
  if (!rev) return res.status(404).json({ success: false, message: "Post-invoice revision not found." });
  if (!evaluateForDb(req.db, rev).eligible) return res.status(409).json({ success: false, message: "The revision is not yet eligible (client confirmation or paper evidence needed)." });
  const orig = req.db.field_worksheets.find((w) => w.id === rev.revises_worksheet_id);
  rev.credit_rebill = { resolved_by: actor.id, resolved_at: new Date().toISOString(), note: String(req.body.note || "") };
  if (orig && !orig.superseded_by) { orig.superseded_by = rev.id; delete orig.pending_revision_id; }
  req.store.audit(req.db, actor, "field_worksheet", rev.id, "POST_INVOICE_REVISION_RESOLVED", null, rev);
  res.json({ success: true, data: rev });
}
export const _internal = { createHash };
