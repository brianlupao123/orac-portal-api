import test from "node:test";
import assert from "node:assert/strict";
import {
  acknowledgeInternalWorkRequest, createInternalWorkRequest, getInternalWorkRequest, getInternalWorkRequestOptions,
  listInternalWorkRequestInbox, listInternalWorkRequestOutbox, resolveRelatedEntity, transitionInternalWorkRequest
} from "../src/controllers/internalWorkRequestsController.js";
import { CreateInternalWorkRequestSchema, TransitionInternalWorkRequestSchema } from "../src/schemas.js";
import { INTERNAL_WORK_REQUEST_POLICY, INTERNAL_WORK_REQUEST_TYPE_CODES, RELATED_ENTITY_TYPES, pairingRows } from "../src/internalWorkRequestRules.js";
import { collectionGuards } from "../src/controllers/coreController.js";
import { ALL_ROLES, RECORD_KEYS, RELATED_ID, ROLE_USER, makeDb, makeStore, run, seedRequest, snapshotUntouchable, validBody } from "./helpers/internalWorkRequestsFixture.js";

const create = (db, store, userId, body) => run(createInternalWorkRequest, db, store, userId, { body });
const ack = (db, store, userId, id) => run(acknowledgeInternalWorkRequest, db, store, userId, { params: { id }, body: {} });
const act = (db, store, userId, id, action, note) => run(transitionInternalWorkRequest, db, store, userId, { params: { id }, body: { action, ...(note === undefined ? {} : { note }) } });
const get = (db, store, userId, id) => run(getInternalWorkRequest, db, store, userId, { params: { id } });
const inbox = (db, store, userId, query) => run(listInternalWorkRequestInbox, db, store, userId, { query });
const outbox = (db, store, userId, query) => run(listInternalWorkRequestOutbox, db, store, userId, { query });
const ids = (res) => res.body.data.map((item) => item.id);
const readable = (senderRole, type) => INTERNAL_WORK_REQUEST_POLICY[type].related_entity_types.find((related) => collectionGuards[RELATED_ENTITY_TYPES[related].collection].includes(senderRole));

// --- 1. sender / type / recipient allow-list -------------------------------
test("every permitted requester/type/recipient pair succeeds and every other combination is 403", () => {
  const allowed = new Set(pairingRows().map((row) => `${row.type}|${row.sender}|${row.recipient}`));
  let succeeded = 0;
  let refused = 0;
  for (const senderRole of ALL_ROLES) {
    for (const type of INTERNAL_WORK_REQUEST_TYPE_CODES) {
      for (const recipient of ALL_ROLES) {
        const db = makeDb(); const store = makeStore(db);
        const related = readable(senderRole, type);
        const res = create(db, store, ROLE_USER[senderRole], validBody(type, recipient, related));
        if (allowed.has(`${type}|${senderRole}|${recipient}`)) {
          assert.equal(res.statusCode, 201, `${senderRole} -> ${recipient} ${type}: ${res.body?.message}`);
          assert.equal(db.internal_work_requests.length, 1);
          succeeded += 1;
        } else {
          assert.equal(res.statusCode, 403, `${senderRole} -> ${recipient} ${type} must be refused`);
          assert.equal(res.body.success, false);
          assert.equal(db.internal_work_requests.length, 0);
          assert.equal(db.audit_logs.length, 0, "a refused request writes no audit event");
          refused += 1;
        }
      }
    }
  }
  assert.equal(succeeded, allowed.size);
  assert.equal(succeeded + refused, ALL_ROLES.length * INTERNAL_WORK_REQUEST_TYPE_CODES.length * ALL_ROLES.length);
});

test("Client Viewer and Admin can never create, list, read or act on internal work requests", () => {
  for (const role of ["Client Viewer"]) {
    const db = makeDb(); const store = makeStore(db); const seeded = seedRequest(db);
    const user = ROLE_USER[role];
    assert.equal(create(db, store, user, validBody("STOCK_AVAILABILITY", "Operations", "quote")).statusCode, 403);
    assert.equal(outbox(db, store, user).statusCode, 403);
    assert.equal(inbox(db, store, user).statusCode, 403);
    assert.equal(get(db, store, user, seeded.id).statusCode, 403);
    assert.equal(ack(db, store, user, seeded.id).statusCode, 403);
    assert.equal(act(db, store, user, seeded.id, "cancel", "x").statusCode, 403);
    assert.equal(run(getInternalWorkRequestOptions, db, store, user).statusCode, 403);
  }
  const db = makeDb(); const store = makeStore(db);
  assert.equal(create(db, store, "u_admin", validBody("ADMINISTRATIVE_SUPPORT", "Management")).statusCode, 403, "Admin is not a requester");
  assert.equal(outbox(db, store, "u_admin").statusCode, 403);
  assert.equal(run(getInternalWorkRequestOptions, db, store, "u_admin").statusCode, 403);
  assert.equal(create(db, store, "u_nobody", validBody("STOCK_AVAILABILITY", "Operations", "quote")).statusCode, 403, "unknown account fails closed");
  assert.equal(create(db, store, "u_ops_off", validBody("STOCK_FULFILMENT", "Operations", "quote")).statusCode, 403, "inactive account fails closed");
});

