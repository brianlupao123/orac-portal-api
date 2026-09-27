import test from "node:test";
import assert from "node:assert/strict";
import {
  listOwnClientTimesheets, acknowledgeWorksheet, reviseWorksheet,
  getTimesheetPeriodPack, getTimesheetPeriodPackPdf, getTimesheetPeriodSummary
} from "../src/controllers/timesheetAcknowledgementController.js";
import { reviewWorksheet } from "../src/controllers/dispatchController.js";
import { computeWorksheetReport } from "../src/reports.js";
import { ClientAcknowledgeWorksheetSchema, ReviseWorksheetSchema } from "../src/schemas.js";

function response() {
  return {
    statusCode: 200, headers: {}, contentType: null, sentBytes: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    json(body) { this.body = body; return this; },
    type(value) { this.contentType = value; return this; },
    send(bytes) { this.sentBytes = bytes; return this; }
  };
}

function makeDb() {
  const users = [
    { id: "admin-1", role: "Admin", is_active: true },
    { id: "ops-1", role: "Operations", is_active: true },
    { id: "mgmt-1", role: "Management", is_active: true },
    { id: "tech-1", role: "Technician", name: "Tapiwa Moyo", is_active: true },
    { id: "tech-2", role: "Technician", name: "Rudo Chuma", is_active: true },
    { id: "sup-1", role: "Supervisor", is_active: true },
    { id: "client-zimplats", role: "Client Viewer", client_id: "c_zimplats", is_active: true },
    { id: "client-mimosa", role: "Client Viewer", client_id: "c_mimosa", is_active: true }
  ];
  const clients = [{ id: "c_zimplats", name: "Zimplats" }, { id: "c_mimosa", name: "Mimosa" }];
  const mine_sites = [{ id: "ms_ngezi", name: "Ngezi" }];
  const plants = [{ id: "pl_smc", mine_site_id: "ms_ngezi" }];
  const plant_sections = [{ id: "ps_cyclone", plant_id: "pl_smc" }];
  const equipment_tags = [{ id: "eq_1", plant_section_id: "ps_cyclone" }];
  const quotes = [
    { id: "q_zimplats", client_id: "c_zimplats", equipment_tag_id: "eq_1" },
    { id: "q_mimosa", client_id: "c_mimosa", equipment_tag_id: null }
  ];
  const dispatch_cards = [
    { id: "d_zimplats", quotation_id: "q_zimplats", dispatch_number: "DC-1" },
    { id: "d_mimosa", quotation_id: "q_mimosa", dispatch_number: "DC-2" }
  ];
  const field_worksheets = [
    {
      id: "ws-submitted", dispatch_card_id: "d_zimplats", technician_id: "tech-1", work_date: "2026-09-10",
      hours: 8, status: "Submitted", revision_number: 1
    }
  ];
  return {
    users, clients, mine_sites, plants, plant_sections, equipment_tags, quotes, dispatch_cards, field_worksheets,
    purchase_orders: [], audit_logs: []
  };
}

function makeStore(db) {
  let counter = 0;
  return {
    id(prefix) { return `${prefix}-${++counter}`; },
    audit(_db, actor, entityType, entityId, action, before, after) {
      db.audit_logs.push({ id: `audit-${++counter}`, actor_id: actor.id, entity_type: entityType, entity_id: entityId, action, before, after });
    }
  };
}

function req(db, actorId, { params = {}, body = {}, query = {} } = {}) {
  return { user: { id: actorId }, params, body, query, db, store: makeStore(db) };
}

// ---- acknowledgeWorksheet -------------------------------------------------

test("client representative can acknowledge their own client's Submitted entry", () => {
  const db = makeDb();
  const request = req(db, "client-zimplats", {
    params: { id: "ws-submitted" },
    body: { signer_name: "Farai Ncube", signer_role: "Site Manager", acknowledgement: true }
  });
  const res = response();
  acknowledgeWorksheet(request, res);

  assert.equal(res.statusCode, 200);
  const worksheet = db.field_worksheets[0];
  assert.equal(worksheet.status, "Client_Acknowledged");
  assert.equal(worksheet.client_acknowledgement.signer_name, "Farai Ncube");
  assert.equal(worksheet.client_acknowledgement.signer_role, "Site Manager");
  assert.equal(worksheet.client_acknowledgement.acknowledged_by_user_id, "client-zimplats");
  assert.ok(worksheet.client_acknowledgement.acknowledged_at);
  assert.ok(worksheet.client_acknowledgement.evidence_reference);
  assert.equal(db.audit_logs.at(-1).action, "WORKSHEET_CLIENT_ACKNOWLEDGED");
});

