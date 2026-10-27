import assert from "node:assert/strict";
import test from "node:test";
import { buildQuoteTrail, buildInvoiceAnalysis, buildPurchaseOrderAnalysis, buildSupplierAnalysis, buildMaintenanceScheduleAnalysis, buildEquipmentTagAnalysis, buildMaterialUsageAnalysis, buildFieldWorksheetAnalysis, buildDailyTimesheetAnalysis, buildContractorLogAnalysis, buildCatalogItemAnalysis, buildStockItemAnalysis, buildWorksheetRegisterAnalysis, buildServiceRequestAnalysis, validateLeadLink, TRAIL_FLAG } from "../src/recordTrail.js";
import { buildValidLedgerFixture } from "./fixtures/validLedgerFixture.js";

function withFlag(value, fn) {
  const before = process.env[TRAIL_FLAG];
  if (value === undefined) delete process.env[TRAIL_FLAG]; else process.env[TRAIL_FLAG] = value;
  try { return fn(); } finally {
    if (before === undefined) delete process.env[TRAIL_FLAG]; else process.env[TRAIL_FLAG] = before;
  }
}

const users = {
  admin: { id: "u_admin", role: "Admin", is_active: true },
  management: { id: "u_management", role: "Management", is_active: true },
  sales: { id: "u_sales", role: "Sales", is_active: true },
  ops: { id: "u_ops", role: "Operations", is_active: true },
  fin: { id: "u_fin", role: "Finance", is_active: true },
  client: { id: "u_client", role: "Client Viewer", client_id: "c_a", is_active: true },
  tech: { id: "u_tech", role: "Technician", is_active: true }
};

function database() {
  return {
    users: Object.values(users),
    leads: [
      { id: "lead_1", company_name: "Synthetic Co", contact_name: "A Example", email: "a@example.invalid", status: "New", created_at: "2026-01-01T08:00:00.000Z" },
      { id: "lead_c_b", client_id: "c_b", status: "New", created_at: "2026-01-01T08:00:00.000Z" }
    ],
    quotes: [
      { id: "q1", quote_number: "Q-0001", client_id: "c_a", status: "Approved_Pending_PO", source_lead_id: "lead_1", created_at: "2026-01-02T08:00:00.000Z" },
      { id: "q1r", quote_number: "Q-0001-R1", client_id: "c_a", status: "Draft", root_quote_id: "q1", revision_number: 1, created_at: "2026-01-03T08:00:00.000Z" },
      { id: "q_draft", quote_number: "Q-0002", client_id: "c_a", status: "Draft", created_at: "2026-01-02T09:00:00.000Z" }
    ],
    purchase_orders: [{ id: "po1", quotation_id: "q1", status: "pending", po_reference: "PO-SYN-1", po_amount: 5 }],
    dispatch_cards: [{ id: "job1", quotation_id: "q1", dispatch_number: "JOB-0001", status: "active", assigned_technician_ids: ["x", "y"], created_at: "2026-01-05T08:00:00.000Z" }],
    audit_logs: [
      { id: "a1", actor_id: null, entity_type: "lead", entity_id: "lead_1", action: "LEAD_CREATED", created_at: "2026-01-01T08:00:00.000Z", old_values: null, new_values: { email: "a@example.invalid" } },
      { id: "a2", actor_id: "u_sales", entity_type: "quotation", entity_id: "q1", action: "QUOTE_CREATED", created_at: "2026-01-02T08:00:00.000Z", old_values: null, new_values: { total_amount: 999 } },
      { id: "a3", actor_id: "u_ops", entity_type: "lead", entity_id: "q1", action: "WRONG_PAIRING", created_at: "2026-01-02T08:30:00.000Z" }
    ]
  };
}

test("validateLeadLink: absent link is a no-op and supplied links require the opt-in flag", () => {
  withFlag(undefined, () => {
    assert.deepEqual(validateLeadLink(database(), { leadId: undefined, clientId: "c_a" }), { ok: true, leadId: null });
    const result = validateLeadLink(database(), { leadId: "lead_1", clientId: "c_a" });
    assert.equal(result.status, 409);
    assert.equal(result.code, "TRAIL_LINK_DISABLED");
  });
});

test("validateLeadLink rejects unknown and cross-client links without changing data", () => {
  withFlag("enabled", () => {
    const db = database();
    assert.equal(validateLeadLink(db, { leadId: "missing", clientId: "c_a" }).status, 404);
    assert.equal(validateLeadLink(db, { leadId: "lead_c_b", clientId: "c_a" }).status, 409);
    assert.deepEqual(validateLeadLink(db, { leadId: "lead_1", clientId: "c_a" }), { ok: true, leadId: "lead_1" });
  });
});

test("trail visibility follows existing per-collection role guards", () => {
  const db = database();
  const byStage = (actor) => buildQuoteTrail(db, "q1", actor).data.stages.map((item) => item.stage);
  assert.deepEqual(byStage(users.admin), ["lead", "quote", "po", "dispatch"]);
  assert.deepEqual(byStage(users.sales), ["lead", "quote"]);
  assert.deepEqual(byStage(users.ops), ["quote", "po", "dispatch"]);
  assert.deepEqual(byStage(users.fin), ["quote", "po"]);
  assert.equal(buildQuoteTrail(db, "q1", users.client).status, 404);
  assert.equal(buildQuoteTrail(db, "q1", users.tech).status, 404);
});

