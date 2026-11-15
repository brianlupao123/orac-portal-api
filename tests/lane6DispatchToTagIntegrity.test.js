// Lane 6 / FB-2 — dispatch-to-equipment-tag linking integrity (contract tests).
//
// TEST-ONLY. Adds no route, collection, schema or production code.
//
// IMPORTANT — what these tests exercise:
//   The rebaseline package (ORAC_LANE6_REBASELINE_CURRENT.zip, backend 514d1c9) contains NO code
//   that validates or writes `equipment_tag_ids` on a dispatch card. These tests therefore pin the
//   CONTRACT that such a check must meet. They run against a SUBJECT:
//     * default  : the in-file reference validator below ([reference] mode). It proves the contract
//                  is coherent and runnable; it does NOT prove anything about production code.
//     * production: set LANE6_DISPATCH_TAG_VALIDATOR to a module path whose export
//                  `validateDispatchEquipmentTags(db, { dispatch, equipmentTagIds })`
//                  returns { ok: true } or { ok: false, status, message }. (The name and shape are a
//                  test seam proposed here, not an existing production API.)
//   The test titled "subject mode" prints which one ran.
//
// Fixture fields used (all visible in the packet source): quotes.client_id, dispatch_cards.quotation_id,
// dispatch_cards.site_id, equipment_tags.plant_section_id, plant_sections.plant_id, plants.mine_site_id,
// mine_sites.client_id, and the field name `equipment_tag_ids` supplied by the owner's verification.
// Not assumed: any invoice shape, any `equipment_tag` (single) semantics.

import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// ---------- subject seam ----------
function referenceValidate(db, { dispatch, equipmentTagIds }) {
  if (!Array.isArray(equipmentTagIds)) return { ok: false, status: 400, message: "equipment_tag_ids must be an array." };
  const quote = (db.quotes || []).find((q) => q.id === dispatch.quotation_id);
  const dispatchClientId = quote?.client_id ?? null;
  if (!dispatchClientId) return { ok: false, status: 400, message: "The dispatch's client cannot be confirmed." };
  for (const id of new Set(equipmentTagIds)) {
    const tag = (db.equipment_tags || []).find((t) => t.id === id);
    if (!tag) return { ok: false, status: 400, message: `No equipment tag exists with id ${id}.` };
    if (chainClientId(db, tag) !== dispatchClientId) return { ok: false, status: 400, message: "An equipment tag belongs to a different client than this dispatch." };
  }
  return { ok: true };
}

function chainOf(db, tag) {
  const section = (db.plant_sections || []).find((s) => s.id === tag.plant_section_id);
  const plant = section && (db.plants || []).find((p) => p.id === section.plant_id);
  const site = plant && (db.mine_sites || []).find((m) => m.id === plant.mine_site_id);
  const client = site && (db.clients || []).find((c) => c.id === site.client_id);
  return { section, plant, site, client };
}
const chainClientId = (db, tag) => chainOf(db, tag).client?.id ?? null;
const chainSiteId = (db, tag) => chainOf(db, tag).site?.id ?? null;

let validate = referenceValidate;
let mode = "reference";
if (process.env.LANE6_DISPATCH_TAG_VALIDATOR) {
  const mod = await import(pathToFileURL(resolve(process.env.LANE6_DISPATCH_TAG_VALIDATOR)).href);
  assert.equal(typeof mod.validateDispatchEquipmentTags, "function", "LANE6_DISPATCH_TAG_VALIDATOR must export validateDispatchEquipmentTags");
  validate = mod.validateDispatchEquipmentTags;
  mode = "production";
}

