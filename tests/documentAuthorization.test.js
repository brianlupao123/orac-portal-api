import assert from "node:assert/strict";
import test from "node:test";
import * as docs from "../src/controllers/documentController.js";

function res() {
  return {
    statusCode: 200, sent: 0, contentType: null, body: undefined,
    open() { if (this.sent > 0) throw new Error("ERR_HTTP_HEADERS_SENT: second response attempted"); },
    status(code) { this.statusCode = code; return this; },
    type(value) { this.open(); this.contentType = value; return this; },
    json(body) { this.open(); this.sent += 1; this.body = body; return this; },
    send(body) { this.open(); this.sent += 1; this.body = body; return this; }
  };
}

const ALL_ROLES = ["Admin", "Management", "Sales", "Finance", "Operations", "Supervisor", "Technician", "Client Viewer"];

function fixture() {
  const users = [
    { id: "admin", role: "Admin", is_active: true },
    { id: "management", role: "Management", is_active: true },
    { id: "sales", role: "Sales", is_active: true },
    { id: "finance", role: "Finance", is_active: true },
    { id: "operations", role: "Operations", is_active: true },
    { id: "supervisor", role: "Supervisor", is_active: true },
    { id: "supervisor2", role: "Supervisor", is_active: true },
    { id: "technician", role: "Technician", is_active: true },
    { id: "technician2", role: "Technician", is_active: true },
    { id: "client", role: "Client Viewer", is_active: true, client_id: "c1" },
    { id: "client2", role: "Client Viewer", is_active: true, client_id: "c2" },
    { id: "client_noid", role: "Client Viewer", is_active: true },
    { id: "inactive_admin", role: "Admin", is_active: false }
  ];
  return {
    users,
    clients: [{ id: "c1", name: "Client One" }, { id: "c2", name: "Client Two" }],
    mine_sites: [{ id: "ms1", name: "Site <img src=x onerror=alert(1)>" }],
    plants: [{ id: "pl1", mine_site_id: "ms1", name: "Plant" }],
    plant_sections: [{ id: "ps1", plant_id: "pl1", name: "Section" }],
    equipment_tags: [{ id: "eq1", plant_section_id: "ps1", tag_code: "EQ-1" }],
    quotes: [{ id: "q1", client_id: "c1", equipment_tag_id: "eq1", quote_number: "Q-1", status: "Sent", total_amount: 10 }],
    quote_lines: [{ id: "l1", quotation_id: "q1", description: "Line", quantity: 1, unit_price: 10 }],
    purchase_orders: [{ id: "po1", quotation_id: "q1", po_reference: "PO-1", status: "verified", requires_amendment: false, po_amount: 10 }],
    dispatch_cards: [{ id: "d1", quotation_id: "q1", equipment_tag_id: "eq1", dispatch_reference: "DC-1", status: "Open", assigned_technician_id: "technician", assigned_supervisor_id: "supervisor" }],
    field_worksheets: [
      { id: "w1", dispatch_card_id: "d1", technician_id: "technician", status: "Supervisor_Approved", activity: "Replaced liner", hours: 6.5, work_date: "2026-09-20" },
      { id: "w2", dispatch_card_id: "d1", technician_id: "technician", status: "Draft", activity: "Draft work", hours: 1 },
      { id: "w3", dispatch_card_id: "d1", technician_id: "technician", status: "Supervisor_Approved", worksheet_reference: "WS-LEGACY", activity_description: "Legacy text", hours_logged: 3, date_logged: "2026-09-19" }
    ],
    invoices: [
      { id: "i1", purchase_order_id: "po1", dispatch_card_id: "d1", invoice_number: "INV-1", status: "sent", total_amount: 10 },
      { id: "i2", purchase_order_id: "po1", dispatch_card_id: "d1", invoice_number: "INV-2", status: "voided", void_reason: "internal secret reason", voided_at: "2026-09-21T00:00:00Z", total_amount: 10 }
    ],
    invoice_lines: [{ id: "il1", invoice_id: "i1", description: "Line", quantity: 1, unit_price: 10 }, { id: "il2", invoice_id: "i2", description: "Line", quantity: 1, unit_price: 10 }],
    company_profile: {}
  };
}

const request = (db, userId, id) => ({ db, user: { id: userId }, params: { id } });
const run = (handler, db, userId, id) => { const r = res(); handler(request(db, userId, id), r); return r; };

// role -> actor id that satisfies that role's record scope in the fixture
const actorFor = { Admin: "admin", Management: "management", Sales: "sales", Finance: "finance", Operations: "operations", Supervisor: "supervisor", Technician: "technician", "Client Viewer": "client" };

