import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildReconciliation } from "../src/inventoryLedger.js";
import { buildCuratedDemoData } from "../src/curatedDemoData.js";
import { buildValidLedgerFixture } from "./fixtures/validLedgerFixture.js";

// Task 02 - honest reconciliation. Valid-ledger demonstrations use ONLY the separate
// fictional fixture; existing demo/seed records are reported as they are, never repaired.

test("fixture: a ledger built entirely through the real handlers reconciles with no exceptions", () => {
  const { db, expected } = buildValidLedgerFixture();
  const rec = buildReconciliation(db);
  const item = rec.items.find((i) => i.item_code === "FX-VALID-A");
  assert.deepEqual(item.exceptions, []);
  assert.equal(item.quantity_on_hand, expected["FX-VALID-A"].quantity_on_hand);
  assert.equal(item.ledger_balance, expected["FX-VALID-A"].quantity_on_hand);
  assert.equal(item.movement_count, expected["FX-VALID-A"].movements);
  assert.equal(rec.totals.reconciled, 1);
  assert.equal(rec.totals.with_exceptions, 0);
});

test("fixture: every movement carries real before/after, unit and actor produced by the ledger (nothing back-filled)", () => {
  const { db } = buildValidLedgerFixture();
  for (const m of db.stock_movements) {
    assert.equal(typeof m.quantity_before, "number");
    assert.equal(typeof m.quantity_after, "number");
    assert.ok(m.unit_of_measure);
    assert.ok(m.actor_id);
  }
});

test("existing curated demo records are reported as incomplete/unexplained, never repaired or given invented balances", () => {
  const demo = buildCuratedDemoData([]);
  const before = JSON.stringify({ items: demo.stock_items, moves: demo.stock_movements, usage: demo.material_usage });
  const rec = buildReconciliation(demo);
  assert.equal(rec.totals.reconciled, 0, "no legacy item may be presented as reconciled");
  assert.ok(rec.items.every((i) => i.exceptions.length > 0), "every legacy item carries an honest exception");
  for (const m of demo.stock_movements) {
    // The record as shipped has no opening balance and no unit; neither may appear afterwards.
    assert.equal("quantity_before" in m, false, "no fabricated opening balance");
    assert.equal("unit_of_measure" in m, false, "no guessed unit");
  }
  assert.equal(JSON.stringify({ items: demo.stock_items, moves: demo.stock_movements, usage: demo.material_usage }), before, "reconciliation did not edit any record");
});

test("a mixed database keeps the valid fixture clean while still flagging legacy rows beside it", () => {
  const { db } = buildValidLedgerFixture();
  const legacy = buildCuratedDemoData([]);
  db.stock_items.push(...legacy.stock_items);
  db.stock_movements.push(...legacy.stock_movements);
  const rec = buildReconciliation(db);
  assert.deepEqual(rec.items.find((i) => i.item_code === "FX-VALID-A").exceptions, []);
  assert.ok(rec.items.filter((i) => i.item_code !== "FX-VALID-A").every((i) => i.exceptions.length > 0));
});

test("the fixture is test-only: nothing under src/ or the seed scripts imports it", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const walk = (dir) => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? (f === "node_modules" ? [] : walk(p)) : [p];
  });
  for (const file of [...walk(join(root, "src")), ...walk(join(root, "scripts"))].filter((f) => f.endsWith(".js"))) {
    assert.equal(/validLedgerFixture/.test(readFileSync(file, "utf8")), false, file);
  }
});
