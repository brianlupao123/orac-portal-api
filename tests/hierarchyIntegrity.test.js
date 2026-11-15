// Lane 6 / Batch 1 — hierarchy integrity.
//
//   A. No record is moved to a parent owned by a different client (any level),
//      except ORPHAN REPAIR: a record whose current chain resolves to no client
//      may be re-parented, provided the new parent's chain resolves to a client.
//   B. Equipment tag codes are unique per MINE SITE (not client-wide), ignoring
//      case and extra whitespace, inactive tags included; legacy duplicates stay
//      editable. Client-wide scope is NOT assumed: ORAC has not confirmed a
//      single client-wide equipment-tag register.
//
// Rejected requests must change neither data nor the audit trail.
import assert from "node:assert/strict";
import test from "node:test";
import {
  updateMineSite,
  updatePlant,
  updatePlantSection,
  createEquipmentTag,
  updateEquipmentTag
} from "../src/controllers/adminController.js";
import {
  normaliseTagCode,
  findDuplicateTagCode,
  validateParentAssignment
} from "../src/services/entityHierarchy.js";

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function store() {
  let n = 0;
  return {
    audits: [],
    id: (prefix = "id") => `${prefix}-new-${++n}`,
    audit(_db, _actor, entity, id, action, before, after) {
      this.audits.push({ entity, id, action, before, after });
    }
  };
}

// Client A (c_a) has two sites/plants/sections so a SAME-client move is possible.
// Client B (c_b) is a second client. Several records are deliberately broken
// (orphans) or duplicated (legacy data) to exercise repair and legacy rules.
function database() {
  return {
    users: [{ id: "ops-1", name: "Ops", email: "ops@example.test", role: "Operations", is_active: true }],
    clients: [
      { id: "c_a", name: "Client A", client_type: "permanent", is_active: true },
      { id: "c_b", name: "Client B", client_type: "permanent", is_active: true }
    ],
    mine_sites: [
      { id: "ms_a", client_id: "c_a", name: "Site A", location: "Zimbabwe", is_active: true },
      { id: "ms_a2", client_id: "c_a", name: "Site A2", location: "Zimbabwe", is_active: true },
      { id: "ms_b", client_id: "c_b", name: "Site B", location: "Zimbabwe", is_active: true },
      { id: "ms_orphan", client_id: "c_missing", name: "Orphan Site", location: "Zimbabwe", is_active: true }
    ],
    plants: [
      { id: "pl_a", mine_site_id: "ms_a", name: "Plant A", plant_code: "PA", is_active: true },
      { id: "pl_a2", mine_site_id: "ms_a2", name: "Plant A2", plant_code: "PA2", is_active: true },
      { id: "pl_b", mine_site_id: "ms_b", name: "Plant B", plant_code: "PB", is_active: true },
      // Second plant under Site A: same mine site, different plant.
      { id: "pl_ax", mine_site_id: "ms_a", name: "Plant AX", plant_code: "PAX", is_active: true },
      { id: "pl_orphan", mine_site_id: "ms_missing", name: "Orphan Plant", plant_code: "PO", is_active: true }
    ],
    plant_sections: [
      { id: "ps_a", plant_id: "pl_a", name: "Section A", section_code: "SA", is_active: true },
      { id: "ps_a2", plant_id: "pl_a2", name: "Section A2", section_code: "SA2", is_active: true },
      { id: "ps_b", plant_id: "pl_b", name: "Section B", section_code: "SB", is_active: true },
      { id: "ps_ax", plant_id: "pl_ax", name: "Section AX", section_code: "SAX", is_active: true },
      // Plant exists but its mine site does not -> chain cannot reach a client.
      { id: "ps_broken_chain", plant_id: "pl_orphan", name: "Broken Chain Section", section_code: "SBC", is_active: true },
      { id: "ps_orphan", plant_id: "pl_missing", name: "Orphan Section", section_code: "SO", is_active: true }
    ],
    equipment_tags: [
      { id: "eq_a", plant_section_id: "ps_a", tag_code: "PMP 01", equipment_name: "Pump A", is_active: true },
      { id: "eq_a_retired", plant_section_id: "ps_a2", tag_code: "OLD-7", equipment_name: "Retired Mill", is_active: false },
      { id: "eq_b", plant_section_id: "ps_b", tag_code: "PMP 01", equipment_name: "Pump B (other client, same code)", is_active: true },
      // Legacy duplicates inside mine site A, in different plants (pre-date the uniqueness rule).
      { id: "eq_dup1", plant_section_id: "ps_a", tag_code: "FAN-1", equipment_name: "Fan one", is_active: true },
      { id: "eq_dup2", plant_section_id: "ps_ax", tag_code: "fan-1", equipment_name: "Fan two", is_active: true },
      // Tag whose chain reaches no client (unknown owner).
      { id: "eq_orphan", plant_section_id: "ps_orphan", tag_code: "ORPH-1", equipment_name: "Orphan tag", is_active: true }
    ],
    audit_logs: []
  };
}

