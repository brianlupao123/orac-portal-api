import assert from "node:assert/strict";
import test from "node:test";
import { allocateV5AmendmentEvidence } from "../src/controllers/v5AmendmentEvidenceAllocationController.js";
import { createV5ClientSupervisorContact, recordV5PaperSignature, confirmV5Timesheet } from "../src/controllers/v5SignatureController.js";
import { v5SignatureState } from "../src/v5SignatureEvidence.js";
import { database, call, contactBody, paperBody, withV5 } from "./helpers/v5SignatureFixture.js";

function setup() {
  const db = database();
  db.quotes.push({
    id: "amend",
    v5_commercial_workflow: true,
    revision_of_quote_id: "quote-1",
    commercial_acceptance_status: "po_verified",
    commercial_acceptance_po_id: "amend-po",
    v5_amendment_approval: { approved_by: "admin-1", approved_at: "2026-10-12T10:00:00.000Z", approved_po_id: "amend-po" }
  });
  db.purchase_orders = [{ id: "amend-po", quotation_id: "amend", status: "verified" }];
  db.quote_lines.push(
    { id: "amend-hours", quotation_id: "amend", pricing_basis: "hourly", quantity: 2 },
    { id: "amend-material", quotation_id: "amend", pricing_basis: "material", quantity: 3, catalog_item_id: "tile" }
  );
  db.material_usage = [{ id: "usage-1", dispatch_card_id: "job-1", catalog_item_id: "tile", quantity_used: 3, unit_of_measure: "each" }];
  db.v5_material_allocations = [];
  db.v5_amendment_dispatch_links = [{ dispatch_card_id: "job-1", amendment_quote_id: "amend", amendment_purchase_order_id: "amend-po" }];
  return db;
}

function verifyLabour(db) {
  const contact = call(createV5ClientSupervisorContact, db, "sales-1", { params: { id: "job-1" }, body: contactBody() }).body.data;
  assert.equal(call(recordV5PaperSignature, db, "sales-1", { params: { id: "ws-1" }, body: paperBody(contact.id) }).statusCode, 201);
  const state = v5SignatureState(db, db.field_worksheets[0]);
  assert.equal(call(confirmV5Timesheet, db, "sup-1", { params: { id: "ws-1" }, body: { evidence_id: state.evidence.id, hours_hash: state.current_hash, attest: true } }).statusCode, 201);
}

function run(db, body = {}, actor = "sales-1") {
  return call(allocateV5AmendmentEvidence, db, actor, {
    params: { id: "job-1" },
    body: {
      amendment_quote_id: "amend",
      amendment_quote_line_id: "amend-hours",
      source_type: "field_worksheet",
      source_id: "ws-1",
      quantity: 1,
      reason: "Approved extra labour",
      idempotency_key: "amend-cover-0001",
      ...body
    }
  });
}

test("amendment evidence allocation is dark by default and does not mutate records", () => {
  const db = setup();
  const before = JSON.stringify(db);
  assert.equal(run(db).statusCode, 409);
  assert.equal(JSON.stringify(db), before);
});

test("it allocates actual V5-verified labour once, then replays the same request", () => withV5(() => {
  const db = setup();
  verifyLabour(db);
  const before = JSON.stringify({ quotes: db.quotes, quote_lines: db.quote_lines, purchase_orders: db.purchase_orders, field_worksheets: db.field_worksheets });
  const created = run(db);
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.data.quantity, 1);
  assert.equal(db.v5_amendment_evidence_allocations.length, 1);
  assert.equal(JSON.stringify({ quotes: db.quotes, quote_lines: db.quote_lines, purchase_orders: db.purchase_orders, field_worksheets: db.field_worksheets }), before);
  const replay = run(db);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.idempotent_replay, true);
  assert.equal(db.v5_amendment_evidence_allocations.length, 1);
}));

test("material evidence requires a matching catalog line and cannot be billed through both original and amendment allocations", () => withV5(() => {
  const db = setup();
  const material = { amendment_quote_line_id: "amend-material", source_type: "material_usage", source_id: "usage-1", quantity: 3, reason: "Approved replacement tiles", idempotency_key: "amend-material-0001" };
  assert.equal(run(db, { ...material, amendment_quote_line_id: "amend-hours" }).body.code, "V5_AMENDMENT_EVIDENCE_INELIGIBLE");
  db.v5_material_allocations.push({ id: "original-allocation", material_usage_id: "usage-1" });
  assert.equal(run(db, material).body.code, "V5_AMENDMENT_EVIDENCE_ALREADY_ALLOCATED");
  db.v5_material_allocations = [];
  assert.equal(run(db, material).statusCode, 201);
}));

test("allocation ceilings fail closed for bad data and tolerate exact decimal sums", () => withV5(() => {
  const db = setup();
  db.material_usage[0].quantity_used = 0.3;
  const line = db.quote_lines.find((item) => item.id === "amend-material");
  line.quantity = 0.3;
  const material = { amendment_quote_line_id: "amend-material", source_type: "material_usage", source_id: "usage-1" };
  assert.equal(run(db, { ...material, quantity: 0.1, idempotency_key: "decimal-cover-0001" }).statusCode, 201);
  assert.equal(run(db, { ...material, quantity: 0.2, idempotency_key: "decimal-cover-0002" }).statusCode, 201);
  const corrupt = setup();
  corrupt.quote_lines.find((item) => item.id === "amend-material").quantity = undefined;
  assert.equal(run(corrupt, material).body.code, "V5_AMENDMENT_EVIDENCE_INELIGIBLE");
}));

test("allocation rechecks amendment approval and verified PO state at use time", () => withV5(() => {
  const db = setup();
  verifyLabour(db);
  db.purchase_orders[0].status = "received";
  assert.equal(run(db).body.code, "V5_AMENDMENT_NOT_APPROVED");
  db.purchase_orders[0].status = "verified";
  db.v5_amendment_dispatch_links[0].amendment_purchase_order_id = "other-po";
  assert.equal(run(db).body.code, "V5_AMENDMENT_NOT_APPROVED");
}));

test("controller rejects malformed direct calls, stale idempotency keys and unauthorized roles", () => withV5(() => {
  const db = setup();
  verifyLabour(db);
  for (const body of [
    { quantity: 0 },
    { quantity: -1 },
    { quantity: "1" },
    { reason: "" },
    { source_type: "other" }
  ]) assert.equal(run(db, body).body.code, "V5_AMENDMENT_ALLOCATION_INVALID");
  assert.throws(() => run(db, {}, "fin-1"), /cannot perform/);
  assert.equal(run(db).statusCode, 201);
  assert.equal(run(db, { quantity: 2 }).statusCode, 409);
}));
