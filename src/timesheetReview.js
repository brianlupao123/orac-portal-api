// Task 03 - kiosk Timesheet review gate.
//
// Owner-confirmed rule: kiosk-entered Timesheet entries require Supervisor
// review. Until an assigned Supervisor approves an entry it does NOT count as
// approved hours: not in PO variance, not in an invoice, not in the Pastel
// export. Non-kiosk entries (worksheet-evidenced or legacy) are unaffected.
//
// Deliberately rate-agnostic: nothing here reads, writes or returns a rate.

export const KIOSK_REVIEW_STATUS = Object.freeze({
  PENDING: "pending_review",
  APPROVED: "approved",
  REJECTED: "rejected"
});

export function isKioskEntry(entry) {
  return entry?.entry_source === "kiosk";
}

// A kiosk entry with no (or an unknown) review_status is PENDING: fail closed,
// so rows created before this gate existed cannot silently count as approved.
export function kioskReviewStatus(entry) {
  if (!isKioskEntry(entry)) return null;
  return Object.values(KIOSK_REVIEW_STATUS).includes(entry.review_status)
    ? entry.review_status
    : KIOSK_REVIEW_STATUS.PENDING;
}

export function timesheetCountsAsApproved(entry) {
  return !isKioskEntry(entry) || kioskReviewStatus(entry) === KIOSK_REVIEW_STATUS.APPROVED;
}

export function countedTimesheets(db, dispatchId) {
  return (db.timesheets || []).filter((item) => item.dispatch_card_id === dispatchId && timesheetCountsAsApproved(item));
}

export function pendingKioskTimesheets(db, dispatchId) {
  return (db.timesheets || []).filter((item) => item.dispatch_card_id === dispatchId && kioskReviewStatus(item) === KIOSK_REVIEW_STATUS.PENDING);
}

// Same formula the system already used (hours x stored value), restricted to
// entries that count as approved.
export function approvedLabourValue(db, dispatchIds) {
  const ids = dispatchIds instanceof Set ? dispatchIds : new Set(dispatchIds);
  return (db.timesheets || [])
    .filter((item) => ids.has(item.dispatch_card_id) && timesheetCountsAsApproved(item))
    .reduce((sum, item) => sum + Number(item.hours_logged || 0) * Number(item.hourly_rate || 0), 0);
}

// ---- Supervisor availability (owner decision D-K1) ----
// Review is Supervisor-only. There is NO Admin/Operations approval bypass. When a
// dispatch has no active Supervisor, entries stay pending and the API reports a
// clear blocked reason; Admin/Operations resolve it by assigning a Supervisor.
export function dispatchSupervisors(db, dispatch) {
  const ids = new Set([dispatch?.assigned_supervisor_id, dispatch?.supervisor_id].filter(Boolean));
  for (const worksheet of db.field_worksheets || []) {
    if (worksheet.dispatch_card_id === dispatch?.id && worksheet.supervisor_id) ids.add(worksheet.supervisor_id);
  }
  return (db.users || []).filter((user) => ids.has(user.id) && user.role === "Supervisor" && user.is_active !== false);
}

export const NO_SUPERVISOR_REASON = "No active Supervisor is assigned to this dispatch, so these entries cannot be reviewed yet. Operations or Admin must assign a Supervisor to the dispatch.";

export function reviewBlockedReason(db, dispatch) {
  return dispatchSupervisors(db, dispatch).length === 0 ? NO_SUPERVISOR_REASON : null;
}
