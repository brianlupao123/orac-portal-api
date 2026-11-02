import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getCollection, deactivateEntity, collectionGuards } from "../src/controllers/coreController.js";
import { roles } from "../src/permissions.js";
import { makeReq, makeRes } from "./_http.js";

const routerSrc = readFileSync(new URL("../src/router.js", import.meta.url), "utf8").replace(/\r/g, "");
const collections = JSON.parse(
  routerSrc.match(/const collections = (\[[\s\S]*?\]);/)[1].replace(/\s+/g, " ")
);
const allRoles = Object.values(roles);

function db() {
  const d = {};
  for (const c of collections) d[c] = [];
  d.users = allRoles.map((role, i) => ({
    id: `u_${i}`, role, is_active: true, email: `r${i}@x.co`, name: role,
    password_hash: "SECRET_HASH", reset_token: "SECRET_TOKEN", reset_token_expires_at: 1,
    ...(role === roles.CLIENT_VIEWER ? { client_id: "cA" } : {})
  }));
  d.users.push({ id: "viewerB", role: roles.CLIENT_VIEWER, is_active: true, client_id: "cB", email: "b@x.co", password_hash: "SECRET_HASH" });
  d.users.push({ id: "gone", role: roles.ADMIN, is_active: false, email: "g@x.co" });
  d.clients = [{ id: "cA", name: "Client A" }, { id: "cB", name: "Client B" }];
  d.quotes = [{ id: "qA", client_id: "cA" }, { id: "qB", client_id: "cB" }];
  d.quote_lines = [{ id: "lA", quotation_id: "qA" }, { id: "lB", quotation_id: "qB" }];
  d.dispatch_cards = [{ id: "dA", quotation_id: "qA" }, { id: "dB", quotation_id: "qB" }];
  d.invoices = [{ id: "iA", dispatch_card_id: "dA" }, { id: "iB", dispatch_card_id: "dB" }, { id: "iOrphan", dispatch_card_id: "missing" }];
  d.purchase_orders = [{ id: "pA", quotation_id: "qA" }, { id: "pB", quotation_id: "qB" }];
  d.audit_logs = [{ id: "a1", new_values: { reset_token: "SECRET_TOKEN", keep: 1 }, old_values: { password_hash: "SECRET_HASH" } }];
  return d;
}
const call = (handler, d, userId, extra = {}) => {
  const res = makeRes();
  handler(makeReq({ method: "GET", db: d, user: { id: userId }, params: {}, store: { audit() {} }, ...extra }), res);
  return res;
};
const userFor = (d, role) => d.users.find((u) => u.role === role && u.client_id !== "cB");

test("every mounted collection has an explicit role policy (no implicit allow)", () => {
  for (const c of collections) assert.ok(Array.isArray(collectionGuards[c]), `${c} has no entry in collectionGuards`);
  assert.ok(!collectionGuards.users.includes(roles.MANAGEMENT));
  assert.deepEqual(collectionGuards.users, [roles.ADMIN]);
  assert.deepEqual(collectionGuards.access_requests, [roles.ADMIN]);
});

test("collection x role matrix: 200 exactly for the roles in the policy, 403 for every other role", () => {
  const d = db();
  for (const c of collections) {
    for (const role of allRoles) {
      const res = call(getCollection(c), d, userFor(d, role).id);
      const allowed = collectionGuards[c].includes(role);
      assert.equal(res.statusCode, allowed ? 200 : 403, `${role} on ${c}`);
    }
  }
});

test("deactivated accounts and unknown users are refused on every collection", () => {
  const d = db();
  for (const c of collections) {
    assert.equal(call(getCollection(c), d, "gone").statusCode, 403, c);
    assert.equal(call(getCollection(c), d, "does-not-exist").statusCode, 403, c);
  }
});

test("users and audit_logs responses never contain password hashes or reset tokens", () => {
  const d = db();
  const admin = userFor(d, roles.Admin ?? roles.ADMIN).id;
  for (const c of ["users", "audit_logs"]) {
    const text = JSON.stringify(call(getCollection(c), d, admin).body);
    assert.equal(text.includes("SECRET_HASH"), false, c);
    assert.equal(text.includes("SECRET_TOKEN"), false, c);
  }
  assert.match(JSON.stringify(call(getCollection("audit_logs"), d, admin).body), /keep/, "non-sensitive audit content is retained");
});