// --- 2. server-owned fields --------------------------------------------------
test("creator, role, client, status, assignee, history and timestamps come from the server, never the body", () => {
  const db = makeDb(); const store = makeStore(db);
  const res = create(db, store, "u_sales", {
    ...validBody("STOCK_AVAILABILITY", "Operations", "quote"),
    id: "iwr_forged", created_by_user_id: "u_admin", created_by_role: "Admin", client_id: "c_b", status: "Completed",
    assigned_to_user_id: "u_ops", acknowledged_at: "2020-01-01T00:00:00.000Z", resolution_note: "pre-approved", resolved_by_user_id: "u_ops",
    resolved_at: "2020-01-01T00:00:00.000Z", history: [{ to_status: "Completed" }], created_at: "2000-01-01T00:00:00.000Z", updated_at: "2000-01-01T00:00:00.000Z"
  });
  assert.equal(res.statusCode, 201);
  const [stored] = db.internal_work_requests;
  assert.deepEqual(Object.keys(stored).sort(), RECORD_KEYS);
  assert.equal(stored.id, "iwr_1");
  assert.equal(stored.created_by_user_id, "u_sales");
  assert.equal(stored.created_by_role, "Sales");
  assert.equal(stored.client_id, "c_a", "client derives from the related quote");
  assert.equal(stored.status, "Submitted");
  assert.equal(stored.assigned_to_user_id, null);
  assert.equal(stored.acknowledged_at, null);
  assert.equal(stored.resolution_note, null);
  assert.equal(stored.resolved_by_user_id, null);
  assert.equal(stored.resolved_at, null);
  assert.equal(stored.created_at, stored.updated_at);
  assert.notEqual(stored.created_at, "2000-01-01T00:00:00.000Z");
  assert.equal(stored.priority, "Normal");
  assert.equal(stored.history.length, 1);
  assert.deepEqual([stored.history[0].action, stored.history[0].actor_user_id, stored.history[0].from_status, stored.history[0].to_status], ["submit", "u_sales", null, "Submitted"]);
});

