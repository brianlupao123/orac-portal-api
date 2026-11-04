// Phase 3: PO / quoted-scope overrun detection. PURE LOGIC: no req/res, no I/O, no external packages.
//
// Question answered: "Have the CERTIFIED field hours on this quote outgrown what was quoted / what the
// client's PO authorises?" Sales asks it while reviewing the consolidated monthly Worksheet, and the
// invoice gate asks it again before any legacy invoice can be drafted or issued, from the same function,
// so the two can never disagree.
//
// This is NOT the older billed-vs-eligible check (computeVariance in timesheetWorkflow.js). That one
// compares what Finance billed against what was certified. This one compares what was certified against
// what was sold. Both can apply; both stay.
//
// Dark by default under the existing TIMESHEET_INVOICE_VARIANCE flag. With the flag off the gate always
// allows and behaviour is identical to before this packet.
//
// DEFINITIONS (every one of them is deliberately conservative; see the notes returned in the result):
//   quoted hours     Sum of the quote's labour lines that are measured in hours: legacy lines with
//                    unit_of_measure "hours" (labour or untyped), V5 `hourly` lines (quantity) and V5
//                    `minimum_hours` lines (planned_hours, the accepted ceiling). Optional lines and
//                    fixed-price lines are not counted. Days-based labour lines are NOT converted (no
//                    hours-per-day policy exists); they are reported so the baseline is never silently low.
//   certified hours  Hours on Timesheets that pass the shared eligibility predicate (the same one the
//                    invoice gate and the Worksheet builder use), across every dispatch of the quote.
//                    Raw Normal + 1.5 + 2.0 hours: no weighting (owner decision OD-04 is still open).
//   quoted amount    The VERIFIED PO amount. The quote total is not used because it can include tax that
//                    logged work does not, which would raise false overruns.
//   actual amount    Approved labour value + material cost for the quote's dispatches: the same formula
//                    as calculatePurchaseOrderEvidenceValue() in store.js (a test pins them together).
//
// RATE PRIVACY: Sales is rate-free. computePoVarianceCore() holds the money figures; presentPoVariance()
// is the ONLY thing handlers return, and it strips the amount figures unless the viewer may see them.
// Everyone still learns whether the PO value was exceeded (a boolean), which the readiness summary
// already exposes to Sales as `requires_amendment`.
import { createHash } from "node:crypto";
import { flag, getPolicy, eligibleHours } from "./timesheetWorkflow.js";
import { approvedLabourValue } from "./timesheetReview.js";

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const EPS = 1e-9;
const AMOUNT_EPS = 0.005;

export const WITHIN_BUDGET_LABEL = "Within PO Budget — Ready for Invoicing";
export const NO_BASELINE_LABEL = "PO budget not checked — no quoted hours or verified PO value to compare against";
export const EVIDENCE_KINDS = Object.freeze(["amendment_note", "revised_po"]);
export const MIN_NOTE_LENGTH = 10;

// "12", "12.5", "12.25": never "12.00".
const fmt = (n) => String(r2(n));
export const overrunHoursLabel = (hours) => `Scope Overrun Detected: +${fmt(hours)} Hours over PO`;
const OVERRUN_VALUE_LABEL = "Scope Overrun Detected: PO value exceeded";

// ---- quoted hours -------------------------------------------------------------
const HOUR_UNITS = new Set(["hour", "hours", "hr", "hrs"]);
const DAY_UNITS = new Set(["day", "days"]);
const unit = (line) => String(line.unit_of_measure || "").trim().toLowerCase();
const isLabour = (line) => !line.cost_type || line.cost_type === "labour";