// ---------- fixtures ----------
function database() {
  return {
    clients: [
      { id: "c_a", name: "Client A", is_active: true },
      { id: "c_b", name: "Client B", is_active: true }
    ],
    mine_sites: [
      { id: "ms_a1", client_id: "c_a", name: "A Site 1", is_active: true },
      { id: "ms_a2", client_id: "c_a", name: "A Site 2", is_active: true },
      { id: "ms_b1", client_id: "c_b", name: "B Site 1", is_active: true }
    ],
    plants: [
      { id: "pl_a1", mine_site_id: "ms_a1", name: "Plant A1", is_active: true },
      { id: "pl_a2", mine_site_id: "ms_a2", name: "Plant A2", is_active: true },
      { id: "pl_b1", mine_site_id: "ms_b1", name: "Plant B1", is_active: true }
    ],
    plant_sections: [
      { id: "ps_a1", plant_id: "pl_a1", name: "Sec A1", is_active: true },
      { id: "ps_a2", plant_id: "pl_a2", name: "Sec A2", is_active: true },
      { id: "ps_b1", plant_id: "pl_b1", name: "Sec B1", is_active: true }
    ],
    equipment_tags: [
      { id: "eq_a1", plant_section_id: "ps_a1", tag_code: "PMP-01", equipment_name: "Pump A1", is_active: true },
      { id: "eq_a1b", plant_section_id: "ps_a1", tag_code: "PMP-02", equipment_name: "Pump A1b", is_active: true },
      { id: "eq_a2", plant_section_id: "ps_a2", tag_code: "PMP-01", equipment_name: "Pump A2", is_active: true },
      { id: "eq_b1", plant_section_id: "ps_b1", tag_code: "PMP-01", equipment_name: "Pump B1", is_active: true },
      { id: "eq_orphan", plant_section_id: "ps_missing", tag_code: "ORPH-1", equipment_name: "Orphan", is_active: true }
    ],
    quotes: [{ id: "q_a", client_id: "c_a", status: "Field_Dispatch" }],
    dispatch_cards: [{ id: "d_a", quotation_id: "q_a", site_id: "ms_a1", status: "Active" }],
    audit_logs: []
  };
}
const clone = (v) => JSON.parse(JSON.stringify(v));
const dispatchOf = (db) => db.dispatch_cards[0];

function assertRefused(result, db, before, status = 400) {
  assert.equal(result.ok, false);
  assert.equal(result.status, status);
  assert.equal(typeof result.message, "string");
  assert.ok(result.message.length > 0);
  assert.deepEqual(db, before, "a refused link must change nothing, including audit_logs");
}

// ---------- tests ----------
test(`subject mode: ${mode}`, () => {
  assert.ok(mode === "reference" || mode === "production");
  console.log(`# lane6DispatchToTagIntegrity subject mode = ${mode}` + (mode === "reference" ? " (contract run against the in-file reference, NOT production code)" : ""));
});

test("fixture chain derivation agrees with the production hierarchy helper (when importable)", async () => {
  let helper;
  try { helper = (await import("../src/services/entityHierarchy.js")).mineSiteIdForPlantSection; } catch { /* not importable here */ }
  if (typeof helper !== "function") return;           // production helper absent: nothing to cross-check
  const db = database();
  for (const tag of db.equipment_tags) {
    assert.equal(helper(db, tag.plant_section_id), chainSiteId(db, tag), `mine site for ${tag.id}`);
  }
});

test("same-client tags (one or several, even across mine sites) are accepted", () => {
  const db = database();
  const before = clone(db);
  assert.deepEqual(validate(db, { dispatch: dispatchOf(db), equipmentTagIds: ["eq_a1"] }), { ok: true });
  assert.deepEqual(validate(db, { dispatch: dispatchOf(db), equipmentTagIds: ["eq_a1", "eq_a1b", "eq_a2"] }), { ok: true });
  assert.deepEqual(db, before, "validation is read-only");
});

test("an empty list and a dispatch without tags are valid (legacy dispatches keep working)", () => {
  const db = database();
  assert.deepEqual(validate(db, { dispatch: dispatchOf(db), equipmentTagIds: [] }), { ok: true });
});

test("a tag of a different client is refused; nothing is written", () => {
  const db = database();
  const before = clone(db);
  assertRefused(validate(db, { dispatch: dispatchOf(db), equipmentTagIds: ["eq_b1"] }), db, before);
});

test("one foreign tag among valid tags refuses the whole request", () => {
  const db = database();
  const before = clone(db);
  assertRefused(validate(db, { dispatch: dispatchOf(db), equipmentTagIds: ["eq_a1", "eq_b1"] }), db, before);
});

test("an unknown tag id is refused", () => {
  const db = database();
  const before = clone(db);
  assertRefused(validate(db, { dispatch: dispatchOf(db), equipmentTagIds: ["eq_does_not_exist"] }), db, before);
});

