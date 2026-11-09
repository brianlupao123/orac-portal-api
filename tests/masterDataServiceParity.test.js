import assert from "node:assert/strict";
import test from "node:test";
import { createClientRecord, createCatalogItemRecord, MasterDataRuleError } from "../src/services/masterDataService.js";
import { createClient, createCatalogItem } from "../src/controllers/adminController.js";
import { IMPORT_ENTITIES, analyseCsv } from "../src/importers/masterDataImport.js";
import { normalizeDb } from "../src/store.js";

// Synthetic data only. No server, no files: plain objects in memory.

function fixture() {
  const db = normalizeDb({ users: [], clients: [], catalog_items: [] }, { seedDemoRecords: false });
  db.users.push({ id: "u_a", role: "Admin", is_active: true, name: "Test Admin", email: "admin@example.test" });
  db.users.push({ id: "u_s", role: "Sales", is_active: true, name: "Test Sales", email: "sales@example.test" });
  let n = 0;
  const store = { id: (prefix) => `${prefix}_${++n}`, audit: (d, actor, type, id, action, oldV, newV) => { d.audit_logs.push({ entity_type: type, entity_id: id, action, old_values: oldV, new_values: newV, actor_id: actor.id }); } };
  return { db, store, admin: db.users[0], sales: db.users[1] };
}
const withoutId = ({ id, ...rest }) => rest;

test("client: the shared service, the admin handler and the importer create identical records and audit entries", () => {
  const input = { name: "Parity Co", client_type: "Mine", contact_person: "Pat Example", email: "pat@example.test" };
  const a = fixture();
  const direct = createClientRecord({ db: a.db, store: a.store, actor: a.admin, input });

  const b = fixture();
  let body;
  createClient({ db: b.db, store: b.store, user: { id: "u_a" }, body: input }, { json: (x) => { body = x; } });

  const c = fixture();
  const row = analyseCsv(IMPORT_ENTITIES.clients, "name,client_type,contact_person,email\nParity Co,Mine,Pat Example,pat@example.test\n").rows[0];
  const imported = IMPORT_ENTITIES.clients.create({ db: c.db, store: c.store, actor: c.admin, input: row.parsed });

  for (const key of Object.keys(withoutId(direct))) assert.deepEqual(body.data[key], direct[key], `handler response field ${key}`);
  for (const record of [direct, body.data, imported]) {
    assert.deepEqual(withoutId(record).name, "Parity Co");
    assert.equal(record.is_active, true);
  }
  assert.deepEqual(withoutId(direct), withoutId(imported));
  const auditOf = (f) => f.db.audit_logs.map(({ entity_id, new_values, ...rest }) => ({ ...rest, new: withoutId(new_values) }));
  assert.deepEqual(auditOf(a), auditOf(c));
  assert.deepEqual(auditOf(a), auditOf(b));
});

test("catalog item: service, handler and importer agree, with defaults for blank optional fields", () => {
  const a = fixture();
  const direct = createCatalogItemRecord({ db: a.db, store: a.store, actor: a.admin, input: { item_code: "P-1", item_name: "Parity Bolt", unit_price: 12.5 } });
  const b = fixture();
  let body;
  createCatalogItem({ db: b.db, store: b.store, user: { id: "u_a" }, body: { item_code: "P-1", item_name: "Parity Bolt", unit_price: 12.5 } }, { json: (x) => { body = x; }, status: () => ({ json: (x) => { body = x; } }) });
  const c = fixture();
  const row = analyseCsv(IMPORT_ENTITIES.catalog_items, "item_code,item_name,unit_price\nP-1,Parity Bolt,12.50\n").rows[0];
  const imported = IMPORT_ENTITIES.catalog_items.create({ db: c.db, store: c.store, actor: c.admin, input: row.parsed });
  assert.deepEqual(withoutId(direct), withoutId(imported));
  assert.deepEqual(withoutId(body.data), withoutId(direct));
  assert.equal(direct.category, "");
  assert.equal(direct.unit_price, 12.5);
});

test("the service keeps the permission check and the negative-price rule that used to live in the handlers", () => {
  const f = fixture();
  assert.throws(() => createClientRecord({ db: f.db, store: f.store, actor: f.sales, input: { name: "X", client_type: "Y" } }), (e) => e.status === 403);
  assert.throws(() => createCatalogItemRecord({ db: f.db, store: f.store, actor: f.sales, input: { item_code: "X", item_name: "Y", unit_price: 1 } }), (e) => e.status === 403);
  assert.throws(() => createCatalogItemRecord({ db: f.db, store: f.store, actor: f.admin, input: { item_code: "X", item_name: "Y", unit_price: -1 } }), (e) => e instanceof MasterDataRuleError && e.message === "Unit price cannot be negative." && e.status === 400);
  assert.equal(f.db.catalog_items.length, 0);
  assert.equal(f.db.audit_logs.length, 0);
});

test("the catalog handler still answers 400 with the old message when the rule fires", () => {
  const f = fixture();
  let status; let body;
  const res = { json: (x) => { body = x; }, status: (s) => { status = s; return { json: (x) => { body = x; } }; } };
  createCatalogItem({ db: f.db, store: f.store, user: { id: "u_a" }, body: { item_code: "N-1", item_name: "Neg", unit_price: -3 } }, res);
  assert.equal(status, 400);
  assert.deepEqual(body, { success: false, message: "Unit price cannot be negative." });
});
