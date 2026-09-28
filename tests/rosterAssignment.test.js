import test from "node:test";
import assert from "node:assert/strict";
import { assignRosterTechnician, createWorksheet, getDispatchMaterialStatus, getDispatchRoster } from "../src/controllers/dispatchController.js";
import { scopeOperationalData } from "../src/controllers/coreController.js";
import { getKioskRoster } from "../src/controllers/kioskController.js";

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function baseDb() {
  return {
    users: [
      { id: "tech-1", role: "Technician", is_active: true, name: "Tech One", email: "t1@example.com" },
      { id: "tech-2", role: "Technician", is_active: true, name: "Tech Two", email: "t2@example.com" },
      { id: "tech-inactive", role: "Technician", is_active: false, name: "Retired Tech", email: "old@example.com" },
      { id: "ops-1", role: "Operations", is_active: true },
      { id: "sup-1", role: "Supervisor", is_active: true },
      { id: "sup-2", role: "Supervisor", is_active: true }
    ],
    dispatch_cards: [{ id: "dispatch-1", dispatch_number: "DC-001", assigned_technician_ids: [], assigned_supervisor_id: "sup-1" }],
    field_worksheets: [],
    material_usage: [],
    stock_items: [],
    audit_logs: []
  };
}

function req(db, body, actorId, dispatchId = "dispatch-1") {
  const actor = db.users.find((u) => u.id === actorId);
  return {
    user: { id: actorId },
    params: { id: dispatchId },
    body,
    db,
    store: { id: (p) => `${p}-new`, audit() {}, recalculateVariance() {} }
  };
}

test("before this fix, a fresh dispatch had no way to be rostered — assigned_technician_ids starts empty", () => {
  const db = baseDb();
  assert.deepEqual(db.dispatch_cards[0].assigned_technician_ids, []);
});

test("Operations can roster a Technician to a dispatch before any worksheet exists", () => {
  const db = baseDb();
  const res = response();
  assignRosterTechnician(req(db, { technician_id: "tech-1" }, "ops-1"), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(db.dispatch_cards[0].assigned_technician_ids, ["tech-1"]);
});

test("a Technician cannot roster themself or anyone else onto a dispatch", () => {
  const db = baseDb();
  assert.throws(() => assignRosterTechnician(req(db, { technician_id: "tech-1" }, "tech-1"), response()), { status: 403 });
  assert.deepEqual(db.dispatch_cards[0].assigned_technician_ids, [], "no roster change may occur on a rejected attempt");
});

test("rostering the same technician twice is idempotent, not a duplicate", () => {
  const db = baseDb();
  assignRosterTechnician(req(db, { technician_id: "tech-1" }, "ops-1"), response());
  const res2 = response();
  assignRosterTechnician(req(db, { technician_id: "tech-1" }, "ops-1"), res2);

  assert.equal(res2.statusCode, 200);
  assert.deepEqual(db.dispatch_cards[0].assigned_technician_ids, ["tech-1"]);
});

test("an inactive technician cannot be rostered", () => {
  const db = baseDb();
  const res = response();
  assignRosterTechnician(req(db, { technician_id: "tech-inactive" }, "ops-1"), res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(db.dispatch_cards[0].assigned_technician_ids, []);
});

test("once rostered, a Technician can see their own dispatch in the scoped list without any worksheet existing yet", () => {
  const db = baseDb();
  assignRosterTechnician(req(db, { technician_id: "tech-1" }, "ops-1"), response());

  const visible = scopeOperationalData(db.dispatch_cards, "dispatch_cards", { id: "tech-1", role: "Technician" }, db);
  assert.equal(visible.length, 1);

  const notRostered = scopeOperationalData(db.dispatch_cards, "dispatch_cards", { id: "tech-2", role: "Technician" }, db);
  assert.equal(notRostered.length, 0);
});

test("once rostered, a Technician can create their own worksheet on that dispatch", () => {
  const db = baseDb();
  assignRosterTechnician(req(db, { technician_id: "tech-1" }, "ops-1"), response());

  const res = response();
  createWorksheet(req(db, { activity: "Inspection", hours: 2 }, "tech-1"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.technician_id, "tech-1");
});

test("the kiosk roster reflects a technician assigned via the new endpoint, even with zero worksheets so far", () => {
  const db = baseDb();
  assignRosterTechnician(req(db, { technician_id: "tech-1" }, "ops-1"), response());

  const res = response();
  getKioskRoster(req(db, {}, "ops-1"), res);
  assert.equal(res.statusCode, 200);
  const ids = res.body.data.technicians.map((t) => t.id);
  assert.deepEqual(ids, ["tech-1"]);
});

test("dispatch material status stays gated by assignment even for a technician rostered but not yet worksheeted", () => {
  const db = baseDb();
  assignRosterTechnician(req(db, { technician_id: "tech-1" }, "ops-1"), response());

  const resAllowed = response();
  getDispatchMaterialStatus(req(db, {}, "tech-1"), resAllowed);
  assert.equal(resAllowed.statusCode, 200);

  const resDenied = response();
  getDispatchMaterialStatus(req(db, {}, "tech-2"), resDenied);
  assert.equal(resDenied.statusCode, 403);
});

test("a Supervisor assigned to the dispatch can roster a Technician onto it", () => {
  const db = baseDb();
  const res = response();
  assignRosterTechnician(req(db, { technician_id: "tech-1" }, "sup-1"), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(db.dispatch_cards[0].assigned_technician_ids, ["tech-1"]);
});

test("a Supervisor NOT assigned to the dispatch cannot roster anyone onto it", () => {
  const db = baseDb();
  const res = response();
  assignRosterTechnician(req(db, { technician_id: "tech-1" }, "sup-2"), res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(db.dispatch_cards[0].assigned_technician_ids, []);
});

test("roster read lists only active Technicians with id/name/trade — no email or phone", () => {
  const db = baseDb();
  db.users[0].trade = "Fitter";
  assignRosterTechnician(req(db, { technician_id: "tech-1" }, "ops-1"), response());
  const res = response();
  getDispatchRoster(req(db, {}, "ops-1"), res);
  assert.equal(res.statusCode, 200);
  const ids = res.body.data.technicians.map((t) => t.id).sort();
  assert.deepEqual(ids, ["tech-1", "tech-2"], "inactive technicians must not be offered");
  const one = res.body.data.technicians.find((t) => t.id === "tech-1");
  assert.equal(one.on_roster, true);
  assert.equal(one.email, undefined);
});

test("a Technician cannot read the roster picker", () => {
  const db = baseDb();
  assert.throws(() => getDispatchRoster(req(db, {}, "tech-1"), response()), { status: 403 });
});

test("a Supervisor not assigned to the dispatch cannot read its roster picker", () => {
  const db = baseDb();
  const res = response();
  getDispatchRoster(req(db, {}, "sup-2"), res);
  assert.equal(res.statusCode, 403);
});
