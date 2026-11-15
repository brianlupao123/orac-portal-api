// Lane 6 / FB-2 follow-up — a single-valued `equipment_tag` on a dispatch stores an immutable ID (characterization/contract).
//
// TEST-ONLY. Adds no route, collection, schema or production code.
//
// Owner fact: the single-valued `equipment_tag` always stores an id (for example `tag_123`), never the human
// code (for example `TAG-PUMP-01`); codes are mutable display labels and foreign keys are immutable ids.
// No production code that writes or validates `equipment_tag` exists in the package, so this is a CONTRACT run
// against a subject:
//   default   : the in-file reference ([reference] mode) — proves the contract only.
//   production: LANE6_DISPATCH_TAG_VALIDATOR=<module exporting validateDispatchEquipmentTags(db,{dispatch,equipmentTagIds})>
//               (same seam as lane6DispatchToTagIntegrity.test.js). The single value is passed as a one-item list.

import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

function chainClientId(db, tag) {
  const section = (db.plant_sections || []).find((s) => s.id === tag.plant_section_id);
  const plant = section && (db.plants || []).find((p) => p.id === section.plant_id);
  const site = plant && (db.mine_sites || []).find((m) => m.id === plant.mine_site_id);
  return site?.client_id ?? null;
}
function referenceValidate(db, { dispatch, equipmentTagIds }) {
  if (!Array.isArray(equipmentTagIds)) return { ok: false, status: 400, message: "equipment_tag_ids must be an array." };
  const clientId = (db.quotes || []).find((q) => q.id === dispatch.quotation_id)?.client_id ?? null;
  if (!clientId) return { ok: false, status: 400, message: "The dispatch's client cannot be confirmed." };
  for (const id of new Set(equipmentTagIds)) {
    const tag = (db.equipment_tags || []).find((t) => t.id === id);       // lookup by ID only
    if (!tag) return { ok: false, status: 400, message: `No equipment tag exists with id ${id}.` };
    if (tag.is_active === false) return { ok: false, status: 400, message: "An inactive equipment tag cannot be linked to new work." };
    if (chainClientId(db, tag) !== clientId) return { ok: false, status: 400, message: "An equipment tag belongs to a different client than this dispatch." };
  }
  return { ok: true };
}
let validate = referenceValidate; let mode = "reference";
if (process.env.LANE6_DISPATCH_TAG_VALIDATOR) {
  const mod = await import(pathToFileURL(resolve(process.env.LANE6_DISPATCH_TAG_VALIDATOR)).href);
  assert.equal(typeof mod.validateDispatchEquipmentTags, "function");
  validate = mod.validateDispatchEquipmentTags; mode = "production";
}
const single = (db, dispatch) => validate(db, { dispatch, equipmentTagIds: dispatch.equipment_tag == null ? [] : [dispatch.equipment_tag] });

function database() {
  return {
    clients: [{ id: "c_a" }, { id: "c_b" }],
    mine_sites: [{ id: "ms_a", client_id: "c_a" }, { id: "ms_b", client_id: "c_b" }],
    plants: [{ id: "pl_a", mine_site_id: "ms_a" }, { id: "pl_b", mine_site_id: "ms_b" }],
    plant_sections: [{ id: "ps_a", plant_id: "pl_a" }, { id: "ps_b", plant_id: "pl_b" }],
    equipment_tags: [
      { id: "tag_123", plant_section_id: "ps_a", tag_code: "TAG-PUMP-01", equipment_name: "Pump", is_active: true },
      { id: "tag_999", plant_section_id: "ps_b", tag_code: "TAG-PUMP-01", equipment_name: "Pump B", is_active: true }
    ],
    quotes: [{ id: "q_a", client_id: "c_a" }],
    dispatch_cards: [{ id: "d_a", quotation_id: "q_a", site_id: "ms_a", equipment_tag: "tag_123" }],
    audit_logs: []
  };
}
const clone = (v) => JSON.parse(JSON.stringify(v));

test(`subject mode: ${mode}`, () => {
  console.log(`# lane6DispatchTagIdentity subject mode = ${mode}` + (mode === "reference" ? " (contract run against the in-file reference, NOT production code)" : ""));
  assert.ok(mode === "reference" || mode === "production");
});

test("a single equipment_tag holding the tag's id is accepted", () => {
  const db = database();
  assert.deepEqual(single(db, db.dispatch_cards[0]), { ok: true });
});

test("a human tag code in equipment_tag is NOT accepted as a reference (codes are mutable labels)", () => {
  const db = database();
  db.dispatch_cards[0].equipment_tag = "TAG-PUMP-01";
  const before = clone(db);
  const r = single(db, db.dispatch_cards[0]);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.deepEqual(db, before, "refusal changes nothing");
});

test("a code that exists at another client never resolves to that client's tag", () => {
  const db = database();
  db.dispatch_cards[0].equipment_tag = "TAG-PUMP-01";      // same code exists on tag_123 (A) and tag_999 (B)
  assert.equal(single(db, db.dispatch_cards[0]).ok, false);
});

test("an id belonging to another client is refused", () => {
  const db = database();
  db.dispatch_cards[0].equipment_tag = "tag_999";
  const before = clone(db);
  assert.equal(single(db, db.dispatch_cards[0]).ok, false);
  assert.deepEqual(db, before);
});

test("renaming the tag's code leaves the stored reference valid (the id is the foreign key)", () => {
  const db = database();
  db.equipment_tags[0].tag_code = "RENAMED-01";
  assert.equal(db.dispatch_cards[0].equipment_tag, "tag_123");
  assert.deepEqual(single(db, db.dispatch_cards[0]), { ok: true });
});

test("a dispatch with no equipment_tag is valid (legacy)", () => {
  const db = database();
  delete db.dispatch_cards[0].equipment_tag;
  assert.deepEqual(single(db, db.dispatch_cards[0]), { ok: true });
});

test("an unknown id is refused", () => {
  const db = database();
  db.dispatch_cards[0].equipment_tag = "tag_nope";
  assert.equal(single(db, db.dispatch_cards[0]).ok, false);
});

test("an inactive tag cannot be set as the single equipment_tag on new work", () => {
  const db = database();
  db.equipment_tags[0].is_active = false;
  assert.equal(single(db, db.dispatch_cards[0]).ok, false);
});

test("PENDING: which code path writes equipment_tag, and whether it also fills equipment_tag_ids", { skip: "no writer exists in the package" }, () => {});
