import assert from "node:assert/strict";
import test from "node:test";
import {
  isRecordActive,
  enrichClient,
  enrichMineSite,
  enrichPlant,
  enrichPlantSection,
  enrichEquipmentTag,
  validateParentAssignment
} from "../src/services/entityHierarchy.js";

function baseDb() {
  return {
    clients: [
      { id: "c_zimplats", name: "Zimplats", client_type: "permanent", is_active: true },
      { id: "c_retired", name: "Retired Client", client_type: "permanent", is_active: false }
    ],
    mine_sites: [
      { id: "ms_ngezi", client_id: "c_zimplats", name: "Ngezi", location: "Zimbabwe", is_active: true },
      { id: "ms_old", client_id: "c_zimplats", name: "Old Site", location: "Zimbabwe", is_active: false },
      // Legacy record predating the is_active field entirely.
      { id: "ms_legacy", client_id: "c_zimplats", name: "Legacy Site", location: "Zimbabwe" }
    ],
    plants: [
      { id: "pl_smc", mine_site_id: "ms_ngezi", name: "SMC Concentrator", plant_code: "SMC-CON", is_active: true },
      { id: "pl_orphan", mine_site_id: "ms_does_not_exist", name: "Orphan Plant", plant_code: "ORPH", is_active: true }
    ],
    plant_sections: [
      { id: "ps_cyclone", plant_id: "pl_smc", name: "Cyclone Cluster", section_code: "CYCLONE", is_active: true }
    ],
    equipment_tags: [
      { id: "eq_smc_0102", plant_section_id: "ps_cyclone", tag_code: "EQ-TAG-SMC-0102", equipment_name: "Cyclone Wear Liner", is_active: true }
    ]
  };
}

test("isRecordActive treats missing is_active as active (legacy records)", () => {
  assert.equal(isRecordActive({ is_active: true }), true);
  assert.equal(isRecordActive({ is_active: false }), false);
  assert.equal(isRecordActive({}), true);
  assert.equal(isRecordActive(null), false);
});

test("enrichClient normalizes is_active and provides a single-node breadcrumb", () => {
  const db = baseDb();
  const enriched = enrichClient(db, db.clients[0]);
  assert.equal(enriched.hierarchy_label, "Zimplats");
  assert.equal(enriched.hierarchy_path.length, 1);
  assert.equal(enriched.is_active, true);
});

test("enrichMineSite attaches readable client name and full breadcrumb", () => {
  const db = baseDb();
  const mineSite = db.mine_sites.find((m) => m.id === "ms_ngezi");
  const enriched = enrichMineSite(db, mineSite);
  assert.equal(enriched.client_name, "Zimplats");
  assert.equal(enriched.client_is_active, true);
  assert.equal(enriched.parent_orphaned, false);
  assert.equal(enriched.hierarchy_label, "Zimplats \u203a Ngezi");
});

test("enrichMineSite backfills is_active=true for legacy records that never had the field", () => {
  const db = baseDb();
  const legacy = db.mine_sites.find((m) => m.id === "ms_legacy");
  assert.equal("is_active" in legacy, false, "fixture must actually omit the field to test this");
  const enriched = enrichMineSite(db, legacy);
  assert.equal(enriched.is_active, true);
});

test("enrichPlant surfaces mine site AND client context, and flags an orphaned parent", () => {
  const db = baseDb();
  const good = enrichPlant(db, db.plants.find((p) => p.id === "pl_smc"));
  assert.equal(good.mine_site_name, "Ngezi");
  assert.equal(good.client_name, "Zimplats");
  assert.equal(good.parent_orphaned, false);
  assert.equal(good.hierarchy_label, "Zimplats \u203a Ngezi \u203a SMC Concentrator");

  const orphan = enrichPlant(db, db.plants.find((p) => p.id === "pl_orphan"));
  assert.equal(orphan.parent_orphaned, true);
  assert.equal(orphan.mine_site_name, "(missing parent — orphan link)");
});

test("enrichPlantSection and enrichEquipmentTag walk the full chain to the client", () => {
  const db = baseDb();
  const section = enrichPlantSection(db, db.plant_sections[0]);
  assert.equal(section.plant_name, "SMC Concentrator");
  assert.equal(section.mine_site_name, "Ngezi");
  assert.equal(section.client_name, "Zimplats");

  const tag = enrichEquipmentTag(db, db.equipment_tags[0]);
  assert.equal(tag.plant_section_name, "Cyclone Cluster");
  assert.equal(tag.plant_name, "SMC Concentrator");
  assert.equal(tag.mine_site_name, "Ngezi");
  assert.equal(tag.client_name, "Zimplats");
  assert.equal(tag.hierarchy_label, "Zimplats \u203a Ngezi \u203a SMC Concentrator \u203a Cyclone Cluster \u203a EQ-TAG-SMC-0102");
});

test("validateParentAssignment rejects a parent id that does not exist (prevents orphan links)", () => {
  const db = baseDb();
  const result = validateParentAssignment(db, { collection: "mine_sites", parentId: "c_does_not_exist" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.message, /No client exists/);
});

test("validateParentAssignment rejects an empty parent id with a clear message", () => {
  const db = baseDb();
  const result = validateParentAssignment(db, { collection: "plants", parentId: "" });
  assert.equal(result.ok, false);
  assert.match(result.message, /mine site is required/);
});

test("validateParentAssignment rejects assigning a NEW record to an inactive parent", () => {
  const db = baseDb();
  const result = validateParentAssignment(db, { collection: "mine_sites", parentId: "c_retired" });
  assert.equal(result.ok, false);
  assert.match(result.message, /inactive client/);
});

test("validateParentAssignment rejects RE-PARENTING an existing record onto an inactive parent", () => {
  const db = baseDb();
  const result = validateParentAssignment(db, {
    collection: "plants",
    parentId: "ms_old",
    previousParentId: "ms_ngezi"
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /inactive mine site/);
});

test("validateParentAssignment allows KEEPING an existing (now-inactive) parent unchanged — preserves historical links", () => {
  const db = baseDb();
  const result = validateParentAssignment(db, {
    collection: "plants",
    parentId: "ms_old",
    previousParentId: "ms_old"
  });
  assert.equal(result.ok, true);
});

test("validateParentAssignment is a no-op when the field is not being set at all (partial update)", () => {
  const db = baseDb();
  const result = validateParentAssignment(db, { collection: "plants", parentId: undefined, previousParentId: "ms_ngezi" });
  assert.equal(result.ok, true);
});

test("validateParentAssignment allows a valid, active, brand-new parent", () => {
  const db = baseDb();
  const result = validateParentAssignment(db, { collection: "equipment_tags", parentId: "ps_cyclone" });
  assert.equal(result.ok, true);
});
