import assert from "node:assert/strict";
import test from "node:test";
import { createQuote, updateQuote, transition } from "../src/controllers/quoteController.js";
import { AdminCompanyProfileSchema } from "../src/schemas.js";

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function store() {
  let sequence = 0;
  return { id: (prefix) => `${prefix}-${++sequence}`, audit() {} };
}

function database(profile = {}) {
  return {
    users: [{ id: "sales-1", role: "Sales", is_active: true }],
    clients: [{ id: "client-1", name: "Test Client", is_active: true }],
    equipment_tags: [], mine_sites: [], plants: [], plant_sections: [], audit_logs: [],
    quotes: [], quote_lines: [], company_profile: profile
  };
}

function create(db, body = {}) {
  const res = response();
  createQuote({
    user: { id: "sales-1" }, db, store: store(),
    body: {
      client_id: "client-1",
      lines: [{ description: "Service", quantity: 1, unit_price: 100 }],
      ...body
    }
  }, res);
  return res;
}

function withApprovedTaxMode(callback) {
  const previous = process.env.ORAC_REQUIRE_APPROVED_TAX;
  process.env.ORAC_REQUIRE_APPROVED_TAX = "true";
  try { callback(); } finally {
    if (previous === undefined) delete process.env.ORAC_REQUIRE_APPROVED_TAX;
    else process.env.ORAC_REQUIRE_APPROVED_TAX = previous;
  }
}

test("approved-tax mode ignores Sales-supplied tax values and uses the audited company configuration", () => withApprovedTaxMode(() => {
  const db = database({ quotation_tax_configuration: {
    tax_status: "taxable", applied_tax_rate: 0.155, approved: true, approval_reference: "ACCOUNTANT-2026-01"
  } });
  const res = create(db, { tax_status: "provisional", applied_tax_rate: 0.15 });
  const quote = res.body.data;

  assert.equal(res.statusCode, 200);
  assert.equal(quote.tax_status, "taxable");
  assert.equal(quote.applied_tax_rate, 0.155);
  assert.equal(quote.tax_total_cents, 1550);
  assert.equal(quote.tax_approved, true);
  assert.equal(quote.tax_approval_reference, "ACCOUNTANT-2026-01");
}));

test("approved-tax mode creates an unconfigured draft when no approved company tax configuration exists", () => withApprovedTaxMode(() => {
  const res = create(database(), { tax_status: "taxable", applied_tax_rate: 0.15 });
  const quote = res.body.data;

  assert.equal(res.statusCode, 200);
  assert.equal(quote.tax_status, "unconfigured");
  assert.equal(quote.applied_tax_rate, null);
  assert.equal(quote.tax_approved, false);
  assert.equal(quote.tax_total_cents, 0);
}));

test("approved-tax mode re-resolves a draft from company tax authority instead of an update request", () => withApprovedTaxMode(() => {
  const db = database({ quotation_tax_configuration: {
    tax_status: "taxable", applied_tax_rate: 0.155, approved: true, approval_reference: "ACCOUNTANT-2026-01"
  } });
  const created = create(db);
  db.company_profile.quotation_tax_configuration = {
    tax_status: "zero-rated", applied_tax_rate: 0, approved: true, approval_reference: "ZERO-RATED-CASE"
  };
  const res = response();
  updateQuote({
    user: { id: "sales-1" }, db, store: store(), params: { id: created.body.data.id },
    body: { tax_status: "provisional", applied_tax_rate: 0.15, description: "Updated draft" }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.tax_status, "zero-rated");
  assert.equal(res.body.data.applied_tax_rate, 0);
  assert.equal(res.body.data.tax_approval_reference, "ZERO-RATED-CASE");
}));

test("approved-tax mode refreshes an outdated approved draft from the current company configuration before it is sent", () => withApprovedTaxMode(() => {
  const db = database({ quotation_tax_configuration: {
    tax_status: "taxable", applied_tax_rate: 0.155, approved: true, approval_reference: "ACCOUNTANT-OLD"
  } });
  const created = create(db);
  db.company_profile.quotation_tax_configuration = {
    tax_status: "zero-rated", applied_tax_rate: 0, approved: true, approval_reference: "ZERO-RATED-CURRENT"
  };
  const res = response();

  transition({ user: { id: "sales-1" }, db, store: store(), params: { id: created.body.data.id }, body: { target_state: "Sent" } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.quote.status, "Sent");
  assert.equal(res.body.data.quote.tax_status, "zero-rated");
  assert.equal(res.body.data.quote.tax_total_cents, 0);
  assert.equal(res.body.data.quote.tax_approval_reference, "ZERO-RATED-CURRENT");
}));

test("approved-tax mode refuses issue when a previously approved configuration has been withdrawn", () => withApprovedTaxMode(() => {
  const db = database({ quotation_tax_configuration: {
    tax_status: "taxable", applied_tax_rate: 0.155, approved: true, approval_reference: "ACCOUNTANT-OLD"
  } });
  const created = create(db);
  db.company_profile.quotation_tax_configuration = { tax_status: "taxable", applied_tax_rate: 0.155, approved: false };
  const res = response();

  assert.throws(
    () => transition({ user: { id: "sales-1" }, db, store: store(), params: { id: created.body.data.id }, body: { target_state: "Sent" } }, res),
    /unconfigured tax status/
  );
  assert.equal(created.body.data.status, "Draft");
  assert.equal(created.body.data.tax_status, "unconfigured");
  assert.equal(created.body.data.tax_approved, false);
}));

test("development keeps the labelled provisional fixture and does not claim approval", () => {
  const previous = process.env.ORAC_REQUIRE_APPROVED_TAX;
  delete process.env.ORAC_REQUIRE_APPROVED_TAX;
  try {
    const quote = create(database(), { tax_status: "provisional", applied_tax_rate: 0.15 }).body.data;
    assert.equal(quote.tax_status, "provisional");
    assert.equal(quote.applied_tax_rate, 0.15);
    assert.equal(quote.tax_approved, false);
  } finally {
    if (previous !== undefined) process.env.ORAC_REQUIRE_APPROVED_TAX = previous;
  }
});

test("company profile accepts only final approved tax treatments", () => {
  const valid = AdminCompanyProfileSchema.safeParse({ quotation_tax_configuration: {
    tax_status: "taxable", applied_tax_rate: 0.155, approved: true, approval_reference: "ACCOUNTANT-2026-01"
  } });
  const invalid = AdminCompanyProfileSchema.safeParse({ quotation_tax_configuration: {
    tax_status: "taxable", applied_tax_rate: 0, approved: true
  } });
  const missingApprovalReference = AdminCompanyProfileSchema.safeParse({ quotation_tax_configuration: {
    tax_status: "taxable", applied_tax_rate: 0.155, approved: true
  } });

  assert.equal(valid.success, true);
  assert.equal(invalid.success, false);
  assert.equal(missingApprovalReference.success, false);
});
