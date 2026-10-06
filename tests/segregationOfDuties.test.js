import assert from "node:assert/strict";
import test from "node:test";
import { createWorksheet, reviewWorksheet, submitWorksheet } from "../src/controllers/dispatchController.js";

function createResponse() {
  return {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function createRequest(actor, {
  decision = "approve",
  verifiedBy = "finance-1",
  submittedBy = "technician-1",
  legacySubmittedBy = null
} = {}) {
  const verifier = actor.id === verifiedBy
    ? actor
    : { id: verifiedBy, role: "Finance", is_active: true };
  const worksheet = {
    id: "worksheet-1",
    dispatch_card_id: "dispatch-1",
    status: "Client_Acknowledged",
    submitted_by: submittedBy,
    client_acknowledgement: { signer_name: "Site Rep", signer_role: "Site Supervisor", acknowledged_at: "2026-09-13T10:00:00.000Z" }
  };
  const auditEntries = [];
  if (legacySubmittedBy) {
    auditEntries.push({
      id: "audit-submission",
      actor_id: legacySubmittedBy,
      entity_type: "field_worksheet",
      entity_id: worksheet.id,
      action: "WORKSHEET_SUBMITTED",
      created_at: "2026-09-13T09:00:00.000Z"
    });
  }
  return {
    user: { id: actor.id },
    params: { id: worksheet.id },
    body: { decision, comment: decision === "return" ? "Please add missing site evidence." : "" },
    db: {
      users: [actor, verifier],
      field_worksheets: [worksheet],
      dispatch_cards: [{
        id: "dispatch-1",
        purchase_order_id: "po-1",
        quotation_id: "quote-1",
        assigned_supervisor_id: actor.role === "Supervisor" ? actor.id : "supervisor-1"
      }],
      purchase_orders: [{ id: "po-1", quotation_id: "quote-1", verified_by: verifiedBy }],
      audit_logs: auditEntries
    },
    store: {
      audit(_db, auditActor, entityType, entityId, action, before, after) {
        auditEntries.push({ auditActor, entityType, entityId, action, before, after });
      }
    },
    worksheet,
    auditEntries
  };
}

test("PO verifier cannot approve the worksheet for the same dispatch", () => {
  const operations = { id: "operations-1", role: "Operations", is_active: true };
  const req = createRequest(operations, { verifiedBy: operations.id });
  const res = createResponse();

  reviewWorksheet(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(req.worksheet.status, "Client_Acknowledged");
  assert.equal(req.auditEntries.length, 0);
  assert.match(res.body.message, /independent reviewer/i);
});

test("an independent permitted reviewer can approve the worksheet", () => {
  const supervisor = { id: "supervisor-1", role: "Supervisor", is_active: true };
  const req = createRequest(supervisor);
  const res = createResponse();

  reviewWorksheet(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(req.worksheet.status, "Supervisor_Approved");
  assert.equal(req.worksheet.approved_by, supervisor.id);
  assert.equal(req.auditEntries[0].action, "WORKSHEET_APPROVED");
});

test("PO verifier may return a worksheet for correction with a comment", () => {
  const admin = { id: "admin-1", role: "Admin", is_active: true };
  const req = createRequest(admin, { decision: "return", verifiedBy: admin.id });
  const res = createResponse();

  reviewWorksheet(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(req.worksheet.status, "Returned_For_Correction");
  assert.equal(req.auditEntries[0].action, "WORKSHEET_RETURNED");
});

test("worksheet submitter cannot approve their own submission", () => {
  const supervisor = { id: "supervisor-1", role: "Supervisor", is_active: true };
  const req = createRequest(supervisor, { submittedBy: supervisor.id });
  const res = createResponse();

  reviewWorksheet(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(req.worksheet.status, "Client_Acknowledged");
  assert.match(res.body.message, /submitted this timesheet/i);
});

test("legacy worksheet approval uses submission audit evidence without backfilling fields", () => {
  const supervisor = { id: "supervisor-1", role: "Supervisor", is_active: true };
  const req = createRequest(supervisor, { submittedBy: null, legacySubmittedBy: supervisor.id });
  const res = createResponse();

  reviewWorksheet(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(req.worksheet.submitted_by, null);
});

test("worksheet approval fails closed when legacy submission ownership cannot be verified", () => {
  const supervisor = { id: "supervisor-1", role: "Supervisor", is_active: true };
  const req = createRequest(supervisor, { submittedBy: null });
  const res = createResponse();

  reviewWorksheet(req, res);

  assert.equal(res.statusCode, 409);
  assert.equal(req.worksheet.status, "Client_Acknowledged");
  assert.match(res.body.message, /ownership cannot be verified/i);
});

test("a merely-Submitted worksheet (not yet client-acknowledged) cannot be reviewed", () => {
  const supervisor = { id: "supervisor-1", role: "Supervisor", is_active: true };
  const req = createRequest(supervisor);
  req.worksheet.status = "Submitted";
  req.db.field_worksheets[0].status = "Submitted";
  const res = createResponse();

  reviewWorksheet(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(req.worksheet.status, "Submitted");
});

test("new worksheet submissions persist the submitting actor", () => {
  const technician = { id: "technician-1", role: "Technician", is_active: true };
  const auditEntries = [];
  const req = {
    user: { id: technician.id },
    params: { id: "dispatch-1" },
    body: { activity: "Inspect lining", hours: 2, submit: false },
    db: {
      users: [technician],
      dispatch_cards: [{ id: "dispatch-1", assigned_technician_id: technician.id }],
      field_worksheets: [],
      audit_logs: auditEntries
    },
    store: {
      id: () => "worksheet-1",
      audit(_db, actor, entityType, entityId, action, before, after) {
        auditEntries.push({ actor_id: actor.id, entity_type: entityType, entity_id: entityId, action, before, after });
      }
    }
  };

  createWorksheet(req, createResponse());
  req.params.id = "worksheet-1";
  req.body = {};
  const submitResponse = createResponse();
  submitWorksheet(req, submitResponse);

  assert.equal(submitResponse.statusCode, 200);
  assert.equal(req.db.field_worksheets[0].submitted_by, technician.id);
});