function req(db, backingStore, overrides = {}) {
  return { user: { id: "ops-1" }, db, store: backingStore, body: {}, params: {}, ...overrides };
}

function snapshot(db) {
  return JSON.stringify(db);
}

function assertRefused(res, db, st, before, status, pattern) {
  assert.equal(res.statusCode, status);
  assert.equal(res.body.success, false);
  assert.match(res.body.message, pattern);
  assert.equal(snapshot(db), before, "a refused request must not change any data");
  assert.equal(st.audits.length, 0, "a refused request must not write an audit entry");
}

// ── A. Cross-client moves refused at every level ──

test("updateMineSite refuses moving a mine site to a different client; data and audit unchanged", () => {
  const db = database();
  const st = store();
  const before = snapshot(db);
  const res = response();
  updateMineSite(req(db, st, { params: { id: "ms_a" }, body: { client_id: "c_b", name: "Renamed in same request" } }), res);
  assertRefused(res, db, st, before, 400, /different client/);
});

test("updatePlant refuses moving a plant to a mine site of a different client", () => {
  const db = database();
  const st = store();
  const before = snapshot(db);
  const res = response();
  updatePlant(req(db, st, { params: { id: "pl_a" }, body: { mine_site_id: "ms_b", name: "Renamed in same request" } }), res);
  assertRefused(res, db, st, before, 400, /different client/);
});

test("updatePlantSection refuses moving a section to a plant of a different client", () => {
  const db = database();
  const st = store();
  const before = snapshot(db);
  const res = response();
  updatePlantSection(req(db, st, { params: { id: "ps_a" }, body: { plant_id: "pl_b", name: "Renamed in same request" } }), res);
  assertRefused(res, db, st, before, 400, /different client/);
});

test("updateEquipmentTag refuses moving a tag to a plant section of a different client", () => {
  const db = database();
  const st = store();
  const before = snapshot(db);
  const res = response();
  updateEquipmentTag(req(db, st, { params: { id: "eq_a" }, body: { plant_section_id: "ps_b", equipment_name: "Renamed in same request" } }), res);
  assertRefused(res, db, st, before, 400, /different client/);
});

test("the cross-client refusal names both clients in plain language", () => {
  const db = database();
  const res = response();
  updatePlant(req(db, store(), { params: { id: "pl_a" }, body: { mine_site_id: "ms_b" } }), res);
  assert.match(res.body.message, /Client B/);
  assert.match(res.body.message, /Client A/);
  assert.match(res.body.message, /deactivate this one and create a new record/);
});

// ── A. Same-client moves still work ──

