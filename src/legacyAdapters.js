// Compatibility adapters: present LEGACY records (Daily Time Sheets, Contractor
// Logs, and Timesheets recorded before Normal / 1.5 / 2.0 existed) in the one
// Timesheet shape, READ-ONLY. Nothing here writes or deletes: history is kept
// exactly as it was, and the legacy routes keep returning the original records.
import { isTimesheetV2 } from "./timesheetModel.js";

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export function legacyTimesheetViews(db) {
  const out = [];
  for (const sheet of db.daily_timesheets || []) {
    (sheet.entries || []).forEach((row, index) => {
      if (!row || row.kind === "separator") return;
      out.push({
        legacy_kind: "daily_timesheet", legacy_label: "Daily Time Sheet", record_id: sheet.id, row_index: index,
        worker_name: sheet.name_on_form || null, technician_id: sheet.technician_id || null, worker_category: sheet.category || "",
        work_date: row.date || null, activity: row.description || "", start_time: row.start_time || "", end_time: row.end_time || "",
        hours_breakdown: { normal: num(row.normal_hours), ot_15: num(row.ot_15), ot_20: num(row.ot_20) },
        status: sheet.status, department_section: sheet.department_section || "", counted_in_worksheet: sheet.status === "Supervisor_Approved" ? "history (only if no Timesheet covers the date)" : "no",
        read_only: true
      });
    });
  }
  for (const log of db.contractor_log_sheets || []) {
    (log.rows || []).forEach((row, index) => {
      if (!row || (!row.worker_name && row.normal == null)) return;
      out.push({
        legacy_kind: "contractor_log", legacy_label: "Contractor Log", record_id: log.id, row_index: index,
        worker_name: row.worker_name || null, technician_id: null, worker_category: row.grade || "", contractor_name: log.contractor_name || "",
        work_date: log.log_date || null, activity: log.work_description || "", start_time: "", end_time: "",
        hours_breakdown: { normal: num(row.normal), ot_15: num(row.ot_15), ot_20: num(row.ot_20) },
        status: log.status, department_section: log.department_section || "",
        counted_in_worksheet: log.status === "Supervisor_Approved" && row.worker_name && log.log_date ? "history (only if no Timesheet or Daily Time Sheet covers the date)" : "evidence only",
        read_only: true
      });
    });
  }
  for (const ws of db.field_worksheets || []) {
    if (isTimesheetV2(ws) || ws.superseded_by) continue;
    out.push({
      legacy_kind: "timesheet_without_breakdown", legacy_label: "Timesheet (no Normal/1.5/2.0)", record_id: ws.id, row_index: 0,
      worker_name: null, technician_id: ws.technician_id || null, worker_category: ws.technician_trade || "",
      work_date: ws.work_date || null, activity: ws.activity || "", start_time: "", end_time: "",
      hours_breakdown: null, total_hours: num(ws.hours), status: ws.status, dispatch_card_id: ws.dispatch_card_id || null,
      counted_in_worksheet: "no (hours cannot be classified)", read_only: true
    });
  }
  return out.sort((a, b) => String(b.work_date || "").localeCompare(String(a.work_date || "")) || a.record_id.localeCompare(b.record_id) || a.row_index - b.row_index);
}
