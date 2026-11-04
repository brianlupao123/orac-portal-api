// Timesheet workflow, contract steps 3-9. PURE LOGIC: no req/res, no I/O.
//
// Every capability here ships DARK: each flag defaults off and, when off, the
// calling code path behaves exactly as before this packet. Owner decisions that
// are still open are NOT invented: they live in db.company_profile.timesheet_policy
// with safe defaults (see POLICY_DEFAULTS) and the dependent action stays blocked
// until an Admin confirms the value.
import { evaluateForDb, registerValidityHook } from "./timesheetEligibility.js";

const flagOn = (name) => process.env[name] === "enabled";
export const FLAGS = Object.freeze({
  SALES_ACCESS: "TIMESHEET_SALES_ACCESS",           // step 3 + 6: rate-free Sales/Finance read, Sales Worksheet ownership
  AUTHORITY: "TIMESHEET_AUTHORITY",                 // step 4: authoriser/delegate records gate confirmation
  PAPER_CAPTURE: "TIMESHEET_PAPER_CAPTURE",         // step 5
  INVOICE_VARIANCE: "TIMESHEET_INVOICE_VARIANCE",   // step 7: variance control + invoice lock
  RATE_ROW_RESTRICT: "TIMESHEET_RATE_ROW_RESTRICT", // step 7: db.timesheets rows Finance/Admin only
  BATCH_CONFIRM: "TIMESHEET_BATCH_CONFIRM",         // step 8
  REMINDERS: "TIMESHEET_REMINDERS",                 // step 8
  OPS_RESTRICT: "TIMESHEET_OPS_RESTRICT",           // step 9: remove Ops/Supervisor Worksheet + daily approval
  PO_VALIDITY: "TIMESHEET_PO_VALIDITY"              // step 9: dispatch/PO validity gate
});
export const flag = (key) => flagOn(FLAGS[key]);

// ---- Owner configuration (13 confirmations) with SAFE defaults ---------------
export const POLICY_DEFAULTS = Object.freeze({
  kiosk_mode: "unchanged",                // #1  unchanged | restricted | hidden
  site_scope_client_ids: [],              // #2  clients that need site-level confirmation
  paper_capture_user_ids: [],             // #3  empty = nobody may capture (blocked)
  paper_channels: [],                     // #3  empty = capture blocked
  variance_hard_block: true,              // #4
  retention_categories: [],               // #6  empty = capture blocked (legal advice pending)
  holiday_treatment: "blocked_pending_policy", // #7 unchanged, owned by existing register logic
  variance_tolerance_hours: 0,            // #8  beyond two-decimal rounding
  override_user_ids: [],                  // #9  empty = nobody may override
  second_approval_threshold_hours: 0,     // #9  0 = every override needs a second approver
  correction_owner_user_id: null,         // #9
  po_validity_mode: "hard_block",         // #10 hard_block | warn | off (applies only when flag on)
  allow_retroactive_po: false,            // #10
  fallback_reviewer_user_ids: [],         // #11
  paused_state_owner_user_id: null,       // #11 null = Admin role
  delegate_max_days: 30,                  // #12
  reminder_business_days: [2, 5, 10],     // #12/M
  business_holidays: [],                  // #12 ISO dates skipped by the business-day count
  custody_logging: "optional",            // #13 optional | required
  paper_sampling_percent: 10,             // E: Finance sampling default
  paper_sampling_minimum: 3
});

export function getPolicy(db) {
  const stored = db?.company_profile?.timesheet_policy;
  return { ...POLICY_DEFAULTS, ...(stored && typeof stored === "object" ? stored : {}) };
}