// Contract matrix (see ORAC_OPERATIONAL_DOCUMENTS_CONTRACT.md section 3).
const matrix = [
  { name: "quote", id: "q1", data: "getQuoteDocument", pdf: "getQuotePdf", allow: ["Admin", "Management", "Sales", "Finance", "Operations", "Client Viewer"] },
  { name: "job card", id: "d1", data: "getDispatchDocument", pdf: "getJobCardPdf", allow: ["Admin", "Management", "Operations", "Supervisor", "Finance", "Technician"] },
  { name: "worksheet", id: "w1", data: "getWorksheetDocument", pdf: "getWorksheetPdf", allow: ["Admin", "Management", "Operations", "Supervisor", "Technician", "Client Viewer"] },
  { name: "invoice", id: "i1", data: "getInvoiceDocument", pdf: "getInvoicePdf", allow: ["Admin", "Management", "Finance", "Client Viewer"] },
  { name: "purchase order", id: "po1", data: "getPoDocument", pdf: "getPoDocumentPdf", allow: ["Admin", "Management", "Finance", "Operations", "Client Viewer"] }
];

for (const doc of matrix) {
  for (const kind of ["data", "pdf"]) {
    test(`${doc.name} ${kind}: eight-role matrix, exactly one response per request`, () => {
      for (const role of ALL_ROLES) {
        const r = run(docs[doc[kind]], fixture(), actorFor[role], doc.id);
        const allowed = doc.allow.includes(role);
        assert.equal(r.statusCode, allowed ? 200 : 403, `${role} on ${doc.name} ${kind}`);
        assert.equal(r.sent, 1, `${role} must receive exactly one response`);
        if (!allowed) {
          assert.equal(r.body.success, false);
          assert.equal(typeof r.body.message, "string");
        }
      }
    });

    test(`${doc.name} ${kind}: disallowed roles get 403 even for a missing ID (no existence oracle)`, () => {
      for (const role of ALL_ROLES.filter((item) => !doc.allow.includes(item))) {
        const r = run(docs[doc[kind]], fixture(), actorFor[role], "does-not-exist");
        assert.equal(r.statusCode, 403, role);
      }
    });

    test(`${doc.name} ${kind}: allowed role gets JSON 404 for a missing ID without record data`, () => {
      const r = run(docs[doc[kind]], fixture(), "admin", "does-not-exist");
      assert.equal(r.statusCode, 404);
      assert.equal(r.body.success, false);
      assert.deepEqual(Object.keys(r.body).sort(), ["message", "success"]);
    });

    test(`${doc.name} ${kind}: inactive, unknown and unauthenticated actors are denied`, () => {
      assert.equal(run(docs[doc[kind]], fixture(), "inactive_admin", doc.id).statusCode, 403);
      assert.equal(run(docs[doc[kind]], fixture(), "no-such-user", doc.id).statusCode, 403);
      const r = res();
      docs[doc[kind]]({ db: fixture(), params: { id: doc.id } }, r);
      assert.equal(r.statusCode, 403);
    });
  }
}

test("Client Viewer cannot read another client's quote, PO, invoice or worksheet; Client Viewer without client_id reads nothing", () => {
  for (const handlerName of ["getQuoteDocument", "getQuotePdf", "getPoDocument", "getPoDocumentPdf", "getInvoiceDocument", "getInvoicePdf", "getWorksheetDocument", "getWorksheetPdf"]) {
    const id = { getQuoteDocument: "q1", getQuotePdf: "q1", getPoDocument: "po1", getPoDocumentPdf: "po1", getInvoiceDocument: "i1", getInvoicePdf: "i1", getWorksheetDocument: "w1", getWorksheetPdf: "w1" }[handlerName];
    for (const other of ["client2", "client_noid"]) {
      const r = run(docs[handlerName], fixture(), other, id);
      assert.equal(r.statusCode, 403, `${other} ${handlerName}`);
      assert.equal(r.sent, 1);
      assert.equal(JSON.stringify(r.body).includes("Client One"), false, "no data from another client in the denial body");
    }
  }
});

test("Technician and Supervisor documents stay scoped to assigned work", () => {
  for (const [handlerName, id] of [["getDispatchDocument", "d1"], ["getJobCardPdf", "d1"], ["getWorksheetDocument", "w1"], ["getWorksheetPdf", "w1"]]) {
    assert.equal(run(docs[handlerName], fixture(), "technician2", id).statusCode, 403, `technician2 ${handlerName}`);
    const supervisor = run(docs[handlerName], fixture(), "supervisor2", id);
    assert.equal(supervisor.statusCode, 403, `supervisor2 ${handlerName}`);
    assert.equal(supervisor.sent, 1);
  }
});