export function quotedHours(db, quote) {
  const lines = (db.quote_lines || []).filter((l) => l.quotation_id === quote.id && l.item_type !== "optional");
  const out = { hours: 0, line_ids: [], unquantified_lines: [], unconvertible_lines: [] };
  for (const line of lines) {
    if (line.pricing_basis) { // V5 line
      if (line.pricing_basis === "hourly") { out.hours = r2(out.hours + r2(line.quantity)); out.line_ids.push(line.id); }
      else if (line.pricing_basis === "minimum_hours") {
        if (Number(line.planned_hours) > 0) { out.hours = r2(out.hours + r2(line.planned_hours)); out.line_ids.push(line.id); }
        else out.unquantified_lines.push(line.id);
      }
      continue; // fixed lines are not hour-denominated
    }
    if (!isLabour(line)) continue;
    if (HOUR_UNITS.has(unit(line))) { out.hours = r2(out.hours + r2(line.quantity)); out.line_ids.push(line.id); }
    else if (DAY_UNITS.has(unit(line))) out.unconvertible_lines.push(line.id);
  }
  return out;
}

// ---- scope resolution -----------------------------------------------------------
// The PO selection mirrors invoiceReadinessBlock so both look at the same PO.
export function purchaseOrderFor(db, quoteId, preferredId = null) {
  const all = db.purchase_orders || [];
  if (preferredId) { const p = all.find((x) => x.id === preferredId && x.quotation_id === quoteId); if (p) return p; }
  return all.find((p) => p.quotation_id === quoteId && p.status !== "rejected" && p.status !== "cancelled") || all.find((p) => p.quotation_id === quoteId) || null;
}

// A Worksheet register is scoped by client and, optionally, quote and/or PO. Only a quote or PO scope can
// be compared; a client-only scope spans many quotes, so nothing is invented for it.
export function resolveRegisterQuote(db, scope = {}) {
  const po = scope.purchase_order_id ? (db.purchase_orders || []).find((p) => p.id === scope.purchase_order_id) : null;
  if (scope.purchase_order_id && !po) return { quote_id: null, reason: "The Worksheet's PO was not found." };
  if (scope.quote_id && po && po.quotation_id !== scope.quote_id) return { quote_id: null, reason: "The Worksheet's quote and PO do not belong together." };
  const quoteId = scope.quote_id || po?.quotation_id || null;
  if (!quoteId) return { quote_id: null, reason: "This Worksheet is scoped to a client only. Scope it to a quote or PO to compare against quoted hours." };
  return { quote_id: quoteId, purchase_order_id: po?.id || null, reason: null };
}

const certifiedFor = (db, jobs) => {
  const out = { total: 0, normal: 0, ot_15: 0, ot_20: 0, worksheet_ids: [] };
  for (const job of jobs) {
    const e = eligibleHours(db, job.id);
    for (const k of ["total", "normal", "ot_15", "ot_20"]) out[k] = r2(out[k] + e[k]);
    out.worksheet_ids.push(...e.ids);
  }
  return out;
};

const actualAmountFor = (db, jobs) => {
  const ids = new Set(jobs.map((j) => j.id));
  const labour = approvedLabourValue(db, ids);
  const materials = (db.material_usage || []).filter((m) => ids.has(m.dispatch_card_id)).reduce((s, m) => s + Number(m.total_cost || 0), 0);
  return r2(labour + materials);
};

// ---- evidence --------------------------------------------------------------------
// Evidence belongs to one exact overrun state (the hash). If certified hours, quoted hours or the PO figures
// move, it stops counting and Sales must attach fresh evidence. It is single-use: once an invoice consumed
// it, a later invoice needs its own.
export function activeScopeEvidence(db, quoteId, hash) {
  return (db.po_scope_evidence || []).find((e) => e.quote_id === quoteId && !e.voided_at && !e.consumed_invoice_id && e.variance_hash === hash) || null;
}