const POLICY_VALIDATORS = {
  kiosk_mode: (v) => ["unchanged", "restricted", "hidden"].includes(v),
  site_scope_client_ids: Array.isArray, paper_capture_user_ids: Array.isArray, paper_channels: Array.isArray,
  retention_categories: Array.isArray, override_user_ids: Array.isArray, fallback_reviewer_user_ids: Array.isArray,
  business_holidays: (v) => Array.isArray(v) && v.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
  variance_hard_block: (v) => typeof v === "boolean", allow_retroactive_po: (v) => typeof v === "boolean",
  variance_tolerance_hours: (v) => typeof v === "number" && v >= 0 && v <= 8,
  second_approval_threshold_hours: (v) => typeof v === "number" && v >= 0,
  po_validity_mode: (v) => ["hard_block", "warn", "off"].includes(v),
  delegate_max_days: (v) => Number.isInteger(v) && v >= 1 && v <= 90,
  reminder_business_days: (v) => Array.isArray(v) && v.length > 0 && v.every((n) => Number.isInteger(n) && n > 0),
  custody_logging: (v) => ["optional", "required"].includes(v),
  paper_sampling_percent: (v) => typeof v === "number" && v >= 0 && v <= 100,
  paper_sampling_minimum: (v) => Number.isInteger(v) && v >= 0,
  correction_owner_user_id: (v) => v === null || typeof v === "string",
  paused_state_owner_user_id: (v) => v === null || typeof v === "string"
};
export function validatePolicyPatch(patch) {
  const errors = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in POLICY_VALIDATORS)) errors.push(`Unknown policy key: ${k}`);
    else if (!POLICY_VALIDATORS[k](v)) errors.push(`Invalid value for ${k}`);
  }
  return errors;
}

// ---- Step 4: authority records ----------------------------------------------
export const AUTHORITY_KINDS = Object.freeze(["authoriser", "delegate"]);
const isIso = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

export function validateAuthorityInput(db, input, today) {
  const errors = []; const policy = getPolicy(db);
  const user = (db.users || []).find((u) => u.id === input.user_id);
  if (!user || user.role !== "Client Viewer" || !user.client_id) errors.push("The user must be a named Client account.");
  else if (user.client_id !== input.client_id) errors.push("The user belongs to a different client.");
  if (!input.evidence_reference?.trim()) errors.push("An evidence reference (client letter/email) is required.");
  if (!isIso(input.start_date)) errors.push("A start date is required.");
  if (input.end_date != null && !isIso(input.end_date)) errors.push("End date must be YYYY-MM-DD.");
  if (!AUTHORITY_KINDS.includes(input.kind)) errors.push("Kind must be authoriser or delegate.");
  if (input.kind === "delegate") {
    if (!isIso(input.end_date)) errors.push("A delegate needs an explicit end date.");
    else if (isIso(input.start_date) && daysBetween(input.start_date, input.end_date) > policy.delegate_max_days)
      errors.push(`A delegate appointment cannot exceed ${policy.delegate_max_days} days.`);
    if (!input.delegate_for_authority_id) errors.push("A delegate must name the authoriser they act for.");
    else {
      const parent = (db.timesheet_authorities || []).find((a) => a.id === input.delegate_for_authority_id);
      if (!parent || parent.kind !== "authoriser" || parent.client_id !== input.client_id) errors.push("The named authoriser must be an authoriser of the same client.");
    }
  }
  if (input.end_date && input.start_date && input.end_date < input.start_date) errors.push("End date is before start date.");
  return errors;
}

export function activeAuthorityFor(db, userId, clientId, today, siteId = null) {
  const date = String(today).slice(0, 10);
  return (db.timesheet_authorities || []).find((a) =>
    a.user_id === userId && a.client_id === clientId && a.status === "active" && !a.revoked_at &&
    a.start_date <= date && (!a.end_date || a.end_date >= date) &&
    (!a.site_ids?.length || (siteId && a.site_ids.includes(siteId)))) || null;
}
export const anyActiveAuthority = (db, clientId, today) =>
  (db.timesheet_authorities || []).some((a) => a.client_id === clientId && a.status === "active" && !a.revoked_at &&
    a.start_date <= String(today).slice(0, 10) && (!a.end_date || a.end_date >= String(today).slice(0, 10)));

export function authoritySnapshot(authority, actor, today) {
  if (!authority) return { active: false, recorded_at: today };
  const parent = authority.kind === "delegate" ? null : authority;
  return {
    active: true, authority_id: authority.id, kind: authority.kind, user_id: actor.id, user_name: actor.name || null,
    title: authority.title || null, client_id: authority.client_id, site_ids: authority.site_ids || [],
    evidence_reference: authority.evidence_reference, start_date: authority.start_date, end_date: authority.end_date || null,
    confirmed_as: authority.kind === "delegate" ? `delegate for ${authority.delegate_for_authority_id}` : "authoriser",
    parent_authority_id: parent ? null : authority.delegate_for_authority_id, recorded_at: today
  };
}