test("a client representative cannot acknowledge another client's entry (tenancy)", () => {
  const db = makeDb();
  const request = req(db, "client-mimosa", {
    params: { id: "ws-submitted" },
    body: { signer_name: "Someone Else", signer_role: "Manager", acknowledgement: true }
  });
  const res = response();
  acknowledgeWorksheet(request, res);

  assert.equal(res.statusCode, 403);
  assert.equal(db.field_worksheets[0].status, "Submitted");
  assert.equal(db.audit_logs.length, 0);
});

test("only the Client Viewer role may acknowledge, never internal staff", () => {
  const db = makeDb();
  const request = req(db, "ops-1", {
    params: { id: "ws-submitted" },
    body: { signer_name: "Ops User", signer_role: "Operations", acknowledgement: true }
  });
  assert.throws(() => acknowledgeWorksheet(request, response()), { status: 403 });
});

test("acknowledgement is immutable: an already-acknowledged entry cannot be re-acknowledged", () => {
  const db = makeDb();
  db.field_worksheets[0].status = "Client_Acknowledged";
  db.field_worksheets[0].client_acknowledgement = {
    id: "wsack-1", signer_name: "Original Signer", signer_role: "Site Manager",
    acknowledged_by_user_id: "client-zimplats", acknowledged_at: "2026-09-10T08:00:00.000Z", evidence_reference: "evd-1"
  };
  const request = req(db, "client-zimplats", {
    params: { id: "ws-submitted" },
    body: { signer_name: "Different Signer", signer_role: "Someone Else", acknowledgement: true }
  });
  const res = response();
  acknowledgeWorksheet(request, res);

  assert.equal(res.statusCode, 400);
  // Original signed evidence is untouched.
  assert.equal(db.field_worksheets[0].client_acknowledgement.signer_name, "Original Signer");
});

test("a Draft entry is not yet eligible for client acknowledgement", () => {
  const db = makeDb();
  db.field_worksheets[0].status = "Draft";
  const request = req(db, "client-zimplats", {
    params: { id: "ws-submitted" },
    body: { signer_name: "Farai Ncube", signer_role: "Site Manager", acknowledgement: true }
  });
  const res = response();
  acknowledgeWorksheet(request, res);
  assert.equal(res.statusCode, 400);
});

// ---- Supervisor review now gated on Client_Acknowledged -------------------

test("Supervisor review is blocked until the client has acknowledged the entry", () => {
  const db = makeDb();
  db.dispatch_cards[0].assigned_supervisor_id = "sup-1";
  db.field_worksheets[0].submitted_by = "tech-1";
  const request = req(db, "sup-1", { params: { id: "ws-submitted" }, body: { decision: "approve" } });
  const res = response();
  reviewWorksheet(request, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Client_Acknowledged/);
});

test("Supervisor review succeeds once the client has acknowledged the entry", () => {
  const db = makeDb();
  db.dispatch_cards[0].assigned_supervisor_id = "sup-1";
  db.field_worksheets[0].submitted_by = "tech-1";
  db.field_worksheets[0].status = "Client_Acknowledged";
  db.field_worksheets[0].client_acknowledgement = { signer_name: "Farai Ncube", signer_role: "Site Manager", acknowledged_at: "2026-09-10T09:00:00.000Z" };
  const request = req(db, "sup-1", { params: { id: "ws-submitted" }, body: { decision: "approve" } });
  const res = response();
  reviewWorksheet(request, res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.field_worksheets[0].status, "Supervisor_Approved");
});

// ---- reviseWorksheet --------------------------------------------------

test("revising an acknowledged worksheet creates a new linked Draft revision and supersedes the original", () => {
  const db = makeDb();
  db.field_worksheets[0].status = "Client_Acknowledged";
  db.field_worksheets[0].client_acknowledgement = { signer_name: "Farai Ncube", signer_role: "Site Manager", acknowledged_at: "2026-09-10T09:00:00.000Z" };
  const request = req(db, "ops-1", { params: { id: "ws-submitted" }, body: { reason: "Hours were mis-recorded for this shift." } });
  const res = response();
  reviseWorksheet(request, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.status, "Draft");
  assert.equal(res.body.data.revises_worksheet_id, "ws-submitted");
  assert.equal(res.body.data.revision_number, 2);
  assert.equal(res.body.data.revision_reason, "Hours were mis-recorded for this shift.");
  assert.equal(res.body.data.client_acknowledgement, null);

  const original = db.field_worksheets.find((item) => item.id === "ws-submitted");
  assert.equal(original.superseded_by, res.body.data.id);
  assert.equal(db.field_worksheets.length, 2);
  assert.ok(db.audit_logs.some((entry) => entry.action === "WORKSHEET_SUPERSEDED"));
  assert.ok(db.audit_logs.some((entry) => entry.action === "WORKSHEET_REVISION_CREATED"));
});

