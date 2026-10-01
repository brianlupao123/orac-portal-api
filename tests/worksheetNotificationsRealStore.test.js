import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../src/store.js";
import { submitWorksheet, reviewWorksheet } from "../src/controllers/dispatchController.js";
import { acknowledgeWorksheet } from "../src/controllers/timesheetAcknowledgementController.js";
import { getNotifications, markRead } from "../src/controllers/notificationController.js";

// Real controllers + real central audit() + real store (in memory): the corrected worksheet
// notification sequence. Submit asks the CLIENT to acknowledge; only the client's
// acknowledgement notifies reviewers (Admin, Operations, the ASSIGNED Supervisor).

const response = () => ({ statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
function call(handler, db, store, userId, { params, body } = {}) {
  const res = response();
  handler({ db, store, user: { id: userId }, params: params || {}, body: body || {}, query: {} }, res);
  return res;
}
const list = (db, store, userId) => { const res = response(); getNotifications({ db, store, user: { id: userId } }, res); return res.body.data; };

async function fixture() {
  const store = createStore(":memory:");
  const { db, release } = await store.read();
  const hash = db.users[0].password_hash;
  db.users.push(
    { id: "u_sup_other", name: "Other Supervisor", email: "sup2@orac.test", role: "Supervisor", is_active: true, password_hash: hash },
    { id: "u_client_mim", name: "Mimosa Viewer", email: "mim@orac.test", role: "Client Viewer", client_id: "c_mimosa", is_active: true, password_hash: hash }
  );
  db.quotes.push({ id: "q_w", quote_number: "Q-W", client_id: "c_zimplats", status: "Approved" });
  db.dispatch_cards.push({ id: "dc_w", quotation_id: "q_w", assigned_supervisor_id: "u_supervisor", assigned_technician_ids: ["u_tech"], status: "In_Progress" });
  db.field_worksheets.push({ id: "fw_w", dispatch_card_id: "dc_w", technician_id: "u_tech", submitted_by: "u_tech", supervisor_id: "u_supervisor", status: "Draft", created_at: new Date().toISOString() });
  return { store, db, release };
}

test("submit asks the owning client to acknowledge; staff are told it is waiting; nobody is told it is reviewable yet", async () => {
  const { store, db, release } = await fixture();
  try {
    const before = db.notifications.length;
    assert.equal(call(submitWorksheet, db, store, "u_tech", { params: { id: "fw_w" } }).statusCode, 200);
    assert.equal(db.field_worksheets.find((w) => w.id === "fw_w").status, "Submitted");
    assert.ok(db.notifications.length > before);

    const client = list(db, store, "u_client");
    assert.equal(client.length, 1);
    assert.match(client[0].message, /acknowledg/i);
    assert.equal(client[0].destination.route, "/portal");
    assert.equal(list(db, store, "u_client_mim").length, 0, "another client sees nothing");
    for (const id of ["u_admin", "u_ops", "u_management"]) {
      const items = list(db, store, id);
      assert.equal(items.length, 1, id);
      assert.match(items[0].message, /waiting for client acknowledgement/i);
    }
    assert.equal(list(db, store, "u_supervisor").length, 1, "assigned Supervisor");
    for (const id of ["u_sup_other", "u_sales", "u_finance"]) assert.equal(list(db, store, id).length, 0, id);
    assert.equal(list(db, store, "u_tech").length, 0, "the submitter is not notified of their own action");
  } finally { store.release(release); }
});

test("client acknowledgement notifies authorized reviewers only, then a Supervisor return notifies the owner; read state stays per user", async () => {
  const { store, db, release } = await fixture();
  try {
    call(submitWorksheet, db, store, "u_tech", { params: { id: "fw_w" } });

    // A client of ANOTHER client cannot acknowledge, and creates no notification.
    const count = db.notifications.length;
    const foreign = call(acknowledgeWorksheet, db, store, "u_client_mim", { params: { id: "fw_w" }, body: { signer_name: "X", signer_role: "Y" } });
    assert.equal(foreign.statusCode, 403);
    assert.equal(db.notifications.length, count);

    assert.equal(call(acknowledgeWorksheet, db, store, "u_client", { params: { id: "fw_w" }, body: { signer_name: "Zim Rep", signer_role: "Foreman" } }).statusCode, 200);
    const ready = (id) => list(db, store, id).filter((n) => /Ready for Review/.test(n.title));
    for (const id of ["u_admin", "u_ops", "u_supervisor"]) assert.equal(ready(id).length, 1, id);
    for (const id of ["u_sup_other", "u_management", "u_sales", "u_finance", "u_tech", "u_client", "u_client_mim"]) assert.equal(ready(id).length, 0, id);

    // Per-user read state on a group notification.
    const adminItem = ready("u_admin")[0];
    const res = response();
    markRead({ db, store, user: { id: "u_admin" }, params: { id: adminItem.id } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(ready("u_admin")[0].read, true);
    assert.equal(ready("u_ops")[0].read, false);

    // The assigned Supervisor returns it; the owning technician is told, the other technician is not.
    assert.equal(call(reviewWorksheet, db, store, "u_supervisor", { params: { id: "fw_w" }, body: { decision: "return", comment: "Fix hours" } }).statusCode, 200);
    assert.equal(list(db, store, "u_tech").filter((n) => /returned/i.test(n.title)).length, 1);
    assert.equal(list(db, store, "u_sup_other").length, 0);
    assert.equal(list(db, store, "u_client").some((n) => /returned/i.test(n.title)), false);
  } finally { store.release(release); }
});
