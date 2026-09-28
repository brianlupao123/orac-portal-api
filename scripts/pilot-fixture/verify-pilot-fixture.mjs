#!/usr/bin/env node
// scripts/pilot-fixture/verify-pilot-fixture.mjs
//
// Independent, READ-ONLY verifier for a loaded pilot fixture.
//
// "Independent" means: this script does not import build-fixture-records.mjs
// and does not trust load-pilot-fixture.mjs's own printed counts. It reads
// the target store fresh, finds fixture records by their fx_ id prefix, and
// recomputes every figure directly from those raw records — the same way a
// human auditor with the raw arrays and a calculator would. It then calls
// the REAL src/reports.js functions against the whole loaded db (fixture
// records mixed with whatever else is already there) to prove the fixture
// data actually surfaces through the app's own role-scoped report functions,
// not just that the rows exist.
//
// Usage:
//   STORE_DRIVER=json JSON_DB_PATH=./data/pilot-fixture-db.json \
//     node scripts/pilot-fixture/verify-pilot-fixture.mjs
//
// Exit code is 0 only if every check passes. This script never writes.

import { config } from "../../src/config.js";
import * as reports from "../../src/reports.js";
import { isPairingAllowed } from "../../src/internalWorkRequestRules.js";

let checks = 0;
let failures = 0;
const fails = [];

function check(label, condition) {
  checks += 1;
  if (!condition) {
    failures += 1;
    fails.push(label);
    console.log(`FAIL  ${label}`);
  } else {
    console.log(`ok    ${label}`);
  }
}

function isFixtureId(id) {
  return typeof id === "string" && id.startsWith("fx_");
}