test("the route schemas are strict: forged identity, tenant, status and history keys are rejected outright", () => {
  const good = validBody("STOCK_AVAILABILITY", "Operations", "quote");
  assert.equal(CreateInternalWorkRequestSchema.safeParse(good).success, true);
  for (const key of ["id", "created_by_user_id", "created_by_role", "client_id", "status", "assigned_to_user_id", "history", "created_at", "resolved_at", "resolution_note", "office", "tenant_id", "sender_role"]) {
    assert.equal(CreateInternalWorkRequestSchema.safeParse({ ...good, [key]: "forged" }).success, false, `${key} must be rejected`);
  }
  assert.equal(CreateInternalWorkRequestSchema.safeParse({ ...good, request_type: "GENERIC_MESSAGE" }).success, false);
  assert.equal(CreateInternalWorkRequestSchema.safeParse({ ...good, recipient_role: "Everyone" }).success, false);
  assert.equal(TransitionInternalWorkRequestSchema.safeParse({ action: "complete", note: "ok" }).success, true);
  for (const bad of [{ action: "complete", status: "Completed" }, { action: "reopen" }, { action: "acknowledge" }, { status: "Completed" }, { action: "cancel", assigned_to_user_id: "u_ops" }]) {
    assert.equal(TransitionInternalWorkRequestSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

// --- 3. related record resolution -------------------------------------------
test("client and related record are resolved server-side for two clients and every record kind", () => {
  const db = makeDb(); const store = makeStore(db);
  const cases = [
    ["Sales", "STOCK_FULFILMENT", "Operations", "quote", "q_a", "c_a"],
    ["Sales", "STOCK_FULFILMENT", "Operations", "quote", "q_b", "c_b"],
    ["Finance", "PO_AMENDMENT_CONFIRMATION", "Sales", "purchase_order", "po_a", "c_a"],
    ["Finance", "PO_AMENDMENT_CONFIRMATION", "Sales", "purchase_order", "po_b", "c_b"],
    ["Finance", "PO_AMENDMENT_CONFIRMATION", "Operations", "invoice", "inv_a", "c_a"],
    ["Operations", "MATERIAL_RECONCILIATION", "Finance", "dispatch_card", "job_b", "c_b"],
    ["Operations", "MATERIAL_RECONCILIATION", "Finance", "stock_item", "si_1", null]
  ];
  for (const [role, type, recipient, relatedType, relatedId, expectedClient] of cases) {
    const res = create(db, store, ROLE_USER[role], { request_type: type, subject: "s", description: "d", recipient_role: recipient, related_entity_type: relatedType, related_entity_id: relatedId });
    assert.equal(res.statusCode, 201, `${role} ${type} ${relatedType}: ${res.body.message}`);
    assert.equal(db.internal_work_requests.at(-1).client_id, expectedClient, `${relatedType} ${relatedId}`);
  }
});

test("a related record must be allow-listed for the type and readable by THIS requester; refusals do not leak", () => {
  const db = makeDb(); const store = makeStore(db);
  const attempt = (userId, body) => create(db, store, userId, body);
  const base = (over) => ({ request_type: "FIELD_CLARIFICATION", subject: "s", description: "d", recipient_role: "Operations", ...over });

  // Technician: own assigned dispatch OK, another technician's dispatch refused.
  assert.equal(attempt("u_tech", base({ related_entity_type: "dispatch_card", related_entity_id: "job_a" })).statusCode, 201);
  const other = attempt("u_tech", base({ related_entity_type: "dispatch_card", related_entity_id: "job_b" }));
  const missing = attempt("u_tech", base({ related_entity_type: "dispatch_card", related_entity_id: "job_nope" }));
  assert.equal(other.statusCode, 400);
  assert.equal(missing.statusCode, 400);
  assert.deepEqual(other.body, missing.body, "unassigned and non-existent records give the same answer");
  assert.equal(attempt("u_supervisor", base({ related_entity_type: "dispatch_card", related_entity_id: "job_b" })).statusCode, 400);
  assert.equal(attempt("u_supervisor", base({ related_entity_type: "dispatch_card", related_entity_id: "job_a" })).statusCode, 201);

  // Type not allowed for this request type.
  assert.equal(attempt("u_tech", base({ related_entity_type: "quote", related_entity_id: "q_a" })).statusCode, 400);
  assert.equal(attempt("u_sales", { ...base({ request_type: "STOCK_AVAILABILITY" }), related_entity_type: "purchase_order", related_entity_id: "po_a" }).statusCode, 400);
  // Sales can now read stock items, so can attach one to a type that lists them.
  assert.equal(attempt("u_sales", { ...base({ request_type: "STOCK_FULFILMENT" }), related_entity_type: "stock_item", related_entity_id: "si_1" }).statusCode, 201);
  // Operations cannot read invoices today; archived stock items are unavailable to everyone.
  assert.equal(attempt("u_ops", { ...base({ request_type: "COMMERCIAL_CLARIFICATION", recipient_role: "Sales" }), related_entity_type: "invoice", related_entity_id: "inv_a" }).statusCode, 400);
  assert.equal(attempt("u_ops", { ...base({ request_type: "STOCK_FULFILMENT" }), related_entity_type: "stock_item", related_entity_id: "si_archived" }).statusCode, 400);
  // Wrong kind for the id (a quote id presented as a PO).
  assert.equal(attempt("u_finance", { ...base({ request_type: "PO_AMENDMENT_CONFIRMATION", recipient_role: "Sales" }), related_entity_type: "purchase_order", related_entity_id: "q_a" }).statusCode, 400);
  assert.equal(db.internal_work_requests.length, 3, "only the three permitted requests were created");
});

test("required, forbidden and half-specified related records are 400", () => {
  const db = makeDb(); const store = makeStore(db);
  assert.equal(create(db, store, "u_finance", validBody("PO_AMENDMENT_CONFIRMATION", "Sales")).statusCode, 400, "required record missing");
  assert.equal(create(db, store, "u_ops", validBody("MATERIAL_RECONCILIATION", "Finance")).statusCode, 400);
  assert.equal(create(db, store, "u_tech", validBody("ADMINISTRATIVE_SUPPORT", "Admin", "dispatch_card")).statusCode, 400, "administrative support takes no record");
  assert.equal(create(db, store, "u_sales", { ...validBody("STOCK_AVAILABILITY", "Operations"), related_entity_type: "quote" }).statusCode, 400);
  assert.equal(create(db, store, "u_sales", { ...validBody("STOCK_AVAILABILITY", "Operations"), related_entity_id: "q_a" }).statusCode, 400);
  assert.equal(create(db, store, "u_sales", validBody("STOCK_AVAILABILITY", "Operations")).statusCode, 201, "optional record may be omitted");
  assert.equal(db.internal_work_requests.length, 1);
});

test("recipient role defaults only when the pairing is unambiguous", () => {
  const db = makeDb(); const store = makeStore(db);
  const noRecipient = (type, related) => { const body = validBody(type, undefined, related); delete body.recipient_role; return body; };
  const single = create(db, store, "u_sales", noRecipient("STOCK_AVAILABILITY", "quote"));
  assert.equal(single.statusCode, 201);
  assert.equal(single.body.data.recipient_role, "Operations");
  const ambiguous = create(db, store, "u_ops", noRecipient("COMMERCIAL_CLARIFICATION", "quote"));
  assert.equal(ambiguous.statusCode, 400);
  assert.match(ambiguous.body.message, /Sales or Finance/);
  assert.equal(create(db, store, "u_ops", validBody("COMMERCIAL_CLARIFICATION", "Admin", "quote")).statusCode, 403);
});

test("subject, description and priority are validated with the documented limits", () => {
  const db = makeDb(); const store = makeStore(db);
  const send = (extra) => create(db, store, "u_sales", validBody("STOCK_AVAILABILITY", "Operations", "quote", extra));
  assert.equal(send({ subject: "" }).statusCode, 400);
  assert.equal(send({ subject: "s".repeat(161) }).statusCode, 400);
  assert.equal(send({ description: "  " }).statusCode, 400);
  assert.equal(send({ description: "d".repeat(2001) }).statusCode, 400);
  assert.equal(send({ priority: "Asap" }).statusCode, 400);
  assert.equal(send({ subject: "s".repeat(160), description: "d".repeat(2000), priority: "Urgent" }).statusCode, 201);
  assert.equal(create(db, store, "u_sales", null).statusCode, 400);
  assert.equal(create(db, store, "u_sales", undefined).statusCode, 400);
});

// --- 4. inbox, outbox and direct-read scoping ---------------------------------
test("outbox is the caller's own requests only; query parameters cannot widen it", () => {
  const db = makeDb(); const store = makeStore(db);
  const a = create(db, store, "u_sales", validBody("STOCK_AVAILABILITY", "Operations", "quote")).body.data.id;
  const b = create(db, store, "u_sales2", validBody("STOCK_AVAILABILITY", "Operations", "quote")).body.data.id;
  const c = create(db, store, "u_finance", validBody("PO_AMENDMENT_CONFIRMATION", "Sales", "purchase_order")).body.data.id;
  assert.deepEqual(ids(outbox(db, store, "u_sales")), [a]);
  assert.deepEqual(ids(outbox(db, store, "u_sales2")), [b]);
  assert.deepEqual(ids(outbox(db, store, "u_finance")), [c]);
  assert.deepEqual(ids(outbox(db, store, "u_sales", { recipient_role: "Finance", user_id: "u_sales2", created_by_user_id: "u_sales2", office: "Harare", role: "Admin", all: "true" })), [a]);
  assert.deepEqual(ids(outbox(db, store, "u_ops")), [], "the recipient's outbox does not include what they received");
  assert.equal(outbox(db, store, "u_sales", { status: "Completed" }).body.data.length, 0);
  assert.equal(outbox(db, store, "u_sales", { status: "Submitted" }).body.data.length, 1);
  assert.equal(outbox(db, store, "u_sales", { status: "Nonsense" }).statusCode, 400);
  assert.equal(outbox(db, store, "u_sales", { status: ["Submitted", "Completed"] }).statusCode, 400);
});

test("inbox is scoped from the session role; two users in one role and other roles are handled correctly", () => {
  const db = makeDb(); const store = makeStore(db);
  const toOps = create(db, store, "u_sales", validBody("STOCK_AVAILABILITY", "Operations", "quote")).body.data.id;
  const toFinance = create(db, store, "u_ops", validBody("MATERIAL_RECONCILIATION", "Finance", "dispatch_card")).body.data.id;
  const toSales = create(db, store, "u_finance", validBody("PO_AMENDMENT_CONFIRMATION", "Sales", "purchase_order")).body.data.id;
  const opsToOps = create(db, store, "u_ops", validBody("STOCK_FULFILMENT", "Operations", "quote")).body.data.id;

  assert.deepEqual(ids(inbox(db, store, "u_ops")), [toOps], "a requester never sees own request in the inbox");
  assert.deepEqual(ids(inbox(db, store, "u_ops2")).sort(), [toOps, opsToOps].sort());
  assert.deepEqual(ids(inbox(db, store, "u_finance")), [toFinance]);
  assert.deepEqual(ids(inbox(db, store, "u_sales")), [toSales]);
  assert.deepEqual(ids(inbox(db, store, "u_management")), []);
  assert.deepEqual(ids(inbox(db, store, "u_admin")), []);
  // Nothing in the query string is ever read as scope.
  assert.deepEqual(ids(inbox(db, store, "u_sales", { recipient_role: "Operations", role: "Operations", office: "Store", user_id: "u_ops", myOffice: "Operations" })), [toSales]);
  for (const role of ["Technician", "Supervisor", "Client Viewer"]) assert.equal(inbox(db, store, ROLE_USER[role]).statusCode, 403, `${role} has no inbox`);
  assert.equal(inbox(db, store, "u_ops", { status: "Weird" }).statusCode, 400);
});

test("direct reads reveal a request only to its participants; everyone else gets the same 404 as for an unknown id", () => {
  const db = makeDb(); const store = makeStore(db);
  const id = create(db, store, "u_sales", validBody("STOCK_AVAILABILITY", "Operations", "quote")).body.data.id;
  assert.equal(get(db, store, "u_sales", id).statusCode, 200, "requester");
  assert.equal(get(db, store, "u_ops", id).statusCode, 200, "eligible recipient while unclaimed");
  assert.equal(get(db, store, "u_ops2", id).statusCode, 200, "any eligible recipient while unclaimed");
  assert.equal(get(db, store, "u_admin", id).statusCode, 200, "read-only Admin audit");
  const unknown = get(db, store, "u_sales2", "iwr_does_not_exist");
  for (const outsider of ["u_sales2", "u_finance", "u_management", "u_tech", "u_supervisor"]) {
    const res = get(db, store, outsider, id);
    assert.equal(res.statusCode, 404, outsider);
    assert.deepEqual(res.body, unknown.body, `${outsider}: no existence oracle`);
  }
  assert.equal(get(db, store, "u_client_a", id).statusCode, 403);

  assert.equal(ack(db, store, "u_ops", id).statusCode, 200);
  assert.equal(get(db, store, "u_ops", id).statusCode, 200, "assignee");
  assert.equal(get(db, store, "u_sales", id).statusCode, 200, "requester");
  assert.equal(get(db, store, "u_ops2", id).statusCode, 404, "a colleague in the same role loses access once it is claimed");
  assert.equal(get(db, store, "u_admin", id).statusCode, 200);
  const audit = get(db, store, "u_admin", id).body.data;
  assert.equal(audit.viewer.is_audit_only, true);
  assert.deepEqual(audit.allowed_actions, []);
});

// --- 5. acknowledge (single claim) --------------------------------------------
test("only one eligible recipient can acknowledge; a second attempt is a truthful 409", () => {
  const db = makeDb(); const store = makeStore(db);
  const id = create(db, store, "u_sales", validBody("STOCK_AVAILABILITY", "Operations", "quote")).body.data.id;
  const first = ack(db, store, "u_ops", id);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.data.status, "Acknowledged");
  assert.equal(first.body.data.assigned_to_user_id, "u_ops");
  const second = ack(db, store, "u_ops2", id);
  assert.equal(second.statusCode, 409);
  assert.match(second.body.message, /already been acknowledged/);
  assert.equal(ack(db, store, "u_ops", id).statusCode, 409, "even the winner cannot claim twice");
  const [stored] = db.internal_work_requests;
  assert.equal(stored.assigned_to_user_id, "u_ops", "the assignee is unchanged by the failed attempts");
  assert.equal(stored.history.filter((entry) => entry.action === "acknowledge").length, 1);
  assert.equal(db.audit_logs.filter((entry) => entry.action === "INTERNAL_WORK_REQUEST_ACKNOWLEDGED").length, 1);
});

test("acknowledge is refused to the requester, the wrong role, read-only Admin and roles with no work permission", () => {
  const db = makeDb(); const store = makeStore(db);
  const id = create(db, store, "u_sales", validBody("STOCK_AVAILABILITY", "Operations", "quote")).body.data.id;
  assert.equal(ack(db, store, "u_sales", id).statusCode, 403, "requester cannot claim their own request");
  assert.equal(ack(db, store, "u_finance", id).statusCode, 404, "wrong role learns nothing");
  assert.equal(ack(db, store, "u_sales2", id).statusCode, 404);
  assert.equal(ack(db, store, "u_admin", id).statusCode, 403);
  assert.match(ack(db, store, "u_admin", id).body.message, /read-only/);
  assert.equal(ack(db, store, "u_tech", id).statusCode, 403);
  assert.equal(ack(db, store, "u_client_a", id).statusCode, 403);
  assert.equal(ack(db, store, "u_ops_off", id).statusCode, 403, "inactive account");
  assert.equal(ack(db, store, "u_ops", "iwr_missing").statusCode, 404);
  assert.equal(db.internal_work_requests[0].status, "Submitted");

  const same = create(db, store, "u_ops", validBody("STOCK_FULFILMENT", "Operations", "quote")).body.data.id;
  assert.equal(ack(db, store, "u_ops", same).statusCode, 403, "Operations -> Operations: the requester cannot self-acknowledge");
  assert.equal(ack(db, store, "u_ops2", same).statusCode, 200, "a different Operations user can");

  const cancelled = create(db, store, "u_sales", validBody("STOCK_AVAILABILITY", "Operations", "quote")).body.data.id;
  assert.equal(act(db, store, "u_sales", cancelled, "cancel", "no longer needed").statusCode, 200);
  assert.equal(ack(db, store, "u_ops", cancelled).statusCode, 409);
});

// --- 6. lifecycle -------------------------------------------------------------
function claimed(db, store) {
  const id = create(db, store, "u_sales", validBody("STOCK_FULFILMENT", "Operations", "quote")).body.data.id;
  assert.equal(ack(db, store, "u_ops", id).statusCode, 200);
  return id;
}

test("full lifecycle: submit, acknowledge, start, complete with history, resolution and timestamps", () => {
  const db = makeDb(); const store = makeStore(db);
  const id = claimed(db, store);
  const started = act(db, store, "u_ops", id, "start", "Picking now");
  assert.equal(started.statusCode, 200);
  assert.equal(started.body.data.status, "In Progress");
  const done = act(db, store, "u_ops", id, "complete", "  Issued 10 m2 from Store A.  ");
  assert.equal(done.statusCode, 200);
  const view = done.body.data;
  assert.equal(view.status, "Completed");
  assert.equal(view.resolution_note, "Issued 10 m2 from Store A.");
  assert.equal(view.resolved_by_user_id, "u_ops");
  assert.ok(view.resolved_at);
  assert.deepEqual(view.allowed_actions, []);
  assert.deepEqual(view.history.map((entry) => [entry.action, entry.from_status, entry.to_status, entry.actor_user_id]), [
    ["submit", null, "Submitted", "u_sales"], ["acknowledge", "Submitted", "Acknowledged", "u_ops"],
    ["start", "Acknowledged", "In Progress", "u_ops"], ["complete", "In Progress", "Completed", "u_ops"]
  ]);
  assert.equal(view.history[2].note, "Picking now");
  assert.equal(view.history[3].note, "Issued 10 m2 from Store A.");
  assert.ok(view.history.every((entry) => entry.at && entry.actor_name));
});

test("complete straight from Acknowledged is allowed; start is optional", () => {
  const db = makeDb(); const store = makeStore(db);
  const id = claimed(db, store);
  assert.equal(act(db, store, "u_ops", id, "complete", "Not needed after all - stock on hand.").statusCode, 200);
});

test("missing resolution or rejection reasons, unassigned completion and post-progress cancellation all fail", () => {
  const db = makeDb(); const store = makeStore(db);
  const id = claimed(db, store);
  assert.equal(act(db, store, "u_ops", id, "complete").statusCode, 400, "completion needs a note");
  assert.equal(act(db, store, "u_ops", id, "complete", "   ").statusCode, 400, "whitespace is not a note");
  assert.equal(act(db, store, "u_ops", id, "reject").statusCode, 400, "rejection needs a reason");
  assert.equal(act(db, store, "u_sales", id, "cancel").statusCode, 400, "cancellation needs a reason");
  assert.equal(db.internal_work_requests[0].status, "Acknowledged");

  const submitted = create(db, store, "u_sales", validBody("STOCK_AVAILABILITY", "Operations", "quote")).body.data.id;
  const early = act(db, store, "u_ops", submitted, "complete", "Done");
  assert.equal(early.statusCode, 409, "unassigned completion");
  assert.match(early.body.message, /Acknowledge it first/);
  assert.equal(act(db, store, "u_ops", submitted, "start").statusCode, 409);

  assert.equal(act(db, store, "u_ops", id, "start").statusCode, 200);
  const late = act(db, store, "u_sales", id, "cancel", "changed my mind");
  assert.equal(late.statusCode, 409, "cancellation after work has progressed");
  assert.match(late.body.message, /progressed/);
  assert.equal(act(db, store, "u_ops", id, "reject", "too late").statusCode, 409, "In Progress cannot be rejected");
  assert.equal(act(db, store, "u_ops", id, "start").statusCode, 409, "cannot start twice");
});

test("only the requester cancels and only the assignee works a claimed request", () => {
  const db = makeDb(); const store = makeStore(db);
  const id = claimed(db, store);
  assert.equal(act(db, store, "u_ops", id, "cancel", "I am not the requester").statusCode, 403);
  assert.equal(act(db, store, "u_sales", id, "start").statusCode, 403, "requester cannot progress");
  assert.equal(act(db, store, "u_sales", id, "complete", "self-approved").statusCode, 403);
  assert.equal(act(db, store, "u_sales", id, "reject", "self-rejected").statusCode, 403);
  assert.equal(act(db, store, "u_ops2", id, "start").statusCode, 404, "another eligible user cannot even see it after the claim");
  assert.equal(act(db, store, "u_ops2", id, "complete", "hijack").statusCode, 404);
  assert.equal(act(db, store, "u_finance", id, "start").statusCode, 404);
  assert.equal(act(db, store, "u_admin", id, "complete", "override").statusCode, 403, "Admin audit access cannot mutate");
  assert.match(act(db, store, "u_admin", id, "cancel", "override").body.message, /read-only/);
  assert.equal(act(db, store, "u_client_a", id, "cancel", "x").statusCode, 403);
  assert.equal(db.internal_work_requests[0].status, "Acknowledged");
  assert.equal(act(db, store, "u_sales", id, "cancel", "Requirement withdrawn").statusCode, 200);
  assert.equal(db.internal_work_requests[0].status, "Cancelled");
  assert.equal(db.internal_work_requests[0].resolution_note, "Requirement withdrawn");
});

test("rejection: any eligible recipient may reject an unclaimed request; once claimed only the assignee may", () => {
  const db = makeDb(); const store = makeStore(db);
  const open = create(db, store, "u_sales", validBody("STOCK_AVAILABILITY", "Operations", "quote")).body.data.id;
  const rejected = act(db, store, "u_ops2", open, "reject", "Not stocked");
  assert.equal(rejected.statusCode, 200);
  assert.equal(rejected.body.data.status, "Rejected");
  assert.equal(rejected.body.data.assigned_to_user_id, null, "rejecting does not claim");
  assert.equal(rejected.body.data.resolved_by_user_id, "u_ops2");
  assert.equal(act(db, store, "u_sales", open, "cancel", "too late").statusCode, 409, "terminal");
  assert.equal(get(db, store, "u_ops", open).statusCode, 404, "other recipients lose sight of a request someone else rejected");
  assert.equal(get(db, store, "u_ops2", open).statusCode, 200, "the rejecting user keeps it");
  assert.deepEqual(ids(inbox(db, store, "u_ops2")), [open]);
  assert.deepEqual(ids(inbox(db, store, "u_ops")), []);

  const claimedId = claimed(db, store);
  assert.equal(act(db, store, "u_sales", claimedId, "reject", "no").statusCode, 403);
  assert.equal(act(db, store, "u_ops", claimedId, "reject", "Cannot supply").statusCode, 200);
  assert.equal(db.internal_work_requests.at(-1).status, "Rejected");
});

test("terminal requests accept nothing further, and no action name outside the allow-list works", () => {
  const db = makeDb(); const store = makeStore(db);
  const id = claimed(db, store);
  assert.equal(act(db, store, "u_ops", id, "complete", "done").statusCode, 200);
  for (const [user, action] of [["u_ops", "start"], ["u_ops", "complete"], ["u_ops", "reject"], ["u_sales", "cancel"]]) {
    assert.equal(act(db, store, user, id, action, "again").statusCode, 409, `${action} after completion`);
  }
  assert.equal(ack(db, store, "u_ops", id).statusCode, 409);
  for (const action of ["reopen", "acknowledge", "constructor", "__proto__", "Completed", "assign", ""]) {
    const res = act(db, store, "u_ops", id, action, "x");
    assert.equal(res.statusCode, 400, `action "${action}"`);
  }
  const res = run(transitionInternalWorkRequest, db, store, "u_ops", { params: { id }, body: { status: "Completed" } });
  assert.equal(res.statusCode, 400, "a status field is never a substitute for an action");
  assert.equal(run(transitionInternalWorkRequest, db, store, "u_ops", { params: { id }, body: undefined }).statusCode, 400);
});

test("an assignee whose role changed, or whose account was deactivated, can no longer act", () => {
  const db = makeDb(); const store = makeStore(db);
  const id = claimed(db, store);
  db.users.find((user) => user.id === "u_ops").role = "Finance";
  assert.equal(act(db, store, "u_ops", id, "start").statusCode, 403, "role no longer matches the addressed recipient role");
  assert.equal(get(db, store, "u_ops", id).statusCode, 200, "but they still see what they claimed");
  assert.deepEqual(get(db, store, "u_ops", id).body.data.allowed_actions, []);
  db.users.find((user) => user.id === "u_ops").role = "Operations";
  db.users.find((user) => user.id === "u_ops").is_active = false;
  assert.equal(act(db, store, "u_ops", id, "start").statusCode, 403);
  assert.equal(db.internal_work_requests[0].status, "Acknowledged");
});

// --- 7. audit ------------------------------------------------------------------
test("every lifecycle action writes exactly one audit event, and none carries free text", () => {
  const db = makeDb(); const store = makeStore(db);
  const SECRETS = { subject: "SUBJECT-password=hunter2", description: "DESC-reset_token=abc123", note: "NOTE-secret-note", reason: "REASON-secret-reason" };
  const created = create(db, store, "u_sales", validBody("STOCK_FULFILMENT", "Operations", "quote", { subject: SECRETS.subject, description: SECRETS.description }));
  const id = created.body.data.id;
  ack(db, store, "u_ops", id);
  act(db, store, "u_ops", id, "start", SECRETS.note);
  act(db, store, "u_ops", id, "complete", SECRETS.reason);
  const other = create(db, store, "u_sales", validBody("STOCK_AVAILABILITY", "Operations", "quote")).body.data.id;
  act(db, store, "u_sales", other, "cancel", SECRETS.reason);
  const third = create(db, store, "u_sales", validBody("STOCK_AVAILABILITY", "Operations", "quote")).body.data.id;
  act(db, store, "u_ops", third, "reject", SECRETS.reason);

  assert.deepEqual(db.audit_logs.map((entry) => entry.action), [
    "INTERNAL_WORK_REQUEST_CREATED", "INTERNAL_WORK_REQUEST_ACKNOWLEDGED", "INTERNAL_WORK_REQUEST_STARTED", "INTERNAL_WORK_REQUEST_COMPLETED",
    "INTERNAL_WORK_REQUEST_CREATED", "INTERNAL_WORK_REQUEST_CANCELLED", "INTERNAL_WORK_REQUEST_CREATED", "INTERNAL_WORK_REQUEST_REJECTED"
  ]);
  assert.ok(db.audit_logs.every((entry) => entry.entity_type === "internal_work_request"));
  assert.deepEqual(db.audit_logs.slice(0, 4).map((entry) => entry.actor_id), ["u_sales", "u_ops", "u_ops", "u_ops"]);
  assert.equal(db.audit_logs[0].old_values, null);
  assert.equal(db.audit_logs[1].old_values.status, "Submitted");
  assert.equal(db.audit_logs[1].new_values.status, "Acknowledged");
  assert.equal(db.audit_logs[1].new_values.assigned_to_user_id, "u_ops");
  const serialised = JSON.stringify(db.audit_logs);
  for (const secret of Object.values(SECRETS)) assert.equal(serialised.includes(secret), false, `audit must not contain ${secret}`);
  assert.doesNotMatch(serialised, /password|reset_token|hunter2|abc123/);
  // The words themselves live on the participant-scoped record instead.
  assert.equal(get(db, store, "u_sales", id).body.data.subject, SECRETS.subject);
  assert.equal(db.internal_work_requests[0].resolution_note, SECRETS.reason);
});

test("refused and invalid actions write no audit event and change nothing", () => {
  const db = makeDb(); const store = makeStore(db);
  const id = claimed(db, store);
  const before = JSON.stringify([db.internal_work_requests, db.audit_logs]);
  ack(db, store, "u_ops2", id);
  act(db, store, "u_ops", id, "complete");
  act(db, store, "u_sales", id, "start");
  act(db, store, "u_ops2", id, "start");
  act(db, store, "u_admin", id, "complete", "x");
  act(db, store, "u_ops", id, "reopen");
  assert.equal(JSON.stringify([db.internal_work_requests, db.audit_logs]), before);
});

test("a failing audit hook rolls the whole action back", () => {
  const db = makeDb();
  let store = makeStore(db, { failOnAuditCall: 1 });
  assert.throws(() => create(db, store, "u_sales", validBody("STOCK_AVAILABILITY", "Operations", "quote")), /audit hook failure/);
  assert.equal(db.internal_work_requests.length, 0, "no request without its audit event");
  assert.equal(db.audit_logs.length, 0);

  store = makeStore(db);
  const id = create(db, store, "u_sales", validBody("STOCK_AVAILABILITY", "Operations", "quote")).body.data.id;
  const before = JSON.stringify(db.internal_work_requests);
  const auditBefore = db.audit_logs.length;
  store = makeStore(db, { failOnAuditCall: 1 });
  assert.throws(() => ack(db, store, "u_ops", id), /audit hook failure/);
  assert.equal(JSON.stringify(db.internal_work_requests), before, "the claim is undone");
  assert.equal(db.audit_logs.length, auditBefore);
  store = makeStore(db);
  assert.equal(ack(db, store, "u_ops", id).statusCode, 200, "and can still be claimed afterwards");
});

// --- 8. no side effects -----------------------------------------------------------
test("a full request lifecycle changes no stock, quote, PO, dispatch, invoice, timesheet, lead, user or notification", () => {
  const db = makeDb(); const store = makeStore(db);
  const before = snapshotUntouchable(db);
  for (const [sender, type, recipient, related] of [
    ["u_sales", "STOCK_FULFILMENT", "Operations", "quote"], ["u_finance", "PO_AMENDMENT_CONFIRMATION", "Operations", "purchase_order"],
    ["u_ops", "MATERIAL_RECONCILIATION", "Finance", "stock_item"], ["u_tech", "FIELD_CLARIFICATION", "Operations", "dispatch_card"],
    ["u_ops", "COMMERCIAL_CLARIFICATION", "Sales", "quote"], ["u_supervisor", "ADMINISTRATIVE_SUPPORT", "Admin", undefined]
  ]) {
    const id = create(db, store, sender, validBody(type, recipient, related)).body.data.id;
    const recipientUser = { Operations: "u_ops", Finance: "u_finance", Sales: "u_sales", Admin: "u_admin" }[recipient];
    assert.equal(ack(db, store, recipientUser, id).statusCode, 200, `${type} acknowledge`);
    assert.equal(act(db, store, recipientUser, id, "start").statusCode, 200);
    assert.equal(act(db, store, recipientUser, id, "complete", "Resolved without touching any record.").statusCode, 200);
  }
  assert.equal(snapshotUntouchable(db), before);
  // This fixture's stub store has no audit-to-notification hook, so nothing here can generate one.
  // Notification content and routing for these events is pinned against the real store in
  // internalWorkRequestsRealStore.test.js and notificationRouting.test.js (Task 01 owner decision).
  assert.equal(db.notifications.length, 0, "stub store: the hook is not wired in this fixture");
  assert.equal(db.stock_items[0].quantity_on_hand, 30);
});

// --- 9. views ---------------------------------------------------------------------
test("options list only what the caller's role may raise, with recipients and readable related records", () => {
  const db = makeDb(); const store = makeStore(db);
  const opts = (user) => run(getInternalWorkRequestOptions, db, store, user).body.data;
  const sales = opts("u_sales");
  assert.deepEqual(sales.types.map((t) => t.request_type), ["STOCK_AVAILABILITY", "STOCK_FULFILMENT", "ADMINISTRATIVE_SUPPORT"]);
  assert.deepEqual(sales.types.find((t) => t.request_type === "STOCK_FULFILMENT").related_entity_types.map((r) => r.type), ["quote", "dispatch_card", "stock_item"], "Sales can read quotes, dispatch cards and stock items");
  assert.deepEqual(sales.types.find((t) => t.request_type === "ADMINISTRATIVE_SUPPORT").recipients, ["Admin", "Management"]);
  const tech = opts("u_tech");
  assert.deepEqual(tech.types.map((t) => t.request_type), ["FIELD_CLARIFICATION", "ADMINISTRATIVE_SUPPORT"]);
  assert.deepEqual(tech.types[0].related_entity_types.map((r) => r.type), ["dispatch_card"]);
  assert.deepEqual(opts("u_management").types.map((t) => t.request_type), ["ADMINISTRATIVE_SUPPORT"]);
  assert.deepEqual(opts("u_ops").types.find((t) => t.request_type === "COMMERCIAL_CLARIFICATION").related_entity_types.map((r) => r.type), ["quote", "purchase_order"]);
  assert.deepEqual(sales.priorities, ["Low", "Normal", "High", "Urgent"]);
  assert.deepEqual(sales.limits, { subject: 160, description: 2000, note: 1000, relatedId: 100 });
  assert.equal(JSON.stringify(sales).includes("Finance"), false, "a role is told nothing about pairings it cannot use");
});

test("views omit history in lists, include it in detail, and hide the identity of a record the viewer cannot read", () => {
  const db = makeDb(); const store = makeStore(db);
  const id = create(db, store, "u_finance", validBody("PO_AMENDMENT_CONFIRMATION", "Sales", "purchase_order")).body.data.id;
  create(db, store, "u_finance", validBody("PO_AMENDMENT_CONFIRMATION", "Operations", "purchase_order"));
  const listed = inbox(db, store, "u_sales").body.data[0];
  assert.equal("history" in listed, false);
  assert.equal("history" in get(db, store, "u_sales", id).body.data, true);
  assert.deepEqual(listed.related_entity, { type: "purchase_order", type_label: "Purchase order", id: "po_a", label: "PO-A", viewable: true }, "Sales can read portfolio purchase orders");
  assert.equal(listed.client_id, "c_a", "Sales may read clients");
  const asOps = inbox(db, store, "u_ops").body.data[0];
  assert.deepEqual(asOps.related_entity, { type: "purchase_order", type_label: "Purchase order", id: "po_a", label: "PO-A", viewable: true });
  const asFinance = outbox(db, store, "u_finance").body.data.find((item) => item.id === id);
  assert.equal(asFinance.related_entity.label, "PO-A");
  assert.deepEqual(asFinance.allowed_actions, ["cancel"]);
  assert.equal(asFinance.created_by_name, "u_finance name");

  const tech = create(db, store, "u_tech", validBody("FIELD_CLARIFICATION", "Operations", "dispatch_card")).body.data;
  assert.equal(tech.client_id, null, "Technician cannot read clients, so the client is not disclosed");
  assert.equal(get(db, store, "u_ops", tech.id).body.data.client_id, "c_a");
});

test("resolveRelatedEntity is fail-closed for unknown accounts, Client Viewers and malformed input", () => {
  const db = makeDb();
  const sales = db.users.find((user) => user.id === "u_sales");
  assert.equal(resolveRelatedEntity(db, sales, "quote", "q_a").ok, true);
  assert.equal(resolveRelatedEntity(db, sales, "quote", "").ok, false);
  assert.equal(resolveRelatedEntity(db, sales, "quote", 5).ok, false);
  assert.equal(resolveRelatedEntity(db, sales, "constructor", "q_a").ok, false);
  assert.equal(resolveRelatedEntity(db, undefined, "quote", "q_a").ok, false);
  assert.equal(resolveRelatedEntity(db, { ...sales, is_active: false }, "quote", "q_a").ok, false);
  assert.equal(resolveRelatedEntity(db, db.users.find((user) => user.id === "u_client_a"), "quote", "q_a").ok, false, "Client Viewer has no route to this feature");
});
