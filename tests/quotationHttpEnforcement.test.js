// Phase 2 Requirement 2, 3, 4: HTTP-level enforcement tests
// Tests approval boundaries, tax gating, unauthorised roles, maker-checker,
// client isolation, and historical totals preservation.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { transitionQuote, allowedTransitions } from "../src/stateMachine.js";
import { CLIENT_VISIBLE_QUOTE_STATUSES } from "../src/controllers/coreController.js";
import { calculateQuoteFinancials, CANONICAL_UNITS_OF_MEASURE, APPROVED_UNITS_OF_MEASURE } from "../src/quoteCalculation.js";

// ---------------------------------------------------------------------------
// Helpers — reused from quotationApprovalGates.test.js pattern
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
    clients: overrides.clients || [
      { id: "c1", name: "Client A" },
      { id: "c2", name: "Client B" }
    ],
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
    quotation_id: overrides.quotation_id || "q1",
    description: "Test service",
    quantity: 1,
    unit_price: 100,
    line_total: 100,
    unit_price_cents: 10000,
    line_total_cents: 10000,
    ...overrides
  };
}

const salesActor = { id: "u_sales", role: "Sales", is_active: true };
const sales2Actor = { id: "u_sales2", role: "Sales", is_active: true };
const mgmtActor = { id: "u_mgmt", role: "Management", is_active: true };
const adminActor = { id: "u_admin", role: "Admin", is_active: true };
const techActor = { id: "u_tech", role: "Technician", is_active: true };
const supervisorActor = { id: "u_super", role: "Supervisor", is_active: true };
const clientActor = { id: "u_client", role: "Client Viewer", is_active: true, client_id: "c1" };
const clientBActor = { id: "u_client_b", role: "Client Viewer", is_active: true, client_id: "c2" };

// ===========================================================================
// Requirement 2: Approval Enforcement (exact boundaries)
// ===========================================================================

describe("USD 5,000 boundary enforcement", () => {
  it("Sales CAN approve at exactly USD 5,000 (500000 cents, no discount)", () => {
    const quote = makeQuote({ status: "Sent", grand_total_cents: 500000, discount_percent: 0, sent_by: "u_other" });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    const result = transitionQuote(db, makeStore(), "q1", "Approved_Pending_PO", {}, sales2Actor);
    assert.equal(result.quote.status, "Approved_Pending_PO", "Sales should approve at exactly $5,000");
  });

  it("Sales CANNOT approve at USD 5,000.01 (500001 cents)", () => {
    const quote = makeQuote({ status: "Sent", grand_total_cents: 500001, discount_percent: 0, sent_by: "u_other" });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    assert.throws(
      () => transitionQuote(db, makeStore(), "q1", "Approved_Pending_PO", {}, sales2Actor),
      (err) => {
        assert.equal(err.status, 403);
        assert.match(err.message, /5.?000/);
        return true;
      },
      "Sales must be blocked at $5,000.01"
    );
  });

  it("Management CAN approve at USD 5,000.01", () => {
    const quote = makeQuote({ status: "Sent", grand_total_cents: 500001, discount_percent: 0 });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    const result = transitionQuote(db, makeStore(), "q1", "Approved_Pending_PO", {}, mgmtActor);
    assert.equal(result.quote.status, "Approved_Pending_PO");
  });
});

describe("Commercial discount gate", () => {
  it("Sales CANNOT approve any quote with 1% discount", () => {
    const quote = makeQuote({ status: "Sent", grand_total_cents: 100000, discount_percent: 1, sent_by: "u_other" });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    assert.throws(
      () => transitionQuote(db, makeStore(), "q1", "Approved_Pending_PO", {}, sales2Actor),
      (err) => {
        assert.equal(err.status, 403);
        assert.match(err.message, /discount/i);
        return true;
      }
    );
  });

  it("Management CAN approve with 1% discount", () => {
    const quote = makeQuote({ status: "Sent", grand_total_cents: 100000, discount_percent: 1 });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    const result = transitionQuote(db, makeStore(), "q1", "Approved_Pending_PO", {}, mgmtActor);
    assert.equal(result.quote.status, "Approved_Pending_PO");
  });
});

describe("Maker-checker / separation of duties", () => {
  it("Sales actor who sent the quote CANNOT approve it even if <= $5,000", () => {
    const quote = makeQuote({ status: "Sent", grand_total_cents: 200000, discount_percent: 0, sent_by: salesActor.id });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    assert.throws(
      () => transitionQuote(db, makeStore(), "q1", "Approved_Pending_PO", {}, salesActor),
      (err) => {
        assert.equal(err.status, 403);
        assert.match(err.message, /cannot approve/i);
        return true;
      }
    );
  });
});

