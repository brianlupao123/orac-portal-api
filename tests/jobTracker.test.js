import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobActuals } from "../src/jobActuals.js";
import { getJobTracker } from "../src/controllers/jobTrackerController.js";
import { roles } from "../src/permissions.js";
import apiRouter from "../src/router.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { createStore } from "../src/store.js";
import { generateToken } from "../src/middleware/auth.js";

function makeMockDb() {
  return {
    users: [
      { id: "u_admin", role: roles.ADMIN, name: "Alice Admin", is_active: true },
      { id: "u_mgmt", role: roles.MANAGEMENT, name: "Mark Manager", is_active: true },
      { id: "u_ops", role: roles.OPERATIONS, name: "Oliver Ops", is_active: true },
      { id: "u_fin", role: roles.FINANCE, name: "Fiona Finance", is_active: true },
      { id: "u_sales_a", role: roles.SALES, name: "Sam Sales A", is_active: true },
      { id: "u_sales_b", role: roles.SALES, name: "Sally Sales B", is_active: true },
      { id: "u_sup", role: roles.SUPERVISOR, name: "Super Dan", is_active: true },
      { id: "u_tech", role: roles.TECHNICIAN, name: "Tom Tech", is_active: true },
      { id: "u_client", role: roles.CLIENT_VIEWER, client_id: "c_mine", name: "Carl Client", is_active: true }
    ],
    clients: [
      { id: "c_mine", name: "Anglo American Platinum", is_active: true }
    ],
    mine_sites: [
      { id: "ms_site1", client_id: "c_mine", name: "Mogalakwena North" }
    ],
    quotes: [
      {
        id: "q_draft",
        quote_number: "Q-DRAFT",
        client_id: "c_mine",
        status: "Draft",
        sales_owner_id: "u_sales_a",
        created_at: "2026-11-01T08:00:00Z"
      },
      {
        id: "q_cancelled",
        quote_number: "Q-CANCEL",
        client_id: "c_mine",
        status: "Cancelled",
        sales_owner_id: "u_sales_a",
        created_at: "2026-11-01T09:00:00Z"
      },
      {
        id: "q_pending_po",
        quote_number: "Q-101",
        client_id: "c_mine",
        status: "Approved_Pending_PO",
        sales_owner_id: "u_sales_a",
        created_at: "2026-11-02T10:00:00Z"
      },
      {
        id: "q_wip_a",
        quote_number: "Q-102",
        client_id: "c_mine",
        status: "Field_Dispatch",
        sales_owner_id: "u_sales_a",
        created_at: "2026-11-03T11:00:00Z"
      },
      {
        id: "q_sales_b",
        quote_number: "Q-201",
        client_id: "c_mine",
        status: "Approved_Pending_PO",
        sales_owner_id: "u_sales_b",
        created_at: "2026-11-04T12:00:00Z"
      }
    ],
    purchase_orders: [
      {
        id: "po_102",
        quotation_id: "q_wip_a",
        po_number: "PO-MOG-9988",
        status: "Verified",
        verified_at: "2026-11-03T12:00:00Z"
      }
    ],
    dispatch_cards: [
      {
        id: "d_102",
        quotation_id: "q_wip_a",
        purchase_order_id: "po_102",
        dispatch_number: "DISP-102",
        status: "active",
        created_at: "2026-11-03T13:00:00Z"
      }
    ],
    field_worksheets: [
      {
        id: "ws_01_orig",
        timesheet_version: 2,
        dispatch_card_id: "d_102",
        technician_id: "u_tech",
        status: "Supervisor_Approved",
        hours: 8,
        hours_breakdown: { normal: 8, ot_15: 0, ot_20: 0 },
        superseded_by: "ws_01_rev1" // Should be EXCLUDED because superseded!
      },
      {
        id: "ws_01_rev1",
        timesheet_version: 2,
        dispatch_card_id: "d_102",
        technician_id: "u_tech",
        status: "Supervisor_Approved",
        hours: 10,
        hours_breakdown: { normal: 8, ot_15: 2, ot_20: 0 },
        superseded_by: null // Should be INCLUDED!
      },
      {
        id: "ws_draft",
        timesheet_version: 2,
        dispatch_card_id: "d_102",
        technician_id: "u_tech",
        status: "Draft",
        hours: 5,
        hours_breakdown: { normal: 5, ot_15: 0, ot_20: 0 },
        superseded_by: null // Excluded because not eligible (Draft)
      }
    ],
    daily_timesheets: [
      // Legacy / consolidated rows - must NEVER be double counted
      { id: "dt_01", dispatch_card_id: "d_102", hours: 10 }
    ],
    worksheet_registers: [
      { id: "reg_01", dispatch_card_id: "d_102", total_hours: 10 }
    ],
    invoices: [],
    audit_logs: [],
    sessions: []
  };
}

