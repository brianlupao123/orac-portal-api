import { requirePermission, roles } from "../permissions.js";
import { dispatchHasActiveInvoice, INVOICED_DISPATCH_MESSAGE } from "../dispatchFreeze.js";
import { isAssignedToDispatch } from "./dispatchController.js";
import {
  KIOSK_REVIEW_STATUS, isKioskEntry, kioskReviewStatus, timesheetCountsAsApproved, reviewBlockedReason
} from "../timesheetReview.js";

// Task 03: read and review kiosk Timesheet entries.
//
// Rate-blind by design: none of these responses carries hourly_rate or any
// cost, for any role. Rates belong to the controlled-rates work, not to the
// field-review screens.

function getActor(req) {
  return req.db.users.find((user) => user.id === req.user.id);
}

function userName(db, id) {
  return id ? (db.users.find((user) => user.id === id)?.name || null) : null;
}

export function timesheetView(db, entry) {
  const technicianId = entry.technician_id || entry.user_id || null;
  const dispatch = db.dispatch_cards.find((item) => item.id === entry.dispatch_card_id);
  const kiosk = isKioskEntry(entry);
  return {
    id: entry.id,
    dispatch_card_id: entry.dispatch_card_id,
    dispatch_number: dispatch?.dispatch_number || null,
    technician_id: technicianId,
    technician_name: userName(db, technicianId),
    technician_trade: entry.technician_trade || null,
    work_date: entry.work_date || null,
    hours_logged: entry.hours_logged,
    hours_breakdown: entry.hours_breakdown || null,
    notes: entry.notes || "",
    entry_source: entry.entry_source || "direct",
    source_worksheet_id: entry.source_worksheet_id || null,
    recorded_by_user_id: entry.recorded_by_user_id || null,
    recorded_by_name: userName(db, entry.recorded_by_user_id),
    submitted_at: entry.submitted_at || null,
    review_required: kiosk,
    review_status: kiosk ? kioskReviewStatus(entry) : "not_required",
    reviewed_by: entry.reviewed_by || null,
    reviewed_by_name: userName(db, entry.reviewed_by),
    reviewed_at: entry.reviewed_at || null,
    review_comment: entry.review_comment || "",
    counts_as_approved: timesheetCountsAsApproved(entry),
    // Set only while a kiosk entry is pending and nobody can review it.
    review_blocked_reason: kiosk && kioskReviewStatus(entry) === KIOSK_REVIEW_STATUS.PENDING ? reviewBlockedReason(db, dispatch) : null
  };
}

function newestFirst(a, b) {
  return String(b.work_date || "").localeCompare(String(a.work_date || "")) ||
    String(b.submitted_at || "").localeCompare(String(a.submitted_at || ""));
}

// GET /dispatch_cards/:id/timesheets[?work_date=YYYY-MM-DD]
// Assigned scope only; a Technician sees only their own entries.
export function listDispatchTimesheets(req, res) {
  const actor = getActor(req);
  requirePermission(actor, "viewDispatchTimesheets");
  const dispatch = req.db.dispatch_cards.find((item) => item.id === req.params.id);
  if (!dispatch) return res.status(404).json({ success: false, message: "Dispatch card not found." });
  if (!isAssignedToDispatch(actor, dispatch, req.db)) {
    return res.status(403).json({ success: false, message: "This role may work only on an assigned dispatch." });
  }

  const workDate = req.query?.work_date;
  const data = (req.db.timesheets || [])
    .filter((entry) => entry.dispatch_card_id === dispatch.id)
    .filter((entry) => actor.role !== roles.TECHNICIAN || (entry.technician_id || entry.user_id) === actor.id)
    .filter((entry) => !workDate || entry.work_date === workDate)
    .map((entry) => timesheetView(req.db, entry))
    .sort(newestFirst);
  res.json({ success: true, data });
}

