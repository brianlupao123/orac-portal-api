// backend/tests/exportCharacterization.test.js
//
// ORAC Lane 9 - Batch 1: CHARACTERIZATION ONLY.
//
// These tests pin what src/exporter.js (exportInvoicesCsv) does TODAY, at backend
// baseline 73fb29d. They do not assert that the behaviour is correct. Several cases
// are labelled "CURRENT BEHAVIOUR (suspected defect)": they record a behaviour that
// Lane 4 may decide to change after accountant approval. When Lane 4 changes the
// exporter on purpose, the matching case here must be updated in the same change, so
// the change shows up as a reviewed edit to a test rather than an accident.
//
// Scope: no Pastel layout, value, posting, VAT or currency change is proposed here.
// All data below is fictional.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { exportInvoicesCsv } from "../src/exporter.js";

const TZ = { timezone: "Africa/Harare" };

const HEADERS = [
  "transaction_type",
  "transaction_id",
  "date",
  "client_id",
  "client_name",
  "po_reference",
  "asset_tag_id",
  "cost_center",
  "gl_account_code",
  "description",
  "labor_hours",
  "material_cost",
  "total_invoiced_amount"
];

// ---------- helpers ----------

// Minimal CSV reader: commas and "\n" separate cells and records, double quotes wrap
// a cell and "" is an escaped quote. A quoted cell may contain commas, \r and \n.
function parseCsv(text) {
  const records = [];
  let record = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else { quoted = false; }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      record.push(cell); cell = "";
    } else if (ch === "\n") {
      record.push(cell); records.push(record); record = []; cell = "";
    } else {
      cell += ch;
    }
  }
  record.push(cell);
  records.push(record);
  return records;
}

function exportRows(db, options = TZ) {
  const csv = exportInvoicesCsv(db, options);
  const [headerRow, ...body] = parseCsv(csv);
  const rows = body.map((cells) => Object.fromEntries(headerRow.map((name, index) => [name, cells[index]])));
  return { csv, headerRow, rows };
}

function makeDb() {
  return {
    clients: [{ id: "c1", name: "Fictional Test Client" }],
    quotes: [{ id: "q1", client_id: "c1" }],
    purchase_orders: [{ id: "po1", quotation_id: "q1", po_reference: "PO-TEST-001" }],
    dispatch_cards: [{ id: "d1", quotation_id: "q1", equipment_tag_id: "eq1" }],
    equipment_tags: [{ id: "eq1", tag_code: "TAG-01" }],
    // Same shape the existing pastelReviewExports fixture uses: one 8-hour counted row.
    timesheets: [{ id: "ts1", dispatch_card_id: "d1", user_id: "u1", hours_logged: 8, source_worksheet_id: "w1" }],
    // Actual material COST for the job is 60. Invoice lines below bill different amounts
    // so the cost-versus-billed difference between branches is visible.
    material_usage: [{ id: "mu1", dispatch_card_id: "d1", total_cost: 60 }],
    invoices: [],
    invoice_lines: [],
    invoice_credit_notes: []
  };
}

function addInvoice(db, { id = "inv1", number = "INV-T-001", total = 500, lines = [], ...rest } = {}) {
  const invoice = {
    id,
    invoice_number: number,
    purchase_order_id: "po1",
    dispatch_card_id: "d1",
    status: "issued",
    total_amount: total,
    generated_at: "2026-10-15T10:00:00.000Z",
    ...rest
  };
  db.invoices.push(invoice);
  lines.forEach((line, index) => db.invoice_lines.push({ id: `${id}-l${index + 1}`, invoice_id: id, ...line }));
  return invoice;
}

function addCreditNote(db, fields) {
  db.invoice_credit_notes.push({
    id: `cn${db.invoice_credit_notes.length + 1}`,
    invoice_id: "inv1",
    status: "issued",
    amount: 50,
    reason: "Rate adjustment",
    issued_at: "2026-10-20T10:00:00.000Z",
    ...fields
  });
}

const rowsFor = (rows, number) => rows.filter((row) => row.transaction_id === number);

// ---------- header shape ----------

test("header row is exactly 13 columns in this order, with no invoice-link or marker column", () => {
  const { headerRow } = exportRows(makeDb());
  assert.deepEqual(headerRow, HEADERS);
  assert.equal(headerRow.length, 13);
  assert.equal(headerRow.includes("currency"), false);
  assert.equal(headerRow.some((name) => /review|posted|designation|related|parent/i.test(name)), false);
});

