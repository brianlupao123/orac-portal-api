// V5 paper-signature evidence and the V5 "verified" definition (pure logic, no req/res).
//
// Both the client-site Supervisor and the worker sign the SAME paper Timesheet.
// The system stores evidence ABOUT that paper; it never authenticates a client.
// A Timesheet is V5-verified only when, for its CURRENT hash:
//   1. complete paper evidence exists (worker + client-site Supervisor signed,
//      recorder attested, evidence reference / channel / custodian / received
//      date / scan hash present), AND
//   2. the assigned ORAC Supervisor confirmed that exact evidence in-system.
// The hash is recomputed from the live Timesheet every time, so any correction
// makes older evidence and confirmations non-current without deleting them.
// There is deliberately no rate, amount or cost anywhere in this module.
import { createHash } from "node:crypto";
import { v5Enabled } from "./v5CommercialWorkflow.js";
import { isTimesheetV2, isIsoDate } from "./timesheetModel.js";
import { getPolicy } from "./timesheetWorkflow.js";
import { roles } from "./permissions.js";

export const V5_HASH_VERSION = "v5-timesheet-sig-1";
export const V5_PAPER_ATTESTATION_TEXT = "I have the original signed paper Timesheet and its signatures match the hours and classification shown.";
export const V5_NOT_VERIFIED_STATUSES = Object.freeze(["Draft", "Returned_For_Correction"]);

const SHA256_HEX = /^[a-f0-9]{64}$/i;
const hundredths = (value) => Math.round(Number(value || 0) * 100);
const normName = (value) => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const present = (value) => String(value ?? "").trim() !== "";

// Key-sorted JSON so a hash does not depend on property order after a JSON round trip.
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

// ---- hash binding -----------------------------------------------------------
// Bound: Timesheet id, dispatch, worker, work date, Normal / 1.5 / 2.0 and total.
export function v5TimesheetHashBasis(sheet) {
  const b = sheet?.hours_breakdown || {};
  const normal = hundredths(b.normal);
  const ot15 = hundredths(b.ot_15);
  const ot20 = hundredths(b.ot_20);
  return {
    version: V5_HASH_VERSION,
    sheet_id: sheet?.id ?? null,
    dispatch_card_id: sheet?.dispatch_card_id ?? null,
    worker: { technician_id: sheet?.technician_id || null, name: normName(sheet?.worker_name) },
    work_date: sheet?.work_date ?? null,
    hours_hundredths: { normal, ot_15: ot15, ot_20: ot20, total: normal + ot15 + ot20 }
  };
}
export const v5TimesheetHash = (sheet) => sha256(stableStringify(v5TimesheetHashBasis(sheet)));
export const v5RecordHash = (record) => {
  const { record_hash: _ignored, ...rest } = record || {};
  return sha256(stableStringify(rest));
};
export const recordIntact = (record) => Boolean(record) && record.record_hash === v5RecordHash(record);

// ---- scope helpers ----------------------------------------------------------
export function v5Context(db, sheet) {
  const dispatch = (db?.dispatch_cards || []).find((item) => item.id === sheet?.dispatch_card_id) || null;
  const quote = dispatch ? (db?.quotes || []).find((item) => item.id === dispatch.quotation_id) || null : null;
  return { dispatch, quote };
}

// Every user recorded as owning this quotation commercially (its creator, an explicit
// sales owner, and the same on the root quotation of a revision chain).
export function v5SalesOwnerIds(db, quote) {
  const ids = new Set();
  const add = (value) => { if (value) ids.add(value); };
  add(quote?.sales_owner_id); add(quote?.created_by);
  const root = quote?.root_quote_id ? (db?.quotes || []).find((item) => item.id === quote.root_quote_id) : null;
  add(root?.sales_owner_id); add(root?.created_by);
  return ids;
}

