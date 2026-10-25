import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { allocateV5MaterialUsage } from "../src/controllers/v5MaterialAllocationController.js";
import { getV5BillingReadiness } from "../src/controllers/timesheetWorkflowController.js";
import { database, call, withV5 } from "./helpers/v5SignatureFixture.js";
import apiRouter from "../src/router.js";
import { createStore } from "../src/store.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { generateToken } from "../src/middleware/auth.js";

function addMaterialEvidence(db, overrides = {}) {
  db.quote_lines.push({ id: "line-material", quotation_id: "quote-1", description: "Ceramic tile", pricing_basis: "material", catalog_item_id: "cat-tile" });
  db.material_usage = [{
    id: "usage-1", dispatch_card_id: "job-1", catalog_item_id: "cat-tile", description: "Ceramic tile",
    quantity_used: 4, unit_cost: 99, total_cost: 396, created_by: "tech-1", ...overrides
  }];
  db.stock_items = [{ catalog_item_id: "cat-tile", unit_of_measure: "each" }];
}

function allocate(db, actor = "sales-1", body = {}) {
  return call(allocateV5MaterialUsage, db, actor, {
    params: { id: "job-1" },
    body: { material_usage_id: "usage-1", quote_line_id: "line-material", idempotency_key: "v5-material-allocation-0001", ...body }
  });
}

test("V5 material allocation is dark by default", () => {
  const db = database(); addMaterialEvidence(db);
  assert.equal(allocate(db).statusCode, 409);
  assert.equal(db.v5_material_allocations, undefined);
});

test("Sales can append one accepted, catalog-matched material allocation without exposing a cost", () => withV5(() => {
  const db = database(); addMaterialEvidence(db);
  const res = allocate(db);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.quantity_used, 4);
  assert.equal(res.body.data.unit_of_measure, "each");
  assert.equal(res.body.data.quote_line_id, "line-material");
  assert.equal(JSON.stringify(res.body.data).includes("unit_cost"), false);
  assert.equal(JSON.stringify(res.body.data).includes("idempotency"), false);
  assert.equal(db.material_usage[0].unit_cost, 99, "operational evidence is not rewritten");
  assert.equal(db.v5_material_allocations.length, 1);
  assert.equal(db.audit_logs.at(-1).action, "V5_MATERIAL_EVIDENCE_ALLOCATED");
}));

test("material allocations replay only for the same actor and exact request", () => withV5(() => {
  const db = database(); addMaterialEvidence(db);
  assert.equal(allocate(db).statusCode, 201);
  const replay = allocate(db);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.idempotent_replay, true);
  assert.equal(db.v5_material_allocations.length, 1);
  const changed = allocate(db, "sales-1", { quote_line_id: "line-1" });
  assert.equal(changed.statusCode, 409);
}));

test("original material allocation refuses a usage already allocated to an amendment", () => withV5(() => {
  const db = database(); addMaterialEvidence(db);
  db.v5_amendment_evidence_allocations = [{
    id: "amendment-allocation",
    source_type: "material_usage",
    source_id: "usage-1",
    quantity: 4
  }];
  const result = allocate(db);
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, "MATERIAL_USAGE_ALREADY_ALLOCATED");
  assert.equal((db.v5_material_allocations || []).length, 0);
}));

test("allocation requires PO acceptance, controlled roles and an exact catalog match", () => withV5(() => {
  const db = database(); addMaterialEvidence(db);
  db.quotes[0].commercial_acceptance_status = "pending";
  assert.equal(allocate(db).statusCode, 409);
  db.quotes[0].commercial_acceptance_status = "po_verified";
  assert.throws(() => allocate(db, "tech-1"), /cannot perform/);
  db.quote_lines.find((line) => line.id === "line-material").catalog_item_id = "cat-other";
  assert.equal(allocate(db).statusCode, 409);
  assert.equal((db.v5_material_allocations || []).length, 0);
}));