test("an empty database produces the header line only: no trailing newline, no BOM", () => {
  const csv = exportInvoicesCsv({}, TZ);
  assert.equal(csv, HEADERS.join(","));
  assert.equal(csv.charCodeAt(0) === 0xfeff, false);
});

test("output is deterministic: two exports of the same data are byte-identical", () => {
  const db = makeDb();
  addInvoice(db, { lines: [{ description: "Labour", quantity: 8, line_total: 400 }, { description: "Materials", line_total: 100 }] });
  const a = exportInvoicesCsv(db, TZ);
  const b = exportInvoicesCsv(db, TZ);
  assert.equal(crypto.createHash("sha256").update(a).digest("hex"), crypto.createHash("sha256").update(b).digest("hex"));
});

// ---------- invoice rows: zero, single, multi line ----------

test("zero-line invoice: one row, labour hours and ACTUAL material cost from the job, header total", () => {
  const db = makeDb();
  addInvoice(db, { total: 500 });
  const { rows } = exportRows(db);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    transaction_type: "invoice",
    transaction_id: "INV-T-001",
    date: "2026-10-15",
    client_id: "c1",
    client_name: "Fictional Test Client",
    po_reference: "PO-TEST-001",
    asset_tag_id: "TAG-01",
    cost_center: "",
    gl_account_code: "",
    description: "Field service invoice",
    labor_hours: "8",
    material_cost: "60",
    total_invoiced_amount: "500"
  });
});

test("single-line invoice: line amount wins over header total; hours and material cost come from the job, not the line", () => {
  const db = makeDb();
  addInvoice(db, {
    total: 500,
    lines: [{ description: "Pump overhaul labour", quantity: 99, line_total: 450, cost_center: "FIELD", gl_account_code: "SALES-SERVICE" }]
  });
  const { rows } = exportRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cost_center, "FIELD");
  assert.equal(rows[0].gl_account_code, "SALES-SERVICE");
  assert.equal(rows[0].description, "Pump overhaul labour");
  assert.equal(rows[0].labor_hours, "8", "line quantity 99 is ignored in the single-line branch");
  assert.equal(rows[0].material_cost, "60", "single-line branch: material_cost is actual job COST");
  assert.equal(rows[0].total_invoiced_amount, "450", "line_total 450 is used, not header total 500");
});

test("multi-line invoice: labour line takes its quantity, material line takes its BILLED line_total", () => {
  const db = makeDb();
  addInvoice(db, {
    total: 500,
    lines: [
      { description: "Site labour", quantity: 8, line_total: 400, gl_account_code: "SALES-SERVICE" },
      { description: "Materials used", quantity: 1, line_total: 100, gl_account_code: "SALES-MATERIALS" }
    ]
  });
  const { rows } = exportRows(db);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.labor_hours, r.material_cost, r.total_invoiced_amount]), [["8", "0", "400"], ["0", "100", "100"]]);
});

// ---------- material-cost semantics per branch ----------

test("CURRENT BEHAVIOUR (suspected defect): material_cost means actual cost in zero/single-line rows but billed amount in multi-line rows", () => {
  const zero = makeDb();
  addInvoice(zero, { total: 500 });

  const single = makeDb();
  addInvoice(single, { lines: [{ description: "Materials used", line_total: 100, gl_account_code: "SALES-MATERIALS" }] });

  const multi = makeDb();
  addInvoice(multi, {
    lines: [
      { description: "Site labour", quantity: 8, line_total: 400, gl_account_code: "SALES-SERVICE" },
      { description: "Materials used", line_total: 100, gl_account_code: "SALES-MATERIALS" }
    ]
  });

  assert.equal(exportRows(zero).rows[0].material_cost, "60", "actual cost (60)");
  assert.equal(exportRows(single).rows[0].material_cost, "60", "actual cost (60), even though the line billed 100");
  assert.equal(exportRows(multi).rows[1].material_cost, "100", "billed line_total (100), not actual cost (60)");
});

test("CURRENT BEHAVIOUR: a multi-line material line with a zero or missing line_total falls back to the job's actual cost", () => {
  const db = makeDb();
  addInvoice(db, {
    lines: [
      { description: "Site labour", quantity: 8, line_total: 400, gl_account_code: "SALES-SERVICE" },
      { description: "Materials used", line_total: 0, gl_account_code: "SALES-MATERIALS" },
      { description: "Materials extra", amount: 25, gl_account_code: "SALES-MATERIALS" }
    ]
  });
  const { rows } = exportRows(db);
  assert.equal(rows[1].material_cost, "60", "line_total 0 is falsy, so actual cost 60 is used");
  assert.equal(rows[1].total_invoiced_amount, "0");
  assert.equal(rows[2].material_cost, "60", "missing line_total is falsy, so actual cost 60 is used");
  assert.equal(rows[2].total_invoiced_amount, "25", "amount is the fallback for the line total");
});

