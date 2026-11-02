import assert from "node:assert/strict";
import test from "node:test";
import { approveAmendment } from "../src/controllers/dispatchController.js";

// Chat E: maker-checker for PO amendments. Mirrors the existing worksheet
// rule in segregationOfDuties.test.js: whoever verified the PO amount cannot
// approve an increase to it.

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function setup({ actorRole = "Finance", actorId = "fin-1", verifiedBy = "fin-2", newAmount = 150 } = {}) {
  const audits = [];
  const actor = { id: actorId, role: actorRole, is_active: true };
  const po = { id: "po-1", quotation_id: "q-1", po_amount: 100, verified_by: verifiedBy, requires_amendment: true };
  const db = {
    users: [actor],
    purchase_orders: [po],
    po_amendments: [],
    dispatch_cards: [{ id: "job-1", purchase_order_id: "po-1" }],
    timesheets: [{ id: "time-1", dispatch_card_id: "job-1", hours_logged: 3, hourly_rate: 40 }],
    material_usage: []
  };
  const req = {
    user: { id: actorId },
    params: { id: "po-1" },
    body: { new_amount: newAmount, reason: "Extra hours" },
    db,
    store: {
      id: (p) => `${p}_1`,
      recalculateVariance() {},
      audit: (...args) => audits.push(args)
    }
  };
  return { req, db, po, audits };
}

test("PO verifier cannot approve an amendment to the same PO", () => {
  const { req, db, po, audits } = setup({ actorId: "fin-1", verifiedBy: "fin-1" });
  const res = response();
  approveAmendment(req, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /verified this purchase order cannot approve its amendment/);
  assert.equal(po.po_amount, 100, "amount must be unchanged");
  assert.equal(po.requires_amendment, true, "flag must not be cleared");
  assert.equal(db.po_amendments.length, 0);
  assert.equal(audits.length, 0);
});

test("Admin who verified the PO is also blocked (rule is per person, not per role)", () => {
  const { req, po } = setup({ actorRole: "Admin", actorId: "adm-1", verifiedBy: "adm-1" });
  const res = response();
  approveAmendment(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(po.po_amount, 100);
});

test("an independent Finance user can approve the amendment", () => {
  const { req, db, po, audits } = setup({ actorId: "fin-1", verifiedBy: "ops-1" });
  const res = response();
  approveAmendment(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(po.po_amount, 150);
  assert.equal(po.requires_amendment, false);
  assert.equal(db.po_amendments.length, 1);
  assert.equal(db.po_amendments[0].approved_by, "fin-1");
  assert.equal(audits.length, 1);
});

test("a role without approveAmendment is still refused regardless of verifier", () => {
  const { req } = setup({ actorRole: "Operations", actorId: "ops-1", verifiedBy: "fin-2" });
  assert.throws(() => approveAmendment(req, response()), /cannot perform approveAmendment/);
});

test("existing rule kept: amended amount must exceed current amount", () => {
  const { req, po } = setup({ newAmount: 90 });
  const res = response();
  approveAmendment(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(po.po_amount, 100);
});

test("amendment approval waits for recorded evidence of an overrun", () => {
  const { req, db, po, audits } = setup();
  db.timesheets[0].hours_logged = 2;
  db.timesheets[0].hourly_rate = 50;
  const res = response();
  approveAmendment(req, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /Record the additional work or materials first/);
  assert.equal(po.po_amount, 100);
  assert.equal(db.po_amendments.length, 0);
  assert.equal(audits.length, 0);
});

test("approved amendment must cover all recorded evidence", () => {
  const { req, db, po, audits } = setup({ newAmount: 110 });
  const res = response();
  approveAmendment(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /must cover the recorded work and materials/);
  assert.equal(po.po_amount, 100);
  assert.equal(po.requires_amendment, true);
  assert.equal(db.po_amendments.length, 0);
  assert.equal(audits.length, 0);
});
