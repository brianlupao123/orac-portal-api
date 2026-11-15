// Lane 6 / FB-2 follow-up — per-tag maintenance history: newest-first ordering and tenant/role scope (contract tests).
//
// TEST-ONLY. Adds no route, collection, schema or production code.
//
// Owner facts used:
//   * Ordering is newest-first (descending). Dispatches order by `dispatch_date` (fallback `created_at`);
//     worksheets by `work_date` (fallback `created_at`).
//   * A worksheet counts as completed per src/timesheetEligibility.js (legacy path used in fixtures:
//     timesheet_version 2, status "Supervisor_Approved", no superseded_by).
//   * Read access to equipment tags and their history: Admin, Management, Operations, Supervisor.
//     Client Viewer: only where the tag's root client equals `user.client_id`.
//   * Cross-client unauthorized attempts return HTTP 403.
// NOT stated and therefore NOT asserted: tie-break order for equal dates, placement of records with no date at
// all, the status for an unknown tag id, and any route/permission name for the read.
//
// Subjects (both default to in-file references — [reference] mode proves the contract only):
//   LANE6_TAG_HISTORY_MODULE       -> exports buildEquipmentTagHistory(db, { equipmentTagId }) -> [{ source, record_id }, ...]
//   LANE6_TAG_HISTORY_AUTH_MODULE  -> exports authoriseTagHistoryRead(db, { actor, equipmentTagId }) -> { ok:true } | { ok:false, status, message }

import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const READ_ROLES = ["Admin", "Management", "Operations", "Supervisor"];
const DENIED_ROLES = ["Sales", "Finance", "Technician"];   // not in the stated read list

function tagClientId(db, tag) {
  const section = (db.plant_sections || []).find((s) => s.id === tag.plant_section_id);
  const plant = section && (db.plants || []).find((p) => p.id === section.plant_id);
  const site = plant && (db.mine_sites || []).find((m) => m.id === plant.mine_site_id);
  return site?.client_id ?? null;
}
const worksheetCompleted = (w) => !w.superseded_by && w.timesheet_version === 2 && w.status === "Supervisor_Approved";

function referenceHistory(db, { equipmentTagId }) {
  const tag = (db.equipment_tags || []).find((t) => t.id === equipmentTagId);
  const client = tag && tagClientId(db, tag);
  if (!client) return [];
  const dClient = (d) => (db.quotes || []).find((q) => q.id === d.quotation_id)?.client_id ?? null;
  const dispatches = (db.dispatch_cards || []).filter((d) => Array.isArray(d.equipment_tag_ids) && d.equipment_tag_ids.includes(equipmentTagId) && dClient(d) === client);
  const ids = new Set(dispatches.map((d) => d.id));
  const rows = dispatches.map((d) => ({ source: "dispatch_card", record_id: d.id, date: d.dispatch_date ?? d.created_at ?? "" }));
  for (const w of db.field_worksheets || []) {
    if (ids.has(w.dispatch_card_id) && worksheetCompleted(w)) rows.push({ source: "field_worksheet", record_id: w.id, date: w.work_date ?? w.created_at ?? "" });
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));   // newest first; ties keep insertion order
  return rows.map(({ source, record_id }) => ({ source, record_id }));
}
function referenceAuthorise(db, { actor, equipmentTagId }) {
  const tag = (db.equipment_tags || []).find((t) => t.id === equipmentTagId);
  if (READ_ROLES.includes(actor?.role)) return { ok: true };
  if (actor?.role === "Client Viewer") {
    const client = tag && tagClientId(db, tag);
    if (actor.client_id && client && actor.client_id === client) return { ok: true };
    return { ok: false, status: 403, message: "Forbidden." };
  }
  return { ok: false, status: 403, message: "Forbidden." };
}

let history = referenceHistory; let authorise = referenceAuthorise; let hMode = "reference"; let aMode = "reference";
if (process.env.LANE6_TAG_HISTORY_MODULE) {
  const m = await import(pathToFileURL(resolve(process.env.LANE6_TAG_HISTORY_MODULE)).href);
  assert.equal(typeof m.buildEquipmentTagHistory, "function"); history = m.buildEquipmentTagHistory; hMode = "production";
}
if (process.env.LANE6_TAG_HISTORY_AUTH_MODULE) {
  const m = await import(pathToFileURL(resolve(process.env.LANE6_TAG_HISTORY_AUTH_MODULE)).href);
  assert.equal(typeof m.authoriseTagHistoryRead, "function"); authorise = m.authoriseTagHistoryRead; aMode = "production";
}