// ---------- labour hours ----------

test("CURRENT BEHAVIOUR (suspected defect): two labour lines with empty quantity each carry the FULL job hours, so the column sums to double", () => {
  const db = makeDb();
  addInvoice(db, {
    lines: [
      { description: "Day shift labour", line_total: 200, gl_account_code: "SALES-SERVICE" },
      { description: "Night shift labour", quantity: 0, line_total: 200, gl_account_code: "SALES-SERVICE" }
    ]
  });
  const { rows } = exportRows(db);
  assert.deepEqual(rows.map((r) => r.labor_hours), ["8", "8"]);
  assert.equal(rows.reduce((sum, r) => sum + Number(r.labor_hours), 0), 16, "job has 8 counted hours; export sums to 16");
});

test("CURRENT BEHAVIOUR (suspected defect): a labour line's own quantity replaces the counted job hours", () => {
  const db = makeDb();
  addInvoice(db, {
    lines: [
      { description: "Day shift labour", quantity: 5, line_total: 250, gl_account_code: "SALES-SERVICE" },
      { description: "Night shift labour", quantity: 2, line_total: 100, gl_account_code: "SALES-SERVICE" }
    ]
  });
  const { rows } = exportRows(db);
  assert.deepEqual(rows.map((r) => r.labor_hours), ["5", "2"]);
  assert.equal(rows.reduce((sum, r) => sum + Number(r.labor_hours), 0), 7, "counted job hours are 8; export sums to 7");
});

// ---------- labour / material overlap ----------

test("CURRENT BEHAVIOUR (suspected defect): a line that matches both the labour and material tests fills both columns", () => {
  const db = makeDb();
  addInvoice(db, {
    lines: [
      { description: "Labour and materials", quantity: 3, line_total: 300, gl_account_code: "OTHER" },
      { description: "Materials supplied", quantity: 2, line_total: 80, gl_account_code: "SALES-SERVICE" },
      { description: "Consumables", quantity: 1, line_total: 20, gl_account_code: "OTHER" }
    ]
  });
  const { rows } = exportRows(db);
  assert.deepEqual(
    rows.map((r) => [r.labor_hours, r.material_cost, r.total_invoiced_amount]),
    [["3", "300", "300"], ["2", "80", "80"], ["0", "0", "20"]]
  );
  assert.equal(rows[0].labor_hours !== "0" && rows[0].material_cost !== "0", true, "description match: both columns on one row");
  assert.equal(rows[1].labor_hours !== "0" && rows[1].material_cost !== "0", true, "GL match for labour plus description match for material");
  assert.equal(rows[2].labor_hours === "0" && rows[2].material_cost === "0", true, "a line matching neither test carries neither");
});

// ---------- header total versus lines ----------

test("CURRENT BEHAVIOUR (suspected defect): line amounts are not reconciled to the invoice header total; no row or column flags a mismatch", () => {
  const db = makeDb();
  addInvoice(db, {
    total: 650,
    lines: [
      { description: "Site labour", quantity: 8, line_total: 400, gl_account_code: "SALES-SERVICE" },
      { description: "Materials used", line_total: 100, gl_account_code: "SALES-MATERIALS" }
    ]
  });
  const { rows, headerRow } = exportRows(db);
  assert.equal(headerRow.length, 13);
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((sum, r) => sum + Number(r.total_invoiced_amount), 0), 500);
  assert.equal(rows.some((r) => r.total_invoiced_amount === "650"), false, "header total 650 appears nowhere");
});

// ---------- draft / unknown status handling ----------

test("CURRENT BEHAVIOUR (suspected defect): the filter is a deny-list - only the exact lowercase status \"voided\" is excluded", () => {
  const db = makeDb();
  const statuses = ["issued", "draft", "Draft", "pending", "", "paid", "Voided", "VOIDED", "voided"];
  statuses.forEach((status, index) => addInvoice(db, { id: `s${index}`, number: `INV-S-${index}`, status }));
  addInvoice(db, { id: "s-none", number: "INV-S-NONE", status: undefined });

  const { rows } = exportRows(db);
  const exported = new Set(rows.map((r) => r.transaction_id));

  assert.equal(exported.has("INV-S-8"), false, "lowercase voided is excluded");
  for (const [index, status] of statuses.entries()) {
    if (status === "voided") continue;
    assert.equal(exported.has(`INV-S-${index}`), true, `status ${JSON.stringify(status)} is exported`);
  }
  assert.equal(exported.has("INV-S-NONE"), true, "a missing status is exported");
  assert.equal(rows.length, statuses.length, "9 statuses + 1 missing - 1 voided = 9 rows");
});

