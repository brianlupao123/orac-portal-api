import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../src/store.js";
import { handleAuditForNotifications } from "../src/notifications.js";
import { getVisibleNotifications } from "../src/controllers/notificationController.js";

/* ── Helpers ── */
function makeDb() {
  const store = createStore(":memory:");
  const db = {
    users: [
      { id: "u_admin", name: "Admin", role: "Admin", is_active: true },
      { id: "u_sales", name: "Sales", role: "Sales", is_active: true },
      { id: "u_finance", name: "Finance", role: "Finance", is_active: true },
      { id: "u_tech", name: "Technician", role: "Technician", is_active: true },
      { id: "u_ops", name: "Ops", role: "Operations", is_active: true },
      { id: "u_supervisor", name: "Supervisor", role: "Supervisor", is_active: true },
      { id: "u_mgmt", name: "Management", role: "Management", is_active: true },
      { id: "u_client_zim", name: "Zimplats Viewer", role: "Client Viewer", is_active: true, client_id: "c_zim" },
      { id: "u_client_mim", name: "Mimosa Viewer", role: "Client Viewer", is_active: true, client_id: "c_mim" },
      { id: "u_client_none", name: "Unassigned Viewer", role: "Client Viewer", is_active: true }
    ],
    clients: [
      { id: "c_zim", name: "Zimplats" },
      { id: "c_mim", name: "Mimosa" }
    ],
    quotes: [
      { id: "q1", quote_number: "Q-001", client_id: "c_zim", status: "Approved_Pending_PO" }
    ],
    purchase_orders: [],
    dispatch_cards: [],
    field_worksheets: [],
    timesheets: [],
    material_usage: [],
    invoices: [],
    invoice_lines: [],
    audit_logs: [],
    notifications: [],
    stock_items: [],
    stock_movements: [],
    suppliers: []
  };
  return { db, store };
}