function database() {
  const w = (id, d, extra = {}) => ({ id, dispatch_card_id: d, timesheet_version: 2, status: "Supervisor_Approved", superseded_by: null, ...extra });
  return {
    clients: [{ id: "c_a" }, { id: "c_b" }],
    mine_sites: [{ id: "ms_a", client_id: "c_a" }, { id: "ms_b", client_id: "c_b" }],
    plants: [{ id: "pl_a", mine_site_id: "ms_a" }, { id: "pl_b", mine_site_id: "ms_b" }],
    plant_sections: [{ id: "ps_a", plant_id: "pl_a" }, { id: "ps_b", plant_id: "pl_b" }],
    equipment_tags: [
      { id: "eq_a", plant_section_id: "ps_a", tag_code: "PMP-01", is_active: true },
      { id: "eq_b", plant_section_id: "ps_b", tag_code: "PMP-01", is_active: true }
    ],
    quotes: [{ id: "q_a", client_id: "c_a" }, { id: "q_b", client_id: "c_b" }],
    dispatch_cards: [
      { id: "d1", quotation_id: "q_a", equipment_tag_ids: ["eq_a"], dispatch_date: "2026-03-01" },
      { id: "d2", quotation_id: "q_a", equipment_tag_ids: ["eq_a"], dispatch_date: "2026-05-01" },
      { id: "d3", quotation_id: "q_a", equipment_tag_ids: ["eq_a"], created_at: "2026-04-01T08:00:00Z" },                       // fallback to created_at
      { id: "d4", quotation_id: "q_a", equipment_tag_ids: ["eq_a"], dispatch_date: "2026-01-10", created_at: "2026-12-31T00:00:00Z" }, // dispatch_date wins over created_at
      { id: "d_b", quotation_id: "q_b", equipment_tag_ids: ["eq_b"], dispatch_date: "2026-09-01" }
    ],
    field_worksheets: [
      w("w1", "d1", { work_date: "2026-06-01" }),
      w("w2", "d1", { created_at: "2026-02-01T00:00:00Z" }),                    // fallback to created_at
      w("w3", "d2", { work_date: "2026-07-01", created_at: "2026-01-01T00:00:00Z" }), // work_date wins over created_at
      w("w_super", "d1", { work_date: "2026-12-01", superseded_by: "w1" }),     // superseded: excluded
      w("w_draft", "d1", { work_date: "2026-11-01", status: "Draft" }),         // not completed: excluded
      w("w_b", "d_b", { work_date: "2026-10-01" })
    ],
    users: [
      { id: "cv_a", role: "Client Viewer", client_id: "c_a" },
      { id: "cv_b", role: "Client Viewer", client_id: "c_b" },
      { id: "cv_none", role: "Client Viewer" }
    ],
    audit_logs: []
  };
}
const keys = (list) => list.map((e) => `${e.source}:${e.record_id}`);
const clone = (v) => JSON.parse(JSON.stringify(v));
const freeze = (v) => { if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v).forEach(freeze); } return v; };

test(`subject mode: history=${hMode}, authorisation=${aMode}`, () => {
  console.log(`# lane6HistoryOrderingAndScope subject mode: history=${hMode}, authorisation=${aMode}` + (hMode === "reference" || aMode === "reference" ? " (reference parts are NOT production code)" : ""));
});

// ---------- ordering ----------
test("history is newest first across dispatches and completed worksheets", () => {
  // dates: w3 07-01, w1 06-01, d2 05-01, d3 04-01 (created_at), d1 03-01, w2 02-01 (created_at), d4 01-10
  assert.deepEqual(keys(history(database(), { equipmentTagId: "eq_a" })), [
    "field_worksheet:w3", "field_worksheet:w1", "dispatch_card:d2", "dispatch_card:d3",
    "dispatch_card:d1", "field_worksheet:w2", "dispatch_card:d4"
  ]);
});

