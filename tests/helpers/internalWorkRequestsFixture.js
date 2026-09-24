// Shared fixture for the Internal Work Requests tests. No I/O and no network.
// The store stub exposes ONLY id() and audit(): any other store call throws,
// which proves the controller never reaches for anything else.

export const ROLE_USER = {
  Admin: "u_admin", Management: "u_management", Sales: "u_sales", Finance: "u_finance",
  Operations: "u_ops", Technician: "u_tech", Supervisor: "u_supervisor", "Client Viewer": "u_client_a"
};
export const ALL_ROLES = Object.keys(ROLE_USER);

export function makeDb() {
  const person = (id, role, extra = {}) => ({ id, name: `${id} name`, email: `${id}@example.test`, role, is_active: true, ...extra });
  return {
    users: [
      person("u_admin", "Admin"), person("u_admin2", "Admin"),
      person("u_management", "Management"), person("u_management2", "Management"),
      person("u_sales", "Sales"), person("u_sales2", "Sales"),
      person("u_finance", "Finance"), person("u_finance2", "Finance"),
      person("u_ops", "Operations"), person("u_ops2", "Operations"), person("u_ops_off", "Operations", { is_active: false }),
      person("u_tech", "Technician"), person("u_tech2", "Technician"),
      person("u_supervisor", "Supervisor"), person("u_supervisor2", "Supervisor"),
      person("u_client_a", "Client Viewer", { client_id: "c_a" }),
      person("u_client_b", "Client Viewer", { client_id: "c_b" })
    ],
    clients: [{ id: "c_a", name: "Client A" }, { id: "c_b", name: "Client B" }],
    quotes: [
      { id: "q_a", quote_number: "Q-0001", client_id: "c_a", status: "Sent", total_amount: 1000 },
      { id: "q_b", quote_number: "Q-0002", client_id: "c_b", status: "Sent", total_amount: 2000 }
    ],
    quote_lines: [{ id: "ql_1", quotation_id: "q_a", description: "Liner", quantity: 2, unit_price: 500 }],
    purchase_orders: [
      { id: "po_a", quotation_id: "q_a", po_reference: "PO-A", po_amount: 1000, status: "verified", requires_amendment: true },
      { id: "po_b", quotation_id: "q_b", po_reference: "PO-B", po_amount: 2000, status: "verified", requires_amendment: false }
    ],
    dispatch_cards: [
      { id: "job_a", quotation_id: "q_a", purchase_order_id: "po_a", dispatch_number: "JOB-0001", status: "active", assigned_technician_id: "u_tech", assigned_supervisor_id: "u_supervisor" },
      { id: "job_b", quotation_id: "q_b", purchase_order_id: "po_b", dispatch_number: "JOB-0002", status: "active", assigned_technician_id: "u_tech2", assigned_supervisor_id: "u_supervisor2" }
    ],
    field_worksheets: [], timesheets: [{ id: "ts_1", dispatch_card_id: "job_a", hours_logged: 4, hourly_rate: 45 }],
    material_usage: [{ id: "mu_1", dispatch_card_id: "job_a", total_cost: 120 }],
    invoices: [{ id: "inv_a", invoice_number: "INV-0001", dispatch_card_id: "job_a", purchase_order_id: "po_a", total_amount: 1000, status: "sent" }],
    invoice_lines: [],
    stock_items: [
      { id: "si_1", item_code: "RUB-LINING", item_name: "Rubber Lining", quantity_on_hand: 30, reorder_level: 15 },
      { id: "si_archived", item_code: "OLD", item_name: "Old item", quantity_on_hand: 1, reorder_level: 0, is_active: false }
    ],
    stock_movements: [], suppliers: [], leads: [], mine_sites: [], plants: [], plant_sections: [], equipment_tags: [],
    notifications: [], audit_logs: [], internal_work_requests: []
  };
}

export function makeStore(db, { failOnAuditCall } = {}) {
  let counter = 0;
  let audits = 0;
  return {
    id: (prefix) => `${prefix}_${++counter}`,
    audit(target, actor, entityType, entityId, action, oldValues, newValues) {
      audits += 1;
      if (failOnAuditCall === audits) throw new Error("audit hook failure");
      target.audit_logs.push({ actor_id: actor?.id, entity_type: entityType, entity_id: entityId, action, old_values: oldValues, new_values: newValues });
    }
  };
}

export function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

export function run(handler, db, store, userId, { body, params, query } = {}) {
  const res = response();
  handler({ db, store, user: { id: userId }, body, params: params || {}, query: query || {} }, res);
  return res;
}

// Every collection a request must never touch, serialised for before/after comparison.
const UNTOUCHABLE = ["quotes", "quote_lines", "purchase_orders", "dispatch_cards", "field_worksheets", "timesheets", "material_usage",
  "invoices", "invoice_lines", "stock_items", "stock_movements", "suppliers", "leads", "clients", "users", "notifications"];
export const snapshotUntouchable = (db) => JSON.stringify(Object.fromEntries(UNTOUCHABLE.map((key) => [key, db[key]])));

export const RELATED_ID = { quote: "q_a", purchase_order: "po_a", dispatch_card: "job_a", invoice: "inv_a", stock_item: "si_1" };

export const RECORD_KEYS = [
  "acknowledged_at", "assigned_to_user_id", "client_id", "created_at", "created_by_role", "created_by_user_id", "description", "history",
  "id", "priority", "recipient_role", "related_entity_id", "related_entity_type", "request_type", "resolution_note", "resolved_at",
  "resolved_by_user_id", "status", "subject", "updated_at"
];

// A valid create body for (type, recipient), given the related types the SENDER may use.
export function validBody(type, recipient, relatedType, extra = {}) {
  const body = { request_type: type, subject: "Need confirmation", description: "Please confirm the position.", recipient_role: recipient, ...extra };
  if (relatedType) { body.related_entity_type = relatedType; body.related_entity_id = RELATED_ID[relatedType]; }
  return body;
}

// Seeds one request straight into the collection (bypassing the controller) for state-specific tests.
export function seedRequest(db, overrides = {}) {
  const n = db.internal_work_requests.length + 1;
  const record = {
    id: `iwr_seed_${n}`, request_type: "STOCK_AVAILABILITY", subject: "Seed", description: "Seed description", priority: "Normal",
    status: "Submitted", created_by_user_id: "u_sales", created_by_role: "Sales", recipient_role: "Operations",
    assigned_to_user_id: null, acknowledged_at: null, related_entity_type: "quote", related_entity_id: "q_a", client_id: "c_a",
    resolution_note: null, resolved_by_user_id: null,
    history: [{ at: "2026-09-20T08:00:00.000Z", actor_user_id: "u_sales", actor_role: "Sales", action: "submit", from_status: null, to_status: "Submitted", note: "" }],
    created_at: `2026-09-2${n}T08:00:00.000Z`, updated_at: `2026-09-2${n}T08:00:00.000Z`, resolved_at: null, ...overrides
  };
  db.internal_work_requests.push(record);
  return record;
}