test("Client Viewer A sees only client A rows; B sees only B rows; orphaned rows are hidden from both", () => {
  const d = db();
  const viewerA = userFor(d, roles.CLIENT_VIEWER).id;
  const ids = (c, uid) => call(getCollection(c), d, uid).body.data.map((r) => r.id).sort();
  assert.deepEqual(ids("clients", viewerA), ["cA"]);
  assert.deepEqual(ids("quotes", viewerA), ["qA"]);
  assert.deepEqual(ids("quote_lines", viewerA), ["lA"]);
  assert.deepEqual(ids("invoices", viewerA), ["iA"]);
  assert.deepEqual(ids("clients", "viewerB"), ["cB"]);
  assert.deepEqual(ids("quotes", "viewerB"), ["qB"]);
  assert.deepEqual(ids("invoices", "viewerB"), ["iB"]);
  for (const role of [roles.CLIENT_VIEWER]) {
    for (const c of collections.filter((x) => !collectionGuards[x].includes(role))) {
      assert.equal(call(getCollection(c), d, viewerA).statusCode, 403, `Client Viewer must not read ${c}`);
    }
  }
});

test("Client Viewer receives only its own Sent-or-later quotations and their lines", () => {
  const d = db();
  const viewerA = userFor(d, roles.CLIENT_VIEWER).id;
  d.quotes = [
    { id: "q-draft", client_id: "cA", status: "Draft" },
    { id: "q-cancelled", client_id: "cA", status: "Cancelled" },
    { id: "q-sent", client_id: "cA", status: "Sent" },
    { id: "q-po-verified", client_id: "cA", status: "PO_Verified" },
    { id: "q-other-client", client_id: "cB", status: "Sent" }
  ];
  d.quote_lines = d.quotes.map((quote) => ({ id: `line-${quote.id}`, quotation_id: quote.id }));

  const quoteIds = call(getCollection("quotes"), d, viewerA).body.data.map((quote) => quote.id).sort();
  const lineIds = call(getCollection("quote_lines"), d, viewerA).body.data.map((line) => line.id).sort();

  assert.deepEqual(quoteIds, ["q-po-verified", "q-sent"]);
  assert.deepEqual(lineIds, ["line-q-po-verified", "line-q-sent"]);
});

test("Technician and Supervisor only see dispatches/worksheets they are assigned to", () => {
  const d = db();
  d.dispatch_cards = [
    { id: "d1", assigned_technician_ids: ["t1"], assigned_supervisor_id: "s1" },
    { id: "d2", assigned_technician_ids: [], assigned_supervisor_id: "s2" }
  ];
  d.field_worksheets = [{ id: "w1", dispatch_card_id: "d1", technician_id: "t1", supervisor_id: "s1" }, { id: "w2", dispatch_card_id: "d2", technician_id: "t2", supervisor_id: "s2" }];
  d.users.push({ id: "t1", role: roles.TECHNICIAN, is_active: true }, { id: "s1", role: roles.SUPERVISOR, is_active: true });
  const ids = (c, uid) => call(getCollection(c), d, uid).body.data.map((r) => r.id);
  assert.deepEqual(ids("dispatch_cards", "t1"), ["d1"]);
  assert.deepEqual(ids("field_worksheets", "t1"), ["w1"]);
  assert.deepEqual(ids("dispatch_cards", "s1"), ["d1"]);
  assert.deepEqual(ids("field_worksheets", "s1"), ["w1"]);
});

test("archive routes: ledger and audit collections answer 405 even for Admin; others need the matching permission", () => {
  const d = db();
  const admin = userFor(d, roles.ADMIN).id;
  for (const c of ["audit_logs", "stock_movements", "quotes", "invoices", "leads", "access_requests", "dispatch_cards", "field_worksheets", "purchase_orders", "quote_lines"]) {
    const res = call(deactivateEntity(c), d, admin, { method: "POST", params: { id: "x" } });
    assert.equal(res.statusCode, 405, c);
  }
  d.stock_items = [{ id: "s1", is_active: true }];
  const tech = userFor(d, roles.TECHNICIAN).id;
  assert.equal(call(deactivateEntity("stock_items"), d, tech, { method: "POST", params: { id: "s1" } }).statusCode, 403);
  assert.equal(d.stock_items[0].is_active, true, "refused archive changes nothing");
  assert.equal(call(deactivateEntity("stock_items"), d, admin, { method: "POST", params: { id: "s1" } }).statusCode, 200);
});