test("a voided invoice is excluded together with its credit notes", () => {
  const db = makeDb();
  addInvoice(db, { id: "inv1", number: "INV-OK", status: "issued" });
  addInvoice(db, { id: "inv2", number: "INV-VOID", status: "voided" });
  addCreditNote(db, { id: "cn-ok", invoice_id: "inv1" });
  addCreditNote(db, { id: "cn-void", invoice_id: "inv2" });
  const { rows } = exportRows(db);
  assert.deepEqual(rows.map((r) => r.transaction_id), ["INV-OK", "cn-ok"]);
});

// ---------- credit notes ----------

test("credit-note rows: negative amount, zero hours and cost, no cost centre or GL, placed straight after their invoice", () => {
  const db = makeDb();
  addInvoice(db, { id: "inv1", number: "INV-T-001" });
  addInvoice(db, { id: "inv2", number: "INV-T-002" });
  addCreditNote(db, { id: "cn-a", invoice_id: "inv1", amount: 50, reason: "Rate adjustment" });
  addCreditNote(db, { id: "cn-b", invoice_id: "inv1", amount: -30, reason: "Returned item", issued_at: undefined, prepared_at: "2026-10-22T10:00:00.000Z" });
  const { rows } = exportRows(db);

  assert.deepEqual(rows.map((r) => r.transaction_id), ["INV-T-001", "cn-a", "cn-b", "INV-T-002"]);
  const [, a, b] = rows;
  assert.equal(a.transaction_type, "credit_note");
  assert.equal(a.total_invoiced_amount, "-50", "a positive stored amount is exported negative");
  assert.equal(b.total_invoiced_amount, "-30", "a negative stored amount stays negative (-Math.abs)");
  assert.equal(b.date, "2026-10-22", "prepared_at is used when issued_at is absent");
  for (const row of [a, b]) {
    assert.equal(row.labor_hours, "0");
    assert.equal(row.material_cost, "0");
    assert.equal(row.cost_center, "");
    assert.equal(row.gl_account_code, "");
  }
  assert.equal(a.description, "Credit note: Rate adjustment");
});

test("CURRENT BEHAVIOUR (suspected defect): a credit-note row carries no invoice number or id, so it cannot be matched to its invoice from the CSV alone", () => {
  const db = makeDb();
  addInvoice(db, { id: "inv1", number: "INV-T-001" });
  addCreditNote(db, { id: "cn-a", invoice_id: "inv1" });
  const { rows, headerRow } = exportRows(db);
  const credit = rows.find((r) => r.transaction_type === "credit_note");

  assert.equal(headerRow.some((name) => /^(related|parent)|invoice_(id|number|ref)/i.test(name)), false, "no link column exists");
  assert.equal(Object.values(credit).some((value) => value.includes("INV-T-001") || value.includes("inv1")), false, "no cell names the invoice");
  assert.equal(credit.po_reference, "PO-TEST-001", "the PO reference is the only (weak) shared key");
  assert.equal(credit.transaction_id, "cn-a", "the credit note's own id is the transaction id");
});

test("CURRENT BEHAVIOUR: only credit notes with the exact lowercase status \"issued\" are exported", () => {
  const db = makeDb();
  addInvoice(db);
  ["issued", "draft", "Issued", "voided", ""].forEach((status, index) => addCreditNote(db, { id: `cn-${index}`, status }));
  const { rows } = exportRows(db);
  assert.deepEqual(rows.filter((r) => r.transaction_type === "credit_note").map((r) => r.transaction_id), ["cn-0"]);
});

// ---------- formula neutralisation ----------