// GET /timesheets/kiosk-review[?status=pending_review|approved|rejected|all]
// Supervisor: kiosk entries on dispatches they are assigned to. Admin and
// Operations: read-only view of every kiosk entry (they cannot decide).
export function listKioskReviewQueue(req, res) {
  const actor = getActor(req);
  requirePermission(actor, "viewKioskTimesheetReview");
  const status = req.query?.status || KIOSK_REVIEW_STATUS.PENDING;
  if (status !== "all" && !Object.values(KIOSK_REVIEW_STATUS).includes(status)) {
    return res.status(400).json({ success: false, message: "status must be pending_review, approved, rejected or all." });
  }

  const data = (req.db.timesheets || [])
    .filter(isKioskEntry)
    .filter((entry) => status === "all" || kioskReviewStatus(entry) === status)
    .filter((entry) => {
      const dispatch = req.db.dispatch_cards.find((item) => item.id === entry.dispatch_card_id);
      return dispatch && isAssignedToDispatch(actor, dispatch, req.db);
    })
    .map((entry) => ({ ...timesheetView(req.db, entry), can_review: canDecide(actor, entry, req.db) }))
    .sort(newestFirst)
    .slice(0, 500);
  res.json({ success: true, data });
}

function canDecide(actor, entry, db) {
  if (actor.role !== roles.SUPERVISOR) return false;
  if (kioskReviewStatus(entry) !== KIOSK_REVIEW_STATUS.PENDING) return false;
  if (entry.recorded_by_user_id === actor.id || (entry.technician_id || entry.user_id) === actor.id) return false;
  const dispatch = db.dispatch_cards.find((item) => item.id === entry.dispatch_card_id);
  return Boolean(dispatch) && isAssignedToDispatch(actor, dispatch, db) && !dispatchHasActiveInvoice(db, dispatch);
}

// POST /timesheets/:id/review  { decision: "approve" | "reject", comment }
// Assigned Supervisor only. Pending -> approved | rejected; both are terminal
// (a correction is a new kiosk entry). Reject requires a comment.
export function reviewKioskTimesheet(req, res) {
  const actor = getActor(req);
  requirePermission(actor, "reviewKioskTimesheet");

  const entry = (req.db.timesheets || []).find((item) => item.id === req.params.id);
  if (!entry) return res.status(404).json({ success: false, message: "Timesheet entry not found." });
  if (!isKioskEntry(entry)) {
    return res.status(400).json({ success: false, message: "Only kiosk-entered timesheet entries are reviewed here." });
  }
  const dispatch = req.db.dispatch_cards.find((item) => item.id === entry.dispatch_card_id);
  if (!dispatch) return res.status(404).json({ success: false, message: "Dispatch card not found." });
  if (!isAssignedToDispatch(actor, dispatch, req.db)) {
    return res.status(403).json({ success: false, message: "This role may work only on an assigned dispatch." });
  }
  if (dispatchHasActiveInvoice(req.db, dispatch)) {
    return res.status(409).json({ success: false, message: INVOICED_DISPATCH_MESSAGE });
  }

  const { decision, comment } = req.body || {};
  if (decision !== "approve" && decision !== "reject") {
    return res.status(400).json({ success: false, message: "Decision must be approve or reject." });
  }
  const note = String(comment || "").trim();
  if (decision === "reject" && !note) {
    return res.status(400).json({ success: false, message: "Rejecting a kiosk timesheet entry requires a comment." });
  }
  if (entry.recorded_by_user_id === actor.id || (entry.technician_id || entry.user_id) === actor.id) {
    return res.status(403).json({ success: false, message: "You cannot review a kiosk entry you recorded or that is your own time." });
  }
  const current = kioskReviewStatus(entry);
  if (current !== KIOSK_REVIEW_STATUS.PENDING) {
    return res.status(409).json({ success: false, message: `This kiosk entry is already ${current}. Submit a corrected kiosk entry instead.` });
  }

  const before = { ...entry };
  entry.review_status = decision === "approve" ? KIOSK_REVIEW_STATUS.APPROVED : KIOSK_REVIEW_STATUS.REJECTED;
  entry.reviewed_by = actor.id;
  entry.reviewed_at = new Date().toISOString();
  entry.review_comment = note;

  req.store.audit(req.db, actor, "timesheet", entry.id, decision === "approve" ? "KIOSK_TIMESHEET_APPROVED" : "KIOSK_TIMESHEET_REJECTED", before, entry);
  req.store.recalculateVariance(req.db, dispatch.purchase_order_id);
  res.json({ success: true, data: timesheetView(req.db, entry) });
}
