import { requirePermission } from "../permissions.js";
import { kioskBlocked } from "../timesheetWorkflow.js";
import { dispatchHasActiveInvoice, INVOICED_DISPATCH_MESSAGE } from "../dispatchFreeze.js";
import { KIOSK_REVIEW_STATUS, isKioskEntry, kioskReviewStatus } from "../timesheetReview.js";
import { createHash } from "node:crypto";

function getActor(req) {
  return req.db.users.find((user) => user.id === req.user.id);
}

function getDispatch(req, res) {
  const dispatch = req.db.dispatch_cards.find((item) => item.id === req.params.id);
  if (!dispatch) {
    res.status(404).json({ success: false, message: "Dispatch card not found." });
    return null;
  }
  return dispatch;
}

function rosterIds(db, dispatch) {
  const ids = new Set();
  if (dispatch.assigned_technician_id) ids.add(dispatch.assigned_technician_id);
  for (const id of dispatch.assigned_technician_ids || []) ids.add(id);
  for (const worksheet of db.field_worksheets || []) {
    if (worksheet.dispatch_card_id === dispatch.id && worksheet.technician_id) ids.add(worksheet.technician_id);
  }
  return ids;
}

// ---- Cross-batch retry / duplicate protection (owner decision D-K3) ----
// Two different situations, handled differently:
//  1. Network retry of the SAME submission: the client sends the same
//     batch_key with the same content. We return the original result and create
//     nothing (idempotent replay). Same key with different content is a 409.
//  2. Accidental re-entry in a NEW batch: a non-rejected kiosk row already exists
//     for the same dispatch + technician + date + hours + shift + notes +
//     breakdown. That is refused with 409. A genuinely separate shift is still
//     accepted: give it a different shift label, different hours, or a different
//     note. A rejected row never blocks its own correction.
// A technician's non-rejected kiosk hours for one date may never exceed 24.
const MAX_DAILY_KIOSK_HOURS = 24;

function normText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function entryFingerprint(dispatchId, workDate, entry) {
  const b = entry.hours_breakdown || {};
  return [dispatchId, entry.technician_id, workDate, Number(entry.hours_logged),
    normText(entry.shift), normText(entry.notes),
    Number(b.normal || 0), Number(b.ot_1_5 || 0), Number(b.ot_2_0 || 0)].join("|");
}

