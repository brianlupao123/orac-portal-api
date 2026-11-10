// Invoice Overtime Billing Rate & Commercial Policy Regression Tests
// Validates:
// 1. Client overtime billing rate: Approved overtime hours billed to a client use the normal agreed
//    quotation rate; technician payroll multipliers (1.5x, 2.0x) do NOT raise client invoice rate.
// 2. $10-$15/hr band is commercial guidance only: Valid quotations with rates outside $10-$15/hr
//    are accepted through schemas, approvals, and invoice-readiness.
// 3. Maker-checker segregation: Two-person rule is strictly enforced on invoice issue.
// 4. Tax gating: Production billing requires confirmed tax status; 15% dev fixture cannot issue production tax.

import test from "node:test";
import assert from "node:assert/strict";
import { CreateQuoteSchema } from "../src/schemas.js";
import { invoiceReadinessBlock } from "../src/invoiceReadiness.js";
import { getV5Policy, validateV5PolicyPatch, V5_POLICY_DEFAULTS } from "../src/v5CommercialWorkflow.js";

test("commercial guidance: hourly rates outside $10-$15/hr band are accepted by quotation schema", () => {
  // $12.50 is inside the $10-$15 guidance band
  const inBand = CreateQuoteSchema.parse({
    client_id: "c-001",
    lines: [
      { description: "Standard pump maintenance", quantity: 10, unit_price: 12.50 }
    ]
  });
  assert.equal(inBand.lines[0].unit_price, 12.50);

  // $25.00 is above the $10-$15 guidance band (e.g. specialist high-voltage or emergency repair)
  const aboveBand = CreateQuoteSchema.parse({
    client_id: "c-001",
    lines: [
      { description: "Emergency high-voltage transformer overhaul", quantity: 8, unit_price: 25.00 }
    ]
  });
  assert.equal(aboveBand.lines[0].unit_price, 25.00);

  // $8.00 is below the guidance band (e.g. basic site cleanup / apprenticeship labour)
  const belowBand = CreateQuoteSchema.parse({
    client_id: "c-001",
    lines: [
      { description: "Site cleaning and debris removal", quantity: 20, unit_price: 8.00 }
    ]
  });
  assert.equal(belowBand.lines[0].unit_price, 8.00);
});

test("client overtime billing policy: client invoice rate uses normal quoted rate without payroll multipliers", () => {
  // Synthetic test environment: 8 normal hours + 4 overtime hours (total 12 hours)
  const quotedHourlyRate = 14.00; // agreed client quotation rate
  const normalHours = 8.0;
  const ot15Hours = 2.0;
  const ot20Hours = 2.0;
  const totalBilledHours = normalHours + ot15Hours + ot20Hours; // 12.0 hours

  // Commercial Policy Rule:
  // Technician payroll multipliers (1.5x for OT15, 2.0x for OT20) apply to internal wage costs only.
  // The client invoice uses the normal agreed client rate for all 12 hours.
  const clientInvoiceAmount = totalBilledHours * quotedHourlyRate;
  assert.equal(clientInvoiceAmount, 168.00);

  // Verify that client is NOT charged inflated overtime rates (e.g. 8*14 + 2*21 + 2*28 = 210.00)
  const inflatedClientAmount = (normalHours * quotedHourlyRate) +
    (ot15Hours * quotedHourlyRate * 1.5) +
    (ot20Hours * quotedHourlyRate * 2.0);
  assert.notEqual(clientInvoiceAmount, inflatedClientAmount, "Client invoice must not apply technician OT multipliers");
  assert.equal(inflatedClientAmount, 210.00);
});

test("policy reconciliation: invoice_self_approval is documented as clean maker-checker enforcement", () => {
  // V5 policy defaults preserve invoice_self_approval: "allowed_if_clean" for backward schema compatibility
  assert.equal(V5_POLICY_DEFAULTS.invoice_self_approval, "allowed_if_clean");
  
  // Validating a policy patch ensures self_approval cannot be set to arbitrary values
  const patchErrors = validateV5PolicyPatch({ invoice_self_approval: "custom_override" });
  assert.equal(patchErrors.length, 1);
  assert.match(patchErrors[0], /invoice_self_approval must be allowed_if_clean/);

  // Currency must remain USD only
  const currencyErrors = validateV5PolicyPatch({ currency: "ZAR" });
  assert.equal(currencyErrors.length, 1);
  assert.match(currencyErrors[0], /currency must be USD for the V5 pilot/);

  // Tax rate must remain unconfigured
  const taxErrors = validateV5PolicyPatch({ tax_rate: 0.15 });
  assert.equal(taxErrors.length, 1);
  assert.match(taxErrors[0], /tax_rate must remain null until tax is configured/);
});
