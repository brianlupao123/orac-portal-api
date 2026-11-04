import test from "node:test";
import assert from "node:assert/strict";
import {
  acknowledgeInternalWorkRequest, createInternalWorkRequest, getInternalWorkRequest, getInternalWorkRequestOptions,
  listInternalWorkRequestInbox, listInternalWorkRequestOutbox, transitionInternalWorkRequest
} from "../src/controllers/internalWorkRequestsController.js";
import { approveTechnicianRegistration } from "../src/controllers/technicianRegistrationController.js";
import { CreateInternalWorkRequestSchema } from "../src/schemas.js";
import { TECHNICIAN_TRADES, isTechnicianTrade } from "../src/trades.js";
import { ALL_ROLES, ROLE_USER, VALID_TECHNICIAN_PAYLOAD, makeDb, makeStore, run, seedRequest, validBody } from "./helpers/internalWorkRequestsFixture.js";

const TYPE = "NEW_TECHNICIAN_REGISTRATION";
const P = VALID_TECHNICIAN_PAYLOAD;
const submit = (db, store, body = validBody(TYPE, "Admin"), userId = "u_supervisor") => run(createInternalWorkRequest, db, store, userId, { body });
const approve = (db, store, userId, id) => run(approveTechnicianRegistration, db, store, userId, { params: { id }, body: {} });
const ack = (db, store, userId, id) => run(acknowledgeInternalWorkRequest, db, store, userId, { params: { id }, body: {} });
const transition = (db, store, userId, id, action, note) => run(transitionInternalWorkRequest, db, store, userId, { params: { id }, body: { action, ...(note === undefined ? {} : { note }) } });
const get = (db, store, userId, id) => run(getInternalWorkRequest, db, store, userId, { params: { id } });
const inbox = (db, store, userId) => run(listInternalWorkRequestInbox, db, store, userId, {});
const outbox = (db, store, userId) => run(listInternalWorkRequestOutbox, db, store, userId, {});

// Everything an approval must leave alone (users and audit_logs are checked on their own).
const OTHER_COLLECTIONS = ["quotes", "quote_lines", "purchase_orders", "dispatch_cards", "field_worksheets", "timesheets", "material_usage",
  "invoices", "invoice_lines", "stock_items", "stock_movements", "suppliers", "leads", "clients"];
const snapshotOthers = (db) => JSON.stringify(OTHER_COLLECTIONS.map((key) => db[key]));

function pending() {
  const db = makeDb(); const store = makeStore(db);
  const created = submit(db, store);
  assert.equal(created.statusCode, 201, created.body?.message);
  return { db, store, id: created.body.data.id };
}

// --- raising the request -----------------------------------------------------
test("a Supervisor raises a registration for Admin; the server stores the details and writes the words", () => {
  const db = makeDb(); const store = makeStore(db);
  const res = submit(db, store, { ...validBody(TYPE, "Admin"), payload: { ...P, first_name: "  Tendai ", last_name: "Moyo", phone_number: " +263  77 123 4567 " } });
  assert.equal(res.statusCode, 201, res.body?.message);
  const [stored] = db.internal_work_requests;
  assert.equal(stored.request_type, TYPE);
  assert.equal(stored.created_by_user_id, "u_supervisor");
  assert.equal(stored.recipient_role, "Admin");
  assert.equal(stored.status, "Submitted");
  assert.deepEqual(stored.payload, { ...P });
  assert.equal(stored.registered_user_id, null);
  assert.equal(stored.subject, "Register technician: Tendai Moyo (Welder)");
  assert.equal(stored.description, "Please add Tendai Moyo to the Technician Registry as a contractor Welder.");
  assert.equal(stored.related_entity_type, null);
  assert.equal(stored.client_id, null);
  assert.equal(res.body.data.payload.national_id, P.national_id);
});

test("the recipient defaults to Admin, and any other recipient is refused", () => {
  const db = makeDb(); const store = makeStore(db);
  const noRecipient = submit(db, store, { request_type: TYPE, payload: { ...P } });
  assert.equal(noRecipient.statusCode, 201);
  assert.equal(noRecipient.body.data.recipient_role, "Admin");
  for (const recipient of ["Management", "Operations", "Supervisor", "Technician"]) {
    assert.equal(submit(db, store, validBody(TYPE, recipient)).statusCode, 403, `to ${recipient}`);
  }
  assert.equal(db.internal_work_requests.length, 1);
});

