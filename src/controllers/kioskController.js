import { requirePermission } from "../permissions.js";

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
  for (const worksheet of db.field_worksheets || []) {
    if (worksheet.dispatch_card_id === dispatch.id && worksheet.technician_id) ids.add(worksheet.technician_id);
  }
  return ids;
}

export function getKioskRoster(req, res) {
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
  const actor = getActor(req);
  requirePermission(actor, "submitKioskTimesheets");
  const dispatch = getDispatch(req, res);
  if (!dispatch) return;

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
      entry_source: "kiosk"
    };
    req.db.timesheets.push(timesheet);
    req.store.audit(req.db, actor, "timesheet", timesheet.id, "KIOSK_TIMESHEET_ADDED", null, timesheet);
    return timesheet;
  });

  req.store.recalculateVariance(req.db, dispatch.purchase_order_id);
  req.store.audit(req.db, actor, "kiosk_batch", dispatch.id, "KIOSK_TIMESHEET_BATCH_SUBMITTED", null, {
    work_date: req.body.work_date,
    entry_count: created.length,
    timesheet_ids: created.map((entry) => entry.id)
  });
  res.json({ success: true, data: { entries: created } });
}
