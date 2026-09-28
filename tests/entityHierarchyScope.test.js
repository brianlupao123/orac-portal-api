import assert from "node:assert/strict";
import test from "node:test";
import { getCollection } from "../src/controllers/coreController.js";

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function database() {
  return {
    users: [
      { id: "viewer-zimplats", role: "Client Viewer", is_active: true, client_id: "c_zimplats" },
      { id: "viewer-other", role: "Client Viewer", is_active: true, client_id: "c_other" },
      { id: "ops-1", role: "Operations", is_active: true },
      { id: "sales-1", role: "Sales", is_active: true }
    ],
    clients: [
      { id: "c_zimplats", name: "Zimplats", client_type: "permanent", is_active: true },
      { id: "c_other", name: "Other Co", client_type: "permanent", is_active: true }
    ],
    mine_sites: [
      { id: "ms_ngezi", client_id: "c_zimplats", name: "Ngezi", is_active: true },
      { id: "ms_other", client_id: "c_other", name: "Other Site", is_active: true }
    ],
    plants: [],
    plant_sections: [],
    equipment_tags: [],
    quotes: [], quote_lines: [], purchase_orders: [], dispatch_cards: [],
    field_worksheets: [], invoices: []
  };
}

function req(db, userId) {
  return { user: { id: userId }, db };
}

test("a Client Viewer's enriched /clients response is still scoped to only their own client", () => {
  const db = database();
  const res = response();
  getCollection("clients")(req(db, "viewer-zimplats"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].id, "c_zimplats");
  // The enrichment (hierarchy_label etc.) is present, but scope is unaffected.
  assert.equal(res.body.data[0].hierarchy_label, "Zimplats");
});

test("one client's Client Viewer never sees another client's record, even enriched", () => {
  const db = database();
  const res = response();
  getCollection("clients")(req(db, "viewer-other"), res);
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].id, "c_other");
});

test("Client Viewer remains blocked from the internal mine_sites/plants/plant_sections/equipment_tags collections (unchanged by enrichment)", () => {
  const db = database();
  for (const collection of ["mine_sites", "plants", "plant_sections", "equipment_tags"]) {
    const res = response();
    getCollection(collection)(req(db, "viewer-zimplats"), res);
    assert.equal(res.statusCode, 403, `Client Viewer should be blocked from ${collection}`);
  }
});

test("Sales (no manageAssets) is blocked from the hierarchy collections; Operations (has manageAssets) can read them", () => {
  const db = database();
  for (const collection of ["mine_sites", "plants", "plant_sections", "equipment_tags"]) {
    const salesRes = response();
    getCollection(collection)(req(db, "sales-1"), salesRes);
    assert.equal(salesRes.statusCode, 403);

    const opsRes = response();
    getCollection(collection)(req(db, "ops-1"), opsRes);
    assert.equal(opsRes.statusCode, 200);
  }
});