test("a Draft or merely-Submitted worksheet cannot go through the revise endpoint", () => {
  const db = makeDb();
  const request = req(db, "ops-1", { params: { id: "ws-submitted" }, body: { reason: "typo" } });
  const res = response();
  reviseWorksheet(request, res);
  assert.equal(res.statusCode, 400);
});

test("a worksheet that has already been superseded cannot be revised again", () => {
  const db = makeDb();
  db.field_worksheets[0].status = "Client_Acknowledged";
  db.field_worksheets[0].superseded_by = "ws-later";
  const request = req(db, "ops-1", { params: { id: "ws-submitted" }, body: { reason: "again" } });
  const res = response();
  reviseWorksheet(request, res);
  assert.equal(res.statusCode, 400);
});

test("a Technician may revise only their own worksheet", () => {
  const db = makeDb();
  db.field_worksheets[0].status = "Client_Acknowledged";
  const request = req(db, "tech-2", { params: { id: "ws-submitted" }, body: { reason: "not mine" } });
  const res = response();
  reviseWorksheet(request, res);
  assert.equal(res.statusCode, 403);
});

// ---- Operations period pack --------------------------------------------

test("period pack includes only the requested client's acknowledged/approved current-revision entries", () => {
  const db = makeDb();
  db.field_worksheets = [
    { id: "ws-1", dispatch_card_id: "d_zimplats", technician_id: "tech-1", work_date: "2026-09-05", hours: 8, status: "Client_Acknowledged", revision_number: 1, client_acknowledgement: { signer_name: "A", signer_role: "R", acknowledged_at: "x" } },
    { id: "ws-2", dispatch_card_id: "d_zimplats", technician_id: "tech-1", work_date: "2026-09-06", hours: 6, status: "Supervisor_Approved", revision_number: 1 },
    { id: "ws-3", dispatch_card_id: "d_zimplats", technician_id: "tech-1", work_date: "2026-09-07", hours: 4, status: "Submitted", revision_number: 1 }, // not yet acknowledged
    { id: "ws-4", dispatch_card_id: "d_mimosa", technician_id: "tech-2", work_date: "2026-09-05", hours: 8, status: "Client_Acknowledged", revision_number: 1 }, // other client
    { id: "ws-5", dispatch_card_id: "d_zimplats", technician_id: "tech-1", work_date: "2026-09-05", hours: 8, status: "Client_Acknowledged", revision_number: 1, superseded_by: "ws-6" } // superseded, excluded
  ];
  const request = req(db, "ops-1", { query: { client_id: "c_zimplats", from: "2026-09-01", to: "2026-09-30" } });
  const res = response();
  getTimesheetPeriodPack(request, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.client.id, "c_zimplats");
  assert.equal(res.body.data.entry_count, 2);
  const ids = res.body.data.technicians.flatMap((t) => Object.values(t.days).flat()).map((e) => e.id);
  assert.deepEqual(ids.sort(), ["ws-1", "ws-2"]);
});

test("period pack site filter scopes to the requested mine site only", () => {
  const db = makeDb();
  const request = req(db, "ops-1", { query: { client_id: "c_zimplats", from: "2026-09-01", to: "2026-09-30", site: "ms_ngezi" } });
  db.field_worksheets[0].status = "Client_Acknowledged";
  db.field_worksheets[0].client_acknowledgement = { signer_name: "A", signer_role: "R", acknowledged_at: "x" };
  const resMatch = response();
  getTimesheetPeriodPack(request, resMatch);
  assert.equal(resMatch.body.data.entry_count, 1);

  const requestOtherSite = req(db, "ops-1", { query: { client_id: "c_zimplats", from: "2026-09-01", to: "2026-09-30", site: "ms_other" } });
  const resNoMatch = response();
  getTimesheetPeriodPack(requestOtherSite, resNoMatch);
  assert.equal(resNoMatch.body.data.entry_count, 0);
});