// Confirmation wording is a legal-review item; text is exposed, never hard-coded in the UI only.
export const CONFIRMATION_STATEMENT = "I confirm that the work and hours shown were performed. This is not approval of rates, invoice value or payment.";

// ---- Step 5: paper capture ---------------------------------------------------
export const PAPER_REASON_CODES = Object.freeze(["client_not_on_portal", "no_active_authoriser", "connectivity_failure", "short_contract", "agreed_interim_period", "other"]);
const SAMPLED_REASONS = new Set(["other"]);

export function evaluatePaperCapture(db, ws, input, actor) {
  const policy = getPolicy(db); const blocked = []; const missing = [];
  if (!policy.paper_channels.length) blocked.push("No approved paper channels are configured (owner confirmation #3).");
  if (!policy.retention_categories.length) blocked.push("No retention categories are configured (owner confirmation #6).");
  const permitted = actor.role === "Admin" || policy.paper_capture_user_ids.includes(actor.id);
  if (!permitted) blocked.push("You are not on the list of users authorised to capture paper (owner confirmation #3).");
  if (!PAPER_REASON_CODES.includes(input.reason_code)) missing.push("reason_code");
  if (input.reason_code === "other" && !input.reason_text?.trim()) missing.push("reason_text");
  if (!policy.paper_channels.includes(input.source_channel)) missing.push("source_channel");
  if (!policy.retention_categories.includes(input.retention_category)) missing.push("retention_category");
  for (const f of ["client_paper_reference", "received_date", "custodian_user_id", "custody_location", "scan_hash"]) if (!String(input[f] ?? "").trim()) missing.push(f);
  if (input.custodian_user_id && !(db.users || []).some((u) => u.id === input.custodian_user_id && u.is_active !== false)) missing.push("custodian_user_id");
  if (input.legible_and_signed !== true) missing.push("legible_and_signed");
  return { blocked, missing, complete: blocked.length === 0 && missing.length === 0, sampled: SAMPLED_REASONS.has(input.reason_code) };
}

export const duplicateKey = (ws) => `${ws.technician_id || `name:${String(ws.worker_name || "").trim().toLowerCase()}`}|${ws.work_date}|${ws.dispatch_card_id}`;
export function findDuplicates(db, candidate) {
  const key = duplicateKey(candidate);
  return (db.field_worksheets || []).filter((w) => w.id !== candidate.id && !w.superseded_by && duplicateKey(w) === key &&
    ["Client_Acknowledged", "Captured_From_Signed_Paper", "Supervisor_Approved", "Submitted"].includes(w.status));
}

// ---- Step 6: Worksheet reviewer separation -----------------------------------
// Returns a refusal string, or null. `captured` = paper capturers of included records.
export function worksheetReviewerRefusal(db, record, actor) {
  if (record.built_by === actor.id) return "The builder cannot review this Worksheet.";
  if (record.submitted_by === actor.id) return "The submitter cannot review this Worksheet.";
  const ids = new Set((record.lines || []).flatMap((l) => (l.sources || []).map((s) => s.record_id)));
  for (const ws of db.field_worksheets || []) {
    if (ids.has(ws.id) && ws.paper_capture?.captured_by === actor.id) return "You captured paper included in this Worksheet and cannot review it.";
    if (ids.has(ws.id) && ws.paper_entry?.entered_by === actor.id) return "You entered paper included in this Worksheet and cannot review it.";
  }
  if ((record.roster || []).some((r) => r.technician_id && r.technician_id === actor.id)) return "You are on this Worksheet's roster and cannot review your own time.";
  return null;
}
export function eligibleWorksheetReviewers(db, record) {
  return (db.users || []).filter((u) => u.is_active !== false && ["Sales", "Admin"].includes(u.role) && !worksheetReviewerRefusal(db, record, u) &&
    (u.role === "Sales" || getPolicy(db).fallback_reviewer_user_ids.includes(u.id)));
}
// Admin may review only when named as a fallback reviewer (owner confirmation #11), and obeys the same separation.
export function registerReviewRefusal(db, record, actor) {
  if (!flag("SALES_ACCESS")) return null;
  const sep = worksheetReviewerRefusal(db, record, actor);
  if (sep) return sep;
  if (actor.role === "Admin" && !getPolicy(db).fallback_reviewer_user_ids.includes(actor.id)) return "Admin may review a Worksheet only when named as a fallback reviewer.";
  return null;
}
export const reviewPaused = (db, record) => eligibleWorksheetReviewers(db, record).length === 0;