// ── 1. jobActuals Unit Tests ────────────────────────────────────────────────
test("jobActuals: accurately sums eligible field worksheets and ignores superseded ones", () => {
  const db = makeMockDb();
  const actuals = jobActuals(db, "d_102");

  // ws_01_orig (8h) was superseded by ws_01_rev1 (10h). ws_draft (5h) is not approved.
  // Expected total: 10h (not 18h, and not 20h if daily_timesheets were counted).
  assert.equal(actuals.total, 10);
  assert.equal(actuals.normal, 8);
  assert.equal(actuals.ot_15, 2);
  assert.equal(actuals.ot_20, 0);
  assert.deepEqual(actuals.ids, ["ws_01_rev1"]);
});

test("jobActuals: returns 0 hours for unknown dispatch or null db", () => {
  assert.equal(jobActuals(null, "d_102").total, 0);
  assert.equal(jobActuals(makeMockDb(), "d_nonexistent").total, 0);
});

// ── 2. Job Tracker Controller Authorization & Filter Tests ──────────────────
function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
}

test("getJobTracker: allows Admin, Management, Operations, Finance", () => {
  const db = makeMockDb();
  for (const role of [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.FINANCE]) {
    const user = db.users.find(u => u.role === role);
    const req = { db, user: { id: user.id } };
    const res = mockRes();
    getJobTracker(req, res);
    assert.equal(res.statusCode, 200, `Expected 200 for role ${role}`);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.data));
  }
});

test("getJobTracker: returns 403 Forbidden for Supervisor, Technician, Client Viewer", () => {
  const db = makeMockDb();
  for (const role of [roles.SUPERVISOR, roles.TECHNICIAN, roles.CLIENT_VIEWER]) {
    const user = db.users.find(u => u.role === role);
    const req = { db, user: { id: user.id } };
    const res = mockRes();
    getJobTracker(req, res);
    assert.equal(res.statusCode, 403, `Expected 403 for role ${role}`);
    assert.equal(res.body.success, false);
    assert.match(res.body.message, /cannot access Jobs Tracker/);
  }
});

test("getJobTracker: excludes Draft and Cancelled quotes", () => {
  const db = makeMockDb();
  const req = { db, user: { id: "u_admin" } };
  const res = mockRes();
  getJobTracker(req, res);

  assert.equal(res.statusCode, 200);
  const quoteNumbers = res.body.data.map(j => j.quote_number);
  assert.ok(!quoteNumbers.includes("Q-DRAFT"), "Draft quote must be excluded");
  assert.ok(!quoteNumbers.includes("Q-CANCEL"), "Cancelled quote must be excluded");
  assert.ok(quoteNumbers.includes("Q-101"), "Approved_Pending_PO quote must be included");
  assert.ok(quoteNumbers.includes("Q-102"), "Field_Dispatch quote must be included");
});

test("getJobTracker: payload contract excludes money and unmigrated reference fields", () => {
  const db = makeMockDb();
  const req = { db, user: { id: "u_admin" } };
  const res = mockRes();
  getJobTracker(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.data.length > 0);

  for (const job of res.body.data) {
    // Verified canonical fields must exist
    assert.ok(job.id);
    assert.ok(job.quote_id);
    assert.ok(job.quote_number);
    assert.ok(job.client_id);
    assert.ok(job.status);
    assert.ok(job.stage);
    assert.ok(job.created_at);

    // Strictly NO money fields
    assert.equal(job.total_amount, undefined);
    assert.equal(job.grand_total_cents, undefined);
    assert.equal(job.pre_tax_total_cents, undefined);
    assert.equal(job.tax_total_cents, undefined);
    assert.equal(job.hourly_rate, undefined);
    assert.equal(job.currency, undefined);
    assert.equal(job.amount, undefined);

    // Strictly NO unmigrated fields
    assert.equal(job.pastel_quote_reference, undefined);
    assert.equal(job.client_pr_reference, undefined);
  }
});