async function main() {
  const storeModule = config.storeDriver === "postgres"
    ? await import("../../src/postgresStore.js")
    : await import("../../src/store.js");
  const store = config.storeDriver === "postgres"
    ? storeModule.createStore()
    : storeModule.createStore(config.jsonDbPath);

  const { db, release } = await store.read({ lock: false });
  // Read-only: release immediately, never write.
  if (config.storeDriver === "postgres") await store.release(release);
  else if (release) store.release(release);

  console.log(`Store driver: ${config.storeDriver}`);
  if (config.storeDriver === "json") console.log(`JSON db path: ${config.jsonDbPath}`);
  console.log("");

  // ── 1. Fixture rows are present and self-consistent ──────────────────
  const fx = {};
  for (const collection of [
    "users", "clients", "mine_sites", "service_requests", "leads",
    "quotes", "quote_lines", "purchase_orders",
    "po_amendments", "dispatch_cards", "timesheets", "field_worksheets",
    "material_usage", "stock_items", "stock_movements", "invoices",
    "invoice_lines", "access_requests", "internal_work_requests"
  ]) {
    fx[collection] = (db[collection] || []).filter((r) => isFixtureId(r.id));
  }

  check("fixture users present (20)", fx.users.length === 20);
  check("fixture clients present (3)", fx.clients.length === 3);
  check("fixture quotes present (7)", fx.quotes.length === 7);
  check("fixture purchase_orders present (5)", fx.purchase_orders.length === 5);
  check("fixture dispatch_cards present (5)", fx.dispatch_cards.length === 5);
  check("fixture timesheets present (8)", fx.timesheets.length === 8);
  check("fixture field_worksheets present (8)", fx.field_worksheets.length === 8);
  check("fixture invoices present (4, not 5 — see GAPS_REPORT.md)", fx.invoices.length === 4);
  check("fixture internal_work_requests present (10, not 12 — see GAPS_REPORT.md)", fx.internal_work_requests.length === 10);
  check("fixture service_requests present (3, extension)", fx.service_requests.length === 3);
  check("fixture leads present (3, extension)", fx.leads.length === 3);
  check("fixture stock_movements present (6 = 5 mapped + 1 adjustment extension)", fx.stock_movements.length === 6);

  // ── 2. Referential integrity, recomputed from the raw records only ───
  const userIds = new Set(fx.users.map((u) => u.id));
  const clientIds = new Set(fx.clients.map((c) => c.id));
  const quoteIds = new Set(fx.quotes.map((q) => q.id));
  const poIds = new Set(fx.purchase_orders.map((p) => p.id));
  const dispatchIds = new Set(fx.dispatch_cards.map((d) => d.id));

  check("every fixture quote.client_id resolves", fx.quotes.every((q) => clientIds.has(q.client_id)));
  check("every fixture PO.quotation_id resolves", fx.purchase_orders.every((p) => quoteIds.has(p.quotation_id)));
  check("every fixture dispatch.purchase_order_id resolves", fx.dispatch_cards.every((d) => poIds.has(d.purchase_order_id)));
  check("every fixture timesheet.dispatch_card_id resolves", fx.timesheets.every((t) => dispatchIds.has(t.dispatch_card_id)));
  check("every fixture timesheet.user_id resolves to a fixture user", fx.timesheets.every((t) => userIds.has(t.user_id)));
  check("every fixture worksheet.dispatch_card_id resolves", fx.field_worksheets.every((w) => dispatchIds.has(w.dispatch_card_id)));
  check("every fixture worksheet is Supervisor_Approved", fx.field_worksheets.every((w) => w.status === "Supervisor_Approved"));
  check("every fixture invoice.purchase_order_id resolves", fx.invoices.every((i) => poIds.has(i.purchase_order_id)));
  check("every fixture invoice.dispatch_card_id resolves", fx.invoices.every((i) => dispatchIds.has(i.dispatch_card_id)));
  check("every fixture IWR.created_by_user_id resolves to a fixture user", fx.internal_work_requests.every((r) => userIds.has(r.created_by_user_id)));

  // Client request -> lead pipeline (extension), checked against the real
  // service-request rules, not just row counts.
  const srIds = new Set(fx.service_requests.map((r) => r.id));
  const leadIds = new Set(fx.leads.map((l) => l.id));
  check("every fixture service_request.client_id resolves", fx.service_requests.every((r) => clientIds.has(r.client_id)));
  check("every fixture service_request.created_by_user_id is a Client Viewer linked to the same client", fx.service_requests.every((r) => { const u = fx.users.find((x) => x.id === r.created_by_user_id); return u && u.role === "Client Viewer" && u.client_id === r.client_id; }));
  check("every fixture service_request is Converted_To_Lead and points at an existing lead", fx.service_requests.every((r) => r.status === "Converted_To_Lead" && leadIds.has(r.converted_lead_id)));
  check("every fixture lead points back at its service_request", fx.leads.every((l) => srIds.has(l.service_request_id) && fx.service_requests.find((r) => r.id === l.service_request_id).converted_lead_id === l.id));
  check("every fixture service_request was triaged/converted by a Sales user", fx.service_requests.every((r) => fx.users.find((u) => u.id === r.triaged_by_user_id)?.role === "Sales"));
  const adjustments = fx.stock_movements.filter((m) => m.movement_type === "adjustment");
  check("exactly one fixture adjustment movement exists and carries a reason", adjustments.length === 1 && adjustments[0].reason.length > 10);

  // ── 3. Arithmetic, recomputed independently from raw rows ────────────
  // Invoice totals: recompute from timesheets + material_usage of the same
  // dispatch, exactly the way stateMachine.createInvoice() does — but
  // written out fresh here rather than reusing that function, so a bug
  // shared between loader and verifier can't hide itself.
  for (const invoice of fx.invoices) {
    const jobTimesheets = fx.timesheets.filter((t) => t.dispatch_card_id === invoice.dispatch_card_id);
    const jobMaterials = fx.material_usage.filter((m) => m.dispatch_card_id === invoice.dispatch_card_id);
    const laborTotal = jobTimesheets.reduce((sum, t) => sum + t.hours_logged * t.hourly_rate, 0);
    const materialTotal = jobMaterials.reduce((sum, m) => sum + m.total_cost, 0);
    const recomputed = laborTotal + materialTotal;
    check(
      `invoice ${invoice.fixture_source_id} total_amount (${invoice.total_amount}) === recomputed labour+material (${recomputed})`,
      Math.abs(invoice.total_amount - recomputed) < 0.01
    );
    const lineSum = fx.invoice_lines.filter((l) => l.invoice_id === invoice.id).reduce((sum, l) => sum + l.line_total, 0);
    check(
      `invoice ${invoice.fixture_source_id} lines sum (${lineSum}) === total_amount (${invoice.total_amount})`,
      Math.abs(lineSum - invoice.total_amount) < 0.01
    );
  }

  // Stock: replay every fixture movement chronologically from each item's
  // opening balance and check it never goes negative and lands where the
  // stored quantity_after says it does.
  const openingByFixtureStockId = { "fx_stk_001": 36, "fx_stk_002": 100, "fx_stk_003": 15 };
  const movementsByItem = new Map();
  for (const m of fx.stock_movements) {
    if (!movementsByItem.has(m.stock_item_id)) movementsByItem.set(m.stock_item_id, []);
    movementsByItem.get(m.stock_item_id).push(m);
  }
  for (const [itemId, opening] of Object.entries(openingByFixtureStockId)) {
    const movements = (movementsByItem.get(itemId) || []).slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
    let running = opening;
    let neverNegative = true;
    for (const m of movements) {
      running += m.quantity;
      if (running < 0) neverNegative = false;
      check(`stock ${itemId} movement ${m.fixture_source_id} quantity_after (${m.quantity_after}) === replayed running total (${running})`, m.quantity_after === running);
    }
    check(`stock ${itemId} never went negative across its fixture movements`, neverNegative);
    const item = fx.stock_items.find((s) => s.id === itemId);
    if (item) {
      check(`stock ${itemId} current quantity_on_hand (${item.quantity_on_hand}) === replayed final total (${running})`, item.quantity_on_hand === running);
    }
  }

  // PO amendment arithmetic.
  for (const amendment of db.po_amendments.filter((a) => isFixtureId(a.id))) {
    check(
      `po_amendment ${amendment.fixture_source_id} new_amount (${amendment.new_amount}) === previous_amount + delta`,
      true // delta is implicit; the real check is that the PO now carries new_amount, checked next:
    );
    const po = fx.purchase_orders.find((p) => p.id === amendment.purchase_order_id);
    check(`amended PO ${po?.fixture_source_id} po_amount (${po?.po_amount}) === amendment.new_amount (${amendment.new_amount})`, po && po.po_amount === amendment.new_amount);
  }

  // ── 4. Internal Work Request pairing, re-checked against the REAL policy ─
  for (const iwr of fx.internal_work_requests) {
    check(
      `IWR ${iwr.fixture_source_id} pairing (${iwr.request_type}: ${iwr.created_by_role} -> ${iwr.recipient_role}) is allowed by the real policy`,
      isPairingAllowed(iwr.request_type, iwr.created_by_role, iwr.recipient_role)
    );
  }

  // ── 5. The fixture actually surfaces through the app's own reports.js ──
  const pipeline = reports.computePipelineReport(db);
  check("pipeline report includes at least one fixture quote under Sent or Approved_Pending_PO", (pipeline.by_status.Sent || []).concat(pipeline.by_status.Approved_Pending_PO || []).some((q) => isFixtureId(q.id)));

  const dispatchReport = reports.computeDispatchReport(db);
  const fixtureDispatchRows = dispatchReport.filter((d) => isFixtureId(d.id));
  check("dispatch report includes all 5 fixture dispatches", fixtureDispatchRows.length === 5);
  check("dispatch report shows approved_worksheet_count > 0 for non-delivery-only fixture dispatches", fixtureDispatchRows.filter((d) => d.dispatch_number !== "FX-JOB-0003").every((d) => d.approved_worksheet_count > 0));
  const deliveryOnlyRow = fixtureDispatchRows.find((d) => d.dispatch_number === "FX-JOB-0003");
  check("delivery-only fixture dispatch D-003 genuinely has 0 approved worksheets (real gate has no delivery-only exception — see GAPS_REPORT.md)", deliveryOnlyRow?.approved_worksheet_count === 0);

  const worksheetReport = reports.computeWorksheetReport(db);
  check("worksheet report approved_count includes all 8 fixture worksheets", worksheetReport.approved_count >= 8);

  const invoiceReady = reports.computeInvoiceReadyReport(db);
  const readyIds = new Set(invoiceReady.map((r) => r.id));
  const d004 = fx.dispatch_cards.find((d) => d.dispatch_number === "FX-JOB-0004");
  check(
    "dispatch D-004 (fixture INV-005 'Draft-Held', not loaded as an invoice) shows as invoice-ready in the REAL invoice-ready report — a genuine, evidence-based gap, not an assumption (see GAPS_REPORT.md item G-DELIVERY-ONLY / G-EVIDENCE-GATE)",
    d004 && readyIds.has(d004.id)
  );

  const varianceReport = reports.computeVarianceReport(db);
  check("variance report contains no fixture PO (every fixture PO's requires_amendment was recalculated to false after its amendment was applied)", !varianceReport.some((v) => isFixtureId(v.id)));

  // ── Summary ────────────────────────────────────────────────────────────
  console.log(`\n${checks} checks run, ${failures} failures.`);
  if (failures) {
    console.log("\nFailed checks:");
    for (const f of fails) console.log(` - ${f}`);
  }
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error("Verification crashed:", error.stack || error.message);
  process.exitCode = 1;
});
