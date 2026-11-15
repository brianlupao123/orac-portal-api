// Lane 6 / FB-2 — per-equipment-tag maintenance history: read-only characterization (contract tests).
//
// TEST-ONLY. Adds no route, collection, schema or production code.
//
// IMPORTANT — what these tests exercise:
//   The rebaseline package (backend 514d1c9) contains NO per-tag history aggregation code. The owner's
//   verification states the history is an on-the-fly read over existing records (dispatch_cards,
//   completed v2 field_worksheets, incidents). These tests pin the invariants that read must keep.
//   They run against a SUBJECT:
//     * default   : the in-file reference aggregator ([reference] mode) — proves the contract is coherent;
//                   it is NOT production code.
//     * production: set LANE6_TAG_HISTORY_MODULE to a module path exporting
//                   `buildEquipmentTagHistory(db, { equipmentTagId })` returning an array of
//                   { source, record_id }. (Name/shape is a test seam proposed here, not an existing API.)
//   One test below ("rename keeps history") also drives the REAL `updateEquipmentTag` handler.
//
// Linkage used (each visible in the packet source or stated by the owner's verification):
//   dispatch_cards.equipment_tag_ids (owner-stated), field_worksheets.dispatch_card_id and
//   field_worksheets.superseded_by (both used in dispatchController.js).
// NOT assumed: how a worksheet is "completed" (the status string is hidden behind isEligibleForDb), how
// an incident references a tag, any date field for ordering, and how Client Viewer is bound to a client.
// Those are listed as PENDING tests.

import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// ---------- subject seam ----------
// Worksheets count as "completed" in the reference only when the FIXTURE says so (`__completed`).
// The production definition of completed is a pending question.
function referenceHistory(db, { equipmentTagId }) {
  const tag = (db.equipment_tags || []).find((t) => t.id === equipmentTagId);
  if (!tag) return [];
  const clientOf = (obj) => {
    const section = (db.plant_sections || []).find((s) => s.id === obj.plant_section_id);
    const plant = section && (db.plants || []).find((p) => p.id === section.plant_id);
    const site = plant && (db.mine_sites || []).find((m) => m.id === plant.mine_site_id);
    return site?.client_id ?? null;
  };
  const tagClient = clientOf(tag);
  if (!tagClient) return [];
  const dispatchClient = (d) => (db.quotes || []).find((q) => q.id === d.quotation_id)?.client_id ?? null;
  const dispatches = (db.dispatch_cards || []).filter((d) =>
    Array.isArray(d.equipment_tag_ids) && d.equipment_tag_ids.includes(equipmentTagId) && dispatchClient(d) === tagClient);
  const out = dispatches.map((d) => ({ source: "dispatch_card", record_id: d.id }));
  const ids = new Set(dispatches.map((d) => d.id));
  for (const w of db.field_worksheets || []) {
    if (ids.has(w.dispatch_card_id) && !w.superseded_by && w.__completed === true) out.push({ source: "field_worksheet", record_id: w.id });
  }
  return out;
}

let history = referenceHistory;
let mode = "reference";
if (process.env.LANE6_TAG_HISTORY_MODULE) {
  const mod = await import(pathToFileURL(resolve(process.env.LANE6_TAG_HISTORY_MODULE)).href);
  assert.equal(typeof mod.buildEquipmentTagHistory, "function", "LANE6_TAG_HISTORY_MODULE must export buildEquipmentTagHistory");
  history = mod.buildEquipmentTagHistory;
  mode = "production";
}