test("only a Supervisor may raise one: every other role is refused and nothing is written", () => {
  for (const role of ALL_ROLES.filter((r) => r !== "Supervisor")) {
    const db = makeDb(); const store = makeStore(db);
    const res = submit(db, store, validBody(TYPE, "Admin"), ROLE_USER[role]);
    assert.equal(res.statusCode, 403, `${role} must not raise a technician registration`);
    assert.equal(db.internal_work_requests.length, 0);
    assert.equal(db.audit_logs.length, 0);
  }
});

test("malformed registrations are refused with 400 and nothing is stored", () => {
  const bad = {
    "no payload": { request_type: TYPE },
    "payload is a list": { request_type: TYPE, payload: [] },
    "payload is text": { request_type: TYPE, payload: "Tendai Moyo" },
    "extra payload key": { request_type: TYPE, payload: { ...P, role: "Admin" } },
    "missing first name": { request_type: TYPE, payload: { ...P, first_name: undefined } },
    "blank last name": { request_type: TYPE, payload: { ...P, last_name: "   " } },
    "digits in a name": { request_type: TYPE, payload: { ...P, first_name: "T3ndai" } },
    "name too long": { request_type: TYPE, payload: { ...P, last_name: "M".repeat(51) } },
    "national id too short": { request_type: TYPE, payload: { ...P, national_id: "12345" } },
    "national id too long": { request_type: TYPE, payload: { ...P, national_id: "1".repeat(21) } },
    "national id with symbols": { request_type: TYPE, payload: { ...P, national_id: "63/123456<A>" } },
    "national id is a number": { request_type: TYPE, payload: { ...P, national_id: 63123456 } },
    "unknown trade": { request_type: TYPE, payload: { ...P, trade: "Astronaut" } },
    "trade in the wrong case": { request_type: TYPE, payload: { ...P, trade: "welder" } },
    "unknown worker type": { request_type: TYPE, payload: { ...P, worker_type: "temp" } },
    "worker type in the wrong case": { request_type: TYPE, payload: { ...P, worker_type: "Permanent" } },
    "phone too short": { request_type: TYPE, payload: { ...P, phone_number: "12345" } },
    "phone with letters": { request_type: TYPE, payload: { ...P, phone_number: "call me maybe" } },
    "free-text subject": { request_type: TYPE, subject: "Tendai", payload: { ...P } },
    "free-text description": { request_type: TYPE, description: "ID 63-123456 A 42", payload: { ...P } },
    "related record": { request_type: TYPE, related_entity_type: "quote", related_entity_id: "q_a", payload: { ...P } },
    "bad priority": { request_type: TYPE, priority: "Whenever", payload: { ...P } },
    "payload on another type": { ...validBody("ADMINISTRATIVE_SUPPORT", "Admin"), payload: { ...P } }
  };
  for (const [label, body] of Object.entries(bad)) {
    const db = makeDb(); const store = makeStore(db);
    const res = submit(db, store, body);
    assert.equal(res.statusCode, 400, `${label}: ${res.body?.message}`);
    assert.equal(res.body.success, false);
    assert.equal(db.internal_work_requests.length, 0, label);
    assert.equal(db.audit_logs.length, 0, label);
  }
});

test("every trade the registry knows (including Welder and Rigger) is accepted, and each worker type", () => {
  assert.ok(TECHNICIAN_TRADES.includes("Welder") && TECHNICIAN_TRADES.includes("Rigger"));
  for (const trade of TECHNICIAN_TRADES) {
    const db = makeDb(); const store = makeStore(db);
    assert.equal(submit(db, store, { request_type: TYPE, payload: { ...P, trade } }).statusCode, 201, trade);
  }
  for (const worker_type of ["permanent", "contractor"]) {
    const db = makeDb(); const store = makeStore(db);
    assert.equal(submit(db, store, { request_type: TYPE, payload: { ...P, worker_type } }).statusCode, 201, worker_type);
  }
});

