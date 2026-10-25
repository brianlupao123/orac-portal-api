import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDb } from "../src/store.js";
import { hasPermission } from "../src/permissions.js";
import {
  CreateV5InvoiceDraftSchema,
  IssueV5InvoiceDraftSchema,
  V5AllocationRemapSchema,
  V5AmendmentSupersessionSchema,
  V5LineCompletionSchema
} from "../src/schemas.js";
import { buildV5InvoiceCandidate, nextV5InvoiceNumber, v5InvoiceDraftWorkspace } from "../src/v5InvoiceWriter.js";
import { createV5ClientSupervisorContact, recordV5PaperSignature, confirmV5Timesheet } from "../src/controllers/v5SignatureController.js";
import { createV5InvoiceDraft, getV5InvoiceDraft, issueV5InvoiceDraft, recordV5LineCompletion, supersedeV5Amendment, remapV5Allocation, getV5Invoice, getV5InvoiceBillingState, listDispatchV5Invoices } from "../src/controllers/v5InvoiceWriterController.js";
import { v5SignatureState } from "../src/v5SignatureEvidence.js";
import { call, contactBody, database, paperBody, withV5 } from "./helpers/v5SignatureFixture.js";

test("V5 invoice writer storage is normalized without creating a financial record", () => {
  const db = { users: [], audit_logs: [] };
  normalizeDb(db, { seedDemoRecords: false });
  for (const key of [
    "v5_invoice_drafts", "v5_invoices", "v5_invoice_lines", "v5_invoice_source_consumption",
    "v5_invoice_events", "v5_invoice_number_ledger",
    "v5_line_completions", "v5_amendment_supersessions", "v5_allocation_remaps",
    "v5_invoice_idempotency"
  ]) assert.deepEqual(db[key], []);
  assert.deepEqual(db.invoices, []);
});

test("V5 invoice writer permissions separate drafting, issuing and read access", () => {
  const finance = { role: "Finance", is_active: true };
  const admin = { role: "Admin", is_active: true };
  const management = { role: "Management", is_active: true };
  const sales = { role: "Sales", is_active: true };
  const supervisor = { role: "Supervisor", is_active: true };
  assert.equal(hasPermission(finance, "manageV5InvoiceDraft"), true);
  assert.equal(hasPermission(finance, "issueV5Invoice"), true);
  assert.equal(hasPermission(management, "viewV5Invoice"), true);
  assert.equal(hasPermission(management, "issueV5Invoice"), false);
  assert.equal(hasPermission(sales, "manageV5InvoiceDraft"), false);
  assert.equal(hasPermission(supervisor, "recordV5LineCompletion"), true);
  assert.equal(hasPermission(admin, "manageV5AmendmentSupersession"), true);
});

test("V5 invoice writer schemas accept evidence references only and reject financial client input", () => {
  const draft = CreateV5InvoiceDraftSchema.parse({
    idempotency_key: "v5-draft-0001",
    lines: [{ quote_line_id: "line-1", sources: [{ source_type: "field_worksheet", source_id: "sheet-1", quantity: 0.125 }]}]
  });
  assert.equal(draft.lines[0].sources[0].quantity, 0.125);
  assert.throws(() => CreateV5InvoiceDraftSchema.parse({
    idempotency_key: "v5-draft-0001", lines: [{ quote_line_id: "line-1" }], total_amount: 1
  }));
  assert.throws(() => CreateV5InvoiceDraftSchema.parse({
    idempotency_key: "v5-draft-0001", lines: [{ quote_line_id: "line-1", sources: [{ source_type: "field_worksheet", source_id: "sheet-1", quantity: 0.1234567 }]}]
  }));
  assert.deepEqual(IssueV5InvoiceDraftSchema.parse({ idempotency_key: "v5-issue-0001" }), { idempotency_key: "v5-issue-0001" });
});

test("V5 invoice support-event schemas are append-only and require a reason", () => {
  assert.equal(V5LineCompletionSchema.parse({ quote_line_id: "line-1", reason: "Work accepted", idempotency_key: "v5-complete-0001" }).quote_line_id, "line-1");
  assert.throws(() => V5AmendmentSupersessionSchema.parse({
    superseded_amendment_quote_id: "amend-1", replacement_amendment_quote_id: "amend-1", reason: "Duplicate", idempotency_key: "v5-supersede-0001"
  }));
  assert.equal(V5AllocationRemapSchema.parse({
    allocation_id: "allocation-1", replacement_amendment_quote_line_id: "line-2", reason: "Superseded scope", idempotency_key: "v5-remap-0001"
  }).allocation_id, "allocation-1");
});

