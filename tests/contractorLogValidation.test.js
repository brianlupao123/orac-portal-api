import test from "node:test";
import assert from "node:assert/strict";
import {
  isRowInUse, computeRowTotals, computeLogTotals, validateContractorLogRows, voidStartIndex
} from "../src/contractorLogValidation.js";

test("isRowInUse is false for a completely blank row", () => {
  assert.equal(isRowInUse({}), false);
  assert.equal(isRowInUse({ worker_name: "", normal: "", ot_15: "", ot_20: "" }), false);
});

test("isRowInUse is true once a name or any hour cell is filled", () => {
  assert.equal(isRowInUse({ worker_name: "Employee A" }), true);
  assert.equal(isRowInUse({ normal: 8 }), true);
  assert.equal(isRowInUse({ ot_15: 1 }), true);
  assert.equal(isRowInUse({ ot_20: 0 }), true); // explicit 0 still counts as "entered"
});

test("computeRowTotals returns nulls (not zeros) for a row with no hours at all", () => {
  assert.deepEqual(computeRowTotals({ worker_name: "Employee A" }), {
    total_hours: null, total_ot_hours: null, total_payable_hours: null
  });
});

test("computeRowTotals matches the prototype's three formulas", () => {
  // Employee A: normal 8, OT 1.5 = 1, OT 2.0 = 0
  assert.deepEqual(computeRowTotals({ worker_name: "Employee A", normal: 8, ot_15: 1, ot_20: 0 }), {
    total_hours: 9, total_ot_hours: 1, total_payable_hours: 9.5
  });
  // Employee B: normal 8, OT 1.5 = 0, OT 2.0 = 2
  assert.deepEqual(computeRowTotals({ worker_name: "Employee B", normal: 8, ot_15: 0, ot_20: 2 }), {
    total_hours: 10, total_ot_hours: 2, total_payable_hours: 12
  });
});

test("computeLogTotals sums only rows that are in use", () => {
  const rows = [
    { worker_name: "Employee A", normal: 8, ot_15: 1, ot_20: 0 },
    { worker_name: "Employee B", normal: 8, ot_15: 0, ot_20: 2 },
    {} // blank trailing row must not contribute
  ];
  assert.deepEqual(computeLogTotals(rows), {
    normal: 16, ot_15: 1, ot_20: 2,
    total_hours: 19, total_ot_hours: 3, total_payable_hours: 21.5
  });
});

test("computeLogTotals returns all zeros for an empty sheet rather than throwing", () => {
  assert.deepEqual(computeLogTotals([]), {
    normal: 0, ot_15: 0, ot_20: 0, total_hours: 0, total_ot_hours: 0, total_payable_hours: 0
  });
});

test("validateContractorLogRows requires a worker name once hours are entered", () => {
  const errors = validateContractorLogRows([{ normal: 8 }]);
  assert.ok(errors.some((e) => /worker name is required/.test(e)));
});

test("validateContractorLogRows accepts a fully blank row (unused trailing rows are fine)", () => {
  assert.deepEqual(validateContractorLogRows([{}, {}]), []);
});

test("validateContractorLogRows enforces the Artisan/Assistant grade enum", () => {
  const errors = validateContractorLogRows([{ worker_name: "Employee A", normal: 8, grade: "Foreman" }]);
  assert.ok(errors.some((e) => /grade must be/.test(e)));
});

test("validateContractorLogRows accepts the two valid grades", () => {
  assert.deepEqual(validateContractorLogRows([
    { worker_name: "Employee A", normal: 8, grade: "Artisan" },
    { worker_name: "Employee B", normal: 8, grade: "Assistant" }
  ]), []);
});

test("validateContractorLogRows rejects an out-of-range hour cell", () => {
  const errors = validateContractorLogRows([{ worker_name: "Employee A", normal: 30 }]);
  assert.ok(errors.some((e) => /Normal must be a number/.test(e)));
});

test("voidStartIndex points past the last row that is in use", () => {
  const rows = [{ worker_name: "Employee A", normal: 8 }, { worker_name: "Employee B", normal: 8 }, {}, {}];
  assert.equal(voidStartIndex(rows), 2);
});
