// Shared daily-source eligibility predicate (Implementation Contract 2.3).
//
// ONE function decides whether a Timesheet (field_worksheets record) is an
// eligible daily source. Every consumer (invoice gate, register builder,
// completion documents, reports, dashboard counters, lineage checks) calls it;
// none may keep a private copy of the status logic.
//
// DARK BY DEFAULT: with TIMESHEET_ELIGIBILITY_CUTOVER unset the predicate is
// exactly the pre-change rule (status === "Supervisor_Approved"), so every
// consumer returns identical output to today. Pure logic: no req/res, no I/O.
import { isTimesheetV2, employeeSignoffMissing, isIsoDate } from "./timesheetModel.js";

export const FLAG_ELIGIBILITY_CUTOVER = "TIMESHEET_ELIGIBILITY_CUTOVER";
export const FLAG_CLIENT_RETURN = "TIMESHEET_CLIENT_RETURN";

// Read live so a test (or an operator restart) changes behaviour without re-import.
const flagOn = (name) => process.env[name] === "enabled";
export const eligibilityCutoverEnabled = () => flagOn(FLAG_ELIGIBILITY_CUTOVER);
export const clientReturnEnabled = () => flagOn(FLAG_CLIENT_RETURN);

export const STATUS_HISTORICAL_APPROVED = "Supervisor_Approved";
export const STATUS_CLIENT_CONFIRMED = "Client_Acknowledged";
export const STATUS_CAPTURED_FROM_PAPER = "Captured_From_Signed_Paper";

export const INELIGIBLE = Object.freeze({
  NOT_ELIGIBLE_STATE: "NOT_ELIGIBLE_STATE",
  SUPERSEDED: "SUPERSEDED",
  DUPLICATE_CONFLICT: "DUPLICATE_CONFLICT",
  OUT_OF_VALIDITY: "OUT_OF_VALIDITY",
  NO_DECLARATION: "NO_DECLARATION",
  PAPER_EVIDENCE_INCOMPLETE: "PAPER_EVIDENCE_INCOMPLETE",
  NO_CLIENT_CUTOVER: "NO_CLIENT_CUTOVER",
  PRE_CUTOVER_ACKNOWLEDGEMENT: "PRE_CUTOVER_ACKNOWLEDGEMENT",
  NO_AUTHORITY_SNAPSHOT: "NO_AUTHORITY_SNAPSHOT"
});

const MESSAGES = Object.freeze({
  NOT_ELIGIBLE_STATE: "this status is not an eligible daily source",
  SUPERSEDED: "it has been superseded by a later revision",
  DUPLICATE_CONFLICT: "it has an open duplicate conflict",
  OUT_OF_VALIDITY: "its work date is outside the dispatch/PO validity",
  NO_DECLARATION: "the worker/contractor declaration is incomplete",
  PAPER_EVIDENCE_INCOMPLETE: "the paper evidence is incomplete",
  NO_CLIENT_CUTOVER: "this client has no confirmation cutover date set",
  PRE_CUTOVER_ACKNOWLEDGEMENT: "it was acknowledged before this client's cutover",
  NO_AUTHORITY_SNAPSHOT: "the confirmation has no active authoriser/delegate authority snapshot"
});

// Client company that owns a Timesheet (dispatch -> quote -> client). Null if unresolved.
export function clientForWorksheet(db, ws) {
  const dispatch = (db?.dispatch_cards || []).find((item) => item.id === ws?.dispatch_card_id);
  const quote = dispatch && (db.quotes || []).find((item) => item.id === dispatch.quotation_id);
  return quote ? (db.clients || []).find((item) => item.id === quote.client_id) || null : null;
}

// Optional validity hook (PO/dispatch validity, contract P). Registered by timesheetWorkflow.js;
// returns false only when the validity gate is enabled AND configured to hard-block.
let validityHook = null;
export const registerValidityHook = (fn) => { validityHook = fn; };
export const eligibilityContext = (db, ws) => ({
  client: clientForWorksheet(db, ws),
  workDateValid: validityHook ? validityHook(db, ws) : undefined
});