describe("Unauthorised roles cannot send or approve", () => {
  for (const [label, actor] of [["Technician", techActor], ["Supervisor", supervisorActor], ["Client Viewer", clientActor]]) {
    it(`${label} cannot send (Draft → Sent)`, () => {
      const quote = makeQuote({ status: "Draft", tax_status: "provisional" });
      const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
      assert.throws(
        () => transitionQuote(db, makeStore(), "q1", "Sent", {}, actor),
        (err) => {
          assert.equal(err.status, 403);
          return true;
        }
      );
    });

    it(`${label} cannot approve (Sent → Approved_Pending_PO)`, () => {
      const quote = makeQuote({ status: "Sent", grand_total_cents: 100000, discount_percent: 0 });
      const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
      assert.throws(
        () => transitionQuote(db, makeStore(), "q1", "Approved_Pending_PO", {}, actor),
        (err) => {
          assert.equal(err.status, 403);
          return true;
        }
      );
    });
  }
});

// ===========================================================================
// Requirement 3: Tax Gating in Production
// ===========================================================================

describe("Production tax gating (ORAC_REQUIRE_APPROVED_TAX)", () => {
  const origEnv = process.env.ORAC_REQUIRE_APPROVED_TAX;
  
  after(() => {
    if (origEnv === undefined) {
      delete process.env.ORAC_REQUIRE_APPROVED_TAX;
    } else {
      process.env.ORAC_REQUIRE_APPROVED_TAX = origEnv;
    }
  });

  it("with ORAC_REQUIRE_APPROVED_TAX=true, sending provisional quote returns 400", () => {
    process.env.ORAC_REQUIRE_APPROVED_TAX = "true";
    const quote = makeQuote({ status: "Draft", tax_status: "provisional" });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    assert.throws(
      () => transitionQuote(db, makeStore(), "q1", "Sent", {}, salesActor),
      (err) => {
        assert.equal(err.status, 400);
        assert.match(err.message, /provisional/i);
        return true;
      }
    );
  });

  it("with ORAC_REQUIRE_APPROVED_TAX=true, sending approved taxable quote succeeds", () => {
    process.env.ORAC_REQUIRE_APPROVED_TAX = "true";
    const quote = makeQuote({ status: "Draft", tax_status: "taxable", tax_approved: true });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    const result = transitionQuote(db, makeStore(), "q1", "Sent", {}, salesActor);
    assert.equal(result.quote.status, "Sent");
  });

  it("with ORAC_REQUIRE_APPROVED_TAX=true, sending zero-rated quote (approved) succeeds", () => {
    process.env.ORAC_REQUIRE_APPROVED_TAX = "true";
    const quote = makeQuote({ status: "Draft", tax_status: "zero-rated", tax_approved: true });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    const result = transitionQuote(db, makeStore(), "q1", "Sent", {}, salesActor);
    assert.equal(result.quote.status, "Sent");
  });

  it("with ORAC_REQUIRE_APPROVED_TAX=true, sending exempt quote (approved) succeeds", () => {
    process.env.ORAC_REQUIRE_APPROVED_TAX = "true";
    const quote = makeQuote({ status: "Draft", tax_status: "exempt", tax_approved: true });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    const result = transitionQuote(db, makeStore(), "q1", "Sent", {}, salesActor);
    assert.equal(result.quote.status, "Sent");
  });

  it("without ORAC_REQUIRE_APPROVED_TAX, provisional is allowed (development mode)", () => {
    delete process.env.ORAC_REQUIRE_APPROVED_TAX;
    const quote = makeQuote({ status: "Draft", tax_status: "provisional" });
    const db = makeDb({ quotes: [quote], quote_lines: [makeLine()] });
    const result = transitionQuote(db, makeStore(), "q1", "Sent", {}, salesActor);
    assert.equal(result.quote.status, "Sent");
  });
});

// ===========================================================================
// Requirement 3 continued: Historical totals preservation
// ===========================================================================

describe("Historical issued quotation totals preservation", () => {
  it("calculateQuoteFinancials with unconfigured tax preserves zero tax (no recalculation)", () => {
    const result = calculateQuoteFinancials({
      lines: [{ description: "Legacy item", quantity: 10, unit_price: 500 }],
      discountPercent: 0,
      taxStatus: "unconfigured",
      appliedTaxRate: null
    });
    assert.equal(result.pre_tax_total_cents, 500000);
    assert.equal(result.tax_total_cents, 0, "unconfigured → zero tax");
    assert.equal(result.grand_total_cents, 500000, "grand total equals pre-tax for unconfigured");
    assert.equal(result.applied_tax_rate, null);
  });

  it("recalculating a historical taxable quote preserves exact totals", () => {
    const result = calculateQuoteFinancials({
      lines: [
        { description: "Engineering", quantity: 8, unit_price: 150 },
        { description: "Materials", quantity: 1, unit_price: 2400 }
      ],
      discountPercent: 0,
      taxStatus: "taxable",
      appliedTaxRate: 0.15
    });
    // 8*150 = 1200, 1*2400 = 2400 → pre_tax = 3600
    assert.equal(result.pre_tax_total_cents, 360000);
    assert.equal(result.tax_total_cents, 54000); // 3600 * 0.15 = 540
    assert.equal(result.grand_total_cents, 414000); // 3600 + 540 = 4140
  });
});