test("text cells starting with = + - @ tab or CR get a leading apostrophe; other text is untouched", () => {
  const db = makeDb();
  db.clients[0].name = "=1+1";
  db.purchase_orders[0].po_reference = "+PO-9";
  db.equipment_tags[0].tag_code = "\tTAG";
  addInvoice(db, { number: "@INV-1" });
  addInvoice(db, { id: "inv2", number: "-INV-2" });
  addInvoice(db, { id: "inv3", number: "\rINV-3" });
  addInvoice(db, { id: "inv4", number: " =INV-4" });
  const { rows } = exportRows(db);

  assert.equal(rows[0].transaction_id, "'@INV-1");
  assert.equal(rows[1].transaction_id, "'-INV-2");
  assert.equal(rows[2].transaction_id, "'\rINV-3");
  assert.equal(rows[0].client_name, "'=1+1");
  assert.equal(rows[0].po_reference, "'+PO-9");
  assert.equal(rows[0].asset_tag_id, "'\tTAG");
  assert.equal(rows[3].transaction_id, " =INV-4", "a leading space is not caught by the neutraliser");
});

test("description text is neutralised and quoted when it also contains a comma or quote", () => {
  const db = makeDb();
  addInvoice(db, { lines: [{ description: "=SUM(A1,A2)", line_total: 10 }] });
  addInvoice(db, { id: "inv2", number: "INV-T-002", lines: [{ description: 'Pump "A", seal', line_total: 10 }] });
  const { csv, rows } = exportRows(db);
  assert.equal(rows[0].description, "'=SUM(A1,A2)");
  assert.equal(rows[1].description, 'Pump "A", seal');
  assert.match(csv, /"'=SUM\(A1,A2\)"/);
  assert.match(csv, /"Pump ""A"", seal"/);
});

test("numeric fields stay numeric: negative numbers are not prefixed, but a numeric STRING total is", () => {
  const numeric = makeDb();
  addInvoice(numeric, { total: -25 });
  addInvoice(numeric, { id: "inv2", number: "INV-T-002", lines: [{ description: "Adjustment", line_total: -10 }] });
  const fromNumber = exportRows(numeric).rows;
  assert.equal(fromNumber[0].total_invoiced_amount, "-25", "zero-line: numeric header total");
  assert.equal(fromNumber[1].total_invoiced_amount, "-10", "single-line: Number(line_total)");

  const asString = makeDb();
  addInvoice(asString, { total: "-25" });
  assert.equal(exportRows(asString).rows[0].total_invoiced_amount, "'-25", "zero-line total is passed through raw, so a string gets an apostrophe");

  const credit = makeDb();
  addInvoice(credit);
  addCreditNote(credit, { amount: 50 });
  assert.equal(exportRows(credit).rows[1].total_invoiced_amount, "-50", "credit-note amount is a computed number");
});

// ---------- visible REVIEW / NOT POSTED marker ----------

test("CURRENT BEHAVIOUR (suspected defect): the CSV bytes carry no REVIEW / NOT POSTED marker - the first line is the header and nothing names the file as non-posting", () => {
  const db = makeDb();
  addInvoice(db, { lines: [{ description: "Site labour", quantity: 8, line_total: 400 }, { description: "Materials", line_total: 100 }] });
  addCreditNote(db);
  const csv = exportInvoicesCsv(db, TZ);

  assert.equal(csv.split("\n")[0], HEADERS.join(","));
  assert.equal(/review|not[\s_-]*posted|non[\s_-]*posting|posted|draft|preview/i.test(csv), false);
  assert.equal(csv.includes("\r\n"), false, "records are separated by bare \\n");
  assert.equal(csv.endsWith("\n"), false, "no trailing newline");
});

// ---------- missing relations and date handling ----------

test("a missing purchase order leaves client and PO cells blank but keeps job hours and cost", () => {
  const db = makeDb();
  addInvoice(db, { purchase_order_id: "po-missing" });
  const { rows } = exportRows(db);
  assert.equal(rows[0].client_id, "");
  assert.equal(rows[0].client_name, "");
  assert.equal(rows[0].po_reference, "");
  assert.equal(rows[0].labor_hours, "8");
  assert.equal(rows[0].material_cost, "60");
});

test("dates use the business timezone: 22:30Z on 31 Dec is 1 Jan in Africa/Harare; a date-only value is unchanged", () => {
  const db = makeDb();
  addInvoice(db, { id: "inv1", number: "INV-T-001", generated_at: "2026-12-31T22:30:00.000Z" });
  addInvoice(db, { id: "inv2", number: "INV-T-002", generated_at: "2026-10-05" });
  addCreditNote(db, { id: "cn-a", invoice_id: "inv1", issued_at: "2026-12-31T22:30:00.000Z" });
  const { rows } = exportRows(db);
  assert.equal(rowsFor(rows, "INV-T-001")[0].date, "2027-01-01");
  assert.equal(rowsFor(rows, "cn-a")[0].date, "2027-01-01");
  assert.equal(rowsFor(rows, "INV-T-002")[0].date, "2026-10-05");
});
