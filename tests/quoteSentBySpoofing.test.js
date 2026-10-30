import test from "node:test";
import assert from "node:assert/strict";
import { CreateQuoteSchema, TransitionQuoteSchema, UpdateQuoteSchema } from "../src/schemas.js";

// sent_by is server-owned (stateMachine.js sets it from the authenticated
// actor). The HTTP layer replaces req.body with schema.parse(req.body)
// (middleware/validate.js), so a forged field must not survive parsing on any
// quote-writing route.
const FORGED = { sent_by: "u_someone_else", created_by: "u_someone_else", status: "Approved_Pending_PO" };

test("TransitionQuoteSchema strips a forged sent_by", () => {
  const parsed = TransitionQuoteSchema.parse({
    target_state: "Approved_Pending_PO",
    approval_exception_reason: "Sales approver was unavailable for the client deadline.",
    ...FORGED
  });
  assert.equal("sent_by" in parsed, false);
  assert.equal(parsed.approval_exception_reason, "Sales approver was unavailable for the client deadline.");
});

test("CreateQuoteSchema strips a forged sent_by, created_by and status", () => {
  const parsed = CreateQuoteSchema.parse({ client_id: "c1", lines: [{ description: "Labour", quantity: 1, unit_price: 10 }], ...FORGED });
  for (const key of Object.keys(FORGED)) assert.equal(key in parsed, false, key);
});

test("UpdateQuoteSchema strips a forged sent_by, created_by and status", () => {
  const parsed = UpdateQuoteSchema.parse({ description: "x", ...FORGED });
  for (const key of Object.keys(FORGED)) assert.equal(key in parsed, false, key);
});