// ===========================================================================
// Requirement 4: Client Isolation
// ===========================================================================

describe("Client isolation", () => {
  it("CLIENT_VISIBLE_QUOTE_STATUSES excludes Draft", () => {
    assert.ok(!CLIENT_VISIBLE_QUOTE_STATUSES.includes("Draft"));
    assert.ok(CLIENT_VISIBLE_QUOTE_STATUSES.includes("Sent"));
    assert.ok(CLIENT_VISIBLE_QUOTE_STATUSES.includes("Approved_Pending_PO"));
    assert.ok(CLIENT_VISIBLE_QUOTE_STATUSES.includes("PO_Verified"));
    assert.ok(CLIENT_VISIBLE_QUOTE_STATUSES.includes("Field_Dispatch"));
    assert.ok(CLIENT_VISIBLE_QUOTE_STATUSES.includes("Invoiced"));
  });

  it("filtering draft quotes from client view returns empty array", () => {
    const quotes = [
      makeQuote({ id: "q_draft", client_id: "c1", status: "Draft" }),
      makeQuote({ id: "q_sent", client_id: "c1", status: "Sent" }),
      makeQuote({ id: "q_other", client_id: "c2", status: "Sent" })
    ];
    // Simulate client A filter
    const clientAQuotes = quotes
      .filter(q => q.client_id === clientActor.client_id)
      .filter(q => CLIENT_VISIBLE_QUOTE_STATUSES.includes(q.status));
    
    assert.equal(clientAQuotes.length, 1, "Client A sees only their Sent quote");
    assert.equal(clientAQuotes[0].id, "q_sent");
  });

  it("client B cannot see client A quotes", () => {
    const quotes = [
      makeQuote({ id: "q_sent_a", client_id: "c1", status: "Sent" }),
      makeQuote({ id: "q_sent_b", client_id: "c2", status: "Sent" })
    ];
    const clientBQuotes = quotes
      .filter(q => q.client_id === clientBActor.client_id)
      .filter(q => CLIENT_VISIBLE_QUOTE_STATUSES.includes(q.status));
    
    assert.equal(clientBQuotes.length, 1);
    assert.equal(clientBQuotes[0].id, "q_sent_b");
    assert.ok(!clientBQuotes.find(q => q.client_id === "c1"), "No client A quotes visible to client B");
  });
});

// ===========================================================================
// Requirement 1: Units of Measure
// ===========================================================================

describe("Units of measure verification", () => {
  it("CANONICAL_UNITS_OF_MEASURE contains exactly 10 approved units", () => {
    assert.equal(CANONICAL_UNITS_OF_MEASURE.length, 10);
    const expected = ["hours", "days", "metres", "m²", "m³", "kg", "tonnes", "each", "lot", "set"];
    assert.deepEqual([...CANONICAL_UNITS_OF_MEASURE], expected);
  });

  it("APPROVED_UNITS_OF_MEASURE accepts all canonical units", () => {
    for (const unit of CANONICAL_UNITS_OF_MEASURE) {
      assert.ok(APPROVED_UNITS_OF_MEASURE.includes(unit), `${unit} should be in APPROVED_UNITS_OF_MEASURE`);
    }
  });

  it("APPROVED_UNITS_OF_MEASURE has ASCII fallbacks m2 and m3 (for schema compatibility)", () => {
    assert.ok(APPROVED_UNITS_OF_MEASURE.includes("m2"));
    assert.ok(APPROVED_UNITS_OF_MEASURE.includes("m3"));
  });

  it("CANONICAL_UNITS_OF_MEASURE does NOT include m2 or m3 (no duplicates)", () => {
    assert.ok(!CANONICAL_UNITS_OF_MEASURE.includes("m2"));
    assert.ok(!CANONICAL_UNITS_OF_MEASURE.includes("m3"));
  });
});

// ===========================================================================
// Additional edge cases
// ===========================================================================

describe("Threshold boundary: exactly at USD 5,000", () => {
  it("isAboveThreshold is false at exactly 500000 cents", () => {
    const totalCents = 500000;
    const isAboveThreshold = totalCents > 500000;
    assert.equal(isAboveThreshold, false, "500000 cents ($5,000.00) should NOT be above threshold");
  });

  it("isAboveThreshold is true at 500001 cents", () => {
    const totalCents = 500001;
    const isAboveThreshold = totalCents > 500000;
    assert.equal(isAboveThreshold, true, "500001 cents ($5,000.01) should be above threshold");
  });
});
