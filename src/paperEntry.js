// Paper entry (Sales Desk transcription of signed paper timesheets).
//
// Site supervisors bring signed paper back to the ORAC office. The Sales Desk may
// key it in under its OWN account; it never logs in as a Supervisor. This module
// is PURE (no req/res, no I/O) and is shared by the Timesheet (field_worksheets)
// and Daily Time Sheet controllers so both stamp identical audit evidence.
//
// What a paper entry is NOT:
//  - It is not client confirmation. The signatory named on the paper is recorded
//    as written (signatory_authenticated: false) and never becomes an acknowledgement.
//  - It is not the owner-gated Captured_From_Signed_Paper route
//    (POST /field_worksheets/paper-capture); a paper entry follows the normal
//    Draft -> Submitted -> client confirmation -> Supervisor review path.
import { roles } from "./permissions.js";

export const PAPER_SOURCE = "paper_entry";
export const PAPER_CAPTURE_METHOD = "paper_transcription";
export const PAPER_BODY_FIELDS = Object.freeze(["client_paper_reference", "signatory_name_on_paper", "scan_reference", "scan_hash"]);

const clean = (value) => {
  const text = String(value ?? "").trim();
  return text || null;
};

export const isPaperEntry = (record) => record?.source === PAPER_SOURCE && Boolean(record?.paper_entry);

/** True when the request carries any paper metadata (a blank string is "not supplied"). */
export const hasPaperFields = (body) => PAPER_BODY_FIELDS.some((key) => clean(body?.[key]) !== null);

/**
 * Refusal text (or null) for a CREATE request.
 *  - Sales may only enter paper, so Sales must send source "paper_entry".
 *  - Paper metadata without source "paper_entry" is refused rather than silently dropped.
 *  - A paper entry must say which paper it came from and who signed it. The scan is optional.
 *  - Nobody can attest "on device" for a paper entry: the worker's signature is on the paper.
 */
export function paperEntryCreateRefusal(actor, body) {
  const isPaper = body?.source === PAPER_SOURCE;
  if (actor?.role === roles.SALES && !isPaper) {
    return "The Sales Desk enters signed paper only. Set source to paper_entry and give the paper reference and the signatory named on the paper.";
  }
  if (!isPaper) {
    return hasPaperFields(body) ? "Paper details can only be sent with source paper_entry." : null;
  }
  if (!clean(body.client_paper_reference)) return "A paper entry needs client_paper_reference (for example, booklet and sheet number).";
  if (!clean(body.signatory_name_on_paper)) return "A paper entry needs signatory_name_on_paper (the client representative who signed on site).";
  if (body.signatures?.employee?.method === "on_device") return "A paper entry cannot use an on-device attestation. The worker's signature is on the paper.";
  return null;
}

/** Evidence block stored on the record. The server, never the client, supplies who entered it and when. */
export function buildPaperEntry(actor, body, now) {
  return {
    entered_by: actor.id,
    entered_by_name: actor.name || null,
    entered_by_role: actor.role,
    entered_at: now,
    client_paper_reference: clean(body.client_paper_reference),
    signatory_name_on_paper: clean(body.signatory_name_on_paper),
    signatory_authenticated: false,
    scan_reference: clean(body.scan_reference),
    scan_hash: clean(body.scan_hash)
  };
}

/**
 * Stamps a freshly built record. created_by stays the real actor (set by the caller).
 * A scan reference doubles as the signed copy, so the existing worker sign-off rule
 * (signed copy or on-device attestation) is satisfied by the paper itself, never relaxed.
 */
export function stampPaperEntry(record, actor, body, now) {
  record.source = PAPER_SOURCE;
  record.capture_method = PAPER_CAPTURE_METHOD;
  record.paper_entry = buildPaperEntry(actor, body, now);
  if (!record.signed_copy_image && record.paper_entry.scan_reference) record.signed_copy_image = record.paper_entry.scan_reference;
  return record;
}

/** A Sales user may touch only the paper entries they created themselves. */
export function salesOwnPaperEntryRefusal(actor, record) {
  if (actor?.role !== roles.SALES) return null;
  return isPaperEntry(record) && record.created_by === actor.id ? null : "Sales may change only the paper entries they created.";
}

/** Refusal text (or null) for an UPDATE request. Pure: call before mutating anything. */
export function paperEntryUpdateRefusal(record, body) {
  const touches = body?.source !== undefined || PAPER_BODY_FIELDS.some((key) => body?.[key] !== undefined);
  if (!isPaperEntry(record)) return touches ? "Paper details can only be changed on a paper entry." : null;
  if (body.source !== undefined && body.source !== PAPER_SOURCE) return "The source of a paper entry cannot be changed.";
  for (const key of ["client_paper_reference", "signatory_name_on_paper"]) {
    if (body[key] !== undefined && !clean(body[key])) return `${key} cannot be blank on a paper entry.`;
  }
  if (body.signatures?.employee?.method === "on_device") return "A paper entry cannot use an on-device attestation. The worker's signature is on the paper.";
  return null;
}

/** Applies supplied paper fields to an existing paper entry. Entered-by/at are never rewritten. */
export function applyPaperEntryUpdate(record, body) {
  if (!isPaperEntry(record)) return;
  const entry = record.paper_entry;
  const previousScan = entry.scan_reference;
  for (const key of PAPER_BODY_FIELDS) if (body[key] !== undefined) entry[key] = clean(body[key]);
  if (body.signed_copy_image === undefined && entry.scan_reference && entry.scan_reference !== previousScan) record.signed_copy_image = entry.scan_reference;
}
