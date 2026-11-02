import { V5_MASTER_FLAG } from "../../src/v5CommercialWorkflow.js";

export const HEX64 = "a".repeat(64);

export function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

export function withV5(callback, enabled = true) {
  const prior = process.env[V5_MASTER_FLAG];
  if (enabled) process.env[V5_MASTER_FLAG] = "enabled"; else delete process.env[V5_MASTER_FLAG];
  try { return callback(); } finally { if (prior === undefined) delete process.env[V5_MASTER_FLAG]; else process.env[V5_MASTER_FLAG] = prior; }
}

export function database() {
  return {
    company_profile: { v5_commercial_policy: { client_signature_methods: ["paper_attested"] } },
    users: [
      { id: "admin-1", role: "Admin", name: "Admin", is_active: true },
      { id: "sales-1", role: "Sales", name: "Sales Owner", is_active: true },
      { id: "sales-2", role: "Sales", name: "Other Sales", is_active: true },
      { id: "ops-1", role: "Operations", name: "Operations", is_active: true },
      { id: "fin-1", role: "Finance", name: "Finance", is_active: true },
      { id: "tech-1", role: "Technician", name: "Technician One", is_active: true },
      { id: "sup-1", role: "Supervisor", name: "Assigned Supervisor", is_active: true },
      { id: "sup-2", role: "Supervisor", name: "Other Supervisor", is_active: true },
      { id: "client-1", role: "Client Viewer", name: "Client Viewer", is_active: true }
    ],
    quotes: [{ id: "quote-1", quote_number: "Q-0001-R1", v5_commercial_workflow: true, commercial_acceptance_status: "po_verified", created_by: "sales-1" }],
    quote_lines: [{ id: "line-1", quotation_id: "quote-1", description: "Labour", pricing_basis: "hourly", unit_price: 25 }],
    dispatch_cards: [{ id: "job-1", quotation_id: "quote-1", assigned_supervisor_id: "sup-1", assigned_technician_id: "tech-1" }],
    field_worksheets: [sheet()],
    v5_client_supervisor_contacts: [],
    v5_paper_signatures: [],
    v5_supervisor_confirmations: [],
    invoices: [],
    audit_logs: []
  };
}

export function sheet(overrides = {}) {
  return {
    id: "ws-1", dispatch_card_id: "job-1", technician_id: "tech-1", worker_name: "Technician One", worker_type: "technician",
    work_date: "2026-10-05", activity: "Repair work completed", timesheet_version: 2,
    hours_breakdown: { normal: 8, ot_15: 1, ot_20: 0 }, hours: 9, quote_line_id: "line-1", status: "Submitted",
    created_by: "tech-1", submitted_by: "tech-1", ...overrides
  };
}

export function request(db, userId, { params = {}, body = {} } = {}) {
  let counter = 0;
  return {
    user: userId ? { id: userId } : undefined, params, body, db,
    store: {
      id(prefix) { counter += 1; return `${prefix}-${db.audit_logs.length}-${db.v5_paper_signatures.length}-${db.v5_supervisor_confirmations.length}-${counter}`; },
      audit(_db, actor, entityType, entityId, action, oldValues, newValues) {
        db.audit_logs.push({ actor_id: actor?.id, entity_type: entityType, entity_id: entityId, action, old_values: oldValues ? JSON.parse(JSON.stringify(oldValues)) : null, new_values: newValues ? JSON.parse(JSON.stringify(newValues)) : null });
      }
    }
  };
}

export function call(handler, db, userId, options) {
  const res = response();
  handler(request(db, userId, options), res);
  return res;
}

export const contactBody = (overrides = {}) => ({ name: "Chipo Dube", title: "Site Supervisor", phone: "+263 77 000 0000", source_reference: "Client PO 4500-1 cover email", ...overrides });

export const paperBody = (contactId, overrides = {}) => ({
  client_supervisor_contact_id: contactId, worker_name_on_paper: "Technician One", client_supervisor_name_on_paper: "Chipo Dube",
  worker_signed_on_paper: true, client_supervisor_signed_on_paper: true, paper_attestation: true,
  evidence_reference: "BOX-14/2026-10-05", source_channel: "hand_delivered", custodian_user_id: "ops-1", received_date: "2026-10-06", scan_hash: HEX64,
  ...overrides
});