test("only Operations/Admin may download a period pack", () => {
  const db = makeDb();
  const request = req(db, "sup-1", { query: { client_id: "c_zimplats", from: "2026-09-01", to: "2026-09-30" } });
  assert.throws(() => getTimesheetPeriodPack(request, response()), { status: 403 });
});

// ---- Operations period pack (PDF) ---------------------------------------

test("period pack PDF renders as a real PDF for a valid client/date range, one table per technician", () => {
  const db = makeDb();
  db.field_worksheets = [
    {
      id: "ws-1", dispatch_card_id: "d_zimplats", technician_id: "tech-1", work_date: "2026-09-05",
      hours: 8, status: "Client_Acknowledged", revision_number: 1,
      client_acknowledgement: { signer_name: "Farai Ncube", signer_role: "Site Manager", acknowledged_at: "2026-09-05T16:00:00.000Z" }
    }
  ];
  const request = req(db, "ops-1", { query: { client_id: "c_zimplats", from: "2026-09-01", to: "2026-09-30" } });
  const res = response();
  getTimesheetPeriodPackPdf(request, res);

  assert.equal(res.contentType, "application/pdf");
  assert.ok(res.sentBytes instanceof Uint8Array || Buffer.isBuffer(res.sentBytes));
  assert.ok(res.sentBytes.length > 100);
  assert.match(res.sentBytes.toString("latin1", 0, 8), /%PDF-/);
  assert.match(res.headers["Content-Disposition"], /attachment; filename="orac-period-pack-c_zimplats-2026-09-01-to-2026-09-30\.pdf"/);
});

test("period pack PDF is refused to a role that is not Operations/Admin", () => {
  const db = makeDb();
  const request = req(db, "sup-1", { query: { client_id: "c_zimplats", from: "2026-09-01", to: "2026-09-30" } });
  assert.throws(() => getTimesheetPeriodPackPdf(request, response()), { status: 403 });
});

test("period pack PDF for an unknown client fails closed with 404, not an empty/blank PDF", () => {
  const db = makeDb();
  const request = req(db, "ops-1", { query: { client_id: "c_nope", from: "2026-09-01", to: "2026-09-30" } });
  const res = response();
  getTimesheetPeriodPackPdf(request, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.sentBytes, null);
});

test("period pack PDF for one client never contains another client's rows", () => {
  const db = makeDb();
  db.field_worksheets = [
    { id: "ws-1", dispatch_card_id: "d_zimplats", technician_id: "tech-1", work_date: "2026-09-05", hours: 8, status: "Client_Acknowledged", revision_number: 1, client_acknowledgement: { signer_name: "Farai Ncube", signer_role: "Site Manager", acknowledged_at: "x" } },
    { id: "ws-2", dispatch_card_id: "d_mimosa", technician_id: "tech-2", work_date: "2026-09-05", hours: 8, status: "Client_Acknowledged", revision_number: 1, client_acknowledgement: { signer_name: "Someone At Mimosa", signer_role: "Manager", acknowledged_at: "x" } }
  ];
  const zimplatsRequest = req(db, "ops-1", { query: { client_id: "c_zimplats", from: "2026-09-01", to: "2026-09-30" } });
  const zimplatsRes = response();
  getTimesheetPeriodPackPdf(zimplatsRequest, zimplatsRes);
  const text = zimplatsRes.sentBytes.toString("latin1");
  assert.match(text, /Tapiwa Moyo/);
  assert.doesNotMatch(text, /Someone At Mimosa/);
});

// ---- Internal cross-client summary --------------------------------------

test("internal period summary spans clients but keeps each entry's client/site/day and signature status", () => {
  const db = makeDb();
  db.field_worksheets = [
    { id: "ws-1", dispatch_card_id: "d_zimplats", technician_id: "tech-1", work_date: "2026-09-05", hours: 8, status: "Client_Acknowledged", revision_number: 1, client_acknowledgement: { signer_name: "A", signer_role: "R" } },
    { id: "ws-2", dispatch_card_id: "d_mimosa", technician_id: "tech-1", work_date: "2026-09-06", hours: 4, status: "Submitted", revision_number: 1 }
  ];
  const request = req(db, "mgmt-1", { query: { from: "2026-09-01", to: "2026-09-30" } });
  const res = response();
  getTimesheetPeriodSummary(request, res);

  assert.equal(res.statusCode, 200);
  const entries = res.body.data.technicians[0].entries;
  assert.equal(entries.length, 2);
  const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
  assert.equal(byId["ws-1"].client_name, "Zimplats");
  assert.equal(byId["ws-1"].signature_status, "acknowledged");
  assert.equal(byId["ws-2"].client_name, "Mimosa");
  assert.equal(byId["ws-2"].signature_status, "pending_client_acknowledgement");
  assert.match(res.body.data.note, /not a client acknowledgement/i);
});

