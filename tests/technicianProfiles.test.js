import test from "node:test";
import assert from "node:assert/strict";
import { createDailyTimesheet } from "../src/controllers/dailyTimesheetController.js";
import { listTechnicianProfiles } from "../src/controllers/technicianProfilesController.js";
import { isArtisanProfile, isTechnicianRecord } from "../src/technicianProfiles.js";

function makeRes() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function makeDb() {
  return {
    users: [
      { id: "u_ops", role: "Operations", name: "Ops One", email: "ops@example.com", is_active: true },
      { id: "u_sup", role: "Supervisor", name: "Sup One", email: "sup@example.com", is_active: true },
      { id: "u_sales", role: "Sales", name: "Sales One", email: "sales@example.com", is_active: true },
      { id: "u_mgmt", role: "Management", name: "Mgmt One", email: "m@example.com", is_active: true },
      { id: "u_fin", role: "Finance", name: "Fin One", email: "f@example.com", is_active: true },
      { id: "u_tech", role: "Technician", name: "Reg Tech", email: "t@example.com", password_hash: "x", trade: "Fitter", is_active: true },
      // Artisan staff profiles: no email, no password_hash, no login.
      { id: "tech-01", first_name: "Tendai", last_name: "Moyo", national_id: "63-1234567-X-42", trade: "Boilermaker", worker_type: "permanent", is_active: true },
      { id: "tech-02", first_name: "Farai", last_name: "Chuma", national_id: "08-7654321-K-11", trade: "Coded Welder", worker_type: "contractor", is_active: true },
      { id: "tech-03", first_name: "Old", last_name: "Hand", national_id: "00-0000000-A-00", trade: "Rigger", worker_type: "permanent", is_active: false }
    ],
    daily_timesheets: [],
    audit_logs: []
  };
}

function makeStore() {
  let n = 0;
  return { id(p) { n += 1; return `${p}_${n}`; }, audit() {} };
}

const req = (db, userId, body = {}) => ({ db, store: makeStore(), user: { id: userId }, body, params: {} });
const entries = [{ date: "2026-10-27", start_time: "07:00", end_time: "16:00", normal_hours: 8, ot_15: "X", ot_20: "X" }];

test("a login-less artisan profile can be selected for a timesheet and the record carries name, trade and national ID", () => {
  const db = makeDb();
  assert.equal(db.users.find((u) => u.id === "tech-01").password_hash, undefined);
  const res = makeRes();
  createDailyTimesheet(req(db, "u_sup", { technician_id: "tech-01", name_on_form: "Tendai Moyo", entries }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.technician_id, "tech-01");
  assert.equal(res.body.data.worker_name, "Tendai Moyo");
  assert.equal(res.body.data.technician_trade, "Boilermaker");
  assert.equal(res.body.data.national_id, "63-1234567-X-42");
  assert.equal(db.daily_timesheets.length, 1);
});

test("contractor artisan profiles are also selectable", () => {
  const db = makeDb();
  const res = makeRes();
  createDailyTimesheet(req(db, "u_ops", { technician_id: "tech-02", name_on_form: "Farai Chuma", entries }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.technician_trade, "Coded Welder");
});

test("an inactive artisan profile cannot be assigned to a new timesheet", () => {
  const db = makeDb();
  const res = makeRes();
  createDailyTimesheet(req(db, "u_sup", { technician_id: "tech-03", name_on_form: "Old Hand", entries }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /active Technician/);
  assert.equal(db.daily_timesheets.length, 0);
});

test("an inactive registered Technician user is still refused", () => {
  const db = makeDb();
  db.users.find((u) => u.id === "u_tech").is_active = false;
  const res = makeRes();
  createDailyTimesheet(req(db, "u_sup", { technician_id: "u_tech", name_on_form: "Reg Tech", entries }), res);
  assert.equal(res.statusCode, 400);
});

test("non-technician accounts and unknown ids cannot be used as the technician", () => {
  const db = makeDb();
  for (const id of ["u_fin", "u_sup", "nope"]) {
    const res = makeRes();
    createDailyTimesheet(req(db, "u_ops", { technician_id: id, name_on_form: "x", entries }), res);
    assert.equal(res.statusCode, 400, id);
  }
  // A staff account does not become an artisan by carrying a worker_type.
  db.users.find((u) => u.id === "u_fin").worker_type = "permanent";
  assert.equal(isArtisanProfile(db.users.find((u) => u.id === "u_fin")), false);
});

test("a registered Technician filing their own sheet gets worker_name and trade; national_id is null when unset", () => {
  const db = makeDb();
  const res = makeRes();
  createDailyTimesheet(req(db, "u_tech", { name_on_form: "Reg Tech", entries }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.worker_name, "Reg Tech");
  assert.equal(res.body.data.technician_trade, "Fitter");
  assert.equal(res.body.data.national_id, null);
});

test("a sheet with no technician linked has null identity snapshot fields", () => {
  const db = makeDb();
  const res = makeRes();
  createDailyTimesheet(req(db, "u_ops", { name_on_form: "Walk-in", entries }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.worker_name, null);
  assert.equal(res.body.data.national_id, null);
});

test("GET technician-profiles returns active technicians with trade only, without credentials or identity/payment data", () => {
  const db = makeDb();
  const res = makeRes();
  listTechnicianProfiles(req(db, "u_sales"), res);
  assert.equal(res.statusCode, 200);
  const ids = res.body.data.map((p) => p.id).sort();
  assert.deepEqual(ids, ["tech-01", "tech-02", "u_tech"]); // tech-03 inactive, staff excluded
  const moyo = res.body.data.find((p) => p.id === "tech-01");
  assert.equal(moyo.name, "Tendai Moyo");
  assert.equal(moyo.trade, "Boilermaker");
  assert.equal("national_id" in moyo, false);
  assert.equal(moyo.worker_type, "permanent");
  assert.equal(moyo.has_login, false);
  assert.equal(res.body.data.find((p) => p.id === "u_tech").has_login, true);
  for (const p of res.body.data) {
    assert.equal("password_hash" in p, false);
    assert.equal("email" in p, false);
    assert.equal("phone_number" in p, false);
    assert.equal("bank_account" in p, false);
  }
});

test("GET technician-profiles is open to Admin/Management/Operations/Supervisor/Sales only", () => {
  const db = makeDb();
  db.users.push({ id: "u_admin", role: "Admin", name: "Admin", is_active: true });
  for (const id of ["u_admin", "u_mgmt", "u_ops", "u_sup", "u_sales"]) {
    const res = makeRes();
    listTechnicianProfiles(req(db, id), res);
    assert.equal(res.statusCode, 200, id);
  }
  for (const id of ["u_tech", "u_fin"]) {
    assert.throws(() => listTechnicianProfiles(req(db, id), makeRes()), /cannot perform/, id);
  }
});

test("artisan profiles have no email so they can never match a login lookup", () => {
  const db = makeDb();
  const profile = db.users.find((u) => u.id === "tech-01");
  assert.equal(isTechnicianRecord(profile), true);
  assert.equal(profile.email, undefined);
  assert.equal(String(profile.email || "").trim().toLowerCase() === "ops@example.com", false);
});
