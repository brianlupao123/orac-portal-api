import assert from "node:assert/strict";
import test from "node:test";
import { createQuote, updateQuote } from "../src/controllers/quoteController.js";

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function store() {
  let n = 0;
  return { id: (prefix) => `${prefix}-${++n}`, audit() {} };
}

// Two clients, each with a complete hierarchy down to one equipment tag.
function database() {
  return {
    users: [{ id: "sales-1", name: "Sales", role: "Sales", is_active: true }],
    clients: [
      { id: "c_a", name: "Client A", is_active: true },
      { id: "c_b", name: "Client B", is_active: true }
    ],
    mine_sites: [
      { id: "ms_a", client_id: "c_a", name: "Site A", is_active: true },
      { id: "ms_b", client_id: "c_b", name: "Site B", is_active: true }
    ],
    plants: [
      { id: "pl_a", mine_site_id: "ms_a", name: "Plant A", is_active: true },
      { id: "pl_b", mine_site_id: "ms_b", name: "Plant B", is_active: true }
    ],
    plant_sections: [
      { id: "ps_a", plant_id: "pl_a", name: "Section A", is_active: true },
      { id: "ps_b", plant_id: "pl_b", name: "Section B", is_active: true }
    ],
    equipment_tags: [
      { id: "eq_a", plant_section_id: "ps_a", tag_code: "EQ-A", equipment_name: "Pump A", is_active: true },
      { id: "eq_b", plant_section_id: "ps_b", tag_code: "EQ-B", equipment_name: "Pump B", is_active: true },
      { id: "eq_orphan", plant_section_id: "ps_missing", tag_code: "EQ-ORPHAN", equipment_name: "Orphan", is_active: true }
    ],
    quotes: [],
    quote_lines: [],
    audit_logs: []
  };
}

const lines = [{ description: "Service", quantity: 1, unit_price: 100 }];

function create(db, body) {
  const res = response();
  createQuote({ user: { id: "sales-1" }, db, store: store(), body: { client_id: "c_a", lines, ...body } }, res);
  return res;
}

function update(db, quoteId, body) {
  const res = response();
  updateQuote({ user: { id: "sales-1" }, db, store: store(), params: { id: quoteId }, body }, res);
  return res;
}

// ── Creating: only valid, active, client-owned tags ──

test("a new quote may link an active equipment tag that belongs to the same client", () => {
  const db = database();
  const res = create(db, { equipment_tag_id: "eq_a" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.equipment_tag_id, "eq_a");
});

test("a new quote with no equipment tag is unchanged behaviour", () => {
  const db = database();
  const res = create(db, {});
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.equipment_tag_id, null);
});

test("a new quote cannot link an equipment tag that does not exist (no orphan link, nothing inserted)", () => {
  const db = database();
  const res = create(db, { equipment_tag_id: "eq_missing" });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /No equipment tag exists/);
  assert.equal(db.quotes.length, 0);
  assert.equal(db.quote_lines.length, 0);
});

test("a new quote cannot link another client's equipment tag (no cross-client hierarchy on documents)", () => {
  const db = database();
  const res = create(db, { equipment_tag_id: "eq_b" });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /different client/);
  assert.equal(db.quotes.length, 0);
});

test("a new quote cannot link a tag whose own record is inactive", () => {
  const db = database();
  db.equipment_tags.find((t) => t.id === "eq_a").is_active = false;
  const res = create(db, { equipment_tag_id: "eq_a" });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Equipment tag "EQ-A" is inactive/);
});

test("a new quote cannot link a tag when a PARENT (plant) is inactive, and the message names which level", () => {
  const db = database();
  db.plants.find((p) => p.id === "pl_a").is_active = false;
  const res = create(db, { equipment_tag_id: "eq_a" });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /its plant "Plant A" is inactive/);
});

test("a new quote cannot link a tag whose chain is broken, since its client cannot be confirmed", () => {
  const db = database();
  const res = create(db, { equipment_tag_id: "eq_orphan" });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /complete Plant Section > Plant > Mine Site chain/);
});

// ── Updating: historical links preserved, changes validated, nothing half-applied ──

test("re-saving a Draft quote keeps its tag even after that tag is disabled (historical link preserved)", () => {
  const db = database();
  const created = create(db, { equipment_tag_id: "eq_a" });
  db.equipment_tags.find((t) => t.id === "eq_a").is_active = false;
  db.plants.find((p) => p.id === "pl_a").is_active = false;

  // The client re-sends the same tag id alongside an unrelated edit.
  const res = update(db, created.body.data.id, { equipment_tag_id: "eq_a", description: "Renamed" });
  assert.equal(res.statusCode, 200);
  assert.equal(db.quotes[0].equipment_tag_id, "eq_a");
  assert.equal(db.quotes[0].description, "Renamed");
});

test("changing a Draft quote to an inactive tag is rejected", () => {
  const db = database();
  db.equipment_tags.push({ id: "eq_a2", plant_section_id: "ps_a", tag_code: "EQ-A2", equipment_name: "Pump A2", is_active: false });
  const created = create(db, { equipment_tag_id: "eq_a" });
  const res = update(db, created.body.data.id, { equipment_tag_id: "eq_a2" });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /inactive/);
  assert.equal(db.quotes[0].equipment_tag_id, "eq_a", "the original link is untouched");
});

test("a rejected update leaves the quote completely unchanged (validation happens before any mutation)", () => {
  const db = database();
  const created = create(db, { equipment_tag_id: "eq_a" });
  const res = update(db, created.body.data.id, { equipment_tag_id: "eq_b", description: "Should not stick" });
  assert.equal(res.statusCode, 400);
  assert.equal(db.quotes[0].description, undefined, "description must not be applied when the same request is rejected");
  assert.equal(db.quotes[0].equipment_tag_id, "eq_a");
});

test("changing a Draft quote to another client's tag is rejected", () => {
  const db = database();
  const created = create(db, {});
  const res = update(db, created.body.data.id, { equipment_tag_id: "eq_b" });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /different client/);
});

test("a Draft quote's tag can always be cleared", () => {
  const db = database();
  const created = create(db, { equipment_tag_id: "eq_a" });
  db.equipment_tags.find((t) => t.id === "eq_a").is_active = false;
  const res = update(db, created.body.data.id, { equipment_tag_id: null });
  assert.equal(res.statusCode, 200);
  assert.equal(db.quotes[0].equipment_tag_id, null);
});