// ---- core ---------------------------------------------------------------------------
// Holds money figures. Never return this from a handler: use presentPoVariance().
export function computePoVarianceCore(db, quoteId, { preferredPoId = null } = {}) {
  const base = { quote_id: quoteId || null };
  const quote = quoteId ? (db.quotes || []).find((q) => q.id === quoteId) : null;
  if (!quote) return { ...base, status: "no_baseline", reason: "Quote not found.", hash: null, blocks_invoicing: false };

  const policy = getPolicy(db);
  const tol = policy.variance_tolerance_hours;
  const jobs = (db.dispatch_cards || []).filter((d) => d.quotation_id === quote.id);
  const q = quotedHours(db, quote);
  const cert = certifiedFor(db, jobs);
  const po = purchaseOrderFor(db, quote.id, preferredPoId);

  const hoursBaseline = q.hours > 0;
  const hoursDiff = hoursBaseline ? r2(cert.total - q.hours) : null;
  const hoursOver = hoursBaseline && hoursDiff > tol + EPS;

  const poAmount = po && po.status === "verified" && Number(po.po_amount) > 0 ? r2(po.po_amount) : null;
  const actual = actualAmountFor(db, jobs);
  const amountDiff = poAmount !== null ? r2(actual - poAmount) : null;
  const amountOver = poAmount !== null && amountDiff > AMOUNT_EPS;

  // V5 quotes have their own controlled amendment workflow and invoice preview (accepted-quantity overruns are
  // already blocked there). This legacy evidence gate reports them for information and never gates them.
  const v5 = Boolean(quote.v5_commercial_workflow);
  const notes = [];
  if (v5) notes.push("This is a V5 quotation: overruns are resolved through the V5 amendment workflow, not by a Sales note.");
  if (!hoursBaseline) notes.push("The quote has no hour-denominated labour lines, so hours cannot be compared.");
  if (q.unconvertible_lines.length) notes.push(`${q.unconvertible_lines.length} labour line(s) are priced in days and are not converted to hours, so quoted hours may be understated.`);
  if (q.unquantified_lines.length) notes.push(`${q.unquantified_lines.length} minimum-hours line(s) have no planned hours and are not counted.`);
  if (poAmount === null) notes.push(po ? "The PO is not verified or has no amount, so PO value cannot be compared." : "No PO exists for this quote, so PO value cannot be compared.");

  const status = !hoursBaseline && poAmount === null ? "no_baseline" : (hoursOver || amountOver ? "overrun" : "within_budget");
  const hash = createHash("sha256").update(JSON.stringify([quote.id, q.hours, cert.total, hoursOver, amountOver ? [po.id, poAmount, actual] : null])).digest("hex").slice(0, 16);
  const gated = status === "overrun" && !v5;
  const evidence = gated ? activeScopeEvidence(db, quote.id, hash) : null;
  const hardBlock = policy.variance_hard_block !== false;

  return {
    ...base, status, hash, notes, tolerance_hours: tol, workflow: v5 ? "v5" : "legacy",
    scope: { quote_number: quote.quote_number || null, purchase_order_id: po?.id || null, po_reference: po?.po_reference || null, dispatch_card_ids: jobs.map((j) => j.id) },
    hours: { available: hoursBaseline, quoted: q.hours, certified: cert.total, certified_breakdown: { normal: cert.normal, ot_15: cert.ot_15, ot_20: cert.ot_20 },
      difference: hoursDiff, overrun_hours: hoursOver ? hoursDiff : 0, overrun: hoursOver, baseline_partial: q.unconvertible_lines.length + q.unquantified_lines.length > 0 },
    amount: { available: poAmount !== null, basis: "verified_po", quoted: poAmount, actual: poAmount !== null ? actual : null, difference: amountDiff, overrun_amount: amountOver ? amountDiff : 0, overrun: amountOver },
    evidence_required: gated,
    evidence,
    blocks_invoicing: gated && hardBlock && !evidence,
    warn_only: gated && !hardBlock
  };
}

function labelFor(core, canSeeAmounts) {
  if (core.status === "no_baseline") return NO_BASELINE_LABEL;
  if (core.status === "within_budget") return WITHIN_BUDGET_LABEL;
  if (core.hours.overrun) return overrunHoursLabel(core.hours.overrun_hours);
  return canSeeAmounts ? `Scope Overrun Detected: +${fmt(core.amount.overrun_amount)} over PO value` : OVERRUN_VALUE_LABEL;
}