function writerReadyDb() {
  const db = database();
  Object.assign(db.quotes[0], {
    currency: "USD", tax_status: "unconfigured", commercial_acceptance_po_id: "po-1"
  });
  Object.assign(db.quote_lines[0], { quantity: 16, unit_price_cents: 2500, currency: "USD" });
  db.purchase_orders = [{ id: "po-1", po_reference: "PO-V5-1", po_amount: 1000, status: "verified" }];
  db.dispatch_cards[0].purchase_order_id = "po-1";
  const contact = call(createV5ClientSupervisorContact, db, "sales-1", { params: { id: "job-1" }, body: contactBody() }).body.data;
  assert.equal(call(recordV5PaperSignature, db, "sales-1", { params: { id: "ws-1" }, body: paperBody(contact.id) }).statusCode, 201);
  const state = v5SignatureState(db, db.field_worksheets[0]);
  assert.equal(call(confirmV5Timesheet, db, "sup-1", { params: { id: "ws-1" }, body: { evidence_id: state.evidence.id, hours_hash: state.current_hash, attest: true } }).statusCode, 201);
  return db;
}

function withWriter(callback) {
  const priorWriter = process.env.ORAC_V5_INVOICE_WRITER;
  const priorJson = process.env.ORAC_V5_INVOICE_JSON_SINGLE_PROCESS;
  process.env.ORAC_V5_INVOICE_WRITER = "enabled";
  process.env.ORAC_V5_INVOICE_JSON_SINGLE_PROCESS = "acknowledged";
  try { return withV5(callback); } finally {
    if (priorWriter === undefined) delete process.env.ORAC_V5_INVOICE_WRITER; else process.env.ORAC_V5_INVOICE_WRITER = priorWriter;
    if (priorJson === undefined) delete process.env.ORAC_V5_INVOICE_JSON_SINGLE_PROCESS; else process.env.ORAC_V5_INVOICE_JSON_SINGLE_PROCESS = priorJson;
  }
}

test("V5 writer candidate uses verified evidence, preserves cents, and has no write side effect", () => withWriter(() => {
  const db = writerReadyDb();
  const before = JSON.stringify(db);
  const result = buildV5InvoiceCandidate(db, "job-1", [{
    quote_line_id: "line-1", sources: [{ source_type: "field_worksheet", source_id: "ws-1", quantity: 9 }]
  }], { storeDriver: "json" });
  assert.equal(result.error, undefined);
  assert.equal(result.data.pre_tax_total_cents, 22500);
  assert.equal(result.data.lines[0].quantity_micro_units, 9000000);
  assert.match(result.data.candidate_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(db), before);
}));

test("V5 writer candidate subtracts amendment-covered evidence from the original quote", () => withWriter(() => {
  const db = writerReadyDb();
  db.v5_amendment_evidence_allocations = [{
    source_type: "field_worksheet", source_id: "ws-1", amendment_quote_line_id: "amend-line", quantity: 2
  }];
  const result = buildV5InvoiceCandidate(db, "job-1", [{
    quote_line_id: "line-1", sources: [{ source_type: "field_worksheet", source_id: "ws-1", quantity: 8 }]
  }], { storeDriver: "json" });
  assert.equal(result.error.code, "V5_EVIDENCE_SOURCE_EXHAUSTED");
  assert.equal(result.error.blockers[0].source_id, "ws-1");
}));

test("V5 draft workspace exposes only current, available evidence without a write", () => withWriter(() => {
  const db = writerReadyDb();
  db.v5_amendment_evidence_allocations = [{
    source_type: "field_worksheet", source_id: "ws-1", amendment_quote_line_id: "amend-line", quantity: 2
  }];
  const before = JSON.stringify(db);
  const workspace = v5InvoiceDraftWorkspace(db, "job-1", { storeDriver: "json" });
  assert.equal(workspace.error, undefined);
  const line = workspace.data.lines.find((item) => item.quote_line_id === "line-1");
  assert.equal(line.source_rule, "exact_evidence_portions");
  assert.deepEqual(line.available_sources, [{
    source_type: "field_worksheet", source_id: "ws-1", available_quantity: 7,
    available_micro_units: 7000000, unit: "hours", evidence_status: "v5_verified", selectable: true
  }]);
  assert.equal(JSON.stringify(db), before);
}));

