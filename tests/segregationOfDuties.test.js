import assert from "node:assert/strict";
import test from "node:test";
import { reviewWorksheet } from "../src/controllers/dispatchController.js";

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

function createRequest(actor, { decision = "approve", verifiedBy = "finance-1" } = {}) {
  const verifier = actor.id === verifiedBy
    ? actor
    : { id: verifiedBy, role: "Finance", is_active: true };
  const worksheet = { id: "worksheet-1", dispatch_card_id: "dispatch-1", status: "Submitted" };
  const auditEntries = [];
  return {
    user: { id: actor.id },
    params: { id: worksheet.id },
    body: { decision, comment: decision === "return" ? "Please add missing site evidence." : "" },
    db: {
      users: [actor, verifier],
      field_worksheets: [worksheet],
      dispatch_cards: [{ id: "dispatch-1", purchase_order_id: "po-1", quotation_id: "quote-1" }],
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
  assert.equal(req.worksheet.status, "Submitted");
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
