import assert from "node:assert/strict";
import test from "node:test";
import { invoiceReadinessBlock } from "../src/invoiceReadiness.js";
import { buildPhase5BrowserUatFixture } from "../scripts/phase5BrowserUatFixture.mjs";

test("Phase 5 browser UAT fixture is legacy-only and invoice-ready", async () => {
  const { db, financePreparerEmail, financeReviewerEmail } = await buildPhase5BrowserUatFixture();
  const quote = db.quotes[0];
  const dispatch = db.dispatch_cards[0];

  assert.equal(quote.v5_commercial_workflow, false);
  assert.deepEqual(db.v5_invoices, []);
  assert.equal(invoiceReadinessBlock(db, dispatch), null);
  assert.notEqual(financePreparerEmail, financeReviewerEmail);
  assert.equal(db.purchase_orders[0].status, "verified");
  assert.equal(db.field_worksheets[0].status, "Supervisor_Approved");
});