test("V5 writer refuses a later hourly draft that would exceed the quote-line ceiling with different evidence", () => withWriter(() => {
  const db = writerReadyDb();
  db.v5_invoice_lines = [{ id: "issued-line-1", invoice_id: "issued-invoice-1", quote_line_id: "line-1", quantity_micro_units: 8000000 }];
  const result = buildV5InvoiceCandidate(db, "job-1", [{
    quote_line_id: "line-1", sources: [{ source_type: "field_worksheet", source_id: "ws-1", quantity: 9 }]
  }], { storeDriver: "json" });
  assert.equal(result.error.code, "V5_LINE_CEILING_EXCEEDED");
}));

test("V5 invoice numbers use the Harare year and ledger sequence, never a record count", () => {
  const db = { v5_invoice_number_ledger: [{ year: "2026", last_sequence: 41 }, { year: "2026", last_sequence: 42 }] };
  assert.deepEqual(nextV5InvoiceNumber(db, new Date("2026-12-31T22:30:00.000Z")), {
    year: "2027", sequence: 1, invoice_number: "V5-INV-2027-00001"
  });
  assert.deepEqual(nextV5InvoiceNumber(db, new Date("2026-06-10T10:00:00.000Z")), {
    year: "2026", sequence: 43, invoice_number: "V5-INV-2026-00043"
  });
});

test("V5 writer drafts consume nothing and a second authorised user issues atomically", () => withWriter(() => {
  const db = writerReadyDb();
  const body = {
    idempotency_key: "v5-draft-issue-0001",
    lines: [{ quote_line_id: "line-1", sources: [{ source_type: "field_worksheet", source_id: "ws-1", quantity: 9 }]}]
  };
  const draftResponse = call(createV5InvoiceDraft, db, "fin-1", { params: { id: "job-1" }, body });
  assert.equal(draftResponse.statusCode, 201);
  assert.equal((db.v5_invoice_source_consumption || []).length, 0);
  assert.equal((db.v5_invoices || []).length, 0);
  const issueResponse = call(issueV5InvoiceDraft, db, "admin-1", {
    params: { id: draftResponse.body.data.id }, body: { idempotency_key: "v5-issue-0001" }
  });
  assert.equal(issueResponse.statusCode, 201);
  assert.equal(issueResponse.body.data.invoice_number, "V5-INV-2026-00001");
  assert.equal(db.v5_invoices.length, 1);
  assert.equal(db.v5_invoice_lines.length, 1);
  assert.equal(db.v5_invoice_source_consumption[0].quantity_micro_units, 9000000);
  assert.equal(db.v5_invoice_drafts[0].status, "prepared");
  assert.equal(db.v5_invoice_drafts[0].issued_invoice_id, undefined);
  const draftRead = call(getV5InvoiceDraft, db, "fin-1", { params: { id: draftResponse.body.data.id } });
  assert.equal(draftRead.statusCode, 200);
  assert.equal(draftRead.body.data.status, "issued");
  assert.equal(draftRead.body.data.issued_invoice_id, issueResponse.body.data.id);
  const duplicateIssue = call(issueV5InvoiceDraft, db, "admin-1", {
    params: { id: draftResponse.body.data.id }, body: { idempotency_key: "v5-issue-different-key-0001" }
  });
  assert.equal(duplicateIssue.statusCode, 409);
  assert.equal(duplicateIssue.body.code, "V5_INVOICE_DRAFT_NOT_ISSUABLE");
}));

test("V5 writer rejects self-issue and returns a tenant-wide idempotent replay only after permission", () => withWriter(() => {
  const db = writerReadyDb();
  const draft = call(createV5InvoiceDraft, db, "fin-1", {
    params: { id: "job-1" }, body: { idempotency_key: "v5-draft-self-0001", lines: [{ quote_line_id: "line-1", sources: [{ source_type: "field_worksheet", source_id: "ws-1", quantity: 9 }]}] }
  }).body.data;
  const selfIssue = call(issueV5InvoiceDraft, db, "fin-1", { params: { id: draft.id }, body: { idempotency_key: "v5-issue-self-0001" } });
  assert.equal(selfIssue.statusCode, 403);
  assert.equal(selfIssue.body.code, "V5_INVOICE_TWO_PERSON_REQUIRED");
  const issued = call(issueV5InvoiceDraft, db, "admin-1", { params: { id: draft.id }, body: { idempotency_key: "v5-issue-replay-0001" } });
  const replay = call(issueV5InvoiceDraft, db, "admin-1", { params: { id: draft.id }, body: { idempotency_key: "v5-issue-replay-0001" } });
  assert.equal(issued.statusCode, 201);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.idempotent_replay, true);
  assert.equal(db.v5_invoices.length, 1);
}));