// ---- Step 7: invoice variance --------------------------------------------------
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const CLASSES = ["normal", "ot_15", "ot_20"];

export function eligibleHours(db, dispatchId) {
  const out = { total: 0, normal: 0, ot_15: 0, ot_20: 0, ids: [] };
  for (const ws of db.field_worksheets || []) {
    if (ws.dispatch_card_id !== dispatchId || !evaluateForDb(db, ws).eligible) continue;
    out.ids.push(ws.id); out.total = r2(out.total + r2(ws.hours || 0));
    for (const c of CLASSES) out[c] = r2(out[c] + r2(ws.hours_breakdown?.[c] || 0));
  }
  return out;
}

export function billedHours(db, dispatchId) {
  const rows = (db.timesheets || []).filter((t) => t.dispatch_card_id === dispatchId && !t.voided_at);
  const classed = rows.length > 0 && rows.every((t) => t.hours_breakdown && CLASSES.every((c) => t.hours_breakdown[c] !== undefined));
  const out = { total: 0, normal: 0, ot_15: 0, ot_20: 0, classed, row_ids: rows.map((t) => t.id) };
  for (const t of rows) {
    out.total = r2(out.total + r2(t.hours_logged || 0));
    if (classed) for (const c of CLASSES) out[c] = r2(out[c] + r2(t.hours_breakdown[c]));
  }
  return out;
}

export function computeVariance(db, dispatchId) {
  const E = eligibleHours(db, dispatchId); const B = billedHours(db, dispatchId);
  const tol = getPolicy(db).variance_tolerance_hours; const eps = 1e-9;
  const compared = B.classed ? [...CLASSES, "total"] : ["total"];
  const blocks = []; const warns = [];
  if (B.total > 0 && E.total === 0) blocks.push({ class: "total", billed: B.total, eligible: 0, reason: "Billing hours exist but there is no eligible source." });
  else for (const c of compared) {
    const diff = r2(B[c] - E[c]);
    if (diff > tol + eps) blocks.push({ class: c, billed: B[c], eligible: E[c], difference: diff, reason: "Billed hours exceed eligible hours." });
    else if (diff < -(tol + eps)) warns.push({ class: c, billed: B[c], eligible: E[c], difference: diff, reason: "Under-billing: eligible hours exceed billed hours." });
  }
  return { dispatch_card_id: dispatchId, eligible: E, billed: B, compared_classes: compared, blocks, warnings: warns,
    blocked: blocks.length > 0, hash: `${E.ids.join(",")}#${B.row_ids.join(",")}#${E.total}#${B.total}` };
}

// An override is valid only for the exact eligible/billed state it was granted against.
export function activeOverride(db, dispatchId, variance) {
  return (db.timesheet_variance_overrides || []).find((o) => o.dispatch_card_id === dispatchId && !o.voided_at && o.variance_hash === variance.hash && o.second_approved_by) || null;
}
export function voidStaleOverrides(db, dispatchId, variance, now) {
  let n = 0;
  for (const o of db.timesheet_variance_overrides || []) {
    if (o.dispatch_card_id === dispatchId && !o.voided_at && !o.consumed_invoice_id && o.variance_hash !== variance.hash) { o.voided_at = now; o.voided_reason = "Eligible or billed hours changed after the override."; n++; }
  }
  return n;
}