test("readiness shows allocation provenance and blocks unallocated material evidence", () => withV5(() => {
  const db = database(); addMaterialEvidence(db);
  let res = call(getV5BillingReadiness, db, "sales-1", { params: { id: "job-1" } });
  assert.equal(res.body.data.ready_for_pricing_review, false);
  assert.match(res.body.data.blockers.join(" "), /Material usage requires/);
  assert.deepEqual(res.body.data.unallocated_material_usage.map((item) => item.material_usage_id), ["usage-1"]);
  assert.equal(allocate(db).statusCode, 201);
  res = call(getV5BillingReadiness, db, "sales-1", { params: { id: "job-1" } });
  const material = res.body.data.lines.find((line) => line.quote_line_id === "line-material");
  assert.equal(material.allocated_material_quantity, 4);
  assert.deepEqual(material.source_material_usage_ids, ["usage-1"]);
  assert.deepEqual(res.body.data.unallocated_material_usage, []);
  assert.equal(JSON.stringify(res.body.data).includes("unit_cost"), false);
}));

test("real router authenticates, validates and replays a V5 material allocation", async () => {
  const prior = process.env.ORAC_V5_COMMERCIAL_WORKFLOW;
  process.env.ORAC_V5_COMMERCIAL_WORKFLOW = "enabled";
  const dir = mkdtempSync(join(tmpdir(), "orac-v5-material-http-"));
  const store = createStore(join(dir, "db.json"));
  const users = {
    sales: { id: "v5-sales", email: "sales@fixture.invalid", role: "Sales", is_active: true },
    finance: { id: "v5-finance", email: "finance@fixture.invalid", role: "Finance", is_active: true }
  };
  try {
    const { db, release } = await store.read();
    db.users = Object.values(users);
    db.quotes = [{ id: "v5-quote", v5_commercial_workflow: true, commercial_acceptance_status: "po_verified" }];
    db.quote_lines = [{ id: "v5-material-line", quotation_id: "v5-quote", pricing_basis: "material", catalog_item_id: "v5-catalog", description: "Fixture material" }];
    db.dispatch_cards = [{ id: "v5-job", quotation_id: "v5-quote" }];
    db.material_usage = [{ id: "v5-usage", dispatch_card_id: "v5-job", catalog_item_id: "v5-catalog", description: "Fixture material", quantity_used: 2, unit_cost: 70 }];
    db.stock_items = [{ catalog_item_id: "v5-catalog", unit_of_measure: "each" }];
    db.v5_material_allocations = [];
    db.audit_logs = [];
    store.write(db, release);

    const app = express();
    app.use(express.json());
    app.use("/api", persistenceMiddleware(store));
    app.use("/api", apiRouter);
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
    const server = await new Promise((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    try {
      const base = `http://127.0.0.1:${server.address().port}/api`;
      const body = { material_usage_id: "v5-usage", quote_line_id: "v5-material-line" };
      const request = (user, key, payload = body) => fetch(`${base}/dispatch_cards/v5-job/v5-material-allocations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${generateToken(user)}`, "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(payload)
      });
      const key = randomUUID();
      const created = await request(users.sales, key);
      assert.equal(created.status, 201);
      const createdBody = await created.json();
      assert.equal(createdBody.data.quantity_used, 2);
      assert.equal(JSON.stringify(createdBody).includes("unit_cost"), false);

      const replay = await request(users.sales, key);
      assert.equal(replay.status, 200);
      assert.equal((await replay.json()).idempotent_replay, true);

      const denied = await request(users.finance, randomUUID());
      assert.equal(denied.status, 403);

      const malformed = await fetch(`${base}/dispatch_cards/v5-job/v5-material-allocations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${generateToken(users.sales)}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify({ material_usage_id: "v5-usage" })
      });
      assert.equal(malformed.status, 400);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    if (prior === undefined) delete process.env.ORAC_V5_COMMERCIAL_WORKFLOW;
    else process.env.ORAC_V5_COMMERCIAL_WORKFLOW = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