test("V5 invoice read models are role-gated and expose issued evidence without a mutation", () => withWriter(() => {
  const db = writerReadyDb();
  const draft = call(createV5InvoiceDraft, db, "fin-1", {
    params: { id: "job-1" }, body: { idempotency_key: "v5-draft-read-0001", lines: [{ quote_line_id: "line-1", sources: [{ source_type: "field_worksheet", source_id: "ws-1", quantity: 9 }]}] }
  }).body.data;
  const invoice = call(issueV5InvoiceDraft, db, "admin-1", { params: { id: draft.id }, body: { idempotency_key: "v5-issue-read-0001" } }).body.data;
  assert.throws(() => call(getV5Invoice, db, "management-absent", { params: { id: invoice.id } }), /cannot perform viewV5Invoice/, "The fixture deliberately has no Management user");
  db.users.push({ id: "management-1", role: "Management", is_active: true });
  const before = JSON.stringify(db);
  const allowed = call(getV5Invoice, db, "management-1", { params: { id: invoice.id } });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.body.data.lines.length, 1);
  assert.equal(call(listDispatchV5Invoices, db, "management-1", { params: { id: "job-1" } }).body.data.length, 1);
  assert.equal(call(getV5InvoiceBillingState, db, "management-1", { params: { id: "job-1" } }).body.data.billing_state, "partially_billed");
  assert.equal(JSON.stringify(db), before, "Read routes do not mutate invoice records.");
}));

test("V5 minimum-hours billing requires current assigned-Supervisor completion evidence", () => withWriter(() => {
  const db = writerReadyDb();
  Object.assign(db.quote_lines[0], { pricing_basis: "minimum_hours", quantity: 8, planned_hours: 16 });
  const incomplete = buildV5InvoiceCandidate(db, "job-1", [{ quote_line_id: "line-1" }], { storeDriver: "json" });
  assert.equal(incomplete.error.code, "V5_LINE_COMPLETION_REQUIRED");
  const completion = call(recordV5LineCompletion, db, "sup-1", {
    params: { id: "job-1" }, body: { quote_line_id: "line-1", reason: "Evidence reviewed", idempotency_key: "v5-completion-0001" }
  });
  assert.equal(completion.statusCode, 201);
  const candidate = buildV5InvoiceCandidate(db, "job-1", [{ quote_line_id: "line-1" }], { storeDriver: "json" });
  assert.equal(candidate.error, undefined);
  assert.equal(candidate.data.lines[0].quantity, 9);
  assert.equal(candidate.data.pre_tax_total_cents, 22500);
  const denied = call(recordV5LineCompletion, db, "sup-2", {
    params: { id: "job-1" }, body: { quote_line_id: "line-1", reason: "Wrong supervisor", idempotency_key: "v5-completion-0002" }
  });
  assert.equal(denied.statusCode, 403);
}));

function addApprovedAmendments(db) {
  for (const [id, lineId, poId] of [["amend-1", "amend-line-1", "amend-po-1"], ["amend-2", "amend-line-2", "amend-po-2"]]) {
    db.quotes.push({
      id, root_quote_id: "quote-1", revision_of_quote_id: "quote-1", v5_commercial_workflow: true, currency: "USD", tax_status: "unconfigured",
      commercial_acceptance_status: "po_verified", commercial_acceptance_po_id: poId,
      v5_amendment_approval: { approved_by: "sales-1", approved_po_id: poId }
    });
    db.quote_lines.push({ id: lineId, quotation_id: id, description: id, pricing_basis: "hourly", quantity: 4, unit_price_cents: 2500, currency: "USD" });
    db.purchase_orders.push({ id: poId, po_reference: poId, po_amount: 1000, status: "verified" });
    db.v5_amendment_dispatch_links ||= [];
    db.v5_amendment_dispatch_links.push({ id: `link-${id}`, dispatch_card_id: "job-1", amendment_quote_id: id, amendment_purchase_order_id: poId });
  }
}