export function overrideRefusal(db, dispatchId, actor, { creatorIds = [], invoiceCreatorId = null } = {}) {
  const policy = getPolicy(db);
  if (!["Finance", "Admin"].includes(actor.role)) return "Only Finance or Admin can override.";
  if (actor.role === "Finance" && !policy.override_user_ids.includes(actor.id)) return "You are not a named override user (owner confirmation #9).";
  const rows = (db.timesheets || []).filter((t) => t.dispatch_card_id === dispatchId);
  if (rows.some((t) => t.created_by === actor.id) || creatorIds.includes(actor.id)) return "You created billing rows for this dispatch and cannot override its variance.";
  if (invoiceCreatorId && invoiceCreatorId === actor.id) return "The invoice creator cannot override its variance.";
  return null;
}
export const secondApprovalRequired = (db, differenceHours) => Math.abs(differenceHours) > getPolicy(db).second_approval_threshold_hours || getPolicy(db).second_approval_threshold_hours === 0;

// Invoice gate: returns { allow, reason, variance }. Flag off -> always allow (today's behaviour).
export function invoiceVarianceGate(db, dispatchId) {
  if (!flag("INVOICE_VARIANCE")) return { allow: true, skipped: true };
  const variance = computeVariance(db, dispatchId);
  if (!variance.blocked) return { allow: true, variance };
  if (!getPolicy(db).variance_hard_block) return { allow: true, variance, warned: true };
  if (activeOverride(db, dispatchId, variance)) return { allow: true, variance, overridden: true };
  return { allow: false, variance, reason: `Invoice blocked: ${variance.blocks.map((b) => `${b.class} billed ${b.billed} vs eligible ${b.eligible}`).join("; ")}.` };
}

// PO position shown at invoice readiness (Finance/Admin view only). The system holds PO VALUE, not PO hours,
// so hours remaining is reported as null rather than invented.
export function poPosition(db, dispatchId) {
  const job = (db.dispatch_cards || []).find((d) => d.id === dispatchId);
  const po = job && (db.purchase_orders || []).find((p) => p.id === job.purchase_order_id || p.quotation_id === job.quotation_id);
  if (!po || !Number(po.po_amount)) return { available: false, note: "No PO value recorded for this dispatch." };
  const invoiced = (db.invoices || []).filter((i) => i.purchase_order_id === po.id).reduce((s, i) => s + Number(i.total_amount || 0), 0);
  const remaining = r2(Number(po.po_amount) - invoiced);
  return { available: true, po_reference: po.po_reference || null, po_value: r2(po.po_amount), invoiced_value: r2(invoiced), remaining_value: remaining, remaining_hours: null, warning: remaining <= 0 ? "PO value is fully invoiced." : null };
}

// Finance sampling of paper-captured records per capturer per month (contract E). Deterministic order, so the
// same month always yields the same sample; Finance reviews them, this never changes a record.
export function paperSamplingPlan(db, month) {
  const policy = getPolicy(db); const groups = new Map();
  for (const ws of db.field_worksheets || []) {
    const pc = ws.paper_capture;
    if (ws.status !== "Captured_From_Signed_Paper" || !pc || String(pc.captured_at || "").slice(0, 7) !== month) continue;
    if (!groups.has(pc.captured_by)) groups.set(pc.captured_by, []);
    groups.get(pc.captured_by).push(ws);
  }
  return [...groups.entries()].map(([capturer, rows]) => {
    rows.sort((a, b) => (a.id < b.id ? -1 : 1));
    const need = Math.min(rows.length, Math.max(policy.paper_sampling_minimum, Math.ceil(rows.length * policy.paper_sampling_percent / 100)));
    const flagged = rows.filter((r) => r.paper_capture.finance_sampling);
    const pick = [...new Map([...flagged, ...rows].map((r) => [r.id, r])).values()].slice(0, Math.max(need, flagged.length));
    return { capturer_user_id: capturer, capturer_name: rows[0].paper_capture.captured_by_name || null, captured_count: rows.length, sample_size: pick.length,
      sample: pick.map((r) => ({ id: r.id, work_date: r.work_date, dispatch_card_id: r.dispatch_card_id, hours: r.hours, reason_code: r.paper_capture.reason_code, client_paper_reference: r.paper_capture.client_paper_reference, scan_hash: r.paper_capture.scan_hash })) };
  });
}

export function lockTimesheetsForInvoice(db, dispatchId, invoiceId, now) {
  let n = 0;
  for (const id of eligibleHours(db, dispatchId).ids) {
    const ws = db.field_worksheets.find((w) => w.id === id);
    if (ws && !ws.invoice_locked) { ws.invoice_locked = { invoice_id: invoiceId, locked_at: now }; n++; }
  }
  return n;
}