// The ORAC Supervisor of a dispatch is the one ASSIGNED to it. A Supervisor who merely
// appears on a linked worksheet is not assigned for V5 confirmation purposes.
export const isAssignedOracSupervisor = (dispatch, userId) =>
  Boolean(userId) && (dispatch?.assigned_supervisor_id === userId || dispatch?.supervisor_id === userId);

// Assignment-time guard (dark): a quotation's Sales owner cannot be its dispatch Supervisor.
export function v5SupervisorAssignmentRefusal(db, dispatch, supervisor) {
  if (!v5Enabled()) return null;
  const quote = (db?.quotes || []).find((item) => item.id === dispatch?.quotation_id);
  if (!quote?.v5_commercial_workflow) return null;
  if (v5SalesOwnerIds(db, quote).has(supervisor?.id)) return "The Sales owner of this quotation cannot be its assigned ORAC Supervisor.";
  return null;
}

// ---- Timesheet eligibility to carry V5 evidence ----------------------------
export function v5SheetBlockers(db, sheet) {
  const blockers = [];
  const { dispatch, quote } = v5Context(db, sheet);
  if (!dispatch || !quote?.v5_commercial_workflow) return ["NOT_V5_QUOTATION"];
  if (!isTimesheetV2(sheet)) blockers.push("NOT_V5_TIMESHEET");
  const line = (db?.quote_lines || []).find((item) => item.id === sheet?.quote_line_id && item.quotation_id === quote.id);
  if (!line) blockers.push("NO_QUOTE_LINE");
  if (sheet?.superseded_by) blockers.push("SUPERSEDED");
  if (sheet?.duplicate_conflict && sheet.duplicate_conflict.resolved_at == null) blockers.push("DUPLICATE_CONFLICT");
  if (V5_NOT_VERIFIED_STATUSES.includes(sheet?.status)) blockers.push("NOT_SUBMITTED");
  if (isTimesheetV2(sheet)) {
    const basis = v5TimesheetHashBasis(sheet);
    if (basis.hours_hundredths.total <= 0 || Math.abs(Number(sheet.hours) * 100 - basis.hours_hundredths.total) > 0.5) blockers.push("HOURS_MISMATCH");
  }
  return blockers;
}

// ---- completeness of a stored paper evidence record -------------------------
export function paperEvidenceMissing(record, db) {
  const missing = [];
  const need = (ok, name) => { if (!ok) missing.push(name); };
  need(record?.hours_hash && SHA256_HEX.test(record.hours_hash), "hours_hash");
  need(record?.paper?.worker_signed === true, "worker_signed_on_paper");
  need(record?.paper?.client_supervisor_signed === true, "client_supervisor_signed_on_paper");
  need(present(record?.paper?.worker_name_on_paper), "worker_name_on_paper");
  need(present(record?.paper?.client_supervisor_name_on_paper), "client_supervisor_name_on_paper");
  need(record?.paper?.attestation?.attested === true && present(record.paper.attestation.attested_by) && present(record.paper.attestation.attested_at), "paper_attestation");
  need(present(record?.client_supervisor_contact?.contact_id) && present(record.client_supervisor_contact.name), "client_supervisor_contact");
  need(present(record?.evidence_reference), "evidence_reference");
  need(present(record?.source_channel), "source_channel");
  need(present(record?.custodian_user_id) && (!db || (db.users || []).some((u) => u.id === record.custodian_user_id)), "custodian_user_id");
  need(isIsoDate(record?.received_date), "received_date");
  need(SHA256_HEX.test(String(record?.scan_hash || "")), "scan_hash");
  need(present(record?.recorded_by) && present(record?.recorded_at), "recorded_by");
  return missing;
}