test("trail returns scoped event metadata only to roles allowed to read audit logs", () => {
  const db = database();
  const finance = buildQuoteTrail(db, "q1", users.fin).data;
  assert.deepEqual(finance.events.map((event) => event.action), ["QUOTE_CREATED"]);
  assert.equal(finance.events_truncated, false);
  assert.equal(buildQuoteTrail(db, "q1", users.sales).data.event_history.status, "not_available_to_role");
  assert.equal(buildQuoteTrail(db, "q1", users.ops).data.event_history.status, "not_available_to_role");
  const serialized = JSON.stringify(finance);
  for (const secret of ["old_values", "new_values", "a@example.invalid", "A Example", "total_amount", "po_amount"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test("trail resolves a revision to its root lead and never infers missing links", () => {
  const db = database();
  const result = buildQuoteTrail(db, "q1r", users.sales, { now: new Date("2026-02-01T00:00:00.000Z") });
  assert.equal(result.data.generated_at, "2026-02-01T00:00:00.000Z");
  assert.equal(result.data.stages.find((item) => item.stage === "lead").ref.id, "lead_1");
  delete db.quotes[0].source_lead_id;
  const missing = buildQuoteTrail(db, "q1", users.sales).data;
  assert.equal(missing.stages.find((item) => item.stage === "lead").status, "not_recorded");
  assert.ok(missing.gaps.some((gap) => gap.code === "LEAD_NOT_LINKED"));
});

test("trail flags historical unverified dispatches and never returns amounts or free-text reasons", () => {
  const db = database();
  db.dispatch_cards[0].started_before_po = true;
  db.dispatch_cards[0].urgent_reason = "synthetic private note";
  const ops = buildQuoteTrail(db, "q1", users.ops).data;
  assert.equal(ops.stages.find((item) => item.stage === "dispatch").exception, "URGENT_BEFORE_PO");
  const serialized = JSON.stringify(ops);
  assert.equal(serialized.includes("synthetic private note"), false);
  assert.equal(serialized.includes("po_amount"), false);
});

test("trail is read-only, caps event pages, and supplies an opaque cursor for older evidence", () => {
  const db = database();
  for (let index = 0; index < 250; index += 1) {
    db.audit_logs.push({
      actor_id: "u_sales",
      entity_type: "quotation",
      entity_id: "q1",
      action: `QUOTE_UPDATED_${index}`,
      created_at: new Date(Date.UTC(2026, 0, 4, 0, index)).toISOString()
    });
  }
  const before = structuredClone(db);
  const result = buildQuoteTrail(db, "q1", users.admin);
  assert.deepEqual(db, before);
  assert.equal(result.data.events.length, 200);
  assert.equal(result.data.events[0].action, "QUOTE_UPDATED_50");
  assert.equal(result.data.events.at(-1).action, "QUOTE_UPDATED_249");
  assert.equal(result.data.events_truncated, true);
  assert.equal(result.data.events_pagination.returned, 200);
  assert.equal(result.data.events_pagination.total_matching_events, 252);
  assert.equal(result.data.events_pagination.has_more, true);
  assert.equal(typeof result.data.events_pagination.next_cursor, "string");

  const older = buildQuoteTrail(db, "q1", users.admin, { eventCursor: result.data.events_pagination.next_cursor });
  assert.equal(older.ok, true);
  assert.equal(older.data.events.length, 52);
  assert.ok(older.data.events.some((event) => event.action === "QUOTE_UPDATED_0"));
  assert.equal(older.data.events.at(-1).action, "QUOTE_UPDATED_49");
  assert.deepEqual(older.data.events_pagination, { returned: 52, total_matching_events: 252, has_more: false, next_cursor: null });
  assert.equal(buildQuoteTrail(db, "q1", users.admin, { eventCursor: "not-a-cursor" }).status, 400);
});

test("invoice analysis is role-scoped, read-only, and exposes the manual settlement summary only to internal financial roles", () => {
  const db = database();
  db.invoices = [{ id: "inv1", invoice_number: "INV-SYN-1", dispatch_card_id: "job1", purchase_order_id: "po1", total_amount: 9999, status: "sent", generated_at: "2026-01-06T08:00:00.000Z", void_reason: "private reason" }];
  db.invoice_lines = [{ id: "line1", invoice_id: "inv1", description: "private line", unit_price: 777, line_total: 9999 }];
  const before = structuredClone(db);
  const finance = buildInvoiceAnalysis(db, "inv1", users.fin, { now: new Date("2026-02-01T00:00:00.000Z") });
  assert.equal(finance.ok, true);
  assert.deepEqual(finance.data.payment_assessment, "not_determined");
  assert.deepEqual(finance.data.settlement, {
    status: "recorded_manual_ledger",
    currency: "USD",
    total_amount: 9999,
    paid_amount: 0,
    credited_amount: 0,
    effective_total_amount: 9999,
    outstanding_amount: 9999,
    payment_count: 0,
    credit_note_count: 0
  });
  assert.deepEqual(finance.data.purchase_order, { id: "po1", status: "pending" });
  const serialized = JSON.stringify(finance.data);
  for (const secret of ["777", "private line", "private reason", "po_amount"]) assert.equal(serialized.includes(secret), false, secret);
  assert.deepEqual(db, before);
  const client = buildInvoiceAnalysis(db, "inv1", users.client);
  assert.equal(client.ok, true);
  assert.deepEqual(client.data.settlement, { status: "not_available_to_role" });
  assert.equal(buildInvoiceAnalysis(db, "inv1", { ...users.client, client_id: "c_other" }).status, 404);
  assert.equal(buildInvoiceAnalysis(db, "inv1", users.sales).status, 404);
  assert.equal(buildInvoiceAnalysis(db, "missing", users.admin).status, 404);
});

test("invoice analysis reports missing recorded links and respects role-specific related-record visibility", () => {
  const db = database();
  db.invoices = [{ id: "inv_orphan", status: "issued", total_amount: 10 }];
  const result = buildInvoiceAnalysis(db, "inv_orphan", users.admin);
  assert.deepEqual(result.data.findings.map((item) => item.code), ["INVOICE_DISPATCH_LINK_MISSING", "INVOICE_PO_LINK_MISSING"]);
  assert.deepEqual(result.data.evidenceRefs, [{ stage: "invoice", targetType: "invoice", targetId: "inv_orphan" }]);
  assert.equal(buildInvoiceAnalysis(db, "inv_orphan", users.client).status, 404);
});

test("worksheet-register analysis cites approved worker/date coverage without leaking names or hours", () => {
  const db = database();
  db.worksheet_registers = [
    {
      id: "wr1", reference: "REG-SYN-1", status: "Approved",
      roster: [{ key: "t_u_tech", technician_id: "u_tech", display_name: "Private Worker Name" }],
      lines: [
        { roster_key: "t_u_tech", date: "2026-09-01", normal: 8, ot_15: 1, ot_20: 0, sources: [{ source_type: "daily_timesheet", record_id: "dts1", row_index: 0 }] },
        { roster_key: "t_u_tech", date: "2026-09-02", normal: 7, ot_15: 0, ot_20: 0, sources: [{ source_type: "timesheet", record_id: "ts1", row_index: 0 }] }
      ]
    },
    {
      id: "wr2", reference: "REG-SYN-2", status: "Approved",
      roster: [{ key: "t_u_tech", technician_id: "u_tech", display_name: "Private Worker Name" }],
      lines: [{ roster_key: "t_u_tech", date: "2026-09-01", normal: 8, ot_15: 0, ot_20: 0, sources: [] }]
    }
  ];
  const before = structuredClone(db);
  const result = buildWorksheetRegisterAnalysis(db, "wr1", users.management);
  assert.equal(result.ok, true);
  assert.equal(result.data.coverage_status, "approved_recorded_coverage");
  assert.deepEqual(result.data.covered_worker_dates, [
    { worker_ref: "u_tech", date: "2026-09-01" },
    { worker_ref: "u_tech", date: "2026-09-02" }
  ]);
  assert.ok(result.data.findings.some((item) => item.code === "APPROVED_WORKER_DATE_COVERAGE_OVERLAP"));
  assert.deepEqual(result.data.evidenceRefs, [
    { stage: "worksheet_register", targetType: "worksheet_register", targetId: "wr1" },
    { stage: "timesheet_source", targetType: "daily_timesheet", targetId: "dts1" },
    { stage: "timesheet_source", targetType: "timesheet", targetId: "ts1" },
    { stage: "overlapping_worksheet_register", targetType: "worksheet_register", targetId: "wr2" }
  ]);
  assert.deepEqual(result.data.findings.find((item) => item.code === "APPROVED_WORKER_DATE_COVERAGE_OVERLAP").register_ids, ["wr2"]);
  const serialized = JSON.stringify(result.data);
  for (const secret of ["Private Worker Name", "normal", "ot_15", "\"hours\":", "\"normal\":"]) assert.equal(serialized.includes(secret), false, secret);
  assert.deepEqual(db, before);
  assert.equal(buildWorksheetRegisterAnalysis(db, "wr1", users.client).status, 404);
  assert.equal(buildWorksheetRegisterAnalysis(db, "missing", users.admin).status, 404);
});

test("unapproved worksheet registers never claim coverage", () => {
  const db = database();
  db.worksheet_registers = [{ id: "wr_draft", status: "Draft", roster: [{ key: "t_u_tech", technician_id: "u_tech" }], lines: [{ roster_key: "t_u_tech", date: "2026-09-01" }] }];
  const result = buildWorksheetRegisterAnalysis(db, "wr_draft", users.ops);
  assert.equal(result.data.coverage_status, "not_confirmed");
  assert.deepEqual(result.data.covered_worker_dates, []);
  assert.deepEqual(result.data.findings.map((item) => item.code), ["WORKSHEET_REGISTER_NOT_APPROVED"]);
});

test("worksheet register analysis bounds output, hashes unlinked worker keys, and allowlists source types", () => {
  const db = database();
  const privateWorkerName = "Private Contractor Name";
  db.worksheet_registers = [{
    id: "wr_large", status: "Approved",
    roster: [{ key: privateWorkerName, display_name: privateWorkerName }],
    lines: Array.from({ length: 520 }, (_, index) => ({
      roster_key: privateWorkerName,
      date: `2026-09-${String(index + 1).padStart(2, "0")}`,
      sources: [{ source_type: "unexpected_private_type", record_id: `source-${index}` }]
    }))
  }];
  const result = buildWorksheetRegisterAnalysis(db, "wr_large", users.management);
  assert.equal(result.data.covered_worker_dates.length, 500);
  assert.equal(result.data.evidenceRefs.length, 1);
  assert.equal(result.data.evidence_truncated, true);
  assert.ok(result.data.findings.some((item) => item.code === "EVIDENCE_LIST_TRUNCATED"));
  const serialized = JSON.stringify(result.data);
  assert.equal(serialized.includes(privateWorkerName), false);
  assert.match(result.data.covered_worker_dates[0].worker_ref, /^roster:[a-f0-9]{16}$/);
  assert.equal(serialized.includes("unexpected_private_type"), false);
});

test("service request analysis respects owner/triage scopes and never represents a request date as a booking", () => {
  const db = database();
  db.service_requests = [{
    id: "sr1", client_id: "c_a", status: "Accepted", urgency: "planned_shutdown",
    title: "Private request title", service_need: "PRIVATE_SERVICE_NEED", triage_note: "PRIVATE_TRIAGE_NOTE",
    mine_site_id: "site_a", equipment_tag_id: "eq_a", requested_date: "2026-10-20",
    created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-02T00:00:00.000Z"
  }];
  db.mine_sites = [{ id: "site_a", client_id: "c_a", name: "Private site name" }];
  db.equipment_tags = [{ id: "eq_a", client_id: "c_a", tag_code: "PRIVATE-EQUIPMENT-CODE" }];

  const client = buildServiceRequestAnalysis(db, "sr1", users.client);
  assert.equal(client.ok, true);
  assert.equal(client.data.service_request.state, "Accepted");
  assert.equal(client.data.service_request.requested_date, "2026-10-20");
  assert.equal(Object.hasOwn(client.data, "conversion"), false, "client projection must not expose the internal lead link");
  assert.ok(client.data.findings.some((item) => item.code === "REQUESTED_DATE_IS_NOT_A_BOOKING"));
  assert.ok(client.data.findings.some((item) => item.code === "ACCEPTED_MEANS_FOLLOW_UP"));
  const clientJson = JSON.stringify(client.data);
  for (const secret of ["PRIVATE_SERVICE_NEED", "PRIVATE_TRIAGE_NOTE", "Private site name", "PRIVATE-EQUIPMENT-CODE", "c_a"]) assert.equal(clientJson.includes(secret), false, secret);

  const sales = buildServiceRequestAnalysis(db, "sr1", users.sales);
  assert.equal(sales.ok, true);
  assert.equal(sales.data.conversion.status, "not_converted");
  assert.equal(sales.data.next_step, "Convert the accepted request to a Lead when ready; confirm any visit separately.");
  assert.equal(buildServiceRequestAnalysis(db, "sr1", users.fin).status, 404);
  assert.equal(buildServiceRequestAnalysis(db, "sr1", { ...users.client, client_id: "c_b" }).status, 404);
});

test("service request conversion is verified from reciprocal stored links, not inferred", () => {
  const db = database();
  db.service_requests = [{ id: "sr_converted", client_id: "c_a", status: "Converted_To_Lead", converted_lead_id: "lead_sr", requested_date: null }];
  db.leads = [{ id: "lead_sr", lead_number: "L-SYN-1", service_request_id: "sr_converted" }];
  const valid = buildServiceRequestAnalysis(db, "sr_converted", users.ops);
  assert.equal(valid.data.conversion.status, "linked");
  assert.deepEqual(valid.data.evidenceRefs.at(-1), { stage: "converted_lead", targetType: "lead", targetId: "lead_sr" });
  db.leads[0].service_request_id = "another_request";
  const invalid = buildServiceRequestAnalysis(db, "sr_converted", users.ops);
  assert.equal(invalid.data.conversion.status, "link_inconsistent");
  assert.ok(invalid.data.findings.some((item) => item.code === "SERVICE_REQUEST_LEAD_LINK_INCONSISTENT"));
  assert.equal(invalid.data.evidenceRefs.some((item) => item.targetId === "lead_sr"), false);
});

test("purchase-order analysis follows PO read roles and reports only safe verification evidence", () => {
  const db = database();
  db.purchase_orders[0] = {
    id: "po1", quotation_id: "q1", status: "pending", po_reference: "PRIVATE-PO-REF", po_amount: 123456,
    requires_amendment: true, verified_by: "u_fin", date_received: "2026-01-03T00:00:00.000Z"
  };
  const before = structuredClone(db);
  const result = buildPurchaseOrderAnalysis(db, "po1", users.fin);
  assert.equal(result.ok, true);
  assert.equal(result.data.purchase_order.state, "pending");
  assert.equal(result.data.purchase_order.amendment_required, true);
  assert.equal(result.data.quotation.human_ref, "Q-0001");
  assert.ok(result.data.findings.some((item) => item.code === "PO_NOT_VERIFIED"));
  assert.ok(result.data.findings.some((item) => item.code === "PO_AMENDMENT_REQUIRED"));
  assert.deepEqual(result.data.evidenceRefs, [
    { stage: "purchase_order", targetType: "purchase_order", targetId: "po1" },
    { stage: "quote", targetType: "quote", targetId: "q1" }
  ]);
  const serialized = JSON.stringify(result.data);
  for (const secret of ["PRIVATE-PO-REF", "123456", "verified_by", "u_fin", "po_amount"]) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(buildPurchaseOrderAnalysis(db, "po1", users.sales).status, 404);
  assert.equal(buildPurchaseOrderAnalysis(db, "po1", users.client).status, 404);
  assert.equal(buildPurchaseOrderAnalysis(db, "missing", users.admin).status, 404);
  assert.deepEqual(db, before, "analysis must not mutate source records");
});

test("purchase-order analysis flags broken links and missing verification evidence", () => {
  const db = database();
  db.purchase_orders = [{ id: "po_orphan", quotation_id: "missing_quote", status: "verified", po_reference: "PO-SYN" }];
  const result = buildPurchaseOrderAnalysis(db, "po_orphan", users.ops);
  assert.equal(result.data.quotation, null);
  assert.deepEqual(result.data.findings.map((item) => item.code), ["PO_QUOTE_NOT_FOUND", "PO_VERIFICATION_TIME_MISSING"]);
});

test("stock-item analysis reuses read-only ledger reconciliation and enforces inventory read roles", () => {
  const { db } = buildValidLedgerFixture();
  const item = db.stock_items[0];
  const before = JSON.stringify({ stock_items: db.stock_items, stock_movements: db.stock_movements, material_usage: db.material_usage });
  const result = buildStockItemAnalysis(db, item.id, users.ops);
  assert.equal(result.ok, true);
  assert.equal(result.data.stock_item.reconciliation_status, "reconciled");
  assert.equal(result.data.stock_item.quantity_on_hand, result.data.stock_item.ledger_balance);
  assert.equal(result.data.stock_item.movement_count, db.stock_movements.length);
  assert.equal(result.data.findings.length, 0);
  assert.equal(result.data.evidenceRefs.length, db.stock_movements.length + 1);
  assert.ok(result.data.limitations.some((text) => /not proof of supplier delivery, physical quantity/i.test(text)));
  assert.equal(JSON.stringify({ stock_items: db.stock_items, stock_movements: db.stock_movements, material_usage: db.material_usage }), before, "analysis must not mutate inventory");

  const anomalyDb = structuredClone(db);
  anomalyDb.stock_items[0].quantity_on_hand += 1;
  const anomaly = buildStockItemAnalysis(anomalyDb, item.id, users.management);
  assert.equal(anomaly.data.stock_item.reconciliation_status, "exceptions");
  assert.ok(anomaly.data.findings.some((finding) => finding.code === "ONHAND_DRIFT"));
  assert.equal(buildStockItemAnalysis(db, item.id, users.fin).status, 404);
  assert.equal(buildStockItemAnalysis(db, item.id, users.sales).status, 404);
  assert.equal(buildStockItemAnalysis(db, "missing", users.admin).status, 404);
});

test("catalog-item analysis follows commercial master-data access and cites linked stock without inferring quote terms", () => {
  const db = database();
  db.catalog_items = [{ id: "cat1", item_code: "SYN-CAT", item_name: "Synthetic Part", category: "Wear", unit_of_measure: "each", unit_price: 12.5, material_grade: "synthetic grade", dimensions: "10mm", internal_note: "MUST_NOT_ESCAPE" }];
  db.stock_items = [{ id: "stock1", catalog_item_id: "cat1", item_code: "SYN-STOCK", supplier_id: "supplier-private", quantity_on_hand: 20, unit_cost: 6 }];
  const before = JSON.stringify({ catalog_items: db.catalog_items, stock_items: db.stock_items });
  const result = buildCatalogItemAnalysis(db, "cat1", users.management);
  assert.equal(result.ok, true);
  assert.equal(result.data.catalog_item.unit_price, 12.5);
  assert.equal(result.data.catalog_item.status, "not_statused");
  assert.deepEqual(result.data.linked_stock_items, [{ id: "stock1", item_code: "SYN-STOCK" }]);
  assert.deepEqual(result.data.evidenceRefs.map((ref) => ref.targetId), ["cat1", "stock1"]);
  assert.ok(result.data.limitations.some((text) => /does not establish an accepted quotation price/i.test(text)));
  assert.equal(JSON.stringify(result.data).includes("MUST_NOT_ESCAPE"), false);
  assert.equal(JSON.stringify(result.data).includes("supplier-private"), false);
  assert.equal(JSON.stringify(result.data).includes("unit_cost"), false);
  assert.equal(JSON.stringify({ catalog_items: db.catalog_items, stock_items: db.stock_items }), before);
  assert.equal(buildCatalogItemAnalysis(db, "cat1", users.admin).ok, true);
  assert.equal(buildCatalogItemAnalysis(db, "cat1", users.ops).status, 404);
  assert.equal(buildCatalogItemAnalysis(db, "cat1", users.sales).status, 404);
  assert.equal(buildCatalogItemAnalysis(db, "missing", users.admin).status, 404);
  const legacyDb = structuredClone(db);
  legacyDb.catalog_items[0].unit_price = null;
  const legacy = buildCatalogItemAnalysis(legacyDb, "cat1", users.admin);
  assert.equal(legacy.data.catalog_item.unit_price, null);
  assert.ok(legacy.data.findings.some((finding) => finding.code === "CATALOG_ITEM_PRICE_INVALID"));
});

test("supplier analysis summarizes linked receipt evidence without exposing private fields or asserting supplier performance", () => {
  const db = database();
  db.suppliers = [{ id: "sup1", name: "Synthetic Supplier", contact_person: "Private Contact", email: "private@example.invalid", phone: "555-0100", lead_time_days: 7, note: "PRIVATE-SUPPLIER-NOTE" }];
  db.stock_items = [{ id: "stock1", supplier_id: "sup1", item_code: "SYN-BOLT", item_name: "Synthetic bolt", unit_of_measure: "each", quantity_on_hand: 4 }];
  db.stock_movements = [{ id: "move1", stock_item_id: "stock1", movement_type: "in", quantity: 4, quantity_before: 0, quantity_after: 4, unit_of_measure: "each", direction: "increase", reference_type: "supplier", reference_id: "sup1", source_document_ref: "PRIVATE-DN-001", created_at: "2026-01-01T00:00:00.000Z" }];
  db.material_usage = [];
  const before = JSON.stringify({ suppliers: db.suppliers, stock_items: db.stock_items, stock_movements: db.stock_movements });
  const result = buildSupplierAnalysis(db, "sup1", users.ops);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.linked_stock_items[0].receipt_summary, { receipt_count: 1, quantities_by_unit: { each: 4 }, receipts_with_source_reference: 1 });
  assert.equal(result.data.linked_stock_items[0].reconciliation_status, "reconciled");
  assert.deepEqual(result.data.evidenceRefs.map((ref) => ref.targetId), ["sup1", "stock1", "move1"]);
  assert.ok(result.data.limitations.some((text) => /does not verify document authenticity/i.test(text)));
  const serialized = JSON.stringify(result.data);
  for (const secret of ["Private Contact", "private@example.invalid", "555-0100", "PRIVATE-SUPPLIER-NOTE", "PRIVATE-DN-001", "supplier_id"]) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(JSON.stringify({ suppliers: db.suppliers, stock_items: db.stock_items, stock_movements: db.stock_movements }), before);
  assert.equal(buildSupplierAnalysis(db, "sup1", users.admin).ok, true);
  assert.equal(buildSupplierAnalysis(db, "sup1", users.management).ok, true);
  assert.equal(buildSupplierAnalysis(db, "sup1", users.sales).status, 404);
  assert.equal(buildSupplierAnalysis(db, "sup1", users.fin).status, 404);
  assert.equal(buildSupplierAnalysis(db, "missing", users.ops).status, 404);
  db.stock_movements[0].source_document_ref = null;
  const missingRef = buildSupplierAnalysis(db, "sup1", users.ops);
  assert.ok(missingRef.data.findings.some((finding) => finding.code === "SUPPLIER_RECEIPT_REFERENCE_MISSING"));
});

test("maintenance schedule analysis verifies contract and equipment links without claiming completion", () => {
  const db = database();
  db.contracts = [{ id: "contract1", client_id: "c_a", contract_number: "CTR-0001", status: "Active", start_date: "2026-01-01", end_date: "2026-12-31", total_value: 900, created_by_user_id: "private-staff" }];
  db.maintenance_schedules = [{ id: "schedule1", contract_id: "contract1", equipment_tag_id: "tag1", frequency: "Quarterly", next_due_date: "2026-10-30", notes: "PRIVATE-SCHEDULE-NOTE", created_by_user_id: "private-staff", created_at: "2026-01-01T00:00:00.000Z" }];
  db.equipment_tags = [{ id: "tag1", tag_code: "SYN-TAG", plant_section_id: "section1", is_active: true }];
  db.plant_sections = [{ id: "section1", plant_id: "plant1" }];
  db.plants = [{ id: "plant1", mine_site_id: "site1" }];
  db.mine_sites = [{ id: "site1", client_id: "c_a" }];
  const before = JSON.stringify({ contracts: db.contracts, maintenance_schedules: db.maintenance_schedules });
  const result = buildMaintenanceScheduleAnalysis(db, "schedule1", users.management);
  assert.equal(result.ok, true);
  assert.equal(result.data.contract.status, "Active");
  assert.deepEqual(result.data.equipment, { id: "tag1", tag_code: "SYN-TAG", status: "not_statused" });
  assert.deepEqual(result.data.evidenceRefs.map((ref) => ref.targetId), ["schedule1", "contract1", "tag1"]);
  assert.ok(result.data.limitations.some((text) => /does not prove.*performed/i.test(text)));
  const serialized = JSON.stringify(result.data);
  for (const secret of ["PRIVATE-SCHEDULE-NOTE", "private-staff", "total_value", "c_a"]) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(JSON.stringify({ contracts: db.contracts, maintenance_schedules: db.maintenance_schedules }), before);
  assert.equal(buildMaintenanceScheduleAnalysis(db, "schedule1", users.client).ok, true);
  assert.equal(buildMaintenanceScheduleAnalysis(db, "schedule1", { ...users.client, client_id: "c_b" }).status, 404);
  assert.equal(buildMaintenanceScheduleAnalysis(db, "schedule1", users.sales).status, 404);
  db.contracts[0].status = "Ended";
  const ended = buildMaintenanceScheduleAnalysis(db, "schedule1", users.admin);
  assert.ok(ended.data.findings.some((finding) => finding.code === "SCHEDULE_CONTRACT_NOT_OPEN"));
  db.maintenance_schedules[0].next_due_date = "2026-02-30";
  const invalidDate = buildMaintenanceScheduleAnalysis(db, "schedule1", users.admin);
  assert.ok(invalidDate.data.findings.some((finding) => finding.code === "SCHEDULE_DUE_DATE_INVALID"));
  assert.equal(invalidDate.data.findings.some((finding) => finding.code === "SCHEDULE_OUTSIDE_CONTRACT_PERIOD"), false);
});

test("equipment tag analysis checks its hierarchy and reports only recorded master data", () => {
  const db = database();
  db.equipment_tags = [{ id: "tag1", tag_code: "SYN-TAG", equipment_name: "Pump A", criticality: "high", status: "active", plant_section_id: "section1", notes: "PRIVATE-NOTE", is_active: true }];
  db.plant_sections = [{ id: "section1", name: "Pumps", plant_id: "plant1", is_active: true }];
  db.plants = [{ id: "plant1", name: "Process Plant", mine_site_id: "site1", is_active: true }];
  db.mine_sites = [{ id: "site1", name: "North Site", client_id: "c_a", is_active: true }];
  const before = JSON.stringify(db);
  const result = buildEquipmentTagAnalysis(db, "tag1", users.ops);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.equipment_tag, { id: "tag1", tag_code: "SYN-TAG", equipment_name: "Pump A", criticality: "high", status: "active", is_active: true });
  assert.deepEqual(result.data.hierarchy.map((item) => item.id), ["site1", "plant1", "section1"]);
  assert.deepEqual(result.data.evidenceRefs.map((item) => item.targetId), ["tag1", "site1", "plant1", "section1"]);
  assert.ok(result.data.limitations.some((text) => /does not identify a physical asset/i.test(text)));
  assert.ok(result.data.limitations.some((text) => /not proof that work was performed/i.test(text)));
  assert.equal(JSON.stringify(result.data).includes("PRIVATE-NOTE"), false);
  assert.equal(JSON.stringify(db), before);
  assert.equal(buildEquipmentTagAnalysis(db, "tag1", users.admin).ok, true);
  assert.equal(buildEquipmentTagAnalysis(db, "tag1", users.management).ok, true);
  assert.equal(buildEquipmentTagAnalysis(db, "tag1", users.sales).status, 404);
  assert.equal(buildEquipmentTagAnalysis(db, "tag1", users.client).status, 404);
  assert.equal(buildEquipmentTagAnalysis(db, "missing", users.ops).status, 404);
  db.plants[0].is_active = false;
  assert.ok(buildEquipmentTagAnalysis(db, "tag1", users.ops).data.findings.some((item) => item.code === "EQUIPMENT_PLANT_INACTIVE"));
  db.equipment_tags.push({ ...db.equipment_tags[0], id: "tag2", tag_code: "syn-tag" });
  assert.ok(buildEquipmentTagAnalysis(db, "tag1", users.ops).data.findings.some((item) => item.code === "EQUIPMENT_TAG_CODE_DUPLICATE"));
});

test("material usage analysis checks a linked stock deduction, hides costs and enforces dispatch assignment", () => {
  const db = database();
  db.dispatch_cards = [{ id: "job1", dispatch_number: "JOB-0001", assigned_technician_id: users.tech.id, assigned_supervisor_id: "u_supervisor" }];
  db.material_usage = [{ id: "usage1", dispatch_card_id: "job1", catalog_item_id: "cat1", quantity_used: 3, unit_cost: 99, total_cost: 297, description: "PRIVATE-DESCRIPTION", created_by: "PRIVATE-ACTOR", idempotency_key: "PRIVATE-KEY" }];
  db.stock_items = [{ id: "stock1", catalog_item_id: "cat1", item_code: "SYN-CAT", unit_of_measure: "each" }];
  db.stock_movements = [{ id: "move1", stock_item_id: "stock1", reference_type: "material_usage", reference_id: "usage1", movement_type: "out", quantity: -3 }];
  const before = JSON.stringify({ dispatch_cards: db.dispatch_cards, material_usage: db.material_usage, stock_items: db.stock_items, stock_movements: db.stock_movements });
  const result = buildMaterialUsageAnalysis(db, "usage1", users.tech);
  assert.equal(result.ok, true);
  assert.equal(result.data.material_usage.stock_ledger_status, "matched");
  assert.equal(result.data.material_usage.quantity_used, 3);
  assert.deepEqual(result.data.evidenceRefs.map((item) => item.targetId), ["usage1", "job1", "stock1", "move1"]);
  const serialized = JSON.stringify(result.data);
  for (const secret of ["PRIVATE-DESCRIPTION", "PRIVATE-ACTOR", "PRIVATE-KEY", "unit_cost", "total_cost"]) assert.equal(serialized.includes(secret), false, secret);
  assert.ok(result.data.limitations.some((text) => /does not prove physical consumption/i.test(text)));
  assert.equal(JSON.stringify({ dispatch_cards: db.dispatch_cards, material_usage: db.material_usage, stock_items: db.stock_items, stock_movements: db.stock_movements }), before);
  assert.equal(buildMaterialUsageAnalysis(db, "usage1", users.admin).ok, true);
  assert.equal(buildMaterialUsageAnalysis(db, "usage1", users.ops).ok, true);
  assert.equal(buildMaterialUsageAnalysis(db, "usage1", { id: "u_supervisor", role: "Supervisor", is_active: true }).ok, true);
  assert.equal(buildMaterialUsageAnalysis(db, "usage1", users.sales).status, 404);
  assert.equal(buildMaterialUsageAnalysis(db, "usage1", users.fin).status, 404);
  assert.equal(buildMaterialUsageAnalysis(db, "usage1", { ...users.tech, id: "other-tech" }).status, 404);
  db.stock_movements[0].quantity = -2;
  assert.equal(buildMaterialUsageAnalysis(db, "usage1", users.tech).data.material_usage.stock_ledger_status, "mismatch");
  db.stock_movements = [];
  assert.equal(buildMaterialUsageAnalysis(db, "usage1", users.tech).data.material_usage.stock_ledger_status, "missing_movement");
});

test("field worksheet analysis reports recorded sign-off and eligibility without exposing personal or signature data", () => {
  const db = database();
  db.clients = [{ id: "c_a", timesheet_cutover_date: "2026-01-01" }];
  db.dispatch_cards[0].assigned_technician_ids = [users.tech.id];
  db.field_worksheets = [{
    id: "ws1", dispatch_card_id: "job1", technician_id: users.tech.id, supervisor_id: "u_supervisor",
    status: "Supervisor_Approved", work_date: "2026-01-06", timesheet_version: 2, hours: 8,
    hours_breakdown: { normal: 8, ot_15: 0, ot_20: 0 },
    signatures: { employee: { name: "PRIVATE-WORKER", date: "2026-01-06", method: "on_device", attested_at: "2026-01-06T10:00:00Z" } },
    signed_copy_image: "PRIVATE-SIGNATURE-IMAGE",
    client_acknowledgement: { acknowledged_at: "2026-01-07T10:00:00Z", signer_name: "PRIVATE-CLIENT" },
    approved_by: "PRIVATE-SUPERVISOR", approved_at: "2026-01-08T10:00:00Z",
    revises_worksheet_id: "ws0", supervisor_comment: "PRIVATE-COMMENT", hourly_rate: 123
  }, { id: "ws0", dispatch_card_id: "job1", superseded_by: "ws1", status: "Returned_For_Correction" }];
  const before = JSON.stringify(db.field_worksheets);
  const result = buildFieldWorksheetAnalysis(db, "ws1", users.tech);
  assert.equal(result.ok, true);
  assert.equal(result.data.field_worksheet.daily_source_eligibility, "eligible_under_current_rules");
  assert.equal(result.data.field_worksheet.hours_total, 8);
  assert.deepEqual(result.data.field_worksheet.hours_breakdown, { normal: 8, ot_15: 0, ot_20: 0 });
  assert.deepEqual(result.data.field_worksheet.signoff, {
    employee_recorded: true, client_acknowledgement_recorded: true, supervisor_approval_recorded: true, complete: true
  });
  assert.deepEqual(result.data.evidenceRefs.map((item) => item.targetId), ["ws1", "job1", "ws0"]);
  const serialized = JSON.stringify(result.data);
  for (const secret of ["PRIVATE-WORKER", "PRIVATE-SIGNATURE-IMAGE", "PRIVATE-CLIENT", "PRIVATE-SUPERVISOR", "PRIVATE-COMMENT", "hourly_rate"]) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(JSON.stringify(db.field_worksheets), before, "analysis is read-only");
  assert.equal(buildFieldWorksheetAnalysis(db, "ws1", { ...users.tech, id: "other-tech" }).status, 404);
  assert.equal(buildFieldWorksheetAnalysis(db, "ws1", users.sales).status, 404);
  assert.equal(buildFieldWorksheetAnalysis(db, "ws1", users.client).status, 404);
  assert.equal(buildFieldWorksheetAnalysis(db, "ws1", { id: "u_supervisor", role: "Supervisor", is_active: true }).ok, true);
  assert.equal(buildFieldWorksheetAnalysis(db, "ws1", { id: "other-supervisor", role: "Supervisor", is_active: true }).status, 404);
  assert.equal(buildFieldWorksheetAnalysis(db, "ws0", users.admin).data.findings.some((item) => item.code === "TIMESHEET_SUPERSEDED"), true);
});

test("daily timesheet analysis reuses validation, detects approved-register overlap, and excludes personal evidence", () => {
  const db = database();
  db.daily_timesheets = [{
    id: "dts1", technician_id: users.tech.id, status: "Submitted", created_at: "2026-01-06T08:00:00Z",
    name_on_form: "PRIVATE WORKER", cell_number: "PRIVATE PHONE", supervisor_comment: "PRIVATE COMMENT",
    entries: [{ date: "2026-01-06", start_time: "08:00", end_time: "16:00", normal_hours: 8, description: "PRIVATE DESCRIPTION" }],
    signatures: {
      employee: { name: "PRIVATE EMPLOYEE", date: "2026-01-06", method: "on_device" },
      site_foreman: { name: "PRIVATE FOREMAN", date: "2026-01-06", method: "on_device" }
    },
    signed_copy_image: "PRIVATE IMAGE"
  }];
  db.worksheet_registers = [{ status: "Approved", reference: "PRIVATE REGISTER REF", roster: [{ technician_id: users.tech.id, key: "worker-key" }], lines: [{ roster_key: "worker-key", date: "2026-01-06", normal: 8, ot_15: 0, ot_20: 0 }] }];

  const before = JSON.stringify({ daily_timesheets: db.daily_timesheets, worksheet_registers: db.worksheet_registers });
  const result = buildDailyTimesheetAnalysis(db, "dts1", users.tech);
  assert.equal(result.ok, true);
  assert.equal(result.data.daily_timesheet.validation, "valid");
  assert.deepEqual(result.data.daily_timesheet.distinct_work_dates, ["2026-01-06"]);
  assert.equal(result.data.daily_timesheet.signoff.complete, true);
  assert.equal(result.data.daily_timesheet.approved_register_overlap, true);
  assert.ok(result.data.findings.some((item) => item.code === "DAILY_TIMESHEET_NOT_APPROVED"));
  assert.ok(result.data.findings.some((item) => item.code === "DAILY_TIMESHEET_ALREADY_COVERED"));
  const serialized = JSON.stringify(result.data);
  for (const secret of ["PRIVATE WORKER", "PRIVATE PHONE", "PRIVATE COMMENT", "PRIVATE DESCRIPTION", "PRIVATE EMPLOYEE", "PRIVATE FOREMAN", "PRIVATE IMAGE", "PRIVATE REGISTER REF", "normal_hours"]) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(JSON.stringify({ daily_timesheets: db.daily_timesheets, worksheet_registers: db.worksheet_registers }), before);
  assert.equal(buildDailyTimesheetAnalysis(db, "dts1", { ...users.tech, id: "other-tech" }).status, 404);
  assert.equal(buildDailyTimesheetAnalysis(db, "dts1", users.sales).status, 404);

  db.daily_timesheets[0].entries[0].end_time = "07:00";
  const invalid = buildDailyTimesheetAnalysis(db, "dts1", users.tech);
  assert.equal(invalid.data.daily_timesheet.validation, "invalid");
  assert.ok(invalid.data.findings.some((item) => item.code === "DAILY_TIMESHEET_ENTRIES_INVALID"));
});

test("contractor log analysis validates rows, reports unweighted hours and excludes worker/signature details", () => {
  const db = database();
  db.contractor_log_sheets = [{
    id: "cl1", status: "Supervisor_Approved", log_date: "2026-01-06", created_at: "2026-01-06T08:00:00Z",
    contractor_name: "PRIVATE CONTRACTOR", order_no: "PRIVATE ORDER", work_description: "PRIVATE DESCRIPTION", supervisor_comment: "PRIVATE COMMENT",
    rows: [{ worker_name: "PRIVATE WORKER", grade: "Artisan", normal: 8, ot_15: 1, ot_20: 0 }],
    signatures: { foreman: { name: "PRIVATE SIGNER", date: "2026-01-06" } }
  }];
  const before = JSON.stringify(db.contractor_log_sheets);
  const result = buildContractorLogAnalysis(db, "cl1", users.ops);
  assert.equal(result.ok, true);
  assert.equal(result.data.contractor_log_sheet.validation, "valid");
  assert.equal(result.data.contractor_log_sheet.recorded_hours_total, 9);
  assert.equal(result.data.contractor_log_sheet.foreman_or_supervisor_signoff_recorded, true);
  const serialized = JSON.stringify(result.data);
  for (const secret of ["PRIVATE CONTRACTOR", "PRIVATE ORDER", "PRIVATE DESCRIPTION", "PRIVATE COMMENT", "PRIVATE WORKER", "PRIVATE SIGNER", "Artisan"]) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(JSON.stringify(db.contractor_log_sheets), before);
  assert.equal(buildContractorLogAnalysis(db, "cl1", users.tech).status, 404);
  assert.equal(buildContractorLogAnalysis(db, "cl1", users.sales).status, 404);

  db.contractor_log_sheets[0].rows[0].normal = 25;
  const invalid = buildContractorLogAnalysis(db, "cl1", users.ops);
  assert.equal(invalid.data.contractor_log_sheet.recorded_hours_total, null);
  assert.ok(invalid.data.findings.some((item) => item.code === "CONTRACTOR_LOG_ROWS_INVALID"));
});