test("the route schema is strict about the payload and keeps subject and description required for every other type", () => {
  const body = { request_type: TYPE, payload: { ...P } };
  assert.equal(CreateInternalWorkRequestSchema.safeParse(body).success, true);
  assert.equal(CreateInternalWorkRequestSchema.safeParse({ ...body, payload: { ...P, extra: "x" } }).success, false);
  assert.equal(CreateInternalWorkRequestSchema.safeParse({ ...body, payload: { ...P, trade: 7 } }).success, false);
  assert.equal(CreateInternalWorkRequestSchema.safeParse({ ...body, created_by_user_id: "u_admin" }).success, false);
  assert.equal(CreateInternalWorkRequestSchema.safeParse({ request_type: "STOCK_AVAILABILITY" }).success, false, "subject and description are still required");
  assert.equal(CreateInternalWorkRequestSchema.safeParse({ request_type: "STOCK_AVAILABILITY", subject: "a", description: "b" }).success, true);
});

test("the create options hand the form its trades and worker types, and only to a Supervisor", () => {
  const db = makeDb(); const store = makeStore(db);
  const supervisor = run(getInternalWorkRequestOptions, db, store, "u_supervisor");
  const entry = supervisor.body.data.types.find((type) => type.request_type === TYPE);
  assert.deepEqual(entry.recipients, ["Admin"]);
  assert.deepEqual(entry.technician_registration.trades, TECHNICIAN_TRADES);
  assert.deepEqual(entry.technician_registration.worker_types, ["permanent", "contractor"]);
  assert.equal(entry.technician_registration.limits.name, 50);
  for (const role of ["Sales", "Finance", "Operations", "Technician", "Management"]) {
    const types = run(getInternalWorkRequestOptions, db, store, ROLE_USER[role]).body.data.types;
    assert.equal(types.some((type) => type.request_type === TYPE), false, `${role} is not offered it`);
  }
  for (const type of supervisor.body.data.types.filter((t) => t.request_type !== TYPE)) assert.equal("technician_registration" in type, false);
});

test("raising a request writes no national ID or phone number into the audit log", () => {
  const { db } = pending();
  const audit = JSON.stringify(db.audit_logs);
  assert.equal(db.audit_logs.length, 1);
  assert.equal(audit.includes("123456"), false);
  assert.equal(audit.includes("77 123"), false);
  assert.equal(audit.includes("Tendai"), false);
});

// --- who sees it ---------------------------------------------------------------
test("the details are visible to the Supervisor who raised it and to Admin, and to nobody else", () => {
  const { db, store, id } = pending();
  assert.equal(outbox(db, store, "u_supervisor").body.data[0].payload.national_id, P.national_id);
  const adminRow = inbox(db, store, "u_admin").body.data[0];
  assert.equal(adminRow.id, id);
  assert.equal(adminRow.payload.first_name, "Tendai");
  assert.deepEqual(adminRow.allowed_actions, ["approve_registration", "acknowledge", "reject"]);
  assert.equal(get(db, store, "u_admin2", id).statusCode, 200, "any Admin can open it");
  for (const user of ["u_supervisor2", "u_ops", "u_management", "u_sales", "u_finance", "u_tech", "u_client_a"]) {
    assert.notEqual(get(db, store, user, id).statusCode, 200, `${user} must not read the details`);
  }
  for (const user of ["u_ops", "u_management", "u_sales", "u_finance"]) {
    assert.deepEqual(inbox(db, store, user).body?.data, [], `${user} inbox`);
  }
  assert.deepEqual(outbox(db, store, "u_supervisor2").body.data, []);
});

test("other request types keep their exact view shape (no payload key)", () => {
  const db = makeDb(); const store = makeStore(db);
  seedRequest(db, { request_type: "ADMINISTRATIVE_SUPPORT", recipient_role: "Admin", created_by_user_id: "u_supervisor", created_by_role: "Supervisor", related_entity_type: null, related_entity_id: null, client_id: null });
  const view = get(db, store, "u_admin", db.internal_work_requests[0].id).body.data;
  assert.equal("payload" in view, false);
  assert.equal("registered_user_id" in view, false);
});

