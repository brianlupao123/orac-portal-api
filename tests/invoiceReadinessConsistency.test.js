import assert from "node:assert/strict";
import test from "node:test";
import { computeInvoiceReadyReport } from "../src/reports.js";
import { invoiceReadinessBlock } from "../src/invoiceReadiness.js";

function database({ worksheets = [], timesheets = [], purchaseOrder = {}, invoices = [], v5 = false } = {}) {
  return {
    quotes: [{ id: "q1", status: "Field_Dispatch", total_amount: 100, ...(v5 ? { v5_commercial_workflow: true } : {}) }],
    dispatch_cards: [{ id: "d1", quotation_id: "q1", dispatch_number: "JOB-1" }],
    purchase_orders: [{ id: "po1", quotation_id: "q1", status: "verified", po_reference: "PO-1", po_amount: 10000, requires_amendment: false, ...purchaseOrder }],
    field_worksheets: worksheets,
    timesheets,
    invoices
  };
}

test("invoice-ready report excludes work blocked by pending kiosk review", () => {
  const db = database({
    worksheets: [{ id: "w1", dispatch_card_id: "d1", status: "Supervisor_Approved" }],
    timesheets: [{ id: "t1", dispatch_card_id: "d1", entry_source: "kiosk" }]
  });

  assert.deepEqual(computeInvoiceReadyReport(db), []);
});

test("invoice-ready report excludes work blocked by the enabled variance gate", () => {
  const previous = process.env.TIMESHEET_INVOICE_VARIANCE;
  process.env.TIMESHEET_INVOICE_VARIANCE = "enabled";
  try {
    const db = database({
      worksheets: [{ id: "w1", dispatch_card_id: "d1", status: "Supervisor_Approved", hours: 1 }],
      timesheets: [{ id: "t1", dispatch_card_id: "d1", hours_logged: 2, hourly_rate: 100, source_worksheet_id: "w1" }]
    });

    assert.deepEqual(computeInvoiceReadyReport(db), []);
  } finally {
    if (previous === undefined) delete process.env.TIMESHEET_INVOICE_VARIANCE;
    else process.env.TIMESHEET_INVOICE_VARIANCE = previous;
  }
});

test("invoice-ready report retains eligible dispatches and excludes every invoiced dispatch", () => {
  const db = database({
    worksheets: [{ id: "w1", dispatch_card_id: "d1", status: "Supervisor_Approved" }]
  });

  assert.deepEqual(computeInvoiceReadyReport(db), [
    { id: "d1", dispatch_number: "JOB-1", quotation_id: "q1" }
  ]);
  db.invoices.push({ id: "i1", dispatch_card_id: "d1", status: "voided" });
  assert.deepEqual(computeInvoiceReadyReport(db), []);
});

test("invoice-ready report excludes dispatches whose quote is not in Field_Dispatch", () => {
  const db = database({
    worksheets: [{ id: "w1", dispatch_card_id: "d1", status: "Supervisor_Approved" }]
  });
  db.quotes[0].status = "Invoiced";

  assert.deepEqual(computeInvoiceReadyReport(db), []);
});

test("invoice-ready report excludes V5 dispatches until V5 invoice calculation is implemented", () => {
  const db = database({
    v5: true,
    worksheets: [{ id: "w1", dispatch_card_id: "d1", status: "Supervisor_Approved", hours: 8 }],
    timesheets: [{ id: "t1", dispatch_card_id: "d1", hours_logged: 8, hourly_rate: 999 }]
  });

  assert.deepEqual(computeInvoiceReadyReport(db), []);
});

