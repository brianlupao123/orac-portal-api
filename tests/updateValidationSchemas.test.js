import assert from "node:assert/strict";
import test from "node:test";
import { UpdateQuoteSchema, UpdateWorksheetSchema } from "../src/schemas.js";

test("quote updates reject malformed line items", () => {
  assert.throws(() => UpdateQuoteSchema.parse({ lines: [{ description: "Labour", quantity: 0, unit_price: 50 }] }));
  assert.throws(() => UpdateQuoteSchema.parse({ lines: [{ description: "", quantity: 1, unit_price: 50 }] }));
  assert.deepEqual(UpdateQuoteSchema.parse({}), {});
});

test("Timesheet updates reject invalid activity and hours", () => {
  assert.throws(() => UpdateWorksheetSchema.parse({ hours: -1 }));
  assert.throws(() => UpdateWorksheetSchema.parse({ activity: "" }));
  assert.deepEqual(UpdateWorksheetSchema.parse({ hours: 4.5, activity: "Pump seal replacement" }), {
    hours: 4.5, activity: "Pump seal replacement"
  });
});