function batchHash(dispatchId, body) {
  const entries = [...body.entries]
    .map((entry) => entryFingerprint(dispatchId, body.work_date, entry))
    .sort();
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function storedFingerprint(row) {
  return row.fingerprint || entryFingerprint(row.dispatch_card_id, row.work_date, {
    technician_id: row.technician_id, hours_logged: row.hours_logged, shift: row.shift, notes: row.notes,
    hours_breakdown: row.hours_breakdown
  });
}

export function getKioskRoster(req, res) {
  if (kioskBlocked(req.db)) return res.status(409).json({ success: false, code: "KIOSK_RESTRICTED", message: "Kiosk Mode is restricted for this deployment." });
  const actor = getActor(req);
  requirePermission(actor, "submitKioskTimesheets");
  const dispatch = getDispatch(req, res);
  if (!dispatch) return;

  const technicians = req.db.users
    .filter((user) => user.is_active && user.role === "Technician" && rosterIds(req.db, dispatch).has(user.id))
    .map(({ id, name, email, trade }) => ({ id, name, email, trade: trade || null }));

  res.json({ success: true, data: { dispatch: { id: dispatch.id, dispatch_number: dispatch.dispatch_number, status: dispatch.status }, technicians } });
}

export function submitKioskTimesheets(req, res) {
  if (kioskBlocked(req.db)) return res.status(409).json({ success: false, code: "KIOSK_RESTRICTED", message: "Kiosk Mode is restricted for this deployment." });
  const actor = getActor(req);
  requirePermission(actor, "submitKioskTimesheets");
  const dispatch = getDispatch(req, res);
  if (!dispatch) return;
  if (dispatchHasActiveInvoice(req.db, dispatch)) return res.status(409).json({ success: false, message: INVOICED_DISPATCH_MESSAGE });

  const batchKey = req.body.batch_key ? String(req.body.batch_key) : null;
  const payloadHash = batchHash(dispatch.id, req.body);
  if (batchKey) {
    const prior = (req.db.timesheets || []).filter((row) => isKioskEntry(row) &&
      row.dispatch_card_id === dispatch.id && row.recorded_by_user_id === actor.id && row.batch_key === batchKey);
    if (prior.length > 0) {
      if (prior[0].batch_payload_hash !== payloadHash) {
        return res.status(409).json({ success: false, message: "This submission reference was already used with different time entries. Start a new submission." });
      }
      return res.json({ success: true, data: { entries: prior, review_status: KIOSK_REVIEW_STATUS.PENDING, replayed: true } });
    }
  }

  const allowedTechnicians = rosterIds(req.db, dispatch);
  const submitted = new Set();
  for (const entry of req.body.entries) {
    if (submitted.has(entry.technician_id)) {
      return res.status(400).json({ success: false, message: "A technician can appear only once in a kiosk batch." });
    }
    submitted.add(entry.technician_id);
    if (!allowedTechnicians.has(entry.technician_id)) {
      return res.status(403).json({ success: false, message: "Every kiosk time entry must belong to a technician assigned to this dispatch." });
    }
  }

  const liveKiosk = (req.db.timesheets || []).filter((row) => isKioskEntry(row) && kioskReviewStatus(row) !== KIOSK_REVIEW_STATUS.REJECTED);
  const existingByFingerprint = new Map();
  for (const row of liveKiosk.filter((item) => item.dispatch_card_id === dispatch.id)) existingByFingerprint.set(storedFingerprint(row), row);
  for (const entry of req.body.entries) {
    const clash = existingByFingerprint.get(entryFingerprint(dispatch.id, req.body.work_date, entry));
    if (clash) {
      const name = req.db.users.find((user) => user.id === entry.technician_id)?.name || "this technician";
      return res.status(409).json({
        success: false,
        message: `Possible duplicate: ${name} already has an identical kiosk entry for ${req.body.work_date} (${clash.id}, ${kioskReviewStatus(clash)}). If this is a genuinely separate shift, give it a different shift label, hours or note.`,
        duplicate_of: clash.id
      });
    }
    const dayTotal = liveKiosk
      .filter((row) => (row.technician_id || row.user_id) === entry.technician_id && row.work_date === req.body.work_date)
      .reduce((sum, row) => sum + Number(row.hours_logged || 0), 0);
    if (dayTotal + Number(entry.hours_logged) > MAX_DAILY_KIOSK_HOURS) {
      return res.status(400).json({ success: false, message: `Kiosk hours for this technician on ${req.body.work_date} would total ${dayTotal + Number(entry.hours_logged)}, above the ${MAX_DAILY_KIOSK_HOURS}-hour daily limit.` });
    }
  }

  const submittedAt = new Date().toISOString();
  const created = req.body.entries.map((entry) => {
    const technician = req.db.users.find((user) => user.id === entry.technician_id);
    const timesheet = {
      id: req.store.id("ts"),
      dispatch_card_id: dispatch.id,
      technician_id: entry.technician_id,
      technician_trade: technician?.trade || null,
      user_id: entry.technician_id,
      recorded_by_user_id: actor.id,
      work_date: req.body.work_date,
      hours_logged: entry.hours_logged,
      hourly_rate: entry.hourly_rate,
      notes: String(entry.notes || "").trim(),
      entry_source: "kiosk",
      shift: String(entry.shift || "").trim() || null,
      batch_key: batchKey,
      batch_payload_hash: batchKey ? payloadHash : null,
      // Owner rule: kiosk entries need Supervisor review before they count.
      review_status: KIOSK_REVIEW_STATUS.PENDING,
      submitted_at: submittedAt,
      reviewed_by: null,
      reviewed_at: null,
      review_comment: ""
    };
    timesheet.fingerprint = entryFingerprint(dispatch.id, req.body.work_date, { ...entry, notes: timesheet.notes });
    // Evidence-only record of what the crew reported; billing never reads it.
    if (entry.hours_breakdown) timesheet.hours_breakdown = { ...entry.hours_breakdown };
    req.db.timesheets.push(timesheet);
    req.store.audit(req.db, actor, "timesheet", timesheet.id, "KIOSK_TIMESHEET_ADDED", null, timesheet);
    return timesheet;
  });

  req.store.recalculateVariance(req.db, dispatch.purchase_order_id);
  req.store.audit(req.db, actor, "kiosk_batch", dispatch.id, "KIOSK_TIMESHEET_BATCH_SUBMITTED", null, {
    work_date: req.body.work_date,
    entry_count: created.length,
    review_status: KIOSK_REVIEW_STATUS.PENDING,
    timesheet_ids: created.map((entry) => entry.id)
  });
  res.json({ success: true, data: { entries: created, review_status: KIOSK_REVIEW_STATUS.PENDING } });
}
