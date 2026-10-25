import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import apiRouter from "../src/router.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { createStore } from "../src/store.js";
import { generateToken } from "../src/middleware/auth.js";
import { invoiceReadinessBlock } from "../src/invoiceReadiness.js";

const testUsers = [
  { id: "u_admin", name: "System Admin", email: "admin@example.invalid", role: "Admin", is_active: true },
  { id: "u_ops", name: "Ops Lead", email: "ops@example.invalid", role: "Operations", is_active: true },
  { id: "u_sup_assigned", name: "Assigned Supervisor", email: "sup_assigned@example.invalid", role: "Supervisor", is_active: true },
  { id: "u_sup_unassigned", name: "Unassigned Supervisor", email: "sup_unassigned@example.invalid", role: "Supervisor", is_active: true },
  { id: "u_tech", name: "Field Technician", email: "tech@example.invalid", role: "Technician", is_active: true, trade: "Fitter" },
  { id: "u_sales", name: "Sales Rep", email: "sales@example.invalid", role: "Sales", is_active: true },
  { id: "u_finance", name: "Finance Officer", email: "finance@example.invalid", role: "Finance", is_active: true },
  { id: "u_client", name: "Client Representative", email: "client@example.invalid", role: "Client Viewer", client_id: "c_mine_01", is_active: true }
];

async function apiRequest(base, user, method, path, body = null) {
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${generateToken(user)}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  };
  const response = await fetch(`${base}${path}`, options);
  let resBody = null;
  try {
    resBody = await response.json();
  } catch {
    resBody = null;
  }
  return { status: response.status, body: resBody };
}