test("worksheet documents: Client Viewer only after supervisor approval; internal roles unaffected", () => {
  for (const handlerName of ["getWorksheetDocument", "getWorksheetPdf"]) {
    const client = run(docs[handlerName], fixture(), "client", "w2");
    assert.equal(client.statusCode, 409, handlerName);
    assert.equal(client.body.success, false);
    assert.equal(run(docs[handlerName], fixture(), "admin", "w2").statusCode, 200);
    assert.equal(run(docs[handlerName], fixture(), "technician", "w2").statusCode, 200);
  }
});

test("invoice documents stay blocked without verified PO, with PO amendment, or without approved worksheet (JSON errors)", () => {
  for (const handlerName of ["getInvoiceDocument", "getInvoicePdf"]) {
    let db = fixture(); db.purchase_orders[0].status = "pending";
    let r = run(docs[handlerName], db, "finance", "i1");
    assert.equal(r.statusCode, 409); assert.match(r.body.message, /verified PO/);

    db = fixture(); db.purchase_orders[0].po_reference = "  ";
    assert.equal(run(docs[handlerName], db, "finance", "i1").statusCode, 409);

    db = fixture(); db.purchase_orders[0].requires_amendment = true;
    r = run(docs[handlerName], db, "finance", "i1");
    assert.equal(r.statusCode, 409); assert.match(r.body.message, /amendment/);

    db = fixture(); db.field_worksheets.forEach((w) => { w.status = "Submitted"; });
    r = run(docs[handlerName], db, "finance", "i1");
    assert.equal(r.statusCode, 409); assert.match(r.body.message, /supervisor-approved timesheet/);
    assert.equal(r.body.success, false);
  }
});

test("invoice PDF states VOIDED truthfully and never exposes the internal void reason", () => {
  const voided = run(docs.getInvoicePdf, fixture(), "client", "i2");
  assert.equal(voided.statusCode, 200);
  assert.equal(Buffer.isBuffer(voided.body), true);
  assert.match(voided.body.toString("latin1"), /VOIDED/);
  assert.equal(voided.body.toString("latin1").includes("internal secret reason"), false);
  const live = run(docs.getInvoicePdf, fixture(), "client", "i1");
  assert.equal(/VOIDED/.test(live.body.toString("latin1")), false);
});

test("PDF output contains text rather than executable HTML (stored XSS regression)", () => {
  for (const handlerName of ["getQuotePdf", "getJobCardPdf"]) {
    const r = run(docs[handlerName], fixture(), "admin", handlerName === "getQuotePdf" ? "q1" : "d1");
    assert.equal(r.statusCode, 200);
    const body = r.body.toString("latin1");
    // The controlled-document renderer now sanitizes free-text fields by
    // stripping any embedded markup outright (sanitizeForPdfText in
    // pdfGenerator.js), rather than HTML-escaping it into visible "&lt;"/
    // "&gt;" text as the previous plain-text renderer did. That escaped-
    // entity display was itself an instance of the same literal-artifact
    // defect this packet fixes elsewhere (the raw "&rarr;" separator in the
    // reported quotation PDF), so the stripped-clean result below is the
    // intended behaviour, not a regression. The security guarantee - no
    // raw or escaped markup reaches the PDF body - is unchanged and is
    // asserted in full below.
    assert.equal(body.includes("<img src=x"), false, `${handlerName} body: raw markup must not appear`);
    assert.equal(body.includes("&lt;"), false, `${handlerName} body: markup must be stripped, not HTML-escaped into visible text`);
    assert.equal(body.includes("&gt;"), false, `${handlerName} body: markup must be stripped, not HTML-escaped into visible text`);
    assert.match(body, /Site > Plant > Section/, `${handlerName} body: sanitized hierarchy text should still read cleanly`);
  }
});

test("worksheet PDF prints the fields the worksheet actually stores (current and legacy names)", () => {
  const current = run(docs.getWorksheetPdf, fixture(), "admin", "w1").body.toString("latin1");
  assert.match(current, /Replaced liner/); assert.match(current, /6\.5/); assert.match(current, /2026-09-20/); assert.match(current, /w1/);
  const legacy = run(docs.getWorksheetPdf, fixture(), "admin", "w3").body.toString("latin1");
  assert.match(legacy, /Legacy text/); assert.match(legacy, /WS-LEGACY/); assert.match(legacy, /2026-09-19/);
});

test("job card PDF falls back to dispatch_number then id when dispatch_reference is absent", () => {
  const db = fixture(); delete db.dispatch_cards[0].dispatch_reference; db.dispatch_cards[0].dispatch_number = "DN-9";
  assert.match(run(docs.getJobCardPdf, db, "admin", "d1").body.toString("latin1"), /DN-9/);
});

test("PDF handlers send a real PDF body exactly once with a PDF content type", () => {
  const r = run(docs.getQuotePdf, fixture(), "sales", "q1");
  assert.equal(r.contentType, "application/pdf");
  assert.equal(r.body.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.equal(r.sent, 1);
});
