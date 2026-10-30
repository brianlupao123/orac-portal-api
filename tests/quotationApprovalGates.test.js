// Step 2 focused tests: Approval gates, tax locks, client visibility, controlled PDF model
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { transitionQuote, allowedTransitions } from "../src/stateMachine.js";
import { CLIENT_VISIBLE_QUOTE_STATUSES } from "../src/controllers/coreController.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore() {
  let counter = 0;
  return {
    id: (prefix) => `${prefix}_${++counter}`,
    audit: () => {},
    save: () => {}
  };
}

function makeDb(overrides = {}) {
  return {
    users: overrides.users || [],
    clients: overrides.clients || [{ id: "c1", name: "Test Client" }],
    quotes: overrides.quotes || [],
    quote_lines: overrides.quote_lines || [],
    dispatch_cards: overrides.dispatch_cards || [],
    purchase_orders: overrides.purchase_orders || [],
    invoices: overrides.invoices || [],
    invoice_lines: overrides.invoice_lines || [],
    field_worksheets: overrides.field_worksheets || [],
    equipment_tags: overrides.equipment_tags || [],
    audit_log: overrides.audit_log || [],
    company_profile: overrides.company_profile || null,
    plant_sections: [],
    plants: [],
    mine_sites: [],
    ...(overrides.extra || {})
  };
}