test("Phase 4 Operational Delivery: Full Journey, Authority Boundaries, Roster Scoping, and Integrity Controls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orac-phase4-delivery-"));
  const file = join(dir, "db.json");
  const store = createStore(file);
  let server;

  try {
    const { db, release } = await store.read();
    db.users = structuredClone(testUsers);
    db.clients = [
      { id: "c_mine_01", name: "Kwekwe Gold Mine", is_active: true, timesheet_cutover_date: "2026-01-01" }
    ];
    db.quotes = [
      {
        id: "q_phase4",
        quote_number: "Q-2026-P4",
        client_id: "c_mine_01",
        status: "Approved_Pending_PO",
        total_amount: 800,
        currency: "USD",
        created_by: "u_sales"
      }
    ];
    db.quote_lines = [
      {
        id: "line_p4_01",
        quotation_id: "q_phase4",
        description: "Hydraulic Pump Overhaul",
        quantity: 8,
        unit_price: 100,
        line_total: 800
      }
    ];
    db.purchase_orders = [
      {
        id: "po_p4_01",
        quotation_id: "q_phase4",
        po_reference: "PO-KW-2026-800",
        po_amount: 800,
        status: "pending",
        requires_amendment: false
      }
    ];
    db.dispatch_cards = [];
    db.field_worksheets = [];
    db.audit_logs = [];
    await store.write(db, release);

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/api", persistenceMiddleware(store));
    app.use("/api", apiRouter);
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));

    server = await new Promise((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const base = `http://127.0.0.1:${server.address().port}/api`;

    const admin = testUsers[0];
    const ops = testUsers[1];
    const supAssigned = testUsers[2];
    const supUnassigned = testUsers[3];
    const tech = testUsers[4];
    const sales = testUsers[5];
    const finance = testUsers[6];
    const client = testUsers[7];

    const transitionPath = "/quotes/q_phase4/transition";

    // 1. Dispatch before PO verification is blocked
    const earlyDispatch = await apiRequest(base, ops, "POST", transitionPath, { target_state: "Field_Dispatch" });
    assert.equal(earlyDispatch.status, 400, "Cannot dispatch from Approved_Pending_PO");
    assert.match(earlyDispatch.body.message, /Illegal transition/);

    // 2. Only Finance and Admin can verify PO
    const opsPoVerify = await apiRequest(base, ops, "POST", "/quotes/q_phase4/po", {
      po_reference: "PO-KW-2026-800", po_amount: 800
    });
    assert.equal(opsPoVerify.status, 403, "Operations cannot verify PO");

    const supPoVerify = await apiRequest(base, supAssigned, "POST", "/quotes/q_phase4/po", {
      po_reference: "PO-KW-2026-800", po_amount: 800
    });
    assert.equal(supPoVerify.status, 403, "Supervisor cannot verify PO");

    // 3. Finance verifies PO -> advances quote to PO_Verified
    const financeVerify = await apiRequest(base, finance, "POST", "/quotes/q_phase4/po", {
      po_reference: "PO-KW-2026-800", po_amount: 800
    });
    assert.equal(financeVerify.status, 200, "Finance verifies PO successfully");
    assert.equal(financeVerify.body.quote.status, "PO_Verified");
    assert.equal(financeVerify.body.data.verified_by, finance.id);

    // 4. Dispatch Authority Rejections: Supervisor, Sales, Technician, Client cannot dispatch
    const supDispatch = await apiRequest(base, supAssigned, "POST", transitionPath, { target_state: "Field_Dispatch" });
    assert.equal(supDispatch.status, 403, "Supervisor is forbidden from dispatching quotes");

    const salesDispatch = await apiRequest(base, sales, "POST", transitionPath, { target_state: "Field_Dispatch" });
    assert.equal(salesDispatch.status, 403, "Sales is forbidden from dispatching quotes");

    const techDispatch = await apiRequest(base, tech, "POST", transitionPath, { target_state: "Field_Dispatch" });
    assert.equal(techDispatch.status, 403, "Technician is forbidden from dispatching quotes");

    const clientDispatch = await apiRequest(base, client, "POST", transitionPath, { target_state: "Field_Dispatch" });
    assert.equal(clientDispatch.status, 403, "Client Viewer is forbidden from dispatching quotes");

    // 5. Operations dispatches quote successfully -> creates dispatch_card
    const opsDispatch = await apiRequest(base, ops, "POST", transitionPath, { target_state: "Field_Dispatch" });
    assert.equal(opsDispatch.status, 200, "Operations dispatches PO_Verified quote");
    const createdDispatch = opsDispatch.body.data.created;
    assert.ok(createdDispatch.id, "Dispatch card must have an id");
    const dispatchId = createdDispatch.id;

    // Assign supervisor to the dispatch card
    const assignSup = await apiRequest(base, ops, "POST", `/dispatch_cards/${dispatchId}/supervisor`, {
      supervisor_id: supAssigned.id
    });
    assert.equal(assignSup.status, 200, "Operations assigns supervisor to dispatch");

    // 6. Roster read scoping:
    // - Operations can read roster
    const opsRoster = await apiRequest(base, ops, "GET", `/dispatch_cards/${dispatchId}/roster`);
    assert.equal(opsRoster.status, 200, "Operations can read dispatch roster");

    // - Admin can read roster
    const adminRoster = await apiRequest(base, admin, "GET", `/dispatch_cards/${dispatchId}/roster`);
    assert.equal(adminRoster.status, 200, "Admin can read dispatch roster");

    // - Assigned supervisor can read roster
    const assignedSupRoster = await apiRequest(base, supAssigned, "GET", `/dispatch_cards/${dispatchId}/roster`);
    assert.equal(assignedSupRoster.status, 200, "Assigned supervisor can read dispatch roster");

    // - Unassigned supervisor is REJECTED from reading roster
    const unassignedSupRoster = await apiRequest(base, supUnassigned, "GET", `/dispatch_cards/${dispatchId}/roster`);
    assert.equal(unassignedSupRoster.status, 403, "Unassigned supervisor cannot read dispatch roster");

    // - Technician / Sales / Client Viewer have no viewDispatchRoster permission
    const techRoster = await apiRequest(base, tech, "GET", `/dispatch_cards/${dispatchId}/roster`);
    assert.equal(techRoster.status, 403, "Technician cannot view dispatch roster");

    // 7. Field Work & Timesheet Submission:
    // Roster the technician first
    const rosterTech = await apiRequest(base, ops, "POST", `/dispatch_cards/${dispatchId}/roster`, {
      technician_id: tech.id
    });
    assert.equal(rosterTech.status, 200, "Technician rostered successfully");

    // Technician creates/submits worksheet
    const worksheetPayload = {
      activity: "Overhauled hydraulic pump components and replaced seals",
      hours_breakdown: { normal: 6, ot_15: 0, ot_20: 0 },
      work_date: "2026-03-10",
      technician_id: tech.id,
      worker_type: "technician",
      signatures: {
        employee: {
          name: "Field Technician",
          date: "2026-03-10",
          method: "on_device",
          attest: true
        }
      },
      submit: true
    };
    const techWs = await apiRequest(base, tech, "POST", `/dispatch_cards/${dispatchId}/worksheets`, worksheetPayload);
    assert.equal(techWs.status, 200, "Technician creates and submits field worksheet");
    const wsId = techWs.body.data.id;
    assert.equal(techWs.body.data.status, "Submitted");

    // 8. Supervisor Review Gate:
    // Supervisor CANNOT approve a worksheet that is only Submitted (not yet Client_Acknowledged)
    const prematureReview = await apiRequest(base, supAssigned, "POST", `/field_worksheets/${wsId}/review`, {
      decision: "approve"
    });
    assert.equal(prematureReview.status, 400, "Supervisor review blocked before client acknowledgement");
    assert.match(prematureReview.body.message, /acknowledged/i);

    // 9. Client Acknowledgement:
    // Client acknowledges the worksheet
    const clientAck = await apiRequest(base, client, "POST", `/field_worksheets/${wsId}/client-acknowledge`, {
      signer_name: "Takudzwa M.",
      signer_role: "Site Maintenance Manager",
      acknowledgement: true
    });
    assert.equal(clientAck.status, 200, "Client acknowledges submitted worksheet");
    assert.equal(clientAck.body.data.status, "Client_Acknowledged");

    // 10. Reviewer Separation & Self-Approval Prevention:
    // - Technician cannot self-approve their own worksheet
    const selfApprove = await apiRequest(base, tech, "POST", `/field_worksheets/${wsId}/review`, {
      decision: "approve"
    });
    assert.equal(selfApprove.status, 403, "Technician cannot review or approve worksheet");

    // - Finance officer who verified PO cannot approve the worksheet
    const financeApprove = await apiRequest(base, finance, "POST", `/field_worksheets/${wsId}/review`, {
      decision: "approve"
    });
    assert.equal(financeApprove.status, 403, "Finance / PO verifier cannot approve field worksheet");

    // - Unassigned supervisor cannot approve
    const unassignedApprove = await apiRequest(base, supUnassigned, "POST", `/field_worksheets/${wsId}/review`, {
      decision: "approve"
    });
    assert.equal(unassignedApprove.status, 403, "Unassigned supervisor cannot approve worksheet");

    // 11. Assigned Supervisor Review Success:
    const supApprove = await apiRequest(base, supAssigned, "POST", `/field_worksheets/${wsId}/review`, {
      decision: "approve",
      comment: "All hydraulic seals inspected and pressure tests verified."
    });
    assert.equal(supApprove.status, 200, "Assigned supervisor approves worksheet");
    assert.equal(supApprove.body.data.status, "Supervisor_Approved");

    // 12. Verification of State & Audit Integrity:
    const dbFinal = JSON.parse(readFileSync(file, "utf8"));
    const finalJob = dbFinal.dispatch_cards.find((j) => j.id === dispatchId);
    assert.ok(finalJob, "Dispatch card persisted");

    const finalWs = dbFinal.field_worksheets.find((w) => w.id === wsId);
    assert.equal(finalWs.status, "Supervisor_Approved");
    assert.equal(finalWs.approved_by, supAssigned.id);
    assert.ok(finalWs.client_acknowledgement?.acknowledged_at, "Client acknowledgement recorded");
    assert.equal(finalWs.client_acknowledgement?.signer_name, "Takudzwa M.");

    // Invoice readiness check
    const block = invoiceReadinessBlock(dbFinal, finalJob);
    assert.equal(block, null, "Work is ready for invoicing within PO ceiling");

  } finally {
    server?.closeAllConnections?.();
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