test("invoice readiness validates any claimed billable source record and its approved-hour cap", () => {
  const cases = [
    {
      name: "source is missing",
      worksheet: { id: "w1", dispatch_card_id: "d1", technician_id: "tech1", status: "Supervisor_Approved", hours: 8 },
      entry: { id: "t1", dispatch_card_id: "d1", user_id: "tech1", source_worksheet_id: "missing", hours_logged: 2, hourly_rate: 100 },
      code: "INVOICE_TIMESHEET_EVIDENCE_MISMATCH"
    },
    {
      name: "source belongs to a different worker",
      worksheet: { id: "w1", dispatch_card_id: "d1", technician_id: "tech2", status: "Supervisor_Approved", hours: 8 },
      entry: { id: "t1", dispatch_card_id: "d1", user_id: "tech1", source_worksheet_id: "w1", hours_logged: 2, hourly_rate: 100 },
      code: "INVOICE_TIMESHEET_EVIDENCE_MISMATCH"
    },
    {
      name: "source is not approved",
      worksheet: { id: "w1", dispatch_card_id: "d1", technician_id: "tech1", status: "Draft", hours: 8 },
      entry: { id: "t1", dispatch_card_id: "d1", user_id: "tech1", source_worksheet_id: "w1", hours_logged: 2, hourly_rate: 100 },
      code: "INVOICE_TIMESHEET_EVIDENCE_MISMATCH"
    },
    {
      name: "linked billable hours exceed approved hours",
      worksheet: { id: "w1", dispatch_card_id: "d1", technician_id: "tech1", status: "Supervisor_Approved", hours: 3 },
      entry: { id: "t1", dispatch_card_id: "d1", user_id: "tech1", source_worksheet_id: "w1", hours_logged: 4, hourly_rate: 100 },
      code: "INVOICE_TIMESHEET_HOURS_EXCEEDED"
    },
    {
      name: "stored rate is malformed",
      worksheet: { id: "w1", dispatch_card_id: "d1", status: "Supervisor_Approved" },
      entry: { id: "t1", dispatch_card_id: "d1", hours_logged: 2, hourly_rate: Number.NaN },
      code: "INVALID_INVOICE_TIMESHEET_VALUE"
    }
  ];

  for (const scenario of cases) {
    const db = database({
      worksheets: [
        scenario.worksheet,
        ...(scenario.worksheet.status === "Supervisor_Approved" ? [] : [{ id: "w-approved", dispatch_card_id: "d1", status: "Supervisor_Approved" }])
      ],
      timesheets: [scenario.entry]
    });
    assert.equal(invoiceReadinessBlock(db, db.dispatch_cards[0])?.code, scenario.code, scenario.name);
    assert.deepEqual(computeInvoiceReadyReport(db), [], `${scenario.name} must not appear invoice-ready`);
  }
});

test("invoice readiness accepts a linked entry within the approved source hours", () => {
  const db = database({
    worksheets: [{ id: "w1", dispatch_card_id: "d1", technician_id: "tech1", status: "Supervisor_Approved", hours: 8 }],
    timesheets: [{ id: "t1", dispatch_card_id: "d1", user_id: "tech1", source_worksheet_id: "w1", hours_logged: 8, hourly_rate: 100 }]
  });

  assert.equal(invoiceReadinessBlock(db, db.dispatch_cards[0]), null);
  assert.equal(computeInvoiceReadyReport(db).length, 1);
});

test("invoice readiness hard-caps the calculated amount at remaining verified PO value", () => {
  const db = database({
    purchaseOrder: { po_amount: 100 },
    worksheets: [{ id: "w1", dispatch_card_id: "d1", status: "Supervisor_Approved" }],
    timesheets: [{ id: "t1", dispatch_card_id: "d1", hours_logged: 10, hourly_rate: 10 }],
    invoices: [{ id: "i1", purchase_order_id: "po1", status: "sent", total_amount: 50 }]
  });

  assert.equal(invoiceReadinessBlock(db, db.dispatch_cards[0])?.code, "INVOICE_EXCEEDS_PO_REMAINING");
  assert.deepEqual(computeInvoiceReadyReport(db), []);

  db.invoices[0].status = "voided";
  assert.equal(invoiceReadinessBlock(db, db.dispatch_cards[0]), null, "voided invoices do not consume PO authorization");
});

test("invoice readiness rejects invalid PO values and invalid material amounts", () => {
  const db = database({
    purchaseOrder: { po_amount: Number.NaN },
    worksheets: [{ id: "w1", dispatch_card_id: "d1", status: "Supervisor_Approved" }]
  });
  assert.equal(invoiceReadinessBlock(db, db.dispatch_cards[0])?.code, "VERIFIED_PO_AMOUNT_INVALID");

  db.purchase_orders[0].po_amount = 100;
  db.material_usage = [{ id: "m1", dispatch_card_id: "d1", total_cost: Number.NaN }];
  assert.equal(invoiceReadinessBlock(db, db.dispatch_cards[0])?.code, "INVALID_INVOICE_MATERIAL_VALUE");
});