// --- approving -----------------------------------------------------------------
test("approve from Submitted: creates the technician from the request, completes it, in one step", () => {
  const { db, store, id } = pending();
  const others = snapshotOthers(db);
  const usersBefore = db.users.length;
  const res = approve(db, store, "u_admin", id);
  assert.equal(res.statusCode, 200, res.body?.message);

  assert.equal(db.users.length, usersBefore + 1);
  const user = db.users.at(-1);
  assert.deepEqual(user, {
    id: user.id, name: "Tendai Moyo", email: null, role: "Technician", is_active: true, client_id: null,
    trade: "Welder", worker_type: "contractor", national_id: P.national_id, phone_number: P.phone_number,
    password_hash: null, registered_via_request_id: id, created_at: user.created_at
  });
  assert.equal(isTechnicianTrade(user.trade), true);

  const record = db.internal_work_requests[0];
  assert.equal(record.status, "Completed");
  assert.equal(record.registered_user_id, user.id);
  assert.equal(record.assigned_to_user_id, "u_admin");
  assert.equal(record.resolved_by_user_id, "u_admin");
  assert.ok(record.acknowledged_at && record.resolved_at);
  assert.equal(record.resolution_note, "Approved and added to the Technician Registry.");
  assert.deepEqual(record.history.map((h) => [h.action, h.from_status, h.to_status]), [
    ["submit", null, "Submitted"], ["acknowledge", "Submitted", "Acknowledged"], ["approve_registration", "Acknowledged", "Completed"]
  ]);

  assert.equal(res.body.data.status, "Completed");
  assert.deepEqual(res.body.data.allowed_actions, []);
  assert.equal(res.body.data.registered_user_id, user.id);
  assert.deepEqual(res.body.data.technician, { id: user.id, name: "Tendai Moyo", role: "Technician", trade: "Welder", worker_type: "contractor" });
  assert.equal(snapshotOthers(db), others, "no quote, PO, dispatch, invoice, stock, timesheet or client changed");
});

test("approval audits the account and the request, with no national ID, phone number or credentials", () => {
  const { db, store, id } = pending();
  approve(db, store, "u_admin", id);
  const [, accountAudit, requestAudit] = db.audit_logs;
  assert.equal(accountAudit.action, "TECHNICIAN_REGISTERED_FROM_REQUEST");
  assert.equal(accountAudit.entity_type, "user");
  assert.deepEqual(accountAudit.new_values, {
    id: db.users.at(-1).id, name: "Tendai Moyo", role: "Technician", trade: "Welder", worker_type: "contractor", source_request_id: id, has_national_id: true
  });
  assert.equal(requestAudit.action, "INTERNAL_WORK_REQUEST_COMPLETED");
  assert.equal(requestAudit.new_values.status, "Completed");
  assert.equal(requestAudit.new_values.created_by_user_id, "u_supervisor", "so the Supervisor is notified");
  const everything = JSON.stringify(db.audit_logs);
  for (const secret of ["63-123456", "123456 A", "77 123", "password"]) assert.equal(everything.includes(secret), false, secret);
});

test("approve after claiming, by the same Admin, works; a different Admin cannot take over a claimed request", () => {
  const first = pending();
  assert.equal(ack(first.db, first.store, "u_admin", first.id).statusCode, 200);
  assert.deepEqual(get(first.db, first.store, "u_admin", first.id).body.data.allowed_actions, ["approve_registration", "start", "reject"]);
  assert.equal(approve(first.db, first.store, "u_admin", first.id).statusCode, 200);
  assert.deepEqual(first.db.internal_work_requests[0].history.map((h) => h.action), ["submit", "acknowledge", "approve_registration"]);

  const second = pending();
  ack(second.db, second.store, "u_admin", second.id);
  const usersBefore = second.db.users.length;
  assert.equal(approve(second.db, second.store, "u_admin2", second.id).statusCode, 403);
  assert.equal(second.db.users.length, usersBefore);
  assert.equal(second.db.internal_work_requests[0].status, "Acknowledged");

  const third = pending();
  ack(third.db, third.store, "u_admin", third.id);
  transition(third.db, third.store, "u_admin", third.id, "start");
  assert.deepEqual(get(third.db, third.store, "u_admin", third.id).body.data.allowed_actions, ["approve_registration"]);
  assert.equal(approve(third.db, third.store, "u_admin", third.id).statusCode, 200);
});

