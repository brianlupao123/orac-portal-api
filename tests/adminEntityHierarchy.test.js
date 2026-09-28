import assert from "node:assert/strict";
import test from "node:test";
import {
  createClient,
  createMineSite,
  updateMineSite,
  createPlant,
  updatePlant,
  createPlantSection,
  updatePlantSection,
  createEquipmentTag,
  updateEquipmentTag
} from "../src/controllers/adminController.js";

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function store(nextId = "new-1") {
  return {
    id: () => nextId,
    audit(_db, _actor, _entity, _id, _action, before, after) {
      this.before = before;
      this.after = after;
    }
  };
}

function database() {
  const operationsUser = { id: "ops-1", name: "Ops", email: "ops@example.test", role: "Operations", is_active: true };
  const adminUser = { id: "admin-1", name: "Admin", email: "admin@example.test", role: "Admin", is_active: true };
  return {
    users: [operationsUser, adminUser],
    clients: [
      { id: "c_zimplats", name: "Zimplats", client_type: "permanent", is_active: true },
      { id: "c_retired", name: "Retired Client", client_type: "permanent", is_active: false }
    ],
    mine_sites: [
      { id: "ms_ngezi", client_id: "c_zimplats", name: "Ngezi", location: "Zimbabwe", is_active: true },
      { id: "ms_old", client_id: "c_zimplats", name: "Old Site", location: "Zimbabwe", is_active: false }
    ],
    plants: [
      { id: "pl_smc", mine_site_id: "ms_ngezi", name: "SMC Concentrator", plant_code: "SMC-CON", is_active: true }
    ],
    plant_sections: [
      { id: "ps_cyclone", plant_id: "pl_smc", name: "Cyclone Cluster", section_code: "CYCLONE", is_active: true }
    ],
    equipment_tags: [],
    audit_logs: []
  };
}

function req(db, backingStore, overrides = {}) {
  return { user: { id: "ops-1" }, db, store: backingStore, body: {}, params: {}, ...overrides };
}

// ── Referential integrity (orphan prevention) ──