test("a dispatch orders by dispatch_date even when created_at is later; a worksheet by work_date even when created_at is earlier", () => {
  const got = keys(history(database(), { equipmentTagId: "eq_a" }));
  assert.equal(got[got.length - 1], "dispatch_card:d4", "d4 has created_at 2026-12-31 but dispatch_date 2026-01-10");
  assert.equal(got[0], "field_worksheet:w3", "w3 has work_date 2026-07-01 but created_at 2026-01-01");
});

test("created_at is the fallback date when dispatch_date / work_date is absent", () => {
  const got = keys(history(database(), { equipmentTagId: "eq_a" }));
  assert.ok(got.indexOf("dispatch_card:d2") < got.indexOf("dispatch_card:d3"));
  assert.ok(got.indexOf("dispatch_card:d3") < got.indexOf("dispatch_card:d1"));
  assert.ok(got.indexOf("dispatch_card:d1") < got.indexOf("field_worksheet:w2"));
});

test("superseded and not-completed worksheets are absent however recent they are", () => {
  const got = keys(history(database(), { equipmentTagId: "eq_a" }));
  assert.ok(!got.includes("field_worksheet:w_super"));
  assert.ok(!got.includes("field_worksheet:w_draft"));
});

test("ordering is deterministic and does not mutate the data", () => {
  const db = freeze(database());
  const first = history(db, { equipmentTagId: "eq_a" });
  assert.deepEqual(history(db, { equipmentTagId: "eq_a" }), first);
  assert.equal(db.audit_logs.length, 0);
});

// ---------- tenant and role scope ----------
test("the four read roles are authorised for a tag of any client", () => {
  const db = database();
  for (const role of READ_ROLES) assert.deepEqual(authorise(db, { actor: { id: "u", role }, equipmentTagId: "eq_a" }), { ok: true }, role);
});

test("Sales, Finance and Technician are not in the read list and are refused with 403", () => {
  const db = database();
  for (const role of DENIED_ROLES) {
    const r = authorise(db, { actor: { id: "u", role }, equipmentTagId: "eq_a" });
    assert.equal(r.ok, false, role); assert.equal(r.status, 403, role);
  }
});

test("Client Viewer may read the history of a tag whose client is their own client_id", () => {
  const db = database();
  assert.deepEqual(authorise(db, { actor: db.users[0], equipmentTagId: "eq_a" }), { ok: true });
});

test("Client Viewer is refused (403) for a tag of another client — even if the tag code is identical", () => {
  const db = database();
  assert.equal(db.equipment_tags[0].tag_code, db.equipment_tags[1].tag_code);
  const r = authorise(db, { actor: db.users[0], equipmentTagId: "eq_b" });
  assert.equal(r.ok, false); assert.equal(r.status, 403);
  const r2 = authorise(db, { actor: db.users[1], equipmentTagId: "eq_a" });
  assert.equal(r2.ok, false); assert.equal(r2.status, 403);
});

test("Client Viewer with no client_id fails closed (403)", () => {
  const db = database();
  const r = authorise(db, { actor: db.users[2], equipmentTagId: "eq_a" });
  assert.equal(r.ok, false); assert.equal(r.status, 403);
});

test("an authorised Client Viewer sees only their own client's records; another client's records never appear", () => {
  const db = database();
  const own = keys(history(db, { equipmentTagId: "eq_a" }));
  for (const k of own) assert.ok(!["dispatch_card:d_b", "field_worksheet:w_b"].includes(k));
  const other = keys(history(db, { equipmentTagId: "eq_b" }));
  assert.deepEqual(other.sort(), ["dispatch_card:d_b", "field_worksheet:w_b"]);
});

test("authorisation and history reads write nothing (deep-frozen database)", () => {
  const db = freeze(database());
  authorise(db, { actor: db.users[0], equipmentTagId: "eq_a" });
  history(db, { equipmentTagId: "eq_a" });
  assert.equal(db.audit_logs.length, 0);
});

test("PENDING: tie-break order for records with equal dates", { skip: "not stated by the owner; only determinism is asserted" }, () => {});
test("PENDING: placement of a record that has neither a primary date nor created_at", { skip: "not stated by the owner" }, () => {});
test("PENDING: status/message for an unknown tag id on the history read", { skip: "not stated (403 vs 404); not guessed" }, () => {});
test("PENDING: route and permission name for the history read", { skip: "no such route or permission exists in the package; none is invented" }, () => {});