test("approving twice creates one technician, and the second call is a 409", () => {
  const { db, store, id } = pending();
  const usersBefore = db.users.length;
  assert.equal(approve(db, store, "u_admin", id).statusCode, 200);
  const again = approve(db, store, "u_admin", id);
  assert.equal(again.statusCode, 409);
  assert.match(again.body.message, /already been approved/);
  assert.equal(db.users.length, usersBefore + 1);
  assert.equal(db.audit_logs.length, 3, "the refused second call audits nothing");
});

test("a national ID already registered (any spacing, dashes or case, any status) refuses the approval and changes nothing", () => {
  for (const existing of ["63-123456 A 42", "63123456a42", " 63 123456-a-42 "]) {
    const { db, store, id } = pending();
    db.users.push({ id: "u_existing", name: "Someone Else", role: "Technician", is_active: false, national_id: existing });
    const usersBefore = JSON.stringify(db.users);
    const auditsBefore = db.audit_logs.length;
    const res = approve(db, store, "u_admin", id);
    assert.equal(res.statusCode, 409, existing);
    assert.match(res.body.message, /already registered/);
    assert.equal(JSON.stringify(db.users), usersBefore);
    assert.equal(db.audit_logs.length, auditsBefore);
    assert.equal(db.internal_work_requests[0].status, "Submitted", "left open so Admin can reject it with a reason");
    assert.deepEqual(get(db, store, "u_admin", id).body.data.allowed_actions, ["approve_registration", "acknowledge", "reject"]);
  }
});

test("a different ID is not mistaken for a duplicate", () => {
  const { db, store, id } = pending();
  db.users.push({ id: "u_existing", name: "Someone Else", role: "Technician", is_active: true, national_id: "63-123457 A 42" });
  assert.equal(approve(db, store, "u_admin", id).statusCode, 200);
});

test("only an Admin may approve: every other role, and an inactive or unknown account, gets 403 and no technician is created", () => {
  for (const role of ALL_ROLES.filter((r) => r !== "Admin")) {
    const { db, store, id } = pending();
    const usersBefore = db.users.length;
    const res = approve(db, store, ROLE_USER[role], id);
    assert.equal(res.statusCode, 403, `${role} must not approve`);
    assert.equal(db.users.length, usersBefore);
    assert.equal(db.internal_work_requests[0].status, "Submitted");
  }
  const { db, store, id } = pending();
  db.users.find((u) => u.id === "u_admin2").is_active = false;
  assert.equal(approve(db, store, "u_admin2", id).statusCode, 403, "inactive Admin fails closed");
  assert.equal(approve(db, store, "u_nobody", id).statusCode, 403, "unknown account fails closed");
});

test("the Supervisor who raised it cannot approve their own request", () => {
  const { db, store, id } = pending();
  // Even if the account were (wrongly) given the Admin permissions, the requester is never the recipient.
  const supervisor = db.users.find((u) => u.id === "u_supervisor");
  supervisor.role = "Admin";
  assert.equal(approve(db, store, "u_supervisor", id).statusCode, 403);
  assert.equal(db.users.filter((u) => u.national_id).length, 0);
});

test("approve refuses an unknown id (404), a request that is not a registration (400), and closed requests (409)", () => {
  const { db, store, id } = pending();
  assert.equal(approve(db, store, "u_admin", "iwr_missing").statusCode, 404);
  const other = seedRequest(db, { request_type: "ADMINISTRATIVE_SUPPORT", recipient_role: "Admin", created_by_user_id: "u_supervisor", created_by_role: "Supervisor", related_entity_type: null, related_entity_id: null, client_id: null });
  const wrongType = approve(db, store, "u_admin", other.id);
  assert.equal(wrongType.statusCode, 400);
  assert.equal(other.status, "Submitted");

  assert.equal(transition(db, store, "u_supervisor", id, "cancel", "wrong person").statusCode, 200);
  const cancelled = approve(db, store, "u_admin", id);
  assert.equal(cancelled.statusCode, 409);
  assert.match(cancelled.body.message, /Cancelled/);
  assert.equal(db.users.some((u) => u.national_id), false);

  const rejected = pending();
  assert.equal(transition(rejected.db, rejected.store, "u_admin", rejected.id, "reject").statusCode, 400, "a reason is required");
  ack(rejected.db, rejected.store, "u_admin", rejected.id);
  assert.equal(transition(rejected.db, rejected.store, "u_admin", rejected.id, "reject", "ID does not match the card").statusCode, 200);
  assert.equal(approve(rejected.db, rejected.store, "u_admin", rejected.id).statusCode, 409);
  assert.equal(rejected.db.users.some((u) => u.national_id), false);
});