const result = (eligible, reason = null) => ({ eligible, reason, message: reason ? MESSAGES[reason] : null });

// ctx: { client?, cutoverEnabled?, workDateValid? }
//  - cutoverEnabled overrides the environment flag (tests).
//  - workDateValid === false marks the PO/dispatch validity check failed (contract P).
export function evaluateEligibility(ws, ctx = {}) {
  const cutover = ctx.cutoverEnabled ?? eligibilityCutoverEnabled();
  if (!cutover) {
    // Flag off: exactly today's rule.
    return ws?.status === STATUS_HISTORICAL_APPROVED ? result(true) : result(false, INELIGIBLE.NOT_ELIGIBLE_STATE);
  }
  if (!ws) return result(false, INELIGIBLE.NOT_ELIGIBLE_STATE);
  if (ws.superseded_by) return result(false, INELIGIBLE.SUPERSEDED);
  if (ws.duplicate_conflict && ws.duplicate_conflict.resolved_at == null) return result(false, INELIGIBLE.DUPLICATE_CONFLICT);
  if (ctx.workDateValid === false) return result(false, INELIGIBLE.OUT_OF_VALIDITY);
  // Declaration evidence applies to Timesheets that carry it (version 2). Historical
  // pre-v2 Supervisor_Approved records stay eligible exactly as before.
  if (isTimesheetV2(ws) && employeeSignoffMissing(ws).length > 0) return result(false, INELIGIBLE.NO_DECLARATION);

  switch (ws.status) {
    case STATUS_HISTORICAL_APPROVED:
      return result(true);
    case STATUS_CAPTURED_FROM_PAPER:
      return ws.paper_evidence?.complete === true ? result(true) : result(false, INELIGIBLE.PAPER_EVIDENCE_INCOMPLETE);
    case STATUS_CLIENT_CONFIRMED: {
      const cutoverDate = ctx.client?.timesheet_cutover_date;
      if (!isIsoDate(cutoverDate)) return result(false, INELIGIBLE.NO_CLIENT_CUTOVER);
      const ackDay = String(ws.client_acknowledgement?.acknowledged_at || "").slice(0, 10);
      if (!isIsoDate(ackDay) || ackDay < cutoverDate) return result(false, INELIGIBLE.PRE_CUTOVER_ACKNOWLEDGEMENT);
      if (ws.client_acknowledgement?.authority_snapshot?.active !== true) return result(false, INELIGIBLE.NO_AUTHORITY_SNAPSHOT);
      return result(true);
    }
    default:
      return result(false, INELIGIBLE.NOT_ELIGIBLE_STATE);
  }
}

export const isEligibleDailySource = (ws, ctx) => evaluateEligibility(ws, ctx).eligible;

// Convenience for consumers that hold the db: resolves the owning client for you.
export const evaluateForDb = (db, ws) => evaluateEligibility(ws, eligibilityContext(db, ws));
export const isEligibleForDb = (db, ws) => evaluateForDb(db, ws).eligible;

// A Client_Acknowledged record still waiting on the legacy Supervisor drain.
// Flag off: every Client_Acknowledged record (today's behaviour). Flag on: only
// pre-cutover acknowledgements; a post-cutover confirmation is not a Supervisor task.
export function awaitsSupervisorReview(db, ws) {
  if (ws?.status !== STATUS_CLIENT_CONFIRMED) return false;
  if (!eligibilityCutoverEnabled()) return true;
  const { reason, eligible } = evaluateForDb(db, ws);
  return !eligible && (reason === INELIGIBLE.NO_CLIENT_CUTOVER || reason === INELIGIBLE.PRE_CUTOVER_ACKNOWLEDGEMENT);
}