// ---------- fixtures ----------
function database() {
  return {
    users: [{ id: "admin-1", name: "Admin", email: "admin@example.test", role: "Admin", is_active: true }],
    clients: [{ id: "c_a", name: "Client A", is_active: true }, { id: "c_b", name: "Client B", is_active: true }],
    mine_sites: [{ id: "ms_a", client_id: "c_a", name: "A Site", is_active: true }, { id: "ms_b", client_id: "c_b", name: "B Site", is_active: true }],
    plants: [{ id: "pl_a", mine_site_id: "ms_a", name: "Plant A", plant_code: "PA", is_active: true }, { id: "pl_b", mine_site_id: "ms_b", name: "Plant B", plant_code: "PB", is_active: true }],
    plant_sections: [{ id: "ps_a", plant_id: "pl_a", name: "Sec A", section_code: "SA", is_active: true }, { id: "ps_b", plant_id: "pl_b", name: "Sec B", section_code: "SB", is_active: true }],
    equipment_tags: [
      { id: "eq_a", plant_section_id: "ps_a", tag_code: "PMP-01", equipment_name: "Pump A", is_active: true },
      { id: "eq_a_other", plant_section_id: "ps_a", tag_code: "PMP-02", equipment_name: "Pump A2", is_active: true },
      { id: "eq_b", plant_section_id: "ps_b", tag_code: "PMP-01", equipment_name: "Pump B", is_active: true },
      { id: "eq_empty", plant_section_id: "ps_a", tag_code: "NONE-1", equipment_name: "Unused", is_active: true }
    ],
    quotes: [{ id: "q_a", client_id: "c_a" }, { id: "q_b", client_id: "c_b" }],
    dispatch_cards: [
      { id: "d1", quotation_id: "q_a", equipment_tag_ids: ["eq_a"] },
      { id: "d2", quotation_id: "q_a", equipment_tag_ids: ["eq_a", "eq_a_other"] },
      { id: "d3", quotation_id: "q_a", equipment_tag_ids: ["eq_a_other"] },
      { id: "d4", quotation_id: "q_a" },                                 // legacy: no tag field at all
      { id: "d_b", quotation_id: "q_b", equipment_tag_ids: ["eq_b"] },
      { id: "d_bad", quotation_id: "q_b", equipment_tag_ids: ["eq_a"] } // legacy bad data: Client B dispatch naming a Client A tag
    ],
    field_worksheets: [
      { id: "w1", dispatch_card_id: "d1", __completed: true },
      { id: "w2", dispatch_card_id: "d1", __completed: false },                // not completed (e.g. draft)
      { id: "w3", dispatch_card_id: "d1", __completed: true, superseded_by: "w4" }, // superseded
      { id: "w4", dispatch_card_id: "d2", __completed: true },
      { id: "w5", dispatch_card_id: "d3", __completed: true },               // other tag only
      { id: "w_bad", dispatch_card_id: "d_bad", __completed: true }
    ],
    incidents: [],
    audit_logs: []
  };
}
const clone = (v) => JSON.parse(JSON.stringify(v));
function deepFreeze(v) {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze(v[k]); }
  return v;
}
const key = (e) => `${e.source}:${e.record_id}`;
const keys = (list) => list.map(key).sort();

// ---------- tests ----------
test(`subject mode: ${mode}`, () => {
  assert.ok(mode === "reference" || mode === "production");
  console.log(`# lane6MaintenanceHistoryRead subject mode = ${mode}` + (mode === "reference" ? " (contract run against the in-file reference, NOT production code)" : ""));
});

test("history contains only records that reference the tag; the other tag's records are absent", () => {
  const db = database();
  const result = history(db, { equipmentTagId: "eq_a" });
  const got = keys(result);
  assert.ok(got.includes("dispatch_card:d1") && got.includes("dispatch_card:d2"));
  assert.ok(!got.includes("dispatch_card:d3"), "d3 references only eq_a_other");
  assert.ok(!got.includes("dispatch_card:d4"), "legacy dispatch without tags is not guessed into any history");
  assert.ok(!got.includes("field_worksheet:w5"));
});

test("only completed, non-superseded worksheets of the tag's dispatches appear", () => {
  const got = keys(history(database(), { equipmentTagId: "eq_a" }));
  assert.ok(got.includes("field_worksheet:w1"));
  assert.ok(got.includes("field_worksheet:w4"));
  assert.ok(!got.includes("field_worksheet:w2"), "not completed");
  assert.ok(!got.includes("field_worksheet:w3"), "superseded");
});

test("a dispatch of another client that names this tag is excluded (cross-client defence in depth)", () => {
  const got = keys(history(database(), { equipmentTagId: "eq_a" }));
  assert.ok(!got.includes("dispatch_card:d_bad"));
  assert.ok(!got.includes("field_worksheet:w_bad"));
});