function makeQuote(overrides = {}) {
  return {
    id: "q1",
    quote_number: "QT-0001",
    client_id: "c1",
    equipment_tag_id: null,
    status: "Draft",
    total_amount: 100,
    grand_total_cents: 10000,
    tax_status: "provisional",
    applied_tax_rate: 0.15,
    discount_percent: 0,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

function makeLine(overrides = {}) {
  return {
    id: "ql1",
    quotation_id: "q1",
    description: "Test service",
    quantity: 1,
    unit_price: 100,
    line_total: 100,
    unit_price_cents: 10000,
    line_total_cents: 10000,
    ...overrides
  };
}

const salesActor = { id: "u_sales", role: "Sales", is_active: true, permissions: ["sendQuote", "approveQuote"] };
const sales2Actor = { id: "u_sales2", role: "Sales", is_active: true, permissions: ["sendQuote", "approveQuote"] };
const mgmtActor = { id: "u_mgmt", role: "Management", is_active: true, permissions: ["sendQuote", "approveQuote", "verifyPo", "dispatch", "invoice"] };
const adminActor = { id: "u_admin", role: "Admin", is_active: true, permissions: ["sendQuote", "approveQuote", "verifyPo", "dispatch", "invoice"] };

// ---------------------------------------------------------------------------
// 1. Tax Status Gate — Draft → Sent
// ---------------------------------------------------------------------------

describe("Tax status gate on Draft → Sent", () => {
  it("blocks transition when tax_status is unconfigured", () => {
    const quote = makeQuote({ status: "Draft", tax_status: "unconfigured" });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    assert.throws(
      () => transitionQuote(db, makeStore(), "q1", "Sent", {}, salesActor),
      (err) => {
        assert.match(err.message, /unconfigured/i);
        assert.equal(err.status, 400);
        return true;
      }
    );
  });

  it("allows transition when tax_status is provisional", () => {
    const quote = makeQuote({ status: "Draft", tax_status: "provisional" });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    const result = transitionQuote(db, makeStore(), "q1", "Sent", {}, salesActor);
    assert.equal(result.quote.status, "Sent");
  });

  it("allows transition when tax_status is taxable", () => {
    const quote = makeQuote({ status: "Draft", tax_status: "taxable" });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    const result = transitionQuote(db, makeStore(), "q1", "Sent", {}, salesActor);
    assert.equal(result.quote.status, "Sent");
  });

  it("allows transition when tax_status is zero-rated", () => {
    const quote = makeQuote({ status: "Draft", tax_status: "zero-rated" });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    const result = transitionQuote(db, makeStore(), "q1", "Sent", {}, salesActor);
    assert.equal(result.quote.status, "Sent");
  });

  it("allows transition when tax_status is exempt", () => {
    const quote = makeQuote({ status: "Draft", tax_status: "exempt" });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    const result = transitionQuote(db, makeStore(), "q1", "Sent", {}, salesActor);
    assert.equal(result.quote.status, "Sent");
  });

  it("sets sent_at and tax_rate_locked on Sent transition", () => {
    const quote = makeQuote({ status: "Draft", tax_status: "provisional" });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    transitionQuote(db, makeStore(), "q1", "Sent", {}, salesActor);
    assert.ok(quote.sent_at, "sent_at should be set");
    assert.equal(quote.tax_rate_locked, true, "tax_rate_locked should be true");
    assert.equal(quote.sent_by, salesActor.id);
  });
});

// ---------------------------------------------------------------------------
// 2. Approval Threshold Gate — Sent → Approved_Pending_PO
// ---------------------------------------------------------------------------

describe("Approval threshold gate on Sent → Approved_Pending_PO", () => {
  it("Sales cannot approve quote > USD 5,000", () => {
    const quote = makeQuote({ status: "Sent", grand_total_cents: 600000, sent_by: "u_other" });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    assert.throws(
      () => transitionQuote(db, makeStore(), "q1", "Approved_Pending_PO", {}, sales2Actor),
      (err) => {
        assert.match(err.message, /5.?000/);
        assert.match(err.message, /Management/i);
        assert.equal(err.status, 403);
        return true;
      }
    );
  });

  it("Management CAN approve quote > USD 5,000", () => {
    const quote = makeQuote({ status: "Sent", grand_total_cents: 600000 });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    const result = transitionQuote(db, makeStore(), "q1", "Approved_Pending_PO", {}, mgmtActor);
    assert.equal(result.quote.status, "Approved_Pending_PO");
  });

  it("Admin CAN approve quote > USD 5,000", () => {
    const quote = makeQuote({ status: "Sent", grand_total_cents: 600000 });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    const result = transitionQuote(db, makeStore(), "q1", "Approved_Pending_PO", {}, adminActor);
    assert.equal(result.quote.status, "Approved_Pending_PO");
  });

  it("Sales CAN approve quote <= USD 5,000 (no discount)", () => {
    const quote = makeQuote({ status: "Sent", grand_total_cents: 500000, discount_percent: 0, sent_by: "u_other" });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    const result = transitionQuote(db, makeStore(), "q1", "Approved_Pending_PO", {}, sales2Actor);
    assert.equal(result.quote.status, "Approved_Pending_PO");
  });
});

// ---------------------------------------------------------------------------
// 3. Discount Gate — Sent → Approved_Pending_PO
// ---------------------------------------------------------------------------

describe("Discount approval gate on Sent → Approved_Pending_PO", () => {
  it("Sales cannot approve quote with any discount", () => {
    const quote = makeQuote({ status: "Sent", grand_total_cents: 100000, discount_percent: 5, sent_by: "u_other" });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    assert.throws(
      () => transitionQuote(db, makeStore(), "q1", "Approved_Pending_PO", {}, sales2Actor),
      (err) => {
        assert.match(err.message, /discount/i);
        assert.match(err.message, /Management/i);
        assert.equal(err.status, 403);
        return true;
      }
    );
  });

  it("Management CAN approve quote with discount", () => {
    const quote = makeQuote({ status: "Sent", grand_total_cents: 100000, discount_percent: 10 });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    const result = transitionQuote(db, makeStore(), "q1", "Approved_Pending_PO", {}, mgmtActor);
    assert.equal(result.quote.status, "Approved_Pending_PO");
  });

  it("Sales cannot approve quote > USD 5,000 AND with discount — combined gate", () => {
    const quote = makeQuote({ status: "Sent", grand_total_cents: 800000, discount_percent: 3, sent_by: "u_other" });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    assert.throws(
      () => transitionQuote(db, makeStore(), "q1", "Approved_Pending_PO", {}, sales2Actor),
      (err) => {
        assert.match(err.message, /5.?000/);
        assert.match(err.message, /discount/i);
        assert.equal(err.status, 403);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Self-approval Prevention
// ---------------------------------------------------------------------------

describe("Self-approval prevention", () => {
  it("Sales cannot approve a quote they personally sent", () => {
    const quote = makeQuote({ status: "Sent", grand_total_cents: 200000, discount_percent: 0, sent_by: salesActor.id });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    assert.throws(
      () => transitionQuote(db, makeStore(), "q1", "Approved_Pending_PO", {}, salesActor),
      (err) => {
        assert.match(err.message, /cannot approve/i);
        assert.equal(err.status, 403);
        return true;
      }
    );
  });

  it("A different Sales user CAN approve (under threshold)", () => {
    const quote = makeQuote({ status: "Sent", grand_total_cents: 200000, discount_percent: 0, sent_by: salesActor.id });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    const result = transitionQuote(db, makeStore(), "q1", "Approved_Pending_PO", {}, sales2Actor);
    assert.equal(result.quote.status, "Approved_Pending_PO");
  });

  it("Admin fallback self-approval requires a recorded Sales-unavailability reason", () => {
    const quote = makeQuote({ status: "Sent", grand_total_cents: 200000, discount_percent: 0, sent_by: adminActor.id });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    assert.throws(
      () => transitionQuote(db, makeStore(), "q1", "Approved_Pending_PO", {}, adminActor),
      /fallback approval requires a recorded reason/i
    );

    const result = transitionQuote(db, makeStore(), "q1", "Approved_Pending_PO", {
      approval_exception_reason: "Sales approver unavailable during client operational deadline."
    }, adminActor);
    assert.equal(result.quote.status, "Approved_Pending_PO");
    assert.deepEqual(result.quote.approval_exception, {
      type: "admin_sales_fallback",
      reason: "Sales approver unavailable during client operational deadline.",
      approved_by: adminActor.id,
      approved_at: result.quote.updated_at
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Client Visibility Filter
// ---------------------------------------------------------------------------

describe("Client visibility statuses", () => {
  it("CLIENT_VISIBLE_QUOTE_STATUSES includes only Sent and later", () => {
    assert.ok(CLIENT_VISIBLE_QUOTE_STATUSES.includes("Sent"));
    assert.ok(CLIENT_VISIBLE_QUOTE_STATUSES.includes("Approved_Pending_PO"));
    assert.ok(CLIENT_VISIBLE_QUOTE_STATUSES.includes("PO_Verified"));
    assert.ok(CLIENT_VISIBLE_QUOTE_STATUSES.includes("Field_Dispatch"));
    assert.ok(CLIENT_VISIBLE_QUOTE_STATUSES.includes("Invoiced"));
  });

  it("Draft is NOT in CLIENT_VISIBLE_QUOTE_STATUSES", () => {
    assert.ok(!CLIENT_VISIBLE_QUOTE_STATUSES.includes("Draft"));
  });

  it("No unexpected statuses leak into client view", () => {
    const allStatuses = Object.keys(allowedTransitions);
    const nonVisible = allStatuses.filter((s) => !CLIENT_VISIBLE_QUOTE_STATUSES.includes(s));
    assert.deepEqual(nonVisible, ["Draft"]);
  });
});

// ---------------------------------------------------------------------------
// 6. Legacy fallback (total_amount → grand_total_cents)
// ---------------------------------------------------------------------------

describe("Legacy fallback for approval threshold", () => {
  it("uses total_amount * 100 when grand_total_cents is missing", () => {
    const quote = makeQuote({
      status: "Sent",
      grand_total_cents: undefined,
      total_amount: 6000, // USD 6,000 > 5,000 threshold
      discount_percent: 0,
      sent_by: "u_other"
    });
    delete quote.grand_total_cents;
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    // Sales should be blocked because 6000 > 5000
    assert.throws(
      () => transitionQuote(db, makeStore(), "q1", "Approved_Pending_PO", {}, sales2Actor),
      (err) => {
        assert.match(err.message, /5.?000/);
        assert.equal(err.status, 403);
        return true;
      }
    );
  });
});
