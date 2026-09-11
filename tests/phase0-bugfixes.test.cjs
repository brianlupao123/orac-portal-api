const test = require("node:test");
const assert = require("node:assert");
const { applyStockMovement } = require("../fixes/stockGuard.cjs");
const { dedupeById } = require("../fixes/dedupe.cjs");

test("applyStockMovement: allows a normal positive movement", () => {
  assert.strictEqual(applyStockMovement(10, 5), 15);
});

test("applyStockMovement: allows a movement that keeps stock at zero or above", () => {
  assert.strictEqual(applyStockMovement(10, -10), 0);
});

test("applyStockMovement: blocks a movement that would go negative", () => {
  assert.throws(() => applyStockMovement(2, -4), /Stock movement rejected/);
});

test("applyStockMovement: blocked error has a machine-readable code", () => {
  try {
    applyStockMovement(2, -4);
    assert.fail("expected an error to be thrown");
  } catch (e) {
    assert.strictEqual(e.code, "NEGATIVE_STOCK_BLOCKED");
  }
});

test("applyStockMovement: allows negative when explicitly overridden", () => {
  assert.strictEqual(applyStockMovement(2, -4, { allowNegative: true }), -2);
});

test("dedupeById: removes duplicate records, keeps first occurrence", () => {
  const input = [
    { id: "q_zimplats_1", total: 1000 },
    { id: "q_mimosa_1", total: 500 },
    { id: "q_zimplats_1", total: 1000 },
    { id: "q_mimosa_1", total: 500 },
  ];
  const result = dedupeById(input);
  assert.strictEqual(result.length, 2);
  assert.deepStrictEqual(result.map((r) => r.id), ["q_zimplats_1", "q_mimosa_1"]);
});

test("dedupeById: leaves a list with no duplicates unchanged", () => {
  const input = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.strictEqual(dedupeById(input).length, 3);
});
