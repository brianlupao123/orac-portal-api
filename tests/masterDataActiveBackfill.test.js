import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDb } from "../src/store.js";

function dbWithout(fields) {
  return {
    users: [],
    clients: [{ id: "c1", name: "Legacy Client" }],
    mine_sites: [{ id: "ms1", client_id: "c1", name: "Legacy Site" }],
    plants: [{ id: "pl1", mine_site_id: "ms1", name: "Legacy Plant" }],
    plant_sections: [{ id: "ps1", plant_id: "pl1", name: "Legacy Section" }],
    equipment_tags: [{ id: "eq1", plant_section_id: "ps1", tag_code: "EQ-1" }],
    ...fields
  };
}

test("normalizeDb backfills is_active=true for every master-data collection missing the field", () => {
  const db = normalizeDb(dbWithout({}));
  assert.equal(db.clients[0].is_active, true);
  assert.equal(db.mine_sites[0].is_active, true);
  assert.equal(db.plants[0].is_active, true);
  assert.equal(db.plant_sections[0].is_active, true);
  assert.equal(db.equipment_tags[0].is_active, true);
});

test("normalizeDb does NOT override an explicit is_active:false (a real archived record stays archived)", () => {
  const db = normalizeDb(dbWithout({
    mine_sites: [{ id: "ms1", client_id: "c1", name: "Archived Site", is_active: false }]
  }));
  assert.equal(db.mine_sites[0].is_active, false);
});

test("normalizeDb leaves an explicit is_active:true untouched", () => {
  const db = normalizeDb(dbWithout({
    plants: [{ id: "pl1", mine_site_id: "ms1", name: "Already Active Plant", is_active: true }]
  }));
  assert.equal(db.plants[0].is_active, true);
});

test("normalizeDb backfill is idempotent across repeated calls", () => {
  let db = dbWithout({});
  db = normalizeDb(db);
  db.mine_sites[0].is_active = false; // simulate a real deactivation between reads
  db = normalizeDb(db);
  assert.equal(db.mine_sites[0].is_active, false, "a second normalize pass must not resurrect an archived record");
});

test("normalizeDb can preserve an intentionally empty user collection without adding demo accounts", () => {
  const db = normalizeDb(dbWithout({ users: [] }), { seedDemoRecords: false });
  assert.deepEqual(db.users, []);
});

test("normalizeDb still seeds demo users by default for local JSON/demo compatibility", () => {
  const db = normalizeDb(dbWithout({}));
  assert.ok(db.users.some((user) => user.id === "u_admin"));
});