test("V5 writer independently refuses a linked amendment outside the dispatch quotation lineage", () => withWriter(() => {
  const db = writerReadyDb();
  addApprovedAmendments(db);
  db.quotes.find((quote) => quote.id === "amend-1").root_quote_id = "unrelated-root";
  db.v5_amendment_evidence_allocations = [{
    id: "alloc-cross-lineage", dispatch_card_id: "job-1", amendment_quote_id: "amend-1", amendment_quote_line_id: "amend-line-1",
    source_type: "field_worksheet", source_id: "ws-1", quantity: 2
  }];
  const result = buildV5InvoiceCandidate(db, "job-1", [{
    quote_line_id: "amend-line-1", sources: [{ source_type: "field_worksheet", source_id: "ws-1", quantity: 2 }]
  }], { storeDriver: "json" });
  assert.equal(result.error.code, "V5_AMENDMENT_AUTHORITY_INVALID");
}));

test("V5 writer refuses a linked quote that lacks an amendment revision marker", () => withWriter(() => {
  const db = writerReadyDb();
  addApprovedAmendments(db);
  delete db.quotes.find((quote) => quote.id === "amend-1").revision_of_quote_id;
  db.v5_amendment_evidence_allocations = [{
    id: "alloc-missing-revision", dispatch_card_id: "job-1", amendment_quote_id: "amend-1", amendment_quote_line_id: "amend-line-1",
    source_type: "field_worksheet", source_id: "ws-1", quantity: 2
  }];
  const result = buildV5InvoiceCandidate(db, "job-1", [{
    quote_line_id: "amend-line-1", sources: [{ source_type: "field_worksheet", source_id: "ws-1", quantity: 2 }]
  }], { storeDriver: "json" });
  assert.equal(result.error.code, "V5_AMENDMENT_AUTHORITY_INVALID");
}));

test("V5 amendment supersession independently refuses a linked amendment outside the dispatch quotation lineage", () => withWriter(() => {
  const db = writerReadyDb();
  addApprovedAmendments(db);
  db.quotes.find((quote) => quote.id === "amend-2").root_quote_id = "unrelated-root";
  const result = call(supersedeV5Amendment, db, "fin-1", {
    params: { id: "job-1" }, body: {
      superseded_amendment_quote_id: "amend-1", replacement_amendment_quote_id: "amend-2",
      reason: "Reject cross-lineage replacement", idempotency_key: "v5-supersession-lineage-0001"
    }
  });
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, "V5_AMENDMENT_LINEAGE_INVALID");
  assert.equal((db.v5_amendment_supersessions || []).length, 0);
}));

test("V5 amendment supersession blocks billing until an unconsumed allocation is remapped", () => withWriter(() => {
  const db = writerReadyDb();
  addApprovedAmendments(db);
  db.v5_amendment_evidence_allocations = [{
    id: "alloc-1", dispatch_card_id: "job-1", amendment_quote_id: "amend-1", amendment_quote_line_id: "amend-line-1",
    source_type: "field_worksheet", source_id: "ws-1", quantity: 2
  }];
  const supersession = call(supersedeV5Amendment, db, "fin-1", {
    params: { id: "job-1" }, body: {
      superseded_amendment_quote_id: "amend-1", replacement_amendment_quote_id: "amend-2",
      reason: "Corrected incremental scope", idempotency_key: "v5-supersession-0001"
    }
  });
  assert.equal(supersession.statusCode, 201);
  const blocked = buildV5InvoiceCandidate(db, "job-1", [{ quote_line_id: "amend-line-2", sources: [{ source_type: "field_worksheet", source_id: "ws-1", quantity: 2 }]}], { storeDriver: "json" });
  assert.equal(blocked.error.code, "V5_SUPERSEDED_ALLOCATION_REMAP_REQUIRED");
  const remap = call(remapV5Allocation, db, "admin-1", {
    params: { id: "job-1" }, body: {
      allocation_id: "alloc-1", replacement_amendment_quote_line_id: "amend-line-2",
      reason: "Move unbilled evidence", idempotency_key: "v5-remap-0001"
    }
  });
  assert.equal(remap.statusCode, 201);
  const ready = buildV5InvoiceCandidate(db, "job-1", [{ quote_line_id: "amend-line-2", sources: [{ source_type: "field_worksheet", source_id: "ws-1", quantity: 2 }]}], { storeDriver: "json" });
  assert.equal(ready.error, undefined);
  assert.equal(ready.data.lines[0].quotation_id, "amend-2");
}));
