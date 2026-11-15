// Lane 4 / Batch B1a: invoice-readiness gate vs summary parity, CHARACTERIZATION tests.
//
// PURPOSE
//   These tests record what the code at backend baseline 73fb29d DOES TODAY. They are
//   not a statement that the behaviour is correct or desirable. Where gate and summary
//   disagree, or where a limit exists, the test pins the current result and says so in
//   its message, so that any later finance change (batch B2) shows up as a deliberate,
//   reviewable test diff with a before/after impact report and owner approval.
//
// SCOPE
//   Test-only. Imports invoiceReadiness.js and reports.js. Uses in-memory fixtures only
//   (fictional ids, no I/O, no router, no store). Changes no production source.
//
// ASSUMPTIONS TO CONFIRM ON FIRST RUN (adjust the constants below, never the assertions,
// if a precondition message fires):
//   * The eligibility cutover flag name/value come from RECONCILIATION.md (L4-F02) and
//     have not been seen in source by the author of this file.
//   * The cutover flag is read at call time (as TIMESHEET_INVOICE_VARIANCE is in
//     invoiceReadinessConsistency.test.js), not once at import.

import assert from "node:assert/strict";
import test from "node:test";
import { computeInvoiceReadyReport } from "../src/reports.js";
import {
  calculateLegacyInvoiceAmounts,
  invoiceReadinessBlock,
  invoiceReadinessSummary
} from "../src/invoiceReadiness.js";

const CUTOVER_FLAG = "TIMESHEET_ELIGIBILITY_CUTOVER";
const CUTOVER_ON = "enabled";
const MANAGED_FLAGS = [CUTOVER_FLAG, "TIMESHEET_INVOICE_VARIANCE"];