// ---- Step 8: ageing / reminders ---------------------------------------------
export function businessDaysBetween(fromIso, toIso, holidays = []) {
  const skip = new Set(holidays); let n = 0; const d = new Date(`${fromIso.slice(0, 10)}T00:00:00Z`); const end = Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`);
  while (d.getTime() < end) { d.setUTCDate(d.getUTCDate() + 1); const day = d.getUTCDay(); if (day !== 0 && day !== 6 && !skip.has(d.toISOString().slice(0, 10))) n++; }
  return n;
}
export const reminderStage = (age, thresholds) => { const t = [...thresholds].sort((a, b) => a - b); let s = 0; t.forEach((x, i) => { if (age >= x) s = i + 1; }); return s; };

// ---- Step 9: validity -------------------------------------------------------
export function workDateValidity(db, ws) {
  const policy = getPolicy(db);
  if (!flag("PO_VALIDITY") || policy.po_validity_mode === "off") return { valid: true, mode: "off" };
  const job = (db.dispatch_cards || []).find((d) => d.id === ws.dispatch_card_id);
  if (!job) return { valid: false, mode: policy.po_validity_mode, message: "Dispatch not found." };
  const date = ws.work_date; const issues = [];
  if (job.scheduled_start && date < job.scheduled_start) issues.push("Work date is before the dispatch start.");
  if (job.scheduled_end && date > job.scheduled_end) issues.push("Work date is after the dispatch end.");
  const po = (db.purchase_orders || []).find((p) => p.id === job.purchase_order_id || p.quotation_id === job.quotation_id);
  if (po?.date_received && date < String(po.date_received).slice(0, 10) && !(job.started_before_po && policy.allow_retroactive_po)) issues.push("Work date is before the PO was received (retroactive PO not permitted).");
  return { valid: issues.length === 0, mode: policy.po_validity_mode, issues, blocks: issues.length > 0 && policy.po_validity_mode === "hard_block" };
}

registerValidityHook((db, ws) => (workDateValidity(db, ws).blocks ? false : undefined));

export const kioskBlocked = (db) => flag("OPS_RESTRICT") && ["restricted", "hidden"].includes(getPolicy(db).kiosk_mode);

// Atomic swap (contract 2.2): once a revision is itself eligible, its original becomes Superseded,
// unless the original is invoice-locked (Finance resolves that explicitly).
export function swapRevisionIfEligible(db, store, actor, revision) {
  if (!revision?.revises_worksheet_id) return false;
  const orig = (db.field_worksheets || []).find((w) => w.id === revision.revises_worksheet_id);
  if (!orig || orig.superseded_by || orig.invoice_locked) return false;
  if (!evaluateForDb(db, revision).eligible) return false;
  const before = { ...orig };
  orig.superseded_by = revision.id; delete orig.pending_revision_id; orig.updated_at = new Date().toISOString();
  store.audit(db, actor, "field_worksheet", orig.id, "WORKSHEET_SUPERSEDED", before, orig);
  return true;
}

// Shared authority gate (single and batch confirmation use the same rule).
export function resolveAuthorityGate(db, actor, worksheet) {
  if (!flag("AUTHORITY")) return { ok: true, snapshot: null };
  const client = (db.clients || []).find((c) => c.id === actor.client_id);
  const cutover = client?.timesheet_cutover_date; const t = new Date().toISOString().slice(0, 10);
  if (!cutover || t < cutover) return { ok: true, snapshot: null };
  if (worksheet.submitted_by === actor.id || worksheet.created_by === actor.id) return { ok: false, message: "You cannot confirm a record you prepared." };
  const a = activeAuthorityFor(db, actor.id, client.id, t, worksheet.mine_site_id || null);
  if (!a) return { ok: false, message: anyActiveAuthority(db, client.id, t) ? "Only a named Client Authoriser or Delegate can confirm." : "Awaiting Client Authority: no active authoriser or delegate." };
  return { ok: true, snapshot: authoritySnapshot(a, actor, new Date().toISOString()) };
}