test("a tag whose own hierarchy chain reaches no client cannot be confirmed and is refused", () => {
  const db = database();
  const before = clone(db);
  assertRefused(validate(db, { dispatch: dispatchOf(db), equipmentTagIds: ["eq_orphan"] }), db, before);
});

test("a dispatch whose client cannot be confirmed refuses every link", () => {
  const db = database();
  db.dispatch_cards[0].quotation_id = "q_missing";
  const before = clone(db);
  assertRefused(validate(db, { dispatch: dispatchOf(db), equipmentTagIds: ["eq_a1"] }), db, before);
});

test("non-array input is refused, not coerced", () => {
  const db = database();
  const before = clone(db);
  for (const bad of ["eq_a1", { 0: "eq_a1" }, null, 7]) {
    assertRefused(validate(db, { dispatch: dispatchOf(db), equipmentTagIds: bad }), db, before);
  }
});

test("duplicate ids in one request do not change the verdict", () => {
  const db = database();
  assert.deepEqual(validate(db, { dispatch: dispatchOf(db), equipmentTagIds: ["eq_a1", "eq_a1"] }), { ok: true });
  assert.equal(validate(db, { dispatch: dispatchOf(db), equipmentTagIds: ["eq_a1", "eq_b1", "eq_b1"] }).ok, false);
});

test("same tag code at another client is a different tag: matching by code never grants a link", () => {
  const db = database();
  const before = clone(db);
  // eq_b1 has the same code (PMP-01) as eq_a1 but belongs to Client B.
  assert.equal(db.equipment_tags.find((t) => t.id === "eq_b1").tag_code, db.equipment_tags.find((t) => t.id === "eq_a1").tag_code);
  assertRefused(validate(db, { dispatch: dispatchOf(db), equipmentTagIds: ["eq_b1"] }), db, before);
});

test("renaming a tag's code does not affect link validity (identity is the id)", () => {
  const db = database();
  db.equipment_tags.find((t) => t.id === "eq_a1").tag_code = "RENAMED-99";
  assert.deepEqual(validate(db, { dispatch: dispatchOf(db), equipmentTagIds: ["eq_a1"] }), { ok: true });
});

test("a tag moved to another mine site of the same client stays linkable (client-level rule)", () => {
  const db = database();
  db.equipment_tags.find((t) => t.id === "eq_a1").plant_section_id = "ps_a2";
  assert.deepEqual(validate(db, { dispatch: dispatchOf(db), equipmentTagIds: ["eq_a1"] }), { ok: true });
});

// OWNER DECISION D2.5 (open): the owner approved the client-level rule. A stricter "same mine site as the
// dispatch's site_id" rule is NOT asserted by default. Enable with LANE6_TAG_SITE_STRICT=1 to pin it.
test("OPTIONAL stricter policy: a tag at another mine site of the same client is refused", { skip: process.env.LANE6_TAG_SITE_STRICT !== "1" && "owner decision pending (client-level rule approved; mine-site-strict not decided)" }, () => {
  const db = database();
  const before = clone(db);
  assert.equal(chainSiteId(db, db.equipment_tags.find((t) => t.id === "eq_a2")), "ms_a2");
  assertRefused(validate(db, { dispatch: dispatchOf(db), equipmentTagIds: ["eq_a2"] }), db, before);
});

// Pending items that need production facts not present in the rebaseline package. Skipped on purpose,
// listed so they are not forgotten (see DEPENDENCIES.md).
test("PENDING: link changes are refused once a dispatch has an active invoice", { skip: "needs the invoice fixture shape and signature of dispatchHasActiveInvoice (src/dispatchFreeze.js not in the package; call sites pass the dispatch object, not an id)" }, () => {});
test("PENDING: the single-valued `equipment_tag` field — is its value an id or a code?", { skip: "semantics not stated in the package; not guessed" }, () => {});
test("PENDING: inactive tag may/may not be linked to new work", { skip: "owner decision D2.2 open" }, () => {});
test("PENDING: idempotent retry with different links", { skip: "needs dispatch creation code and idempotency fingerprint inputs (not in the package)" }, () => {});