function makeAudit(action, entityType, entityId, newValues, oldValues) {
  return {
    id: `audit_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    actor_id: "u_admin",
    entity_type: entityType,
    entity_id: entityId,
    action,
    old_values: oldValues || null,
    new_values: newValues || null,
    created_at: new Date().toISOString()
  };
}

/* ── Tests ── */

test("LEAD_CREATED generates notification for Sales/Admin/Management", () => {
  const { db } = makeDb();
  const audit = makeAudit("LEAD_CREATED", "lead", "l1", { id: "l1", client_id: "c_zim" });
  handleAuditForNotifications(db, audit);

  assert.equal(db.notifications.length, 1);
  const notif = db.notifications[0];
  assert.equal(notif.type, "lead");
  assert.equal(notif.audit_log_id, audit.id);
  assert.ok(notif.target_roles.includes("Sales"));
  assert.ok(notif.target_roles.includes("Admin"));
  assert.ok(notif.target_roles.includes("Management"));
  assert.ok(!notif.target_roles.includes("Technician"));
  assert.ok(!notif.target_roles.includes("Finance"));
});

test("WORKSHEET_SUBMITTED asks for client acknowledgement and tells Operations/Admin/Management it is waiting (not yet reviewable)", () => {
  const { db } = makeDb();
  const audit = makeAudit("WORKSHEET_SUBMITTED", "field_worksheet", "ws1", { id: "ws1" });
  handleAuditForNotifications(db, audit);

  // No resolvable dispatch/client in this fixture, so only the staff notification exists (fails closed for clients).
  assert.equal(db.notifications.length, 1);
  const notif = db.notifications[0];
  assert.equal(notif.type, "worksheet");
  assert.match(notif.message, /waiting for client acknowledgement/i);
  assert.ok(notif.target_roles.includes("Operations"));
  assert.ok(notif.target_roles.includes("Admin"));
  assert.ok(notif.target_roles.includes("Management"));
  assert.ok(!notif.target_roles.includes("Supervisor"), "Supervisors are assignment-scoped; they are notified individually");
  assert.ok(!notif.target_roles.includes("Finance"));
});

test("PO_AMENDMENT_REQUIRED only generates one notification (idempotent)", () => {
  const { db, store } = makeDb();
  const po = {
    id: "po1", quotation_id: "q1", po_reference: "PO-001",
    po_amount: 100, logged_value: 0, requires_amendment: false, status: "verified"
  };
  db.purchase_orders.push(po);
  db.dispatch_cards.push({ id: "dc1", quotation_id: "q1", purchase_order_id: "po1" });
  db.timesheets.push({ dispatch_card_id: "dc1", hours_logged: 10, hourly_rate: 20 }); // 200 > 100

  // First recalculation triggers PO_AMENDMENT_REQUIRED
  store.recalculateVariance(db, "po1");
  const firstCount = db.notifications.filter(n => n.type === "po").length;
  assert.equal(firstCount, 1, "First recalculation should generate 1 PO notification");

  // Second recalculation should NOT generate a duplicate
  store.recalculateVariance(db, "po1");
  const secondCount = db.notifications.filter(n => n.type === "po").length;
  assert.equal(secondCount, 1, "Second recalculation should not duplicate the notification");
});

test("Client Viewer cannot see other clients' notifications", () => {
  const { db } = makeDb();

  // Notification for Zimplats (c_zim)
  const audit1 = makeAudit("QUOTE_TRANSITION_Sent_TO_Approved_Pending_PO", "quotation", "q1", { quote_number: "Q-001", client_id: "c_zim" });
  handleAuditForNotifications(db, audit1);

  // Notification for Mimosa (c_mim)
  const audit2 = makeAudit("QUOTE_TRANSITION_Sent_TO_Approved_Pending_PO", "quotation", "q2", { quote_number: "Q-002", client_id: "c_mim" });
  audit2.id = audit2.id + "_2"; // ensure unique
  handleAuditForNotifications(db, audit2);

  assert.equal(db.notifications.length, 2);

  // Zimplats viewer sees only Zimplats notifications
  const zimVisible = getVisibleNotifications(db, db.users.find(u => u.id === "u_client_zim"));
  assert.equal(zimVisible.length, 1);
  assert.equal(zimVisible[0].client_id, "c_zim");

  // Mimosa viewer sees only Mimosa notifications
  const mimVisible = getVisibleNotifications(db, db.users.find(u => u.id === "u_client_mim"));
  assert.equal(mimVisible.length, 1);
  assert.equal(mimVisible[0].client_id, "c_mim");

  // Client Viewer with no client_id sees nothing
  const noneVisible = getVisibleNotifications(db, db.users.find(u => u.id === "u_client_none"));
  assert.equal(noneVisible.length, 0);
});

test("Technician cannot see finance-only notifications", () => {
  const { db } = makeDb();
  const audit = makeAudit("INVOICE_GENERATED", "invoice", "inv1", { invoice_number: "INV-001" });
  handleAuditForNotifications(db, audit);

  assert.equal(db.notifications.length, 1);
  const notif = db.notifications[0];
  assert.ok(notif.target_roles.includes("Finance"));

  // Technician cannot see it
  const techVisible = getVisibleNotifications(db, db.users.find(u => u.id === "u_tech"));
  assert.equal(techVisible.length, 0);

  // Finance can see it
  const finVisible = getVisibleNotifications(db, db.users.find(u => u.id === "u_finance"));
  assert.equal(finVisible.length, 1);
});

test("markRead rejects invisible notification (via visibility filter)", () => {
  const { db } = makeDb();
  // Create a finance-only notification
  const audit = makeAudit("INVOICE_GENERATED", "invoice", "inv1", { invoice_number: "INV-001" });
  handleAuditForNotifications(db, audit);

  const notifId = db.notifications[0].id;
  const techUser = db.users.find(u => u.id === "u_tech");

  // Technician tries to find it in their visible list — should fail
  const techVisible = getVisibleNotifications(db, techUser);
  const found = techVisible.find(n => n.id === notifId);
  assert.equal(found, undefined, "Technician should not find finance notification");
});

test("Admin/Management can see broad oversight notifications", () => {
  const { db } = makeDb();

  // Lead notification
  const a1 = makeAudit("LEAD_CREATED", "lead", "l1", { id: "l1" });
  handleAuditForNotifications(db, a1);

  // Worksheet submitted
  const a2 = makeAudit("WORKSHEET_SUBMITTED", "field_worksheet", "ws1", { id: "ws1" });
  handleAuditForNotifications(db, a2);

  // Invoice generated
  const a3 = makeAudit("INVOICE_GENERATED", "invoice", "inv1", { invoice_number: "INV-001" });
  handleAuditForNotifications(db, a3);

  assert.equal(db.notifications.length, 3);

  // Admin sees all three
  const adminVisible = getVisibleNotifications(db, db.users.find(u => u.id === "u_admin"));
  assert.equal(adminVisible.length, 3, "Admin should see all notifications");

  // Management sees all three
  const mgmtVisible = getVisibleNotifications(db, db.users.find(u => u.id === "u_mgmt"));
  assert.equal(mgmtVisible.length, 3, "Management should see all notifications");
});

test("duplicate audit_log_id does not create duplicate notification", () => {
  const { db } = makeDb();
  const audit = makeAudit("LEAD_CREATED", "lead", "l1", { id: "l1" });
  handleAuditForNotifications(db, audit);
  handleAuditForNotifications(db, audit); // same audit entry again

  assert.equal(db.notifications.length, 1, "Should not create duplicate notification");
});

test("curated user-targeted notifications remain visible without role metadata", () => {
  const { db } = makeDb();
  db.notifications.push({
    id: "notification_demo_001",
    user_id: "u_supervisor",
    type: "worksheet_submitted",
    message: "Worksheet FW-DEMO-002 is ready for review.",
    read_at: null,
    created_at: new Date().toISOString()
  });

  const supervisor = db.users.find((user) => user.id === "u_supervisor");
  const technician = db.users.find((user) => user.id === "u_tech");

  assert.equal(getVisibleNotifications(db, supervisor).length, 1);
  assert.equal(getVisibleNotifications(db, technician).length, 0);
});