test("getJobTracker: Sales portfolio scoping isolates Sales A and Sales B", () => {
  const db = makeMockDb();

  // Sales A view
  const reqA = { db, user: { id: "u_sales_a" } };
  const resA = mockRes();
  getJobTracker(reqA, resA);
  assert.equal(resA.statusCode, 200);
  const quotesA = resA.body.data.map(j => j.quote_number);
  assert.ok(quotesA.includes("Q-101"), "Sales A should see their own quote Q-101");
  assert.ok(quotesA.includes("Q-102"), "Sales A should see their own quote Q-102");
  assert.ok(!quotesA.includes("Q-201"), "Sales A must NOT see Sales B's quote Q-201");

  // Sales B view
  const reqB = { db, user: { id: "u_sales_b" } };
  const resB = mockRes();
  getJobTracker(reqB, resB);
  assert.equal(resB.statusCode, 200);
  const quotesB = resB.body.data.map(j => j.quote_number);
  assert.ok(quotesB.includes("Q-201"), "Sales B should see their own quote Q-201");
  assert.ok(!quotesB.includes("Q-101"), "Sales B must NOT see Sales A's quote Q-101");
  assert.ok(!quotesB.includes("Q-102"), "Sales B must NOT see Sales A's quote Q-102");
});

// ── 3. HTTP Integration Test with Real Router ──────────────────────────────
test("HTTP /api/job-tracker: verifies router authentication, token enforcement, and role access", async () => {
  const db = makeMockDb();
  const dir = mkdtempSync(join(tmpdir(), "orac-tracker-test-"));
  const dbFile = join(dir, "store.json");
  writeFileSync(dbFile, JSON.stringify(db), "utf8");
  const store = createStore(dbFile);

  const app = express();
  app.use(express.json());
  app.use("/api", persistenceMiddleware(store));
  app.use("/api", apiRouter);

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  try {
    // 1. Unauthenticated request -> 401
    const unauthRes = await fetch(`${baseUrl}/job-tracker`);
    assert.equal(unauthRes.status, 401);

    // 2. Authenticated as Supervisor -> 403
    const supToken = generateToken(db.users.find(u => u.role === roles.SUPERVISOR));
    const supRes = await fetch(`${baseUrl}/job-tracker`, {
      headers: { Authorization: `Bearer ${supToken}` }
    });
    assert.equal(supRes.status, 403);

    // 3. Authenticated as Operations -> 200
    const opsToken = generateToken(db.users.find(u => u.role === roles.OPERATIONS));
    const opsRes = await fetch(`${baseUrl}/job-tracker`, {
      headers: { Authorization: `Bearer ${opsToken}` }
    });
    assert.equal(opsRes.status, 200);
    const opsData = await opsRes.json();
    assert.equal(opsData.success, true);
    assert.ok(opsData.data.length >= 2);

    // 4. Authenticated as Sales A -> 200, scoped to Sales A
    const salesAToken = generateToken(db.users.find(u => u.id === "u_sales_a"));
    const salesARes = await fetch(`${baseUrl}/job-tracker`, {
      headers: { Authorization: `Bearer ${salesAToken}` }
    });
    assert.equal(salesARes.status, 200);
    const salesAData = await salesARes.json();
    const salesAQuotes = salesAData.data.map(j => j.quote_number);
    assert.ok(salesAQuotes.includes("Q-101"));
    assert.ok(!salesAQuotes.includes("Q-201"));

    // 5. Authenticated as Sales B -> 200, scoped to Sales B
    const salesBToken = generateToken(db.users.find(u => u.id === "u_sales_b"));
    const salesBRes = await fetch(`${baseUrl}/job-tracker`, {
      headers: { Authorization: `Bearer ${salesBToken}` }
    });
    assert.equal(salesBRes.status, 200);
    const salesBData = await salesBRes.json();
    const salesBQuotes = salesBData.data.map(j => j.quote_number);
    assert.ok(salesBQuotes.includes("Q-201"));
    assert.ok(!salesBQuotes.includes("Q-101"));

  } finally {
    server.close();
  }
});