// ---- Ownership boundary: Timesheets never move stock or create invoices ---

test("acknowledging and revising a worksheet never creates an invoice or touches inventory", () => {
  const db = makeDb();
  db.invoices = [];
  db.inventory_items = [{ id: "inv-1", quantity_on_hand: 10 }];

  const ackRequest = req(db, "client-zimplats", {
    params: { id: "ws-submitted" },
    body: { signer_name: "Farai Ncube", signer_role: "Site Manager", acknowledgement: true }
  });
  acknowledgeWorksheet(ackRequest, response());
  assert.equal(db.field_worksheets[0].status, "Client_Acknowledged");

  const reviseRequest = req(db, "ops-1", { params: { id: "ws-submitted" }, body: { reason: "hours corrected" } });
  reviseWorksheet(reviseRequest, response());

  assert.equal(db.invoices.length, 0);
  assert.equal(db.inventory_items[0].quantity_on_hand, 10);
});

// ---- Reporting stays honest about the new two-stage flow ------------------

test("worksheet report splits pending_review into client-acknowledgement and supervisor-review stages", () => {
  const db = makeDb();
  db.field_worksheets = [
    { id: "ws-1", dispatch_card_id: "d_zimplats", status: "Submitted", work_date: "2026-09-05", hours: 8 },
    { id: "ws-2", dispatch_card_id: "d_zimplats", status: "Client_Acknowledged", work_date: "2026-09-06", hours: 6 },
    { id: "ws-3", dispatch_card_id: "d_zimplats", status: "Supervisor_Approved", work_date: "2026-09-07", hours: 4 }
  ];
  const report = computeWorksheetReport(db);
  assert.deepEqual(report.pending_client_acknowledgement.map((w) => w.id), ["ws-1"]);
  assert.deepEqual(report.pending_supervisor_review.map((w) => w.id), ["ws-2"]);
  // Superset kept for backward compatibility with existing dashboard callers.
  assert.deepEqual(report.pending_review.map((w) => w.id).sort(), ["ws-1", "ws-2"]);
  assert.equal(report.approved_count, 1);
});

// ---- Malformed/tampered requests fail closed -------------------------------

test("the acknowledge schema rejects a missing signer or a false/absent acknowledgement flag", () => {
  assert.equal(ClientAcknowledgeWorksheetSchema.safeParse({ signer_name: "", signer_role: "Site Manager", acknowledgement: true }).success, false);
  assert.equal(ClientAcknowledgeWorksheetSchema.safeParse({ signer_name: "Farai Ncube", signer_role: "Site Manager", acknowledgement: false }).success, false);
  assert.equal(ClientAcknowledgeWorksheetSchema.safeParse({ signer_name: "Farai Ncube", signer_role: "Site Manager" }).success, false);
  assert.equal(ClientAcknowledgeWorksheetSchema.safeParse({ signer_name: "Farai Ncube", signer_role: "Site Manager", acknowledgement: true }).success, true);
});

test("the revise schema requires a non-empty reason", () => {
  assert.equal(ReviseWorksheetSchema.safeParse({ reason: "" }).success, false);
  assert.equal(ReviseWorksheetSchema.safeParse({}).success, false);
  assert.equal(ReviseWorksheetSchema.safeParse({ reason: "Hours corrected after site review." }).success, true);
});

// ---- Client's own list ---------------------------------------------------

test("a client representative's own list is scoped to their client and excludes Drafts", () => {
  const db = makeDb();
  db.field_worksheets = [
    { id: "ws-1", dispatch_card_id: "d_zimplats", technician_id: "tech-1", work_date: "2026-09-05", status: "Submitted", revision_number: 1 },
    { id: "ws-2", dispatch_card_id: "d_zimplats", technician_id: "tech-1", work_date: "2026-09-06", status: "Draft", revision_number: 1 },
    { id: "ws-3", dispatch_card_id: "d_mimosa", technician_id: "tech-2", work_date: "2026-09-05", status: "Submitted", revision_number: 1 }
  ];
  const request = req(db, "client-zimplats", {});
  const res = response();
  listOwnClientTimesheets(request, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.map((item) => item.id), ["ws-1"]);
});