test("same-client moves succeed at plant, section and tag level and write one audit entry each", () => {
  const db = database();
  const st = store();

  let res = response();
  updatePlant(req(db, st, { params: { id: "pl_a" }, body: { mine_site_id: "ms_a2" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.plants.find((p) => p.id === "pl_a").mine_site_id, "ms_a2");

  res = response();
  updatePlantSection(req(db, st, { params: { id: "ps_a" }, body: { plant_id: "pl_a2" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.plant_sections.find((s) => s.id === "ps_a").plant_id, "pl_a2");

  res = response();
  updateEquipmentTag(req(db, st, { params: { id: "eq_a" }, body: { plant_section_id: "ps_a2" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.equipment_tags.find((t) => t.id === "eq_a").plant_section_id, "ps_a2");

  assert.equal(st.audits.length, 3);
});

test("re-sending the unchanged client_id with a rename succeeds (not a move)", () => {
  const db = database();
  const st = store();
  const res = response();
  updateMineSite(req(db, st, { params: { id: "ms_a" }, body: { client_id: "c_a", name: "Site A (renamed)" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.mine_sites.find((s) => s.id === "ms_a").name, "Site A (renamed)");
  assert.equal(st.audits.length, 1);
});

// ── A. Orphan repair (explicit, documented behaviour) ──

test("ORPHAN REPAIR: a mine site whose client is missing may be moved to any existing client", () => {
  const db = database();
  const st = store();
  const res = response();
  updateMineSite(req(db, st, { params: { id: "ms_orphan" }, body: { client_id: "c_b" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.mine_sites.find((s) => s.id === "ms_orphan").client_id, "c_b");
});

test("ORPHAN REPAIR: a plant whose mine site is missing may be re-parented to a valid mine site", () => {
  const db = database();
  const res = response();
  updatePlant(req(db, store(), { params: { id: "pl_orphan" }, body: { mine_site_id: "ms_b" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.plants.find((p) => p.id === "pl_orphan").mine_site_id, "ms_b");
});

test("ORPHAN REPAIR: a section whose plant is missing, or whose chain is broken above the plant, may be re-parented", () => {
  const db = database();
  let res = response();
  updatePlantSection(req(db, store(), { params: { id: "ps_orphan" }, body: { plant_id: "pl_b" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.plant_sections.find((s) => s.id === "ps_orphan").plant_id, "pl_b");

  res = response();
  updatePlantSection(req(db, store(), { params: { id: "ps_broken_chain" }, body: { plant_id: "pl_a" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.plant_sections.find((s) => s.id === "ps_broken_chain").plant_id, "pl_a");
});

test("ORPHAN REPAIR: a tag whose section chain reaches no client may be re-parented", () => {
  const db = database();
  const res = response();
  updateEquipmentTag(req(db, store(), { params: { id: "eq_orphan" }, body: { plant_section_id: "ps_a" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.equipment_tags.find((t) => t.id === "eq_orphan").plant_section_id, "ps_a");
});

test("a healthy record cannot be moved under a parent whose own chain is broken (client cannot be confirmed)", () => {
  const db = database();
  const st = store();
  const before = snapshot(db);
  const res = response();
  updatePlantSection(req(db, st, { params: { id: "ps_a" }, body: { plant_id: "pl_orphan" } }), res);
  assertRefused(res, db, st, before, 400, /client cannot be confirmed/);
});

test("repair is still bound by existing rules: the new parent must exist", () => {
  const db = database();
  const st = store();
  const before = snapshot(db);
  const res = response();
  updatePlant(req(db, st, { params: { id: "pl_orphan" }, body: { mine_site_id: "ms_nope" } }), res);
  assertRefused(res, db, st, before, 400, /No mine site exists/);
});

test("creating records is unaffected by the cross-client rule (no previous parent)", () => {
  const db = database();
  assert.deepEqual(validateParentAssignment(db, { collection: "plants", parentId: "ms_b" }), { ok: true });
  assert.deepEqual(validateParentAssignment(db, { collection: "plants" }), { ok: true });
});

// ── B. Tag-code uniqueness ──

test("normaliseTagCode ignores case and collapses whitespace, never rewriting stored values", () => {
  assert.equal(normaliseTagCode("  PMP   01 "), "pmp 01");
  assert.equal(normaliseTagCode(undefined), "");
  assert.equal(normaliseTagCode(null), "");
});

test("createEquipmentTag refuses a duplicate code in the same mine site (case and whitespace variants)", () => {
  for (const variant of ["pmp 01", "  PMP   01  ", "Pmp\t01"]) {
    const db = database();
    const st = store();
    const before = snapshot(db);
    const res = response();
    createEquipmentTag(req(db, st, { body: { plant_section_id: "ps_a", tag_code: variant, equipment_name: "New pump" } }), res);
    assertRefused(res, db, st, before, 409, /already used/);
  }
});

test("the uniqueness scope is the whole mine site (other plant, same site), not just one plant section", () => {
  const db = database();
  const st = store();
  const before = snapshot(db);
  const res = response();
  createEquipmentTag(req(db, st, { body: { plant_section_id: "ps_ax", tag_code: "pmp 01", equipment_name: "New pump" } }), res);
  assertRefused(res, db, st, before, 409, /already used/);
  assert.match(res.body.message, /mine site/);
});

test("the same code at a different mine site of the SAME client is allowed (scope is not client-wide)", () => {
  const db = database();
  const st = store();
  const res = response();
  createEquipmentTag(req(db, st, { body: { plant_section_id: "ps_a2", tag_code: "pmp 01", equipment_name: "Site A2 pump" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.equipment_tags.filter((t) => t.tag_code === "pmp 01" || t.tag_code === "PMP 01").length, 3);
  assert.equal(st.audits.length, 1);
});

test("the same code under a different client is allowed", () => {
  const db = database();
  const st = store();
  const res = response();
  createEquipmentTag(req(db, st, { body: { plant_section_id: "ps_b", tag_code: "OLD-7", equipment_name: "Client B mill" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.equipment_tags.filter((t) => t.tag_code === "OLD-7").length, 2);
  assert.equal(st.audits.length, 1);
});

test("an INACTIVE tag still reserves its code", () => {
  const db = database();
  const st = store();
  const before = snapshot(db);
  const res = response();
  createEquipmentTag(req(db, st, { body: { plant_section_id: "ps_a2", tag_code: "old-7", equipment_name: "New mill" } }), res);
  assertRefused(res, db, st, before, 409, /\(inactive\)/);
});

test("a tag whose chain reaches no client is not matched (its owner is unknown)", () => {
  const db = database();
  const res = response();
  createEquipmentTag(req(db, store(), { body: { plant_section_id: "ps_a", tag_code: "orph-1", equipment_name: "Fine" } }), res);
  assert.equal(res.statusCode, 200);
});

test("a unique code is created and the stored code is exactly what was sent", () => {
  const db = database();
  const res = response();
  createEquipmentTag(req(db, store(), { body: { plant_section_id: "ps_a", tag_code: "Brand New 9", equipment_name: "New" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.equipment_tags.at(-1).tag_code, "Brand New 9");
});

test("updateEquipmentTag refuses renaming a tag to a code another tag of the mine site already uses", () => {
  const db = database();
  const st = store();
  const before = snapshot(db);
  const res = response();
  updateEquipmentTag(req(db, st, { params: { id: "eq_dup1" }, body: { tag_code: " pmp  01 ", equipment_name: "Renamed in same request" } }), res);
  assertRefused(res, db, st, before, 409, /already used/);
});

test("renaming to a free code succeeds; changing only the case or spacing of its own code succeeds", () => {
  const db = database();
  const st = store();
  let res = response();
  updateEquipmentTag(req(db, st, { params: { id: "eq_a" }, body: { tag_code: "PMP 02" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.equipment_tags.find((t) => t.id === "eq_a").tag_code, "PMP 02");

  res = response();
  updateEquipmentTag(req(db, st, { params: { id: "eq_a" }, body: { tag_code: "  pmp   02 " } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(st.audits.length, 2);
});

// ── B. Legacy duplicates are preserved ──

test("LEGACY: the existing duplicate pair is untouched and detectable", () => {
  const db = database();
  assert.equal(findDuplicateTagCode(db, { tagCode: "FAN-1", plantSectionId: "ps_a", excludeId: "eq_dup1" }).id, "eq_dup2");
  assert.equal(db.equipment_tags.filter((t) => normaliseTagCode(t.tag_code) === "fan-1").length, 2);
});

test("LEGACY: unrelated edits on a legacy duplicate still work", () => {
  const db = database();
  const st = store();
  const res = response();
  updateEquipmentTag(req(db, st, { params: { id: "eq_dup1" }, body: { equipment_name: "Fan one (renamed)", criticality: "high" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.equipment_tags.find((t) => t.id === "eq_dup1").equipment_name, "Fan one (renamed)");
  assert.equal(db.equipment_tags.find((t) => t.id === "eq_dup1").tag_code, "FAN-1", "legacy code is never rewritten");
});

test("LEGACY: re-sending the unchanged (or only re-cased) code on a legacy duplicate is not blocked", () => {
  const db = database();
  for (const code of ["FAN-1", "fan-1", " Fan-1 "]) {
    const res = response();
    updateEquipmentTag(req(db, store(), { params: { id: "eq_dup1" }, body: { tag_code: code, equipment_name: "Fan one" } }), res);
    assert.equal(res.statusCode, 200, `code ${JSON.stringify(code)} should be accepted`);
  }
});

test("LEGACY: a same-mine-site move of a legacy duplicate is not blocked (its site is unchanged)", () => {
  const db = database();
  const res = response();
  updateEquipmentTag(req(db, store(), { params: { id: "eq_dup1" }, body: { plant_section_id: "ps_ax" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.equipment_tags.find((t) => t.id === "eq_dup1").plant_section_id, "ps_ax");
});

test("a same-client move to a DIFFERENT mine site re-checks the code there", () => {
  const db = database();
  let res = response();
  updateEquipmentTag(req(db, store(), { params: { id: "eq_a" }, body: { plant_section_id: "ps_a2" } }), res);
  assert.equal(res.statusCode, 200, "free at Site A2, so the move succeeds");

  const db2 = database();
  db2.equipment_tags.push({ id: "eq_a2_same", plant_section_id: "ps_a2", tag_code: "pmp 01", equipment_name: "Site A2 pump", is_active: true });
  const st = store();
  const before = snapshot(db2);
  res = response();
  updateEquipmentTag(req(db2, st, { params: { id: "eq_a" }, body: { plant_section_id: "ps_a2" } }), res);
  assertRefused(res, db2, st, before, 409, /already used/);
});

test("LEGACY: one half of a duplicate pair can be renamed away, but not onto a third tag's code", () => {
  const db = database();
  let res = response();
  updateEquipmentTag(req(db, store(), { params: { id: "eq_dup2" }, body: { tag_code: "FAN-2" } }), res);
  assert.equal(res.statusCode, 200);

  res = response();
  const st = store();
  const before = snapshot(db);
  updateEquipmentTag(req(db, st, { params: { id: "eq_dup2" }, body: { tag_code: "pmp 01" } }), res);
  assertRefused(res, db, st, before, 409, /already used/);
});

test("repair move that puts a tag under a different mine site re-checks its code there", () => {
  const db = database();
  // eq_orphan has no resolvable mine site; moving it under Site A with a code Site A already uses must be refused.
  db.equipment_tags.find((t) => t.id === "eq_orphan").tag_code = "PMP 01";
  const st = store();
  const before = snapshot(db);
  const res = response();
  updateEquipmentTag(req(db, st, { params: { id: "eq_orphan" }, body: { plant_section_id: "ps_a" } }), res);
  assertRefused(res, db, st, before, 409, /already used/);
});