test("a registration cannot be completed by hand: only approval completes it", () => {
  const { db, store, id } = pending();
  ack(db, store, "u_admin", id);
  const usersBefore = db.users.length;
  const res = transition(db, store, "u_admin", id, "complete", "done");
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Approve this request/);
  assert.equal(db.users.length, usersBefore);
  assert.equal(db.internal_work_requests[0].status, "Acknowledged");
  for (const state of [["Submitted", null], ["Acknowledged", "u_admin"], ["In Progress", "u_admin"]]) {
    const fresh = pending();
    Object.assign(fresh.db.internal_work_requests[0], { status: state[0], assigned_to_user_id: state[1] });
    assert.equal(get(fresh.db, fresh.store, "u_admin", fresh.id).body.data.allowed_actions.includes("complete"), false, state[0]);
  }
});

test("damaged stored details cannot create an account", () => {
  for (const damage of [{ trade: "Hacker" }, { worker_type: "owner" }, { national_id: "1" }, { first_name: "" }, { extra: "x" }]) {
    const { db, store, id } = pending();
    Object.assign(db.internal_work_requests[0].payload, damage);
    const usersBefore = db.users.length;
    const res = approve(db, store, "u_admin", id);
    assert.equal(res.statusCode, 409, JSON.stringify(damage));
    assert.equal(db.users.length, usersBefore);
  }
  const { db, store, id } = pending();
  delete db.internal_work_requests[0].payload;
  assert.equal(approve(db, store, "u_admin", id).statusCode, 409);
});

test("the account is built from the stored request and ignores anything in the approve call", () => {
  const { db, store, id } = pending();
  const res = run(approveTechnicianRegistration, db, store, "u_admin", {
    params: { id },
    body: { role: "Admin", trade: "Electrician", name: "Forged Name", national_id: "00-000000 Z 00", email: "x@y.z", password: "longenoughpassword", is_active: false }
  });
  assert.equal(res.statusCode, 200);
  const user = db.users.at(-1);
  assert.equal(user.role, "Technician");
  assert.equal(user.trade, "Welder");
  assert.equal(user.name, "Tendai Moyo");
  assert.equal(user.national_id, P.national_id);
  assert.equal(user.email, null);
  assert.equal(user.password_hash, null);
  assert.equal(user.is_active, true);
});

test("all or nothing: if either audit write fails, no account, no request change and no stray audit or notification remains", () => {
  for (const failOnAuditCall of [2, 3]) {
    const db = makeDb(); const store = makeStore(db, { failOnAuditCall });
    const created = submit(db, store);
    assert.equal(created.statusCode, 201);
    db.notifications.push({ id: "n_existing" });
    const request = JSON.stringify(db.internal_work_requests[0]);
    const users = JSON.stringify(db.users);
    const audits = db.audit_logs.length;
    assert.throws(() => approve(db, store, "u_admin", created.body.data.id), /audit hook failure/);
    assert.equal(JSON.stringify(db.users), users, `audit call ${failOnAuditCall}: users restored`);
    assert.equal(JSON.stringify(db.internal_work_requests[0]), request, `audit call ${failOnAuditCall}: request restored`);
    assert.equal(db.audit_logs.length, audits);
    assert.equal(db.notifications.length, 1);
  }
});

test("a second request for a person who is already registered is refused, then rejected cleanly", () => {
  const db = makeDb(); const store = makeStore(db);
  const first = submit(db, store).body.data.id;
  const second = submit(db, store).body.data.id;
  assert.equal(approve(db, store, "u_admin", first).statusCode, 200);
  assert.equal(approve(db, store, "u_admin", second).statusCode, 409);
  assert.equal(transition(db, store, "u_admin", second, "reject", "Already registered").statusCode, 200);
  assert.equal(db.users.filter((u) => u.national_id).length, 1);
});