// ---- state ------------------------------------------------------------------
export function v5SignatureState(db, sheet) {
  const hash = v5TimesheetHash(sheet);
  const blockers = v5SheetBlockers(db, sheet);
  const records = (db?.v5_paper_signatures || []).filter((item) => item.sheet_id === sheet?.id);
  const latest = records[records.length - 1] || null;
  const statusOf = (record) => {
    if (!recordIntact(record)) return "integrity_failed";
    if (paperEvidenceMissing(record, db).length) return "incomplete";
    if (record !== latest) return "superseded";
    return record.hours_hash === hash ? "current" : "stale_hours_changed";
  };
  const evidenceList = records.map((record) => ({ record, status: statusOf(record) }));
  const evidence = evidenceList.find((item) => item.status === "current")?.record || null;

  const { quote } = v5Context(db, sheet);
  const owners = v5SalesOwnerIds(db, quote);
  const confirmations = (db?.v5_supervisor_confirmations || []).filter((item) => item.sheet_id === sheet?.id);
  const confirmationCurrent = (item) => Boolean(evidence) && recordIntact(item) && item.evidence_id === evidence.id && item.hours_hash === hash &&
    item.attested === true && !owners.has(item.supervisor_id) &&
    (db?.users || []).some((user) => user.id === item.supervisor_id && user.role === roles.SUPERVISOR);
  const confirmation = [...confirmations].reverse().find(confirmationCurrent) || null;

  const reasons = [...blockers];
  if (!evidence) reasons.push(records.length ? "PAPER_EVIDENCE_NOT_CURRENT" : "NO_PAPER_EVIDENCE");
  if (!confirmation) reasons.push("NO_CURRENT_SUPERVISOR_CONFIRMATION");
  return {
    current_hash: hash,
    hash_basis: v5TimesheetHashBasis(sheet),
    sheet_blockers: blockers,
    evidence,
    evidence_history: evidenceList.map(({ record, status }) => ({ id: record.id, status, hours_hash: record.hours_hash, recorded_at: record.recorded_at })),
    confirmation,
    confirmation_history: confirmations.map((item) => ({ id: item.id, evidence_id: item.evidence_id, hours_hash: item.hours_hash, current: item === confirmation, confirmed_at: item.confirmed_at })),
    verified: blockers.length === 0 && Boolean(evidence) && Boolean(confirmation),
    reasons
  };
}

// Legacy behaviour is untouched while V5 is off: nothing is ever V5-verified then.
export const isV5Verified = (db, sheet) => v5Enabled() && v5SignatureState(db, sheet).verified;

// ---- paper-capture channel (reuses the existing owner-configured list when set)
export function v5ChannelRefusal(db, channel) {
  if (!present(channel)) return "A source channel is required.";
  const configured = getPolicy(db).paper_channels;
  if (Array.isArray(configured) && configured.length && !configured.includes(channel)) return "This source channel is not an approved paper channel.";
  return null;
}

// ---- rate-free billing input ---------------------------------------------------
// Only V5-verified Timesheets contribute hours. Anything else on the dispatch is
// reported (hours and reason codes only) so nothing is silently dropped.
export function v5VerifiedHoursByQuoteLine(db, dispatchId) {
  const by_quote_line = {};
  const unmapped = { hours: 0, source_ids: [] };
  const unverified = { hours: 0, source_ids: [], items: [] };
  for (const sheet of db?.field_worksheets || []) {
    if (sheet.dispatch_card_id !== dispatchId || sheet.superseded_by) continue;
    const state = v5SignatureState(db, sheet);
    const hours = Number(sheet.hours || 0);
    if (!state.verified) {
      unverified.hours = Number((unverified.hours + hours).toFixed(2));
      unverified.source_ids.push(sheet.id);
      unverified.items.push({ id: sheet.id, hours, reasons: state.reasons });
      continue;
    }
    const current = by_quote_line[sheet.quote_line_id] || { hours: 0, source_ids: [] };
    current.hours = Number((current.hours + hours).toFixed(2));
    current.source_ids.push(sheet.id);
    by_quote_line[sheet.quote_line_id] = current;
  }
  return { by_quote_line, unmapped, unverified };
}
