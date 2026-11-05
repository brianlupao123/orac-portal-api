/**
 * tests/salesPortfolioReconciliation.test.js
 * Comprehensive automated regression matrix for Sales Portfolio Reconciliation.
 * Run with: node --test tests/salesPortfolioReconciliation.test.js
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// Verified Production Module Imports
import { roles, permissions, hasPermission, requirePermission } from "../src/permissions.js";
import { transitionQuote, allowedTransitions } from "../src/stateMachine.js";
import { isQuoteInSalesPortfolio, isDispatchInSalesPortfolio, isInvoiceInSalesPortfolio } from "../src/controllers/coreController.js";
import { getInvoiceSettlement } from "../src/controllers/invoiceSettlementController.js";
import { issueLegacyInvoiceDraft } from "../src/controllers/legacyInvoiceDraftController.js";
import { assignCommercialOwnership } from "../src/controllers/adminController.js";
import { calculateLegacyInvoiceAmounts } from "../src/invoiceReadiness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

// Mock Response Factory
function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

// Mock Store Factory matching store API (store.id, store.audit)
function createMockStore() {
  return {
    driver: "mock",
    id(prefix) {
      return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    },
    audit(db, actor, entityType, entityId, action, oldValues, newValues) {
      (db.audit_logs ||= []).push({
        id: this.id("audit"),
        actor_id: actor?.id || "system",
        entity_type: entityType,
        entity_id: entityId,
        action,
        old_values: oldValues,
        new_values: newValues,
        created_at: new Date().toISOString()
      });
    }
  };
}

// Candidate calculation helper mirroring legacyInvoiceDraftController.js
function buildCandidate(db, dispatch, quote) {
  const amounts = calculateLegacyInvoiceAmounts(db, dispatch, quote);
  const po = (db.purchase_orders || []).find((item) => item.id === dispatch.purchase_order_id || item.quotation_id === quote.id);
  const snapshot = {
    dispatch_card_id: dispatch.id,
    quotation_id: quote.id,
    quotation_revision: quote.revision_number || quote.version || null,
    purchase_order_id: po?.id || null,
    purchase_order_amount: po?.po_amount || null,
    tax_status: quote.tax_status || null,
    currency: "USD",
    labor_total: amounts.laborTotal,
    material_total: amounts.materialTotal,
    total: amounts.total,
    worksheet_ids: (amounts.timesheets || []).map((item) => item.source_worksheet_id || item.id).sort(),
    material_ids: (amounts.materials || []).map((item) => item.id).sort()
  };
  return { ...snapshot, candidate_hash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") };
}

function createTestDb() {
  return {
    users: [
      { id: "usr_admin_1", name: "System Admin", role: roles.ADMIN, is_active: true },
      { id: "usr_mgmt_1", name: "Executive Manager", role: roles.MANAGEMENT, is_active: true },
      { id: "usr_fin_1", name: "Chief Financial Officer", role: roles.FINANCE, is_active: true },
      { id: "usr_fin_2", name: "Financial Controller", role: roles.FINANCE, is_active: true },
      { id: "usr_ops_1", name: "Head of Operations", role: roles.OPERATIONS, is_active: true },
      { id: "usr_sales_1", name: "Alice (Sales Alpha)", role: roles.SALES, is_active: true },
      { id: "usr_sales_2", name: "Bob (Sales Beta)", role: roles.SALES, is_active: true },
      { id: "usr_sales_3", name: "Carol (Sales Gamma)", role: roles.SALES, is_active: true },
      { id: "usr_sales_inactive", name: "Dan Inactive", role: roles.SALES, is_active: false },
      { id: "usr_tech_1", name: "Tom Technician", role: roles.TECHNICIAN, is_active: true }
    ],
    clients: [
      {
        id: "cli_alpha",
        name: "Alpha Corp (Alice Portfolio)",
        primary_sales_owner_id: "usr_sales_1",
        account_team_user_ids: ["usr_sales_2"]
      },
      {
        id: "cli_beta",
        name: "Beta Mining (Bob Portfolio)",
        primary_sales_owner_id: "usr_sales_2",
        account_team_user_ids: []
      },
      {
        id: "cli_orphan",
        name: "Orphan Industries (Unassigned)",
        primary_sales_owner_id: null,
        account_team_user_ids: []
      }
    ],
    quotes: [
      {
        id: "qte_alpha_1",
        quotation_number: "Q-2026-A1",
        client_id: "cli_alpha",
        sales_owner_id: "usr_sales_1",
        account_team_user_ids: [],
        status: "Field_Dispatch",
        total_amount: "3500.00",
        grand_total_cents: 350000,
        discount_percent: 0,
        tax_status: "taxable",
        tax_approved: true,
        created_by: "usr_sales_1"
      },
      {
        id: "qte_beta_1",
        quotation_number: "Q-2026-B1",
        client_id: "cli_beta",
        sales_owner_id: "usr_sales_2",
        account_team_user_ids: [],
        status: "Sent",
        total_amount: "6500.00",
        grand_total_cents: 650000,
        discount_percent: 0,
        tax_status: "taxable",
        tax_approved: true,
        created_by: "usr_sales_2"
      },
      {
        id: "qte_author_not_owner",
        quotation_number: "Q-2026-DISOWNED",
        client_id: "cli_orphan",
        sales_owner_id: null,
        account_team_user_ids: [],
        status: "Draft",
        created_by: "usr_sales_1"
      }
    ],
    quote_lines: [
      { id: "ql_1", quotation_id: "qte_alpha_1", quantity: 1, unit_price: "3500.00", line_total: 3500 },
      { id: "ql_2", quotation_id: "qte_beta_1", quantity: 1, unit_price: "6500.00", line_total: 6500 }
    ],
    purchase_orders: [
      {
        id: "po_alpha_1",
        quotation_id: "qte_alpha_1",
        po_reference: "PO-ALPHA-99",
        po_amount: 3500,
        status: "verified"
      }
    ],
    dispatch_cards: [
      {
        id: "dsp_alpha_1",
        quotation_id: "qte_alpha_1",
        purchase_order_id: "po_alpha_1",
        status: "Completed",
        client_id: "cli_alpha"
      },
      {
        id: "dsp_beta_1",
        quotation_id: "qte_beta_1",
        status: "In_Progress",
        client_id: "cli_beta"
      }
    ],
    field_worksheets: [
      {
        id: "ws_alpha_1",
        dispatch_card_id: "dsp_alpha_1",
        status: "Supervisor_Approved", // Explicitly Supervisor_Approved as required
        evidence_files: ["photo_bearing.png"],
        hours_breakdown: { normal: 8, time_and_a_half: 0, double_time: 0 },
        hours: 8,
        supervisor_approved_at: "2026-11-01T10:00:00Z"
      }
    ],
    invoices: [
      { id: "inv_alpha_1", invoice_number: "INV-A1", quotation_id: "qte_alpha_1", dispatch_card_id: "dsp_alpha_1", total_amount: "3500.00", total_amount_cents: 350000, status: "Issued" },
      { id: "inv_beta_1", invoice_number: "INV-B1", quotation_id: "qte_beta_1", dispatch_card_id: "dsp_beta_1", total_amount: "6500.00", total_amount_cents: 650000, status: "Issued" }
    ],
    invoice_lines: [],
    invoice_payments: [
      {
        id: "pay_1",
        invoice_id: "inv_alpha_1",
        amount: "3500.00",
        currency: "USD",
        payment_method: "EFT",
        reference: "BANK-CONFIDENTIAL-REF-9988",
        received_on: "2026-11-01",
        notes: "Internal debt collector note: confirmed clearing with Standard Bank"
      }
    ],
    invoice_credit_notes: [],
    material_usage: [],
    legacy_invoice_drafts: [],
    legacy_invoice_idempotency: [],
    audit_logs: [],
    commercial_ownership_audit: []
  };
}

describe("ORAC Sales Portfolio Reconciliation Matrix", () => {
  let db;
  let mockStore;
  let salesAlice;
  let salesBob;
  let opsUser;
  let mgmtUser;
  let finUser1;
  let finUser2;
  let adminUser;

  beforeEach(() => {
    db = createTestDb();
    mockStore = createMockStore();
    salesAlice = db.users.find((u) => u.id === "usr_sales_1");
    salesBob = db.users.find((u) => u.id === "usr_sales_2");
    opsUser = db.users.find((u) => u.id === "usr_ops_1");
    mgmtUser = db.users.find((u) => u.id === "usr_mgmt_1");
    finUser1 = db.users.find((u) => u.id === "usr_fin_1");
    finUser2 = db.users.find((u) => u.id === "usr_fin_2");
    adminUser = db.users.find((u) => u.id === "usr_admin_1");
  });

  // GAP 1: Executable Child-Process Proof (Zero HTTP Listeners)
  test("SEC-CLI-01: Importing reconcileCommercialOwnership does not start an HTTP listener or invoke server.js", async () => {
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      "import('./src/commands/reconcileCommercialOwnership.js');"
    ], {
      cwd: projectRoot,
      timeout: 2500,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    const [exitCode, signal] = await new Promise((resolve) => {
      child.on("exit", (code, sig) => resolve([code, sig]));
      child.on("error", (err) => resolve([-1, err.message]));
    });

    assert.equal(signal, null, "Child process must not be killed by timeout (indicates hanging HTTP server)");
    assert.equal(exitCode, 0, `CLI import must exit promptly with code 0. Stderr: ${stderr}`);
    assert.ok(!stdout.includes("Orac-IOS running at"), "Server startup banner must never appear on CLI import");
  });

  // GAP 2: Controller-Level Settlement Redaction (Real getInvoiceSettlement Invocation)
  test("SEC-RED-03: Controller-level getInvoiceSettlement returns ONLY 8 aggregate/status fields for Sales and returns 403 on cross-portfolio", () => {
    // 1. Authorized Sales Portfolio Request
    const reqAlice = {
      db,
      user: { id: salesAlice.id },
      params: { id: "inv_alpha_1" }
    };
    const resAlice = createMockRes();
    getInvoiceSettlement(reqAlice, resAlice);

    assert.equal(resAlice.statusCode, 200, "Sales must access invoices in their own portfolio");
    assert.equal(resAlice.body.success, true);

    const data = resAlice.body.data;
    const returnedKeys = Object.keys(data).sort();
    const expectedKeys = [
      "credit_note_total",
      "currency",
      "invoice_id",
      "invoice_number",
      "invoice_total",
      "outstanding_total",
      "received_total",
      "settlement_status"
    ].sort();

    assert.deepEqual(returnedKeys, expectedKeys, "Sales response must contain strictly the 8 authorized fields");
    assert.equal(data.currency, "USD");
    assert.equal(data.invoice_total, 3500);
    assert.equal(data.received_total, 3500);
    assert.equal(data.outstanding_total, 0);

    // Assert complete absence of payment/credit note rows and internal details
    assert.equal(data.payments, undefined, "payments array must be absent");
    assert.equal(data.credit_notes, undefined, "credit_notes array must be absent");
    assert.equal(data.payment_method, undefined);
    assert.equal(data.reference, undefined);
    assert.equal(data.notes, undefined);

    // 2. Cross-Portfolio Sales Request (inv_beta_1 belongs to Bob)
    const reqCross = {
      db,
      user: { id: salesAlice.id },
      params: { id: "inv_beta_1" }
    };
    const resCross = createMockRes();
    getInvoiceSettlement(reqCross, resCross);

    assert.equal(resCross.statusCode, 403, "Cross-portfolio access must return 403 Forbidden");
    assert.equal(resCross.body.success, false);
  });

  // GAP 3: Complete Real Maker-Checker Controller Test (issueLegacyInvoiceDraft)
  test("SEC-FIN-01: issueLegacyInvoiceDraft controller enforces two-person maker-checker, denies Sales, and audits issuance", () => {
    const dispatch = db.dispatch_cards.find((d) => d.id === "dsp_alpha_1");
    const quote = db.quotes.find((q) => q.id === "qte_alpha_1");

    // Prepare a valid invoice draft prepared by Finance User 1
    const candidateData = buildCandidate(db, dispatch, quote);
    const draft = {
      id: "lidraft_prep_fin1",
      dispatch_card_id: dispatch.id,
      quotation_id: quote.id,
      purchase_order_id: "po_alpha_1",
      status: "prepared",
      prepared_by: finUser1.id,
      prepared_at: new Date().toISOString(),
      candidate: candidateData,
      idempotency_key: "draft_key_fin1",
      idempotency_fingerprint: "hash_fin1"
    };
    db.legacy_invoice_drafts.push(draft);

    // 1. Preparer (finUser1) tries to issue their own draft -> HTTP 403 LEGACY_INVOICE_TWO_PERSON_REQUIRED
    const reqPreparer = {
      db,
      store: mockStore,
      user: { id: finUser1.id },
      params: { id: draft.id },
      body: { idempotency_key: "issue_key_prep_attempt" }
    };
    const resPreparer = createMockRes();
    issueLegacyInvoiceDraft(reqPreparer, resPreparer);

    assert.equal(resPreparer.statusCode, 403, "Preparer must be refused with 403");
    assert.equal(resPreparer.body.code, "LEGACY_INVOICE_TWO_PERSON_REQUIRED");
    assert.equal(draft.status, "prepared", "Draft status must remain prepared after refusal");

    // 2. Sales (salesAlice) tries to issue the draft -> Permission refusal (403)
    const reqSales = {
      db,
      store: mockStore,
      user: { id: salesAlice.id },
      params: { id: draft.id },
      body: { idempotency_key: "issue_key_sales_attempt" }
    };
    const resSales = createMockRes();
    assert.throws(
      () => issueLegacyInvoiceDraft(reqSales, resSales),
      /cannot perform issueLegacyInvoiceDraft/,
      "Sales must be denied issueLegacyInvoiceDraft permission"
    );

    // 3. Independent Finance User (finUser2) issues the draft -> HTTP 201
    const reqIndependent = {
      db,
      store: mockStore,
      user: { id: finUser2.id },
      params: { id: draft.id },
      body: { idempotency_key: "issue_key_fin2_success" }
    };
    const resIndependent = createMockRes();
    issueLegacyInvoiceDraft(reqIndependent, resIndependent);

    assert.equal(resIndependent.statusCode, 201, "Independent Finance user must succeed with HTTP 201");
    assert.equal(resIndependent.body.success, true);
    assert.ok(resIndependent.body.data.id, "Issued invoice object must be returned");

    // 4. Assert draft state updates and audit trail
    assert.equal(draft.status, "issued", "Draft status must become 'issued'");
    assert.equal(draft.issued_by, finUser2.id, "Draft issued_by must record Finance User 2");
    assert.ok(draft.issued_at, "Draft issued_at must be populated");
    assert.equal(draft.issued_invoice_id, resIndependent.body.data.id);

    // Verify LEGACY_INVOICE_DRAFT_ISSUED audit entry exists
    const auditEntry = db.audit_logs.find(
      (a) => a.action === "LEGACY_INVOICE_DRAFT_ISSUED" && a.entity_id === draft.id && a.actor_id === finUser2.id
    );
    assert.ok(auditEntry, "LEGACY_INVOICE_DRAFT_ISSUED audit log entry must exist in db.audit_logs");
  });

  // GAP 4: Complete Real assignCommercialOwnership Controller Invocation
  test("SEC-VAL-01: Real assignCommercialOwnership controller validates active Sales, deduplicates team, rejects primary in team, rejects malformed IDs, and audits diffs", () => {
    // 1. Valid Admin/Management assignment succeeds and audits prior/final state
    const reqValid = {
      db,
      store: mockStore,
      user: { id: adminUser.id },
      body: {
        target_entity: "client",
        target_id: "cli_orphan",
        owner_id: "usr_sales_1",
        account_team_user_ids: ["usr_sales_2", "usr_sales_3"],
        reason: "Initial commercial portfolio assignment per Q4 directive"
      }
    };
    const resValid = createMockRes();
    assignCommercialOwnership(reqValid, resValid);

    assert.equal(resValid.statusCode, 200, "Valid assignment must return 200");
    assert.equal(resValid.body.success, true);

    const updatedClient = db.clients.find((c) => c.id === "cli_orphan");
    assert.equal(updatedClient.primary_sales_owner_id, "usr_sales_1");
    assert.deepEqual(updatedClient.account_team_user_ids, ["usr_sales_2", "usr_sales_3"]);

    // Verify audit entry contains prior and final structures
    const auditLog = db.audit_logs.find((a) => a.action === "COMMERCIAL_OWNERSHIP_ASSIGNED" && a.entity_id === "cli_orphan");
    assert.ok(auditLog, "COMMERCIAL_OWNERSHIP_ASSIGNED audit record must exist");
    assert.equal(auditLog.old_values.primary_sales_owner_id, null);
    assert.equal(auditLog.new_values.primary_sales_owner_id, "usr_sales_1");
    assert.equal(auditLog.new_values.reason, "Initial commercial portfolio assignment per Q4 directive");

    // 2. Duplicate team IDs are stored once
    const reqDup = {
      db,
      store: mockStore,
      user: { id: adminUser.id },
      body: {
        target_entity: "quote",
        target_id: "qte_alpha_1",
        owner_id: "usr_sales_1",
        account_team_user_ids: ["usr_sales_2", "usr_sales_2", "usr_sales_3"],
        reason: "Reassignment to test team deduplication logic"
      }
    };
    const resDup = createMockRes();
    assignCommercialOwnership(reqDup, resDup);

    assert.equal(resDup.statusCode, 200);
    const updatedQuote = db.quotes.find((q) => q.id === "qte_alpha_1");
    assert.deepEqual(updatedQuote.account_team_user_ids, ["usr_sales_2", "usr_sales_3"], "Duplicate IDs must be stored once");

    // 3. Primary owner within team is rejected
    const reqPrimaryInTeam = {
      db,
      store: mockStore,
      user: { id: adminUser.id },
      body: {
        target_entity: "client",
        target_id: "cli_orphan",
        owner_id: "usr_sales_1",
        account_team_user_ids: ["usr_sales_1", "usr_sales_2"],
        reason: "Attempt to put primary owner in account team"
      }
    };
    const resPrimaryInTeam = createMockRes();
    assignCommercialOwnership(reqPrimaryInTeam, resPrimaryInTeam);

    assert.equal(resPrimaryInTeam.statusCode, 400);
    assert.match(resPrimaryInTeam.body.message, /Primary owner cannot also appear in account_team_user_ids/);

    // 4. Inactive team member is rejected
    const reqInactiveTeam = {
      db,
      store: mockStore,
      user: { id: adminUser.id },
      body: {
        target_entity: "client",
        target_id: "cli_orphan",
        owner_id: "usr_sales_1",
        account_team_user_ids: ["usr_sales_inactive"],
        reason: "Attempt to assign inactive sales user to team"
      }
    };
    const resInactiveTeam = createMockRes();
    assignCommercialOwnership(reqInactiveTeam, resInactiveTeam);

    assert.equal(resInactiveTeam.statusCode, 400);
    assert.match(resInactiveTeam.body.message, /must be an active Sales user/);

    // 5. Non-Sales team member is rejected
    const reqNonSalesTeam = {
      db,
      store: mockStore,
      user: { id: adminUser.id },
      body: {
        target_entity: "client",
        target_id: "cli_orphan",
        owner_id: "usr_sales_1",
        account_team_user_ids: ["usr_tech_1"],
        reason: "Attempt to assign technician to sales team"
      }
    };
    const resNonSalesTeam = createMockRes();
    assignCommercialOwnership(reqNonSalesTeam, resNonSalesTeam);

    assert.equal(resNonSalesTeam.statusCode, 400);
    assert.match(resNonSalesTeam.body.message, /must be an active Sales user/);

    // 6. Malformed IDs are rejected
    const reqMalformed = {
      db,
      store: mockStore,
      user: { id: adminUser.id },
      body: {
        target_entity: "client",
        target_id: "bad id with spaces!!",
        owner_id: "usr_sales_1",
        account_team_user_ids: [],
        reason: "Attempt with malformed ID string"
      }
    };
    const resMalformed = createMockRes();
    assignCommercialOwnership(reqMalformed, resMalformed);

    assert.equal(resMalformed.statusCode, 400);
    assert.match(resMalformed.body.message, /Invalid target_id format/);

    // 7. created_by NEVER grants Sales portfolio access
    const disownedQuote = db.quotes.find((q) => q.id === "qte_author_not_owner");
    disownedQuote.client_id = "cli_beta"; // cli_beta is explicitly owned by Bob (usr_sales_2)
    assert.equal(disownedQuote.created_by, "usr_sales_1");
    assert.equal(isQuoteInSalesPortfolio(disownedQuote, salesAlice, db), false, "created_by must never grant portfolio visibility");

    // Also assert that a quote with ONLY created_by (no sales_owner_id and unassigned client) stays hidden
    const orphanQuoteOnlyCreatedBy = {
      id: "qte_orphan_created_by",
      created_by: "usr_sales_1",
      sales_owner_id: null,
      client_id: null,
      account_team_user_ids: []
    };
    assert.equal(
      isQuoteInSalesPortfolio(orphanQuoteOnlyCreatedBy, salesAlice, db),
      false,
      "A quote with only created_by and no sales_owner_id must strictly stay hidden from Sales portfolio"
    );
  });

  // GAP 5: Quote Authority Review (Operations Denied; Management Gate Enforced)
  test("SEC-OPS-02: Operations has zero quotation approval authority; Management gate enforced above USD 5,000", () => {
    // 1. Operations has NO approveQuote permission
    assert.equal(hasPermission(opsUser, "approveQuote"), false, "Operations must not have approveQuote authority");
    assert.equal(hasPermission(mgmtUser, "approveQuote"), true, "Management has approveQuote");
    assert.equal(hasPermission(salesBob, "approveQuote"), true, "Sales has approveQuote (for colleague quotes)");

    // 2. Sales cannot approve own quote
    const ownQuote = db.quotes.find((q) => q.id === "qte_alpha_1");
    ownQuote.status = "Sent";
    ownQuote.sent_by = salesAlice.id;
    assert.throws(
      () => transitionQuote(db, mockStore, ownQuote.id, "Approved_Pending_PO", {}, salesAlice),
      /Sales cannot approve a quote they personally sent/
    );

    // 3. Management approval mandatory above USD 5,000
    const highValueQuote = db.quotes.find((q) => q.id === "qte_beta_1");
    assert.throws(
      () => transitionQuote(db, mockStore, highValueQuote.id, "Approved_Pending_PO", {}, salesAlice),
      /require Management approval/
    );
    assert.doesNotThrow(() => {
      transitionQuote(db, mockStore, highValueQuote.id, "Approved_Pending_PO", {}, mgmtUser);
    });
    assert.equal(highValueQuote.status, "Approved_Pending_PO");
  });

  // PROOF OF DRY-RUN: reconcileCommercialOwnership command
  test("SEC-REC-DRY-01: reconcileCommercialOwnership validates staging and executes non-mutating dry run", async () => {
    const { runReconciliation } = await import("../src/commands/reconcileCommercialOwnership.js");
    const { store } = await import("../src/configuredStore.js");
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const tmpMappingPath = join(__dirname, "tmp_test_mapping.json");

    // Write a temporary valid mapping file for real db client
    writeFileSync(tmpMappingPath, JSON.stringify({
      clients: [
        {
          client_id: "c_zimplats",
          primary_sales_owner_id: "u_sales",
          account_team_user_ids: []
        }
      ],
      quotes: []
    }));

    // Capture the BEFORE state of the client to verify non-mutation
    const { db: beforeDb, release: beforeRelease } = await store.read({ lock: false });
    const beforeOwner = beforeDb.clients.find((c) => c.id === "c_zimplats")?.primary_sales_owner_id;
    await store.release(beforeRelease);

    try {
      const result = await runReconciliation([
        "node",
        "reconcileCommercialOwnership.js",
        `--mapping-file=${tmpMappingPath}`,
        `--actor-id=u_admin`,
        `--reason=Automated test proof of dry-run reconciliation without mutations`,
        "--dry-run"
      ]);

      assert.equal(result.success, true);
      assert.equal(result.dryRun, true);

      // Verify non-mutation: client in store must be unchanged from before the dry run
      const { db: realDb, release } = await store.read({ lock: false });
      const client = realDb.clients.find((c) => c.id === "c_zimplats");
      assert.equal(client.primary_sales_owner_id, beforeOwner, "Dry run must NOT mutate store");
      await store.release(release);
    } finally {
      try { unlinkSync(tmpMappingPath); } catch {}
    }
  });
});