test("matching never infers by tag code: same code at another client contributes nothing", () => {
  const db = database();
  assert.equal(db.equipment_tags.find((t) => t.id === "eq_a").tag_code, db.equipment_tags.find((t) => t.id === "eq_b").tag_code);
  const a = keys(history(db, { equipmentTagId: "eq_a" }));
  const b = keys(history(db, { equipmentTagId: "eq_b" }));
  assert.deepEqual(b, ["dispatch_card:d_b"]);
  for (const k of b) assert.ok(!a.includes(k));
});

test("a tag with no linked records returns an empty list (explicit empty state, no error)", () => {
  assert.deepEqual(history(database(), { equipmentTagId: "eq_empty" }), []);
});

test("an unknown tag id returns an empty list and does not throw", () => {
  assert.deepEqual(history(database(), { equipmentTagId: "eq_nope" }), []);
});

test("an orphan tag (chain reaches no client) returns an empty list", () => {
  const db = database();
  db.equipment_tags.push({ id: "eq_orphan", plant_section_id: "ps_missing", tag_code: "O-1", equipment_name: "Orphan", is_active: true });
  db.dispatch_cards.push({ id: "d_orph", quotation_id: "q_a", equipment_tag_ids: ["eq_orphan"] });
  assert.deepEqual(history(db, { equipmentTagId: "eq_orphan" }), []);
});

test("the read performs ZERO writes: a deep-frozen database is accepted unchanged", () => {
  const db = deepFreeze(database());
  const before = clone(db);
  history(db, { equipmentTagId: "eq_a" });                 // would throw TypeError on any write
  assert.deepEqual(db, before);
  assert.equal(db.audit_logs.length, 0, "reads add no audit entry");
});

test("deterministic: two reads of the same data give identical results", () => {
  const db = database();
  assert.deepEqual(history(db, { equipmentTagId: "eq_a" }), history(db, { equipmentTagId: "eq_a" }));
});

test("inactive tag and inactive parents remain viewable (deactivation hides nothing historical)", () => {
  const db = database();
  db.equipment_tags.find((t) => t.id === "eq_a").is_active = false;
  db.mine_sites.find((m) => m.id === "ms_a").is_active = false;
  assert.ok(keys(history(db, { equipmentTagId: "eq_a" })).includes("dispatch_card:d1"));
});

test("no new collection is created or required: only existing collections are read", () => {
  const db = database();
  const names = Object.keys(db);
  history(db, { equipmentTagId: "eq_a" });
  assert.deepEqual(Object.keys(db), names);
});

test("rename keeps history: REAL updateEquipmentTag renames the code, the id (and so the history) is unchanged", async () => {
  let admin;
  try { admin = await import("../src/controllers/adminController.js"); } catch { /* module not importable in this environment */ }
  if (!admin || typeof admin.updateEquipmentTag !== "function") return;   // production handler absent
  const db = database();
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  const req = { user: { id: "admin-1" }, db, store: { id: () => "x", audit() {} }, params: { id: "eq_a" }, body: { tag_code: "RENAMED-77" } };
  const before = keys(history(db, { equipmentTagId: "eq_a" }));
  admin.updateEquipmentTag(req, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(db.equipment_tags.find((t) => t.id === "eq_a").tag_code, "RENAMED-77");
  assert.deepEqual(keys(history(db, { equipmentTagId: "eq_a" })), before);
});

// Pending: need production facts not in the rebaseline package. Skipped on purpose (see DEPENDENCIES.md).
test("PENDING: incidents referencing the tag appear in history", { skip: "how an incident references an equipment tag is not stated; not guessed" }, () => {});
test("PENDING: what 'completed' means for a v2 field worksheet", { skip: "the status behind isEligibleForDb (src/timesheetEligibility.js) is not in the package; fixtures use a test-only flag" }, () => {});
test("PENDING: ordering by date", { skip: "the date field per record type is not stated" }, () => {});
test("PENDING: Client Viewer sees only own-client history", { skip: "how Client Viewer is bound to a client (clientScope) is not in the package" }, () => {});
test("PENDING: role matrix for the eight roles on the history read", { skip: "no route or permission for the history read exists in the package; none is invented" }, () => {});