// Run with every managed flag unset, except the overrides given. Always restores.
function withFlags(overrides, run) {
  const saved = new Map(MANAGED_FLAGS.map((name) => [name, process.env[name]]));
  try {
    for (const name of MANAGED_FLAGS) delete process.env[name];
    for (const [name, value] of Object.entries(overrides)) process.env[name] = value;
    return run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const po = (id, over = {}) => ({
  id, quotation_id: "q1", status: "verified", po_reference: `REF-${id}`, po_amount: 10000, requires_amendment: false, ...over
});
const approved = (id, over = {}) => ({ id, dispatch_card_id: "d1", status: "Supervisor_Approved", ...over });

function database({
  quote = {}, job = {}, purchaseOrders = [po("po1")], worksheets = [], timesheets = [],
  materials = [], invoices = [], creditNotes
} = {}) {
  const db = {
    quotes: [{ id: "q1", status: "Field_Dispatch", total_amount: 100, ...quote }],
    dispatch_cards: [{ id: "d1", quotation_id: "q1", dispatch_number: "JOB-1", ...job }],
    purchase_orders: purchaseOrders,
    field_worksheets: worksheets,
    timesheets,
    material_usage: materials,
    invoices
  };
  if (creditNotes !== undefined) db.invoice_credit_notes = creditNotes;
  return db;
}

function evaluate(db) {
  const job = db.dispatch_cards[0];
  return {
    gate: invoiceReadinessBlock(db, job),
    summary: invoiceReadinessSummary(db, job),
    report: computeInvoiceReadyReport(db)
  };
}

// A billable entry with no source worksheet link: counted, never cross-checked against a worksheet.
const unlinkedEntry = (id, hours, rate) => ({ id, dispatch_card_id: "d1", hours_logged: hours, hourly_rate: rate });
// A billable entry linked to an approved worksheet for the same dispatch and worker.
const linkedEntry = (id, worksheetId, userId, hours, rate = 10) => ({
  id, dispatch_card_id: "d1", user_id: userId, source_worksheet_id: worksheetId, hours_logged: hours, hourly_rate: rate
});

// ---------------------------------------------------------------------------------------
// 1. PO selection when one quote has two POs (gate: invoiceReadiness.js:58, summary: :145)
// ---------------------------------------------------------------------------------------

test("Lane4 B1a PO selection: with no job.purchase_order_id, gate and summary resolve the same (first) PO", () => {
  withFlags({}, () => {
    const db = database({
      purchaseOrders: [po("po1", { po_amount: 10000 }), po("po2", { po_amount: 50 })],
      worksheets: [approved("w1")],
      timesheets: [unlinkedEntry("t1", 10, 10)]
    });
    const { gate, summary, report } = evaluate(db);
    assert.equal(gate, null);
    assert.equal(summary.workflow.purchase_order.id, "po1");
    assert.equal(summary.commercial.po_amount, 10000);
    assert.equal(summary.readiness.ready_for_invoice_review, true);
    assert.deepEqual(report.map((row) => row.id), ["d1"]);
  });
});

test("Lane4 B1a PO selection (CURRENT DRIFT): job.purchase_order_id names the later PO; summary shows it, gate evaluates the first", () => {
  withFlags({}, () => {
    const db = database({
      job: { purchase_order_id: "po2" },
      purchaseOrders: [po("po1", { po_amount: 10000 }), po("po2", { po_amount: 50 })],
      worksheets: [approved("w1")],
      timesheets: [unlinkedEntry("t1", 10, 10)] // calculated invoice = 100
    });
    const { gate, summary, report } = evaluate(db);
    // Gate used po1 (amount 10000): nothing blocks.
    assert.equal(gate, null, "current gate resolves po1 by quotation_id, not job.purchase_order_id");
    // Summary displays po2 (amount 50) ...
    assert.equal(summary.workflow.purchase_order.id, "po2");
    assert.equal(summary.commercial.po_amount, 50);
    assert.equal(summary.commercial.calculated_invoice.total_amount, 100);
    assert.ok(summary.commercial.calculated_invoice.total_amount > summary.commercial.po_amount,
      "summary shows a calculated invoice above the PO it displays");
    // ... yet its readiness verdict comes from the gate, so it still reports ready.
    assert.equal(summary.readiness.ready_for_invoice_review, true);
    assert.deepEqual(report.map((row) => row.id), ["d1"]);
  });
});

test("Lane4 B1a PO selection (CURRENT DRIFT): job names a rejected PO; gate skips it, summary shows it", () => {
  withFlags({}, () => {
    const db = database({
      job: { purchase_order_id: "po1" },
      purchaseOrders: [po("po1", { status: "rejected" }), po("po2", { status: "verified" })],
      worksheets: [approved("w1")]
    });
    const { gate, summary } = evaluate(db);
    assert.equal(gate, null, "gate falls through the rejected PO to the first non-rejected PO");
    assert.equal(summary.workflow.purchase_order.id, "po1");
    assert.equal(summary.workflow.purchase_order.status, "rejected");
    assert.equal(summary.readiness.ready_for_invoice_review, true);
  });
});

test("Lane4 B1a PO selection: every PO rejected, gate and summary agree on VERIFIED_PO_REQUIRED", () => {
  withFlags({}, () => {
    const db = database({
      purchaseOrders: [po("po1", { status: "rejected" }), po("po2", { status: "cancelled" })],
      worksheets: [approved("w1")]
    });
    const { gate, summary, report } = evaluate(db);
    assert.equal(gate?.code, "VERIFIED_PO_REQUIRED");
    assert.equal(summary.readiness.blocker?.code, "VERIFIED_PO_REQUIRED");
    assert.equal(summary.readiness.ready_for_invoice_review, false);
    assert.deepEqual(report, []);
  });
});

test("Lane4 B1a PO selection: headroom is consumed per gate-resolved PO; invoices on the other PO do not count", () => {
  withFlags({}, () => {
    const db = database({
      purchaseOrders: [po("po1", { po_amount: 100 }), po("po2", { po_amount: 100 })],
      worksheets: [approved("w1")],
      timesheets: [unlinkedEntry("t1", 10, 10)], // 100
      invoices: [{ id: "i-po2", purchase_order_id: "po2", status: "sent", total_amount: 90 }]
    });
    const { gate, summary } = evaluate(db);
    assert.equal(gate, null, "po2 invoicing does not reduce po1 headroom");
    assert.equal(summary.commercial.previously_invoiced_amount, 0);
  });
});

// ---------------------------------------------------------------------------------------
// 2. Superseded worksheet, eligibility cutover off and on
//    gate: invoiceReadiness.js:21 and :66 (no !superseded_by); summary: :147 (filters it)
// ---------------------------------------------------------------------------------------

test("Lane4 B1a superseded, cutover OFF (CURRENT DRIFT): gate passes on a superseded worksheet; summary evidence shows none", () => {
  withFlags({}, () => {
    const db = database({ worksheets: [approved("w1", { superseded_by: "w2" })] });
    const { gate, summary, report } = evaluate(db);
    assert.equal(gate, null, "gate accepts Supervisor_Approved even when superseded while the cutover is off");
    assert.equal(summary.evidence.worksheets.total, 0, "summary excludes superseded worksheets");
    assert.equal(summary.evidence.worksheets.approved, 0);
    assert.equal(summary.readiness.ready_for_invoice_review, true, "verdict comes from the gate");
    assert.deepEqual(report.map((row) => row.id), ["d1"]);
  });
});

test("Lane4 B1a superseded, cutover OFF: a superseded worksheet plus an approved replacement is ready; summary counts only the replacement", () => {
  withFlags({}, () => {
    const db = database({ worksheets: [approved("w1", { superseded_by: "w2" }), approved("w2")] });
    const { gate, summary } = evaluate(db);
    assert.equal(gate, null);
    assert.equal(summary.evidence.worksheets.total, 1);
    assert.equal(summary.evidence.worksheets.approved, 1);
  });
});

test("Lane4 B1a superseded, cutover ON: precondition, a non-superseded approved worksheet is eligible", () => {
  withFlags({ [CUTOVER_FLAG]: CUTOVER_ON }, () => {
    const { gate } = evaluate(database({ worksheets: [approved("w1")] }));
    assert.equal(gate, null,
      `PRECONDITION: with ${CUTOVER_FLAG}=${CUTOVER_ON} a plain Supervisor_Approved worksheet must stay eligible. ` +
      "If this fails, the flag name/value or the fixture fields are wrong; fix the constants or fixture, not the later assertions.");
  });
});

test("Lane4 B1a superseded, cutover ON: gate and summary agree that a superseded-only dispatch is blocked", () => {
  withFlags({ [CUTOVER_FLAG]: CUTOVER_ON }, () => {
    const db = database({ worksheets: [approved("w1", { superseded_by: "w2" })] });
    const { gate, summary, report } = evaluate(db);
    assert.equal(gate?.code, "APPROVED_WORKSHEET_REQUIRED");
    assert.equal(summary.evidence.worksheets.approved, 0);
    assert.equal(summary.readiness.ready_for_invoice_review, false);
    assert.equal(summary.readiness.blocker?.code, "APPROVED_WORKSHEET_REQUIRED");
    assert.deepEqual(report, []);
  });
});

// ---------------------------------------------------------------------------------------
// 3. Zero-timesheet fallback (invoiceReadiness.js:132: laborTotal + materialTotal || quote.total_amount)
// ---------------------------------------------------------------------------------------

test("Lane4 B1a fallback (CURRENT): approved worksheet with no timesheets or materials bills the quote total", () => {
  withFlags({}, () => {
    const db = database({ quote: { total_amount: 100 }, worksheets: [approved("w1")] });
    const amounts = calculateLegacyInvoiceAmounts(db, db.dispatch_cards[0], db.quotes[0]);
    assert.equal(amounts.laborTotal, 0);
    assert.equal(amounts.materialTotal, 0);
    assert.equal(amounts.total, 100, "falls back to quote.total_amount");
    const { gate, summary, report } = evaluate(db);
    assert.equal(gate, null);
    assert.deepEqual(summary.commercial.calculated_invoice, { labor_amount: 0, material_amount: 0, total_amount: 100 });
    assert.deepEqual(report.map((row) => row.id), ["d1"]);
  });
});

test("Lane4 B1a fallback (CURRENT): a counted zero-hour timesheet also falls back to the quote total", () => {
  withFlags({}, () => {
    const db = database({ quote: { total_amount: 100 }, worksheets: [approved("w1")], timesheets: [unlinkedEntry("t1", 0, 100)] });
    const amounts = calculateLegacyInvoiceAmounts(db, db.dispatch_cards[0], db.quotes[0]);
    assert.equal(amounts.laborTotal, 0);
    assert.equal(amounts.total, 100);
    assert.equal(evaluate(db).gate, null);
  });
});

test("Lane4 B1a fallback: positive timesheet labour overrides the quote total", () => {
  withFlags({}, () => {
    const db = database({ quote: { total_amount: 100 }, worksheets: [approved("w1")], timesheets: [unlinkedEntry("t1", 4, 10)] });
    const amounts = calculateLegacyInvoiceAmounts(db, db.dispatch_cards[0], db.quotes[0]);
    assert.equal(amounts.total, 40);
    assert.equal(evaluate(db).summary.commercial.calculated_invoice.total_amount, 40);
  });
});

test("Lane4 B1a fallback: materials alone override the quote total", () => {
  withFlags({}, () => {
    const db = database({
      quote: { total_amount: 100 }, worksheets: [approved("w1")],
      materials: [{ id: "m1", dispatch_card_id: "d1", total_cost: 25 }]
    });
    const amounts = calculateLegacyInvoiceAmounts(db, db.dispatch_cards[0], db.quotes[0]);
    assert.equal(amounts.materialTotal, 25);
    assert.equal(amounts.total, 25);
  });
});

test("Lane4 B1a fallback: a zero or missing quote total with no evidence is blocked as INVOICE_AMOUNT_INVALID", () => {
  withFlags({}, () => {
    for (const total_amount of [0, undefined]) {
      const db = database({ quote: { total_amount }, worksheets: [approved("w1")] });
      const { gate, report } = evaluate(db);
      assert.equal(gate?.code, "INVOICE_AMOUNT_INVALID", `quote total ${String(total_amount)}`);
      assert.deepEqual(report, []);
    }
  });
});

// ---------------------------------------------------------------------------------------
// 4. Credit notes and PO headroom (invoiceReadiness.js:98-110 sums invoice total_amount only)
// ---------------------------------------------------------------------------------------

function headroomDb(over = {}) {
  return database({
    purchaseOrders: [po("po1", { po_amount: 100 })],
    worksheets: [approved("w1")],
    timesheets: [unlinkedEntry("t1", 10, 10)], // calculated invoice = 100
    invoices: [{ id: "i1", purchase_order_id: "po1", status: "sent", total_amount: 80 }],
    ...over
  });
}

test("Lane4 B1a headroom: an existing 80 invoice leaves 20 against a 100 PO and blocks a 100 invoice", () => {
  withFlags({}, () => {
    const { gate, summary, report } = evaluate(headroomDb());
    assert.equal(gate?.code, "INVOICE_EXCEEDS_PO_REMAINING");
    assert.equal(summary.commercial.previously_invoiced_amount, 80);
    assert.equal(summary.commercial.remaining_po_amount, 20);
    assert.deepEqual(report, []);
  });
});

test("Lane4 B1a headroom (CURRENT): issued and prepared credit notes do not restore PO headroom", () => {
  withFlags({}, () => {
    const without = evaluate(headroomDb());
    const withCredits = evaluate(headroomDb({
      creditNotes: [
        { id: "c1", invoice_id: "i1", amount: 80, status: "issued", issued_at: "2026-11-01T08:00:00.000Z" },
        { id: "c2", invoice_id: "i1", amount: 10, status: "prepared" }
      ]
    }));
    assert.equal(withCredits.gate?.code, "INVOICE_EXCEEDS_PO_REMAINING");
    assert.equal(withCredits.summary.commercial.previously_invoiced_amount, 80);
    assert.equal(withCredits.summary.commercial.remaining_po_amount, 20);
    assert.deepEqual(withCredits.gate, without.gate, "credit notes leave the gate result unchanged");
    assert.deepEqual(withCredits.summary, without.summary, "credit notes leave the summary unchanged");
    assert.deepEqual(withCredits.report, []);
  });
});

test("Lane4 B1a headroom: only a voided invoice releases PO headroom", () => {
  withFlags({}, () => {
    const db = headroomDb();
    db.invoices[0].status = "voided";
    const { gate, summary } = evaluate(db);
    assert.equal(gate, null);
    assert.equal(summary.commercial.previously_invoiced_amount, 0);
    assert.equal(summary.commercial.remaining_po_amount, 100);
  });
});

// ---------------------------------------------------------------------------------------
// 5. Billable hours never exceed approved worksheet hours (invoiceReadiness.js:6-42)
//    Holds for entries LINKED to a worksheet; unlinked entries are not capped (characterized below).
// ---------------------------------------------------------------------------------------

function linkedHoursByWorksheet(db) {
  const totals = new Map();
  for (const entry of db.timesheets) {
    if (!entry.source_worksheet_id) continue;
    totals.set(entry.source_worksheet_id, (totals.get(entry.source_worksheet_id) || 0) + Number(entry.hours_logged));
  }
  return totals;
}

function linkedFixture(entriesHours, worksheetHours = 8) {
  return database({
    worksheets: [approved("w1", { technician_id: "tech1", hours: worksheetHours })],
    timesheets: entriesHours.map((hours, index) => linkedEntry(`t${index + 1}`, "w1", "tech1", hours))
  });
}

test("Lane4 B1a hours: linked entries within, and exactly at, the approved worksheet hours are accepted", () => {
  withFlags({}, () => {
    for (const hours of [[3, 5], [8], [2.5, 2.5]]) {
      const db = linkedFixture(hours);
      const { gate, summary, report } = evaluate(db);
      assert.equal(gate, null, JSON.stringify(hours));
      assert.equal(summary.evidence.billable_time.hours, hours.reduce((a, b) => a + b, 0));
      assert.deepEqual(report.map((row) => row.id), ["d1"]);
    }
  });
});

test("Lane4 B1a hours: linked entries above the approved worksheet hours are blocked", () => {
  withFlags({}, () => {
    const db = linkedFixture([3, 6]);
    const { gate, summary, report } = evaluate(db);
    assert.equal(gate?.code, "INVOICE_TIMESHEET_HOURS_EXCEEDED");
    assert.equal(summary.readiness.ready_for_invoice_review, false);
    assert.deepEqual(report, []);
  });
});

test("Lane4 B1a hours: the cap is applied per worksheet, not across the dispatch", () => {
  withFlags({}, () => {
    const db = database({
      worksheets: [
        approved("w1", { technician_id: "tech1", hours: 8 }),
        approved("w2", { technician_id: "tech2", hours: 2 })
      ],
      timesheets: [linkedEntry("t1", "w1", "tech1", 8), linkedEntry("t2", "w2", "tech2", 3)]
    });
    assert.equal(evaluate(db).gate?.code, "INVOICE_TIMESHEET_HOURS_EXCEEDED", "w2 is over its own 2 hours although the dispatch total is under 10");
  });
});

test("Lane4 B1a hours: a linked entry against a worksheet with no finite hours is blocked", () => {
  withFlags({}, () => {
    const db = database({
      worksheets: [approved("w1", { technician_id: "tech1" })],
      timesheets: [linkedEntry("t1", "w1", "tech1", 1)]
    });
    assert.equal(evaluate(db).gate?.code, "INVOICE_TIMESHEET_HOURS_EXCEEDED");
  });
});

test("Lane4 B1a hours (CURRENT LIMIT): unlinked billable entries are not capped by worksheet hours", () => {
  withFlags({}, () => {
    const db = database({
      worksheets: [approved("w1", { hours: 8 })],
      timesheets: [unlinkedEntry("t1", 100, 1)]
    });
    const { gate, summary } = evaluate(db);
    assert.equal(gate, null, "no source_worksheet_id: the entry is counted but never compared with a worksheet");
    assert.equal(summary.evidence.billable_time.hours, 100);
    assert.ok(summary.evidence.billable_time.hours > 8, "billable hours exceed the approved worksheet hours without a block");
  });
});

test("Lane4 B1a hours invariant: whenever the gate passes, linked billable hours never exceed approved worksheet hours", () => {
  withFlags({}, () => {
    const scenarios = [[3, 5], [8], [3, 6], [9], [0], [2.5, 2.5], [4, 4, 0.01]];
    for (const hours of scenarios) {
      const db = linkedFixture(hours);
      const { gate } = evaluate(db);
      if (gate !== null) continue;
      for (const [worksheetId, linked] of linkedHoursByWorksheet(db)) {
        const worksheet = db.field_worksheets.find((item) => item.id === worksheetId);
        assert.ok(linked <= Number(worksheet.hours), `${JSON.stringify(hours)}: ${linked} > ${worksheet.hours}`);
      }
    }
  });
});