test("createMineSite rejects a client_id that does not exist (400, no record inserted)", () => {
  const db = database();
  const res = response();
  createMineSite(req(db, store(), { body: { client_id: "c_does_not_exist", name: "New Site" } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.match(res.body.message, /No client exists/);
  assert.equal(db.mine_sites.length, 2, "no orphan mine site should have been inserted");
});

test("createPlant rejects a mine_site_id that does not exist", () => {
  const db = database();
  const res = response();
  createPlant(req(db, store(), { body: { mine_site_id: "ms_missing", name: "New Plant", plant_code: "NP" } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /No mine site exists/);
  assert.equal(db.plants.length, 1);
});

test("createPlantSection rejects a plant_id that does not exist", () => {
  const db = database();
  const res = response();
  createPlantSection(req(db, store(), { body: { plant_id: "pl_missing", name: "New Section", section_code: "NS" } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /No plant exists/);
});

test("createEquipmentTag rejects a plant_section_id that does not exist", () => {
  const db = database();
  const res = response();
  createEquipmentTag(req(db, store(), { body: { plant_section_id: "ps_missing", tag_code: "EQ-X", equipment_name: "Pump" } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /No plant section exists/);
  assert.equal(db.equipment_tags.length, 0);
});

// ── Active-parent enforcement on new/changed links ──

test("createMineSite rejects an inactive client as the parent of a brand-new mine site", () => {
  const db = database();
  const res = response();
  createMineSite(req(db, store(), { body: { client_id: "c_retired", name: "New Site" } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /inactive client/);
});

test("updatePlant rejects RE-PARENTING onto an inactive mine site", () => {
  const db = database();
  const res = response();
  updatePlant(req(db, store(), { params: { id: "pl_smc" }, body: { mine_site_id: "ms_old" } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /inactive mine site/);
  assert.equal(db.plants[0].mine_site_id, "ms_ngezi", "the original link must be unchanged after a rejected re-parent");
});

test("updateMineSite allows saving unrelated fields WITHOUT touching an already-inactive client link (preserves historical data)", () => {
  const db = database();
  db.mine_sites.push({ id: "ms_hist", client_id: "c_retired", name: "Historical Site", location: "X", is_active: true });
  const res = response();
  updateMineSite(req(db, store(), { params: { id: "ms_hist" }, body: { location: "Updated location only" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.location, "Updated location only");
  assert.equal(res.body.data.client_id, "c_retired", "the historical (inactive-parent) link is preserved, not blocked");
});

// ── is_active defaults on create ──

test("createClient, createMineSite, createPlant, createPlantSection, createEquipmentTag all default is_active to true", () => {
  const db = database();
  const clientRes = response();
  createClient(req(db, store("c_new"), { user: { id: "admin-1" }, body: { name: "Brand New Co", client_type: "permanent" } }), clientRes);
  assert.equal(clientRes.body.data.is_active, true);

  const mineSiteRes = response();
  createMineSite(req(db, store("ms_new"), { body: { client_id: "c_zimplats", name: "New Site" } }), mineSiteRes);
  assert.equal(mineSiteRes.body.data.is_active, true);

  const plantRes = response();
  createPlant(req(db, store("pl_new"), { body: { mine_site_id: "ms_ngezi", name: "New Plant", plant_code: "NP" } }), plantRes);
  assert.equal(plantRes.body.data.is_active, true);

  const sectionRes = response();
  createPlantSection(req(db, store("ps_new"), { body: { plant_id: "pl_smc", name: "New Section", section_code: "NS" } }), sectionRes);
  assert.equal(sectionRes.body.data.is_active, true);

  const tagRes = response();
  createEquipmentTag(req(db, store("eq_new"), { body: { plant_section_id: "ps_cyclone", tag_code: "EQ-NEW", equipment_name: "Pump" } }), tagRes);
  assert.equal(tagRes.body.data.is_active, true);
});

// ── Enrichment on responses (readable names instead of raw ids) ──

test("createPlant's response is enriched with readable mine_site_name and client_name, not just raw ids", () => {
  const db = database();
  const res = response();
  createPlant(req(db, store("pl_new2"), { body: { mine_site_id: "ms_ngezi", name: "New Plant", plant_code: "NP2" } }), res);
  assert.equal(res.body.data.mine_site_name, "Ngezi");
  assert.equal(res.body.data.client_name, "Zimplats");
  assert.equal(res.body.data.hierarchy_label, "Zimplats \u203a Ngezi \u203a New Plant");
});

test("updateEquipmentTag's response reflects the full ancestor chain after re-parenting", () => {
  const db = database();
  db.equipment_tags.push({ id: "eq_1", plant_section_id: "ps_cyclone", tag_code: "EQ-1", equipment_name: "Pump", is_active: true });
  const res = response();
  updateEquipmentTag(req(db, store(), { params: { id: "eq_1" }, body: { equipment_name: "Pump (renamed)" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.plant_section_name, "Cyclone Cluster");
  assert.equal(res.body.data.plant_name, "SMC Concentrator");
  assert.equal(res.body.data.mine_site_name, "Ngezi");
  assert.equal(res.body.data.client_name, "Zimplats");
});

// ── Permission is still enforced (unchanged behaviour) ──

test("createMineSite still rejects a caller without manageAssets permission", () => {
  const db = database();
  db.users.push({ id: "viewer-1", name: "Client Viewer", email: "viewer@example.test", role: "Client Viewer", is_active: true });
  const res = response();
  assert.throws(() => {
    createMineSite(req(db, store(), { user: { id: "viewer-1" }, body: { client_id: "c_zimplats", name: "X" } }), res);
  });
});

// ── Status only changes through the audited deactivate/reactivate route ──
// The Admin form used to offer an Active/Inactive dropdown. These pin down why
// it was removed: create/update never honour is_active from the request body,
// so status cannot change except through deactivateEntity/reactivateEntity
// (which stamp deactivated_by/at and write an audit entry).

test("createMineSite ignores a client-supplied is_active:false — records always start active", () => {
  const db = database();
  const res = response();
  createMineSite(req(db, store("ms_x"), { body: { client_id: "c_zimplats", name: "Sneaky", is_active: false } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.is_active, true);
});

test("updateMineSite / updatePlant / updateEquipmentTag never flip is_active from the request body", () => {
  const db = database();
  db.equipment_tags.push({ id: "eq_1", plant_section_id: "ps_cyclone", tag_code: "EQ-1", equipment_name: "Pump", is_active: true });

  updateMineSite(req(db, store(), { params: { id: "ms_ngezi" }, body: { name: "Ngezi 2", is_active: false } }), response());
  updatePlant(req(db, store(), { params: { id: "pl_smc" }, body: { name: "SMC 2", is_active: false } }), response());
  updateEquipmentTag(req(db, store(), { params: { id: "eq_1" }, body: { equipment_name: "Pump 2", is_active: false } }), response());

  assert.equal(db.mine_sites.find((m) => m.id === "ms_ngezi").is_active, true);
  assert.equal(db.plants.find((p) => p.id === "pl_smc").is_active, true);
  assert.equal(db.equipment_tags.find((e) => e.id === "eq_1").is_active, true);
  // ...while the ordinary edits in the same request did apply.
  assert.equal(db.mine_sites.find((m) => m.id === "ms_ngezi").name, "Ngezi 2");
});