// The only shape a handler may return. Money figures are included only when canSeeAmounts is true.
export function presentPoVariance(core, { canSeeAmounts = false, periodHours = null } = {}) {
  if (core.status === "no_baseline" && !core.scope) return { quote_id: core.quote_id, status: core.status, label: NO_BASELINE_LABEL, reason: core.reason, blocks_invoicing: false, issue_disabled_reason: null };
  const a = core.amount;
  const amount = canSeeAmounts
    ? { available: a.available, basis: a.basis, quoted: a.quoted, actual: a.actual, difference: a.difference, overrun: a.overrun }
    : { available: a.available, restricted: true, overrun: a.overrun };
  const ev = core.evidence;
  return {
    quote_id: core.quote_id, status: core.status, label: labelFor(core, canSeeAmounts), hash: core.hash, workflow: core.workflow,
    scope: core.scope, tolerance_hours: core.tolerance_hours,
    hours: { ...core.hours, ...(periodHours === null ? {} : { this_period: periodHours }) }, amount, notes: core.notes,
    evidence_required: core.evidence_required,
    evidence: ev ? { id: ev.id, kind: ev.kind, note: ev.note || null, revised_po_reference: ev.revised_po_reference || null, attached_by_name: ev.attached_by_name || null, attached_at: ev.attached_at } : null,
    blocks_invoicing: core.blocks_invoicing, warn_only: core.warn_only,
    issue_disabled_reason: core.blocks_invoicing ? "Sales must attach an amendment note or revised PO reference before this can be invoiced." : null
  };
}

// Hours on the Worksheet itself (this month), summed from its consolidated lines. Display only: the
// comparison always uses cumulative certified hours, because a PO budget is spent across months.
export function registerPeriodHours(record) {
  return r2((record?.lines || []).reduce((s, l) => s + Number(l.normal || 0) + Number(l.ot_15 || 0) + Number(l.ot_20 || 0), 0));
}

// ---- attach-evidence validation (server-side; the form mirrors it) ------------------
export function validateEvidenceInput(core, body = {}) {
  if (!EVIDENCE_KINDS.includes(body.kind)) return "Choose an amendment note or a revised PO reference.";
  const note = String(body.note || "").trim();
  if (body.kind === "amendment_note" && note.length < MIN_NOTE_LENGTH) return `An amendment note of at least ${MIN_NOTE_LENGTH} characters is required.`;
  if (note.length > 1000) return "The note cannot exceed 1000 characters.";
  if (body.kind === "revised_po") {
    const ref = String(body.revised_po_reference || "").trim();
    if (!/^[A-Za-z0-9._:/-]{3,100}$/.test(ref)) return "A revised PO reference of 3 to 100 letters, numbers or . _ : / - is required.";
    if (core.scope?.po_reference && ref.toLowerCase() === String(core.scope.po_reference).toLowerCase()) return "The revised PO reference must differ from the current PO reference.";
  }
  return null;
}

// ---- invoice gate -----------------------------------------------------------------
// Used by invoiceReadinessBlock, which every legacy invoice path already passes through.
export function poScopeGate(db, job) {
  if (!flag("INVOICE_VARIANCE")) return { allow: true, skipped: true };
  const core = computePoVarianceCore(db, job.quotation_id, { preferredPoId: job.purchase_order_id || null });
  if (core.status !== "overrun" || core.workflow === "v5") return { allow: true, core };
  if (core.evidence) return { allow: true, core, evidence: core.evidence };
  if (!core.blocks_invoicing) return { allow: true, core, warned: true };
  const parts = [];
  if (core.hours.overrun) parts.push(`certified hours exceed quoted hours by ${fmt(core.hours.overrun_hours)}`);
  if (core.amount.overrun) parts.push("approved work exceeds the verified PO value");
  return { allow: false, core, reason: `Invoice blocked: ${parts.join(" and ")}. Sales must attach an amendment note or revised PO reference first.` };
}
