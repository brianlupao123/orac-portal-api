import assert from "node:assert/strict";
import test from "node:test";
import { handleAuditForNotifications, WORK_REQUEST_NOTIFICATIONS_ENABLED } from "../src/notifications.js";
import { getVisibleNotifications, getNotifications, markRead, markAllRead } from "../src/controllers/notificationController.js";
import { hasPermission, permissions } from "../src/permissions.js";
import { collectionGuards } from "../src/controllers/coreController.js";
import { DESTINATIONS, DESTINATION_KINDS, buildDestination, resolveDestination } from "../src/notificationDestinations.js";

function makeDb() {
  return {
    users: [
      { id: "u_admin", role: "Admin", is_active: true },
      { id: "u_admin2", role: "Admin", is_active: true },
      { id: "u_mgmt", role: "Management", is_active: true },
      { id: "u_sales", role: "Sales", is_active: true },
      { id: "u_fin", role: "Finance", is_active: true },
      { id: "u_ops", role: "Operations", is_active: true },
      { id: "u_sup", role: "Supervisor", is_active: true },
      { id: "u_sup2", role: "Supervisor", is_active: true },
      { id: "u_tech", role: "Technician", is_active: true },
      { id: "u_tech2", role: "Technician", is_active: true },
      { id: "u_cz", role: "Client Viewer", client_id: "c_zim", is_active: true },
      { id: "u_cm", role: "Client Viewer", client_id: "c_mim", is_active: true }
    ],
    clients: [{ id: "c_zim" }, { id: "c_mim" }],
    quotes: [{ id: "q_zim", client_id: "c_zim", quote_number: "Q-1" }, { id: "q_mim", client_id: "c_mim", quote_number: "Q-2" }],
    purchase_orders: [{ id: "po_zim", quotation_id: "q_zim" }],
    dispatch_cards: [{ id: "d_zim", quotation_id: "q_zim" }, { id: "d_mim", quotation_id: "q_mim" }],
    field_worksheets: [
      { id: "ws1", dispatch_card_id: "d_zim", technician_id: "u_tech", submitted_by: "u_tech", supervisor_id: "u_sup" },
      { id: "ws2", dispatch_card_id: "d_mim", technician_id: "u_tech2", submitted_by: "u_tech2" }
    ],
    invoices: [],
    leads: [{ id: "l1" }],
    stock_items: [{ id: "si1" }],
    service_requests: [{ id: "sr_zim", client_id: "c_zim" }],
    internal_work_requests: [{ id: "iwr1" }],
    access_requests: [{ id: "areq1" }],
    notifications: [],
    audit_logs: []
  };
}
let n = 0;
const audit = (action, entityType, entityId, newValues = null, oldValues = null, actorId = "u_admin") =>
  ({ id: `audit_${++n}`, actor_id: actorId, entity_type: entityType, entity_id: entityId, action, old_values: oldValues, new_values: newValues, created_at: new Date().toISOString() });
