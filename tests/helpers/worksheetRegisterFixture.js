// Fictional fixture data only. No real company, employee or rate data.
export function makeRes() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

export function makeStore() {
  let counter = 0;
  return {
    id(prefix) { counter += 1; return `${prefix}_${counter}`; },
    audit(db, actor, entityType, entityId, action, oldValues, newValues) {
      db.audit_logs.push({ actor_id: actor?.id, entity_type: entityType, entity_id: entityId, action, old_values: oldValues, new_values: newValues });
    }
  };
}

export function makeDb() {
  return {
    users: [
      { id: "u_tech1", role: "Technician", name: "Test Worker One", trade: "Fitter", is_active: true },
      { id: "u_tech2", role: "Technician", name: "Test Worker Two", trade: "Rigger", is_active: true },
      { id: "u_tech_off", role: "Technician", name: "Inactive Worker", is_active: false },
      { id: "u_sup", role: "Supervisor", name: "Supervisor One", is_active: true },
      { id: "u_sup2", role: "Supervisor", name: "Supervisor Two", is_active: true },
      { id: "u_ops", role: "Operations", name: "Operations One", is_active: true },
      { id: "u_ops2", role: "Operations", name: "Operations Two", is_active: true },
      { id: "u_admin", role: "Admin", name: "Admin One", is_active: true },
      { id: "u_mgmt", role: "Management", name: "Management One", is_active: true },
      { id: "u_fin", role: "Finance", name: "Finance One", is_active: true },
      { id: "u_sales", role: "Sales", name: "Sales One", is_active: true },
      { id: "u_client", role: "Client Viewer", name: "Client One", client_id: "c_test", is_active: true }
    ],
    clients: [{ id: "c_test", name: "Test Client" }, { id: "c_other", name: "Other Client" }],
    quotes: [{ id: "q_test", client_id: "c_test" }, { id: "q_other", client_id: "c_other" }],
    purchase_orders: [{ id: "po_test", quotation_id: "q_test" }],
    dispatch_cards: [{ id: "d_1", quotation_id: "q_test" }, { id: "d_2", quotation_id: "q_test" }, { id: "d_other", quotation_id: "q_other" }],
    daily_timesheets: [],
    contractor_log_sheets: [],
    worksheet_registers: [],
    field_worksheets: [],
    timesheets: [],
    invoices: [],
    audit_logs: [],
    company_profile: { company_name: "Test Company" }
  };
}

export function req(db, userId, body = {}, params = {}, store = db.__store || (db.__store = makeStore()), query = {}) {
  return { db, store, user: { id: userId }, body, params, query };
}

export const row = (date, normal, extra = {}) => ({
  kind: "entry", date, start_time: "07:00", end_time: "16:00", normal_hours: normal, ot_15: "X", ot_20: "X", description: "Fictional task", ...extra
});

let seq = 0;
export const fullSignatures = () => ({
  employee: { name: "Fictional Employee", date: "2026-09-30", method: "on_device" },
  site_foreman: { name: "Fictional Foreman", date: "2026-09-30", method: "on_device" }
});

export function addDaily(db, { id, technician_id = "u_tech1", name = "Test Worker One", status = "Supervisor_Approved", entries, department_section = "Test Section", signoff = true, signatures, customer_signoff_required = false, signed_copy_image = null }) {
  seq += 1;
  const sheet = {
    id: id || `dts_fx_${seq}`, technician_id, name_on_form: name, category: "Fitter", department_section,
    cell_number: "", entries, signatures: signatures || (signoff ? fullSignatures() : {}), signed_copy_image, customer_signoff_required, status,
    submitted_by: "u_ops", supervisor_comment: "", approved_by: status === "Supervisor_Approved" ? "u_sup" : null,
    created_by: "u_ops", created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z"
  };
  db.daily_timesheets.push(sheet);
  return sheet;
}

let tsSeq = 0;
// A version-2 Timesheet (the ONE daily source record). Defaults to fully signed off and approved.
export function addTimesheet(db, { id, technician_id = "u_tech1", worker_name = null, dispatch = "d_1", date = "2026-09-01", breakdown = { normal: 9, ot_15: 0, ot_20: 0 },
  start_time = "", end_time = "", status = "Supervisor_Approved", employee_signoff = true, client_ack = true, approved = true, superseded_by = null, activity = "Fictional task" } = {}) {
  tsSeq += 1;
  const ws = {
    id: id || `ws_fx_${tsSeq}`, timesheet_version: 2, dispatch_card_id: dispatch, technician_id, worker_name: worker_name || (technician_id ? db.users.find((u) => u.id === technician_id)?.name : null),
    worker_type: technician_id ? "technician" : "contractor", work_date: date, activity, hours_breakdown: breakdown,
    hours: breakdown.normal + breakdown.ot_15 + breakdown.ot_20, start_time, end_time, materials_used: [], status,
    signatures: employee_signoff ? { employee: { name: "Fictional Worker", date, method: "on_device", attested_by: technician_id, attested_at: "2026-09-30T00:00:00.000Z" } } : {},
    signed_copy_image: null,
    client_acknowledgement: client_ack ? { signer_name: "Fictional Client Rep", signer_role: "Engineer", acknowledged_at: "2026-09-30T00:00:00.000Z", evidence_reference: "evd_fx" } : null,
    approved_by: approved ? "u_sup" : null, approved_at: approved ? "2026-09-30T00:00:00.000Z" : null, superseded_by,
    created_by: technician_id || "u_ops", created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z"
  };
  db.field_worksheets.push(ws);
  return ws;
}

let clSeq = 0;
export function addContractorLog(db, { id, log_date = "2026-09-01", status = "Supervisor_Approved", rows, department_section = "Test Section", signatures, contractor_name = "Fictional Contractor Ltd" }) {
  clSeq += 1;
  const log = {
    id: id || `cls_fx_${clSeq}`, contractor_name, department_section, section: "", order_no: "", log_date, work_description: "Fictional work",
    rows, signatures: signatures || { foreman: { name: "Fictional Foreman", date: log_date }, supervisor: { name: "", date: "" } },
    status, supervisor_comment: "", created_by: "u_ops", created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z"
  };
  db.contractor_log_sheets.push(log);
  return log;
}
export const clRow = (worker_name, normal, extra = {}) => ({ worker_name, grade: "Artisan", normal, ot_15: null, ot_20: null, comments: "", ...extra });

export const baseBody = (over = {}) => ({
  title: "Fictional Shutdown - September 2026",
  period_start: "2026-08-31",
  period_end: "2026-09-30",
  scope: { client_id: "c_test", project_title: "Fictional Shutdown", department_section: "" },
  roster: [{ technician_id: "u_tech1", group: "Fitters" }, { technician_id: "u_tech2", group: "Riggers" }],
  ...over
});