const emit = (db, entry) => { handleAuditForNotifications(db, entry); return db.notifications; };
// Internal/service request notifications are ON (owner decision, Task 01; see
// notifications.js). emitWR passes the switch explicitly so these tests stay
// independent of the default; a separate test pins the default and the off switch.
const emitWR = (db, entry) => { handleAuditForNotifications(db, entry, { workRequestNotifications: true }); return db.notifications; };
const ws = (db, id) => ({ ...db.field_worksheets.find((w) => w.id === id) });
const visibleTo = (db, id) => getVisibleNotifications(db, { id });
const res = () => ({ statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

// ── Event / role routing ────────────────────────────────────────────────────
test("ACCESS_REQUEST_CREATED reaches Admin only, carries no personal data, and points at the request", () => {
  const db = makeDb();
  const [notif] = emit(db, audit("ACCESS_REQUEST_CREATED", "access_request", "areq1", { name: "Jane Secret", email: "jane@secret.test", reason: "because" }));
  assert.deepEqual(notif.target_roles, ["Admin"]);
  assert.deepEqual(notif.destination, { kind: "access_request", id: "areq1" });
  assert.equal(JSON.stringify(notif).includes("Jane"), false);
  assert.equal(JSON.stringify(notif).includes("jane@secret.test"), false);
  for (const id of ["u_mgmt", "u_sales", "u_fin", "u_ops", "u_sup", "u_tech", "u_cz", "u_cm"]) assert.equal(visibleTo(db, id).length, 0, id);
  assert.equal(visibleTo(db, "u_admin").length, 1);
});

test("INTERNAL_WORK_REQUEST_CREATED goes to the recipient role, never to the requester, never to a role without an inbox", () => {
  const db = makeDb();
  emitWR(db, audit("INTERNAL_WORK_REQUEST_CREATED", "internal_work_request", "iwr1", { recipient_role: "Operations", created_by_user_id: "u_ops" }, null, "u_ops"));
  assert.equal(visibleTo(db, "u_ops").length, 0, "requester holding the recipient role is excluded");
  assert.equal(visibleTo(db, "u_sales").length, 0);
  const db2 = makeDb();
  emitWR(db2, audit("INTERNAL_WORK_REQUEST_CREATED", "internal_work_request", "iwr1", { recipient_role: "Operations", created_by_user_id: "u_sup" }, null, "u_sup"));
  assert.equal(visibleTo(db2, "u_ops").length, 1);
  assert.equal(visibleTo(db2, "u_tech").length, 0);
  const db3 = makeDb();
  emitWR(db3, audit("INTERNAL_WORK_REQUEST_CREATED", "internal_work_request", "iwr1", { recipient_role: "Technician", created_by_user_id: "u_ops" }));
  assert.equal(db3.notifications.length, 0, "Technician has no inbox permission, so no notification is created");
});

test("internal request lifecycle updates go to the requester only, and never to the actor", () => {
  const db = makeDb();
  emitWR(db, audit("INTERNAL_WORK_REQUEST_ACKNOWLEDGED", "internal_work_request", "iwr1", { created_by_user_id: "u_sup" }, null, "u_ops"));
  assert.equal(visibleTo(db, "u_sup").length, 1);
  assert.equal(visibleTo(db, "u_ops").length, 0);
  assert.equal(visibleTo(db, "u_admin").length, 0);
  const own = makeDb();
  emitWR(own, audit("INTERNAL_WORK_REQUEST_REJECTED", "internal_work_request", "iwr1", { created_by_user_id: "u_ops" }, null, "u_ops"));
  assert.equal(own.notifications.length, 0);
  const cancelled = makeDb();
  emitWR(cancelled, audit("INTERNAL_WORK_REQUEST_CANCELLED", "internal_work_request", "iwr1", { assigned_to_user_id: "u_ops", created_by_user_id: "u_sup" }, null, "u_sup"));
  assert.equal(visibleTo(cancelled, "u_ops").length, 1);
});

test("SERVICE_REQUEST_CREATED reaches Sales and Operations only; the decision reaches the requesting client user only", () => {
  const db = makeDb();
  emitWR(db, audit("SERVICE_REQUEST_CREATED", "service_request", "sr_zim", { client_id: "c_zim", created_by_user_id: "u_cz" }, null, "u_cz"));
  assert.equal(visibleTo(db, "u_sales").length, 1);
  assert.equal(visibleTo(db, "u_ops").length, 1);
  assert.equal(visibleTo(db, "u_cz").length, 0);
  assert.equal(visibleTo(db, "u_cm").length, 0);
  emitWR(db, audit("SERVICE_REQUEST_ACCEPTED", "service_request", "sr_zim", { client_id: "c_zim", created_by_user_id: "u_cz" }, null, "u_sales"));
  assert.equal(visibleTo(db, "u_cz").length, 1);
  assert.equal(visibleTo(db, "u_cm").length, 0, "another client never sees it");
});

test("worksheet return/approval: the owning technician and the assigned Supervisor are told individually; nobody else", () => {
  const db = makeDb();
  // An Operations reviewer returns it. Assigned Supervisor u_sup and owner u_tech are told.
  emit(db, audit("WORKSHEET_RETURNED", "field_worksheet", "ws1", ws(db, "ws1"), null, "u_ops"));
  assert.equal(visibleTo(db, "u_tech").length, 1);
  assert.equal(visibleTo(db, "u_sup").length, 1, "assigned Supervisor");
  assert.equal(visibleTo(db, "u_sup2").length, 0, "unassigned Supervisor is not told");
  assert.equal(visibleTo(db, "u_tech2").length, 0, "no broadcast of returns to every Technician");
  assert.equal(visibleTo(db, "u_admin").length, 1);
  assert.equal(visibleTo(db, "u_ops").length, 1, "Operations holds reviewWorksheet (role copy)");
  emit(db, audit("WORKSHEET_APPROVED", "field_worksheet", "ws1", ws(db, "ws1"), null, "u_sup"));
  assert.equal(visibleTo(db, "u_tech").length, 2);
  assert.equal(visibleTo(db, "u_tech2").length, 0);
  assert.equal(visibleTo(db, "u_cz").length, 0);
});

test("WORKSHEET_SUBMITTED asks the owning client to acknowledge; staff are told it is waiting on the client", () => {
  const db = makeDb();
  emit(db, audit("WORKSHEET_SUBMITTED", "field_worksheet", "ws1", ws(db, "ws1"), null, "u_tech"));
  const client = visibleTo(db, "u_cz");
  assert.equal(client.length, 1);
  assert.match(client[0].title + client[0].message, /acknowledg/i);
  for (const id of ["u_cm", "u_fin", "u_sales", "u_tech2", "u_sup2"]) assert.equal(visibleTo(db, id).length, 0, id);
  for (const id of ["u_ops", "u_admin", "u_mgmt"]) {
    const items = visibleTo(db, id);
    assert.equal(items.length, 1, id);
    assert.match(items[0].message, /waiting for client acknowledgement/i, "must not claim it is ready for review");
    assert.doesNotMatch(items[0].message, /awaits supervisor review/i);
  }
  assert.equal(visibleTo(db, "u_sup").length, 1, "assigned Supervisor is informed");
  // The client copy resolves to the client's own workspace, and the other client sees nothing.
  const own = res();
  getNotifications({ db, user: { id: "u_cz" } }, own);
  assert.equal(own.body.data.length, 1);
  assert.equal(own.body.data[0].destination.route, "/portal");
  assert.equal(own.body.data[0].destination.resolved, true);
  assert.equal(own.body.data[0].read, false);
  const foreign = res();
  getNotifications({ db, user: { id: "u_cm" } }, foreign);
  assert.equal(foreign.body.data.length, 0);
});

test("WORKSHEET_SUBMITTED: a dispatch whose client cannot be resolved creates no Client Viewer copy (fails closed)", () => {
  const db = makeDb();
  db.field_worksheets.push({ id: "ws_orphan", dispatch_card_id: "d_missing", technician_id: "u_tech", submitted_by: "u_tech" });
  emit(db, audit("WORKSHEET_SUBMITTED", "field_worksheet", "ws_orphan", ws(db, "ws_orphan"), null, "u_tech"));
  for (const id of ["u_cz", "u_cm"]) assert.equal(visibleTo(db, id).length, 0, id);
  assert.equal(visibleTo(db, "u_ops").length, 1);
});

test("WORKSHEET_CLIENT_ACKNOWLEDGED notifies only authorized reviewers: Admin, Operations and the ASSIGNED Supervisor", () => {
  const db = makeDb();
  emit(db, audit("WORKSHEET_CLIENT_ACKNOWLEDGED", "field_worksheet", "ws1", ws(db, "ws1"), null, "u_cz"));
  for (const id of ["u_admin", "u_admin2", "u_ops", "u_sup"]) {
    const items = visibleTo(db, id);
    assert.equal(items.length, 1, id);
    assert.match(items[0].title, /Ready for Review/);
  }
  for (const id of ["u_sup2", "u_mgmt", "u_sales", "u_fin", "u_tech", "u_tech2", "u_cz", "u_cm"]) {
    assert.equal(visibleTo(db, id).length, 0, `${id} must not receive a review request`);
  }
});

test("WORKSHEET_CLIENT_ACKNOWLEDGED does not tell the submitter to review their own worksheet", () => {
  const db = makeDb();
  db.field_worksheets[0].submitted_by = "u_ops";
  db.field_worksheets[0].supervisor_id = "u_ops";
  emit(db, audit("WORKSHEET_CLIENT_ACKNOWLEDGED", "field_worksheet", "ws1", ws(db, "ws1"), null, "u_cz"));
  assert.equal(visibleTo(db, "u_ops").length, 0, "separation of duties: submitter excluded");
  assert.equal(visibleTo(db, "u_admin").length, 1);
});

test("worksheet destinations: an unassigned Supervisor and another client's user get the honest fallback, not the record", () => {
  const db = makeDb();
  const dest = { kind: "worksheet", id: "ws1" };
  assert.equal(resolveDestination(db, db.users.find((u) => u.id === "u_sup"), dest).resolved, true);
  const other = resolveDestination(db, db.users.find((u) => u.id === "u_sup2"), dest);
  assert.equal(other.resolved, false);
  assert.match(other.note, /no longer available/i);
  const foreign = resolveDestination(db, db.users.find((u) => u.id === "u_cm"), dest);
  assert.equal(foreign.resolved, false);
  assert.equal(JSON.stringify(foreign).includes("ws1"), false, "foreign id is not echoed");
  assert.equal(resolveDestination(db, db.users.find((u) => u.id === "u_cz"), dest).resolved, true);
});

test("internal request destination resolves only for the requester, the addressed role and Admin audit", () => {
  const db = makeDb();
  db.internal_work_requests = [{ id: "iwr1", created_by_user_id: "u_sup", recipient_role: "Operations" }];
  const dest = { kind: "internal_work_request", id: "iwr1" };
  const at = (id) => resolveDestination(db, db.users.find((u) => u.id === id), dest);
  assert.equal(at("u_sup").resolved, true);
  assert.equal(at("u_ops").resolved, true);
  assert.equal(at("u_admin").resolved, true);
  assert.equal(at("u_sales").resolved, false);
  assert.equal(at("u_fin").resolved, false);
});

test("access-request visibility is the named Admin-only policy; Management gets nothing and cannot resolve the destination", () => {
  assert.deepEqual([...permissions.viewAccessRequests], ["Admin"]);
  assert.equal(hasPermission({ is_active: true, role: "Management" }, "viewAccessRequests"), false);
  assert.equal(hasPermission({ is_active: true, role: "Management" }, "manageUsers"), false);
  assert.deepEqual([...collectionGuards.access_requests], ["Admin"]);
  const db = makeDb();
  emit(db, audit("ACCESS_REQUEST_CREATED", "access_request", "areq1", { id: "areq1" }));
  assert.equal(visibleTo(db, "u_mgmt").length, 0);
  const view = resolveDestination(db, db.users.find((u) => u.id === "u_mgmt"), { kind: "access_request", id: "areq1" });
  assert.equal(view.resolved, false);
  assert.equal(view.route, "/");
});

test("PO_SUBMITTED_BY_CLIENT reaches Finance/Operations/Admin, not Sales or clients", () => {
  const db = makeDb();
  emit(db, audit("PO_SUBMITTED_BY_CLIENT", "purchase_order", "po_zim", { quotation_id: "q_zim" }));
  for (const id of ["u_fin", "u_ops", "u_admin"]) assert.equal(visibleTo(db, id).length, 1, id);
  for (const id of ["u_sales", "u_mgmt", "u_cz", "u_cm", "u_tech"]) assert.equal(visibleTo(db, id).length, 0, id);
});

test("events that intentionally create no notification stay silent", () => {
  const db = makeDb();
  for (const action of ["ACCESS_REQUEST_APPROVED", "ACCESS_REQUEST_REJECTED", "ACCESS_REQUEST_USER_CREATED", "ACCESS_REQUEST_SETUP_LINK_ISSUED", "PASSWORD_RESET_REQUESTED", "SERVICE_REQUEST_CONVERTED_TO_LEAD", "KIOSK_TIMESHEET_BATCH_SUBMITTED"]) {
    emit(db, audit(action, "x", "x1", { id: "x1" }));
  }
  assert.equal(db.notifications.length, 0);
});

// ── Idempotency ─────────────────────────────────────────────────────────────
test("replaying the same audit entry never duplicates notifications, including personal ones", () => {
  const db = makeDb();
  const entry = audit("WORKSHEET_RETURNED", "field_worksheet", "ws1", { submitted_by: "u_tech", technician_id: "u_tech" }, null, "u_sup");
  emit(db, entry); emit(db, entry); emit(db, entry);
  assert.equal(db.notifications.length, 2);
});

// ── Read state: per user, including group notifications ─────────────────────
test("mark-read and mark-all-read are per user, for group notifications", () => {
  const db = makeDb();
  emit(db, audit("PO_SUBMITTED_BY_CLIENT", "purchase_order", "po_zim", { quotation_id: "q_zim" }));
  const id = db.notifications[0].id;

  const r = res();
  markRead({ db, user: { id: "u_fin" }, params: { id } }, r);
  assert.equal(r.body.data.read, true);
  const ops = res();
  getNotifications({ db, user: { id: "u_ops" } }, ops);
  assert.equal(ops.body.data.find((x) => x.id === id).read, false, "Operations still sees it unread");

  markAllRead({ db, user: { id: "u_ops" } }, res());
  const admin = res();
  getNotifications({ db, user: { id: "u_admin" } }, admin);
  assert.equal(admin.body.data.find((x) => x.id === id).read, false, "Ops marking all read does not touch Admin");
  const again = res();
  markRead({ db, user: { id: "u_fin" }, params: { id } }, again);
  assert.deepEqual(db.notifications[0].read_by.filter((u) => u === "u_fin"), ["u_fin"], "marking twice does not duplicate");
});

test("notification views never expose other users' ids, role lists or audit ids", () => {
  const db = makeDb();
  emit(db, audit("PO_SUBMITTED_BY_CLIENT", "purchase_order", "po_zim", { quotation_id: "q_zim" }));
  markRead({ db, user: { id: "u_ops" }, params: { id: db.notifications[0].id } }, res());
  const out = res();
  getNotifications({ db, user: { id: "u_fin" } }, out);
  const text = JSON.stringify(out.body);
  for (const secret of ["u_ops", "read_by", "target_roles", "audit_log_id", "exclude_user_ids"]) assert.equal(text.includes(secret), false, secret);
});

test("a viewer cannot mark someone else's notification read", () => {
  const db = makeDb();
  emit(db, audit("ACCESS_REQUEST_CREATED", "access_request", "areq1"));
  const r = res();
  markRead({ db, user: { id: "u_sales" }, params: { id: db.notifications[0].id } }, r);
  assert.equal(r.statusCode, 404);
  assert.deepEqual(db.notifications[0].read_by, []);
});

// ── Cross-client isolation ──────────────────────────────────────────────────
test("Client Viewer sees only their own client's notifications and destinations", () => {
  const db = makeDb();
  emit(db, audit("QUOTE_TRANSITION_Sent_TO_Approved_Pending_PO", "quote", "q_zim", { client_id: "c_zim", quote_number: "Q-1" }));
  emit(db, audit("QUOTE_TRANSITION_Sent_TO_Approved_Pending_PO", "quote", "q_mim", { client_id: "c_mim", quote_number: "Q-2" }));
  assert.equal(visibleTo(db, "u_cz").length, 1);
  assert.equal(visibleTo(db, "u_cm").length, 1);
  // Forge: Mimosa's viewer holding a notification that points at Zimplats' quote.
  const forged = { kind: "quote", id: "q_zim" };
  const out = resolveDestination(db, db.users.find((u) => u.id === "u_cm"), forged);
  assert.equal(out.resolved, false);
  assert.equal(out.route, "/portal");
  assert.equal(JSON.stringify(out).includes("q_zim"), false, "the foreign id is not echoed back");
});

// ── Destinations: typed, validated, role-authorised, stale-safe ────────────
test("destination builder rejects unknown kinds and unsafe identifiers", () => {
  assert.equal(buildDestination("nope", "x"), null);
  assert.equal(buildDestination("quote", "../../admin"), null);
  assert.equal(buildDestination("quote", "https://evil.test"), null);
  assert.equal(buildDestination("quote", "a b"), null);
  assert.equal(buildDestination("quote", ""), null);
  assert.equal(buildDestination("quote", 42), null);
  assert.equal(buildDestination("__proto__", "x"), null);
  assert.deepEqual(buildDestination("quote", "q_1"), { kind: "quote", id: "q_1" });
});

test("every destination route, for every role, is an internal path the role's workspace can open", () => {
  const ALLOWED_PATHS = new Set(["/", "/portal", "/service-requests", "/quotations", "/finance", "/internal-requests", "/worksheets", "/inventory", "/admin"]);
  const db = makeDb();
  const roleUsers = db.users;
  for (const kind of DESTINATION_KINDS) {
    const spec = DESTINATIONS[kind];
    const id = (db[spec.collection] || [])[0]?.id || "missing_1";
    for (const user of roleUsers) {
      const out = resolveDestination(db, user, { kind, id });
      const path = out.route.split("?")[0];
      assert.ok(out.route.startsWith("/") && !out.route.startsWith("//"), `${kind}/${user.role}: ${out.route}`);
      assert.ok(ALLOWED_PATHS.has(path), `${kind}/${user.role} -> ${path}`);
      if (user.role === "Client Viewer") assert.ok(["/", "/portal"].includes(path), `client ${kind} -> ${path}`);
    }
  }
});

test("only Admin is ever routed to the access-request screen, and it focuses that request", () => {
  const db = makeDb();
  for (const user of db.users) {
    const out = resolveDestination(db, user, { kind: "access_request", id: "areq1" });
    if (user.role === "Admin") {
      assert.equal(out.route, "/admin?tab=access-requests&focus=areq1");
      assert.equal(out.exact, true);
    } else {
      assert.equal(out.route, "/", user.role);
      assert.equal(out.resolved, false);
    }
  }
});

test("stale or deleted target falls back to the correct inbox with an honest message", () => {
  const db = makeDb();
  const admin = db.users.find((u) => u.id === "u_admin");
  const out = resolveDestination(db, admin, { kind: "access_request", id: "areq_gone" });
  assert.equal(out.resolved, false);
  assert.equal(out.route, "/admin?tab=access-requests");
  assert.match(out.note, /no longer available/i);
  const ops = resolveDestination(db, db.users.find((u) => u.id === "u_ops"), { kind: "internal_work_request", id: "iwr_gone" });
  assert.equal(ops.route, "/internal-requests");
  assert.match(ops.note, /no longer available/i);
});

test("a technician is not pointed at another technician's worksheet", () => {
  const db = makeDb();
  const out = resolveDestination(db, db.users.find((u) => u.id === "u_tech"), { kind: "worksheet", id: "ws2" });
  assert.equal(out.resolved, false);
  const mine = resolveDestination(db, db.users.find((u) => u.id === "u_tech"), { kind: "worksheet", id: "ws1" });
  assert.equal(mine.resolved, true);
});

test("null, malformed and legacy notifications (no destination) resolve to the dashboard, never throw", () => {
  const db = makeDb();
  const admin = db.users[0];
  for (const bad of [null, undefined, {}, { kind: "quote" }, "quote:q1", { kind: "quote", id: { $ne: 1 } }]) {
    const out = resolveDestination(db, admin, bad);
    assert.equal(out.route, "/");
    assert.equal(out.resolved, false);
  }
});

test("existing curated user-targeted notifications remain visible only to that user", () => {
  const db = makeDb();
  db.notifications.push({ id: "n_legacy", user_id: "u_tech", title: "legacy", message: "m", read_by: [], created_at: new Date().toISOString() });
  assert.equal(visibleTo(db, "u_tech").length, 1);
  assert.equal(visibleTo(db, "u_admin").length, 0);
  const out = res();
  getNotifications({ db, user: { id: "u_tech" } }, out);
  assert.equal(out.body.data[0].destination.route, "/");
});

test("deactivated users receive no notifications", () => {
  const db = makeDb();
  emit(db, audit("ACCESS_REQUEST_CREATED", "access_request", "areq1"));
  db.users.find((u) => u.id === "u_admin").is_active = false;
  assert.equal(visibleTo(db, "u_admin").length, 0);
});

test("internal and service request notifications are ON by default and the kill switch turns them off", () => {
  assert.equal(WORK_REQUEST_NOTIFICATIONS_ENABLED, true);
  const events = [
    ["INTERNAL_WORK_REQUEST_CREATED", "internal_work_request", "iwr1", { recipient_role: "Operations", created_by_user_id: "u_sup" }],
    ["INTERNAL_WORK_REQUEST_ACKNOWLEDGED", "internal_work_request", "iwr1", { created_by_user_id: "u_sup" }],
    ["SERVICE_REQUEST_CREATED", "service_request", "sr_zim", { client_id: "c_zim", created_by_user_id: "u_cz" }],
    ["SERVICE_REQUEST_ACCEPTED", "service_request", "sr_zim", { client_id: "c_zim", created_by_user_id: "u_cz" }]
  ];
  const on = makeDb();
  for (const [action, type, id, nv] of events) emit(on, audit(action, type, id, nv, null, "u_ops"));
  assert.ok(on.notifications.length >= 4, "default path creates them");
  const off = makeDb();
  for (const [action, type, id, nv] of events) handleAuditForNotifications(off, audit(action, type, id, nv, null, "u_ops"), { workRequestNotifications: false });
  assert.equal(off.notifications.length, 0);
});
