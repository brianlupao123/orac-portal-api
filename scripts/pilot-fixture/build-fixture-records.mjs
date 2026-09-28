// scripts/pilot-fixture/build-fixture-records.mjs
//
// Pure mapping function. Takes the abstract, standalone
// ORAC-MONTHLY-FIXTURE-RECONCILED specification (fixture-scenarios.json,
// version 2026-09-25-r2) and produces records shaped exactly like the real
// ORAC-IOS store collections (see backend/src/store.js seedData()).
//
// This file does NOT read/write any file, touch any database, or import
// Express. It is safe to unit-test and safe to import from the guarded
// loader and from the independent verifier without either one trusting the
// other's copy of the logic.
//
// Every mapping decision that could not be made with confidence from the
// real source code is recorded in the returned `gaps` array instead of
// being guessed into a record. See GAPS_REPORT.md for the human-readable
// version of the same list.

import bcrypt from "bcrypt";
import { isPairingAllowed } from "../../src/internalWorkRequestRules.js";

// All fixture-derived IDs are prefixed "fx_" and derived deterministically
// from the fixture's own IDs, so re-running the loader against the same
// fixture version is a no-op (see load-pilot-fixture.mjs) and so anyone
// reading a dump of the store can tell fixture data from real data on sight.
function fx(id) {
  return `fx_${String(id).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

const ROLE_BY_FIXTURE_ROLE = {
  admin: "Admin",
  management: "Management",
  sales: "Sales",
  finance: "Finance",
  operations: "Operations",
  supervisor: "Supervisor",
  technician: "Technician",
  client_viewer: "Client Viewer"
};

// Real movement_type enum is only "in" | "out" | "adjustment"
// (src/schemas.js StockMovementSchema). The fixture's own vocabulary is
// wider ("Reserve", "Issue", "Return", "Receipt"). Only the three that map
// onto an actual physical stock change are loaded; "Reserve" is a soft hold
// with no physical quantity change, which the current stock model has no
// field for at all (see GAPS_REPORT.md item G-STOCK-RESERVE).
const MOVEMENT_ACTION_MAP = {
  Issue: "out",
  Return: "in",
  Receipt: "in"
};

// Real quote state machine (src/stateMachine.js) only knows:
//   Draft -> Sent -> Approved_Pending_PO -> PO_Verified -> Field_Dispatch -> Invoiced
// There is no Declined or Expired state. A fixture quote whose `decision`
// is "declined" or "expired" is therefore loaded at "Sent" (the last real
// status such a quote could actually hold) with the fixture's own decision
// preserved only as free text, never as a fabricated status string.
const REAL_QUOTE_STATUS_FOR_DECISION = {
  accepted: "Approved_Pending_PO"
  // declined / expired: no real terminal status exists; handled inline.
};

export function buildFixtureRecords(scenario) {
  const gaps = [];
  const addGap = (id, area, note) => gaps.push({ id, area, note });

  const actorById = new Map(scenario.actors.map((a) => [a.id, a]));
  const clientById = new Map(scenario.clients.map((c) => [c.id, c]));
  const stockItemById = new Map(scenario.stockItems.map((s) => [s.id, s]));
  const rateByTrade = new Map(scenario.labourCategories.staffedThisMonth.map((r) => [r.trade, r]));

  const userId = (fixtureActorId) => fx(fixtureActorId);
  const clientId = (fixtureClientId) => fx(fixtureClientId);
  const siteId = (fixtureSiteId) => fx(fixtureSiteId);
  const quoteId = (fixtureQuoteId) => fx(fixtureQuoteId);
  const poId = (fixturePoId) => fx(fixturePoId);
  const dispatchId = (fixtureDispatchId) => fx(fixtureDispatchId);
  const stockItemId = (fixtureStockId) => fx(fixtureStockId);

  // ── users ──────────────────────────────────────────────────────────────
  // password: every fixture account uses the same clearly-fictional value,
  // matching the convention already used by the app's own seedData().
  const passwordHash = bcrypt.hashSync("PilotFixture#2026", 10);
  const users = scenario.actors.map((actor) => {
    const record = {
      id: userId(actor.id),
      name: actor.name,
      email: `${actor.id.toLowerCase()}@pilot-fixture.orac.invalid`,
      role: ROLE_BY_FIXTURE_ROLE[actor.role],
      is_active: true,
      password_hash: passwordHash,
      fixture_source_id: actor.id
    };
    if (actor.trade) record.trade = actor.trade;
    if (actor.role === "client_viewer") {
      const client = scenario.clients.find((c) => c.linkedViewer === actor.id);
      if (client) record.client_id = clientId(client.id);
    }
    return record;
  });

  // ── clients + mine_sites ──────────────────────────────────────────────
  // The real schema has no flat "site" concept below mine_site (mine_site ->
  // plant -> plant_section -> equipment_tag). The fixture's flat `sites`
  // list is loaded as one mine_site per site code; plant/section/equipment
  // are intentionally left unset (see GAPS_REPORT.md item G-SITE-DEPTH).
  const clients = scenario.clients.map((c) => ({
    id: clientId(c.id),
    name: c.name,
    client_type: "permanent",
    contact_person: "UAT Pilot Contact",
    email: `${c.id.toLowerCase()}@pilot-fixture.orac.invalid`,
    fixture_source_id: c.id
  }));

  const mine_sites = scenario.clients.flatMap((c) =>
    c.sites.map((s) => ({
      id: siteId(s),
      client_id: clientId(c.id),
      name: s,
      location: "UAT pilot fixture",
      fixture_source_id: s
    }))
  );

  // ── quotes + quote_lines ─────────────────────────────────────────────
  const quotes = [];
  const quote_lines = [];
  for (const q of scenario.quotes) {
    const lines = [];
    for (const line of q.labourLines || []) {
      lines.push({
        id: fx(`${q.id}-lab-${line.trade}`),
        quotation_id: quoteId(q.id),
        catalog_item_id: null,
        description: `${line.trade} labour (${line.days} day${line.days === 1 ? "" : "s"} @ ${line.dailyRate}/day)`,
        quantity: line.days,
        unit_price: line.dailyRate,
        line_total: line.lineValue
      });
    }
    for (const line of q.materialLines || []) {
      const stockItem = stockItemById.get(line.stockItemId);
      lines.push({
        id: fx(`${q.id}-mat-${line.stockItemId}`),
        quotation_id: quoteId(q.id),
        catalog_item_id: null,
        description: stockItem ? stockItem.name : line.stockItemId,
        quantity: line.quantity,
        unit_price: line.unitPrice,
        line_total: line.lineValue
      });
    }
    quote_lines.push(...lines);

    let status = REAL_QUOTE_STATUS_FOR_DECISION[q.decision];
    let fixtureNote = "";
    if (!status) {
      status = "Sent";
      fixtureNote = `Fixture decision was "${q.decision}" on ${q.decisionDate}; the real quote state machine has no Declined/Expired status, so this quote is loaded at its last real status (Sent).`;
      addGap(
        `quote-${q.id}`,
        "quote_lifecycle",
        `Quote ${q.id} (${quoteId(q.id)}): ${fixtureNote}`
      );
    }

    quotes.push({
      id: quoteId(q.id),
      quote_number: `FX-${q.id}`,
      client_id: clientId(q.clientId),
      equipment_tag_id: null,
      status,
      total_amount: q.totalValue,
      created_by: null,
      created_at: `${q.createdDate}T08:00:00+02:00`,
      updated_at: `${q.decisionDate || q.issuedDate}T08:00:00+02:00`,
      fixture_source_id: q.id,
      fixture_note: fixtureNote || undefined
    });
  }

  // ── purchase_orders + po_amendments ─────────────────────────────────
  const purchase_orders = scenario.purchaseOrders.map((po) => {
    const fixtureNote =
      po.status === "Verified-Late"
        ? po.note || "PO arrived late relative to client acceptance; timing preserved as a note only."
        : undefined;
    return {
      id: poId(po.id),
      quotation_id: quoteId(po.quoteId),
      po_reference: `FX-${po.id}`,
      po_amount: po.originalValue,
      status: "verified", // real enum: only "verified" | "pending"
      started_before_po: false,
      date_received: po.loggedDate,
      verified_by: userId(po.verifiedBy),
      verified_at: `${po.verifiedDate}T09:00:00+02:00`,
      requires_amendment: false, // recalculated below, from loaded timesheets/materials
      fixture_source_id: po.id,
      fixture_note: fixtureNote
    };
  });

  const po_amendments = scenario.poAmendments.map((a) => ({
    id: fx(a.id),
    purchase_order_id: poId(a.poId),
    reason: a.reason,
    previous_amount: a.originalValue,
    new_amount: a.amendedValue,
    approved_by: userId(a.verifiedBy),
    approved_at: `${a.verifiedDate}T09:00:00+02:00`,
    fixture_source_id: a.id
  }));
  // Apply amendments to the PO's current amount, matching what
  // approveAmendment() does in the real controller (po.po_amount = new_amount).
  for (const a of scenario.poAmendments) {
    const po = purchase_orders.find((p) => p.id === poId(a.poId));
    if (po) po.po_amount = a.amendedValue;
  }

  // ── dispatch_cards ────────────────────────────────────────────────────
  const dispatch_cards = scenario.dispatches.map((d, index) => {
    const po = purchase_orders.find((p) => p.id === poId(d.poId));
    const record = {
      id: dispatchId(d.id),
      quotation_id: po?.quotation_id || null,
      purchase_order_id: poId(d.poId),
      equipment_tag_id: null,
      dispatch_number: `FX-JOB-${String(index + 1).padStart(4, "0")}`,
      status: "active",
      site_contact: "",
      scheduled_start: d.startDate,
      scheduled_end: d.endDate,
      started_before_po: false,
      urgent_reason: "",
      assigned_supervisor_id: d.supervisorId ? userId(d.supervisorId) : null,
      assigned_technician_id: d.technicianIds?.[0] ? userId(d.technicianIds[0]) : null,
      created_at: `${d.startDate}T07:00:00+02:00`,
      fixture_source_id: d.id
    };
    if (d.deliveryOnly) {
      record.delivery_only = true;
      record.delivery_handler_id = d.deliveryHandlerId ? userId(d.deliveryHandlerId) : null;
      addGap(
        `dispatch-${d.id}`,
        "delivery_only_invoice_gate",
        `Dispatch ${d.id} (${dispatchId(d.id)}) is delivery-only with no technician and no field worksheet. ` +
        `The real invoice-readiness gate (src/stateMachine.js validateTransition, and computeInvoiceReadyReport in ` +
        `src/reports.js) requires an approved field_worksheet before invoicing, with no delivery-only exception. ` +
        `This fixture still records an invoice for it (INV-003) because the specification says a stock-sale/delivery-only ` +
        `path exists, but that path is not currently implemented in code. Loaded by direct fixture insertion, not by ` +
        `driving the real quote-transition API, specifically so this gap is not hidden. See GAPS_REPORT.md item G-DELIVERY-ONLY.`
      );
    }
    return record;
  });

  // ── timesheets + field_worksheets + material_usage ─────────────────
  const timesheets = [];
  const field_worksheets = [];
  const material_usage = [];

  for (const t of scenario.timesheets) {
    const rate = rateByTrade.get(t.trade);
    if (!rate) {
      addGap(`timesheet-${t.id}`, "labour_rate", `Timesheet ${t.id} trade "${t.trade}" has no rate in labourCategories.staffedThisMonth; skipped.`);
      continue;
    }
    const dispatch = dispatch_cards.find((d) => d.id === dispatchId(t.dispatchId));

    timesheets.push({
      id: fx(t.id),
      dispatch_card_id: dispatchId(t.dispatchId),
      user_id: userId(t.technicianId),
      work_date: t.periodEnd,
      hours_logged: t.hoursWorked,
      hourly_rate: rate.hourlyRate,
      notes: `Fixture period ${t.periodStart} to ${t.periodEnd} (${t.daysWorked} day(s)).`,
      fixture_source_id: t.id
    });

    // field_worksheets carry the real Supervisor-approval gate that
    // src/stateMachine.js and src/reports.js actually check. Mapped 1:1 from
    // each fixture timesheet's final ("Approved") status; the fixture's own
    // Submitted/Returned/Approved history is folded into a note rather than
    // fabricated as separate real audit events (see GAPS_REPORT.md item
    // G-WORKSHEET-HISTORY — this chat does not touch the client-signature/
    // Timesheet workflow, which is Chat B's scope).
    if (t.status === "Approved" && dispatch) {
      field_worksheets.push({
        id: fx(`ws-${t.id}`),
        dispatch_card_id: dispatchId(t.dispatchId),
        technician_id: userId(t.technicianId),
        technician_trade: t.trade,
        work_date: t.periodEnd,
        activity: `Fixture field work, ${t.periodStart} to ${t.periodEnd}.`,
        hours: t.hoursWorked,
        tools_used: "",
        materials_used: [],
        outcomes: `${t.daysWorked} day(s) completed.`,
        challenges: "",
        evidence_files: [],
        status: "Supervisor_Approved",
        submitted_by: userId(t.technicianId),
        supervisor_comment: "",
        approved_by: t.supervisorId ? userId(t.supervisorId) : null,
        approved_at: `${t.approvedDate}T16:00:00+02:00`,
        created_at: `${t.periodStart}T07:00:00+02:00`,
        submitted_at: `${t.submittedDate}T16:00:00+02:00`,
        updated_at: `${t.approvedDate}T16:00:00+02:00`,
        fixture_source_id: t.id
      });
    } else {
      addGap(`timesheet-${t.id}`, "worksheet_status", `Timesheet ${t.id} has fixture status "${t.status}", not "Approved"; no field_worksheet was created for it.`);
    }
  }

  // Material usage: derived from the actual net quantities the fixture's
  // own invoice notes describe (e.g. INV-001 nets 1 returned sheet off the
  // 10 issued for D-001), NOT copied blindly from the quote's material
  // lines, so that invoice totals recomputed from these records match the
  // fixture's own totalValue figures (checked by verify-pilot-fixture.mjs).
  const MATERIAL_USAGE_BY_DISPATCH = {
    "D-001": [{ stockItemId: "STK-001", quantity_used: 9, unit_cost: 110 }], // 10 issued - 1 returned (M-02, M-03)
    "D-003": [{ stockItemId: "STK-002", quantity_used: 20, unit_cost: 15 }],
    "D-004": [{ stockItemId: "STK-001", quantity_used: 30, unit_cost: 110 }]
  };
  for (const [fixtureDispatchIdKey, items] of Object.entries(MATERIAL_USAGE_BY_DISPATCH)) {
    for (const item of items) {
      material_usage.push({
        id: fx(`mu-${fixtureDispatchIdKey}-${item.stockItemId}`),
        dispatch_card_id: dispatchId(fixtureDispatchIdKey),
        catalog_item_id: null,
        description: stockItemById.get(item.stockItemId)?.name || item.stockItemId,
        quantity_used: item.quantity_used,
        unit_cost: item.unit_cost,
        total_cost: item.quantity_used * item.unit_cost,
        fixture_source_id: `${fixtureDispatchIdKey}:${item.stockItemId}`
      });
    }
  }

  // ── stock_items + stock_movements ───────────────────────────────────
  const stock_items = scenario.stockItems.map((s) => ({
    id: stockItemId(s.id),
    catalog_item_id: null,
    item_code: `FX-${s.id}`,
    item_name: s.name,
    unit_of_measure: s.unit,
    quantity_on_hand: s.openingOnHand,
    reorder_level: s.reorderLevel,
    unit_cost: s.unitPrice,
    supplier_id: null,
    location: "UAT pilot fixture store",
    fixture_source_id: s.id
  }));

  const stock_movements = [];
  const reserveSkipped = [];
  // Sort chronologically so quantity_after is computed in real order.
  const sortedMovements = [...scenario.stockMovements].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const m of sortedMovements) {
    const realType = MOVEMENT_ACTION_MAP[m.action];
    const item = stock_items.find((s) => s.id === stockItemId(m.stockItemId));
    if (!realType || !item) {
      reserveSkipped.push(m.id);
      continue;
    }
    const signedQty = realType === "out" ? -Math.abs(m.quantity) : Math.abs(m.quantity);
    item.quantity_on_hand += signedQty;
    stock_movements.push({
      id: fx(m.id),
      stock_item_id: item.id,
      movement_type: realType,
      quantity: signedQty,
      quantity_after: item.quantity_on_hand,
      reason: m.linkedDispatch ? `Fixture ${m.action.toLowerCase()} for dispatch ${m.linkedDispatch}` : `Fixture ${m.action.toLowerCase()} (${m.note || "supplier delivery"})`,
      reference_id: m.linkedDispatch ? dispatchId(m.linkedDispatch) : null,
      override_negative: false,
      actor_id: null,
      created_at: `${m.date}T10:00:00+02:00`,
      fixture_source_id: m.id
    });
  }
  if (reserveSkipped.length) {
    addGap(
      "stock-reserve",
      "stock_reservation",
      `Fixture stock movements ${reserveSkipped.join(", ")} use action "Reserve", a soft hold with no physical quantity change. ` +
      `The real stock_items/stock_movements model (src/controllers/inventoryController.js) has no reservation concept or field ` +
      `for it, so these were not loaded as stock_movements. See GAPS_REPORT.md item G-STOCK-RESERVE.`
    );
  }

  // ── invoices + invoice_lines ─────────────────────────────────────────
  // Only invoices the fixture itself marks "Authorised" are loaded, because
  // that is the only status a real invoice record actually represents
  // (src/stateMachine.js createInvoice sets status "sent" once every real
  // invoicing gate has already passed). INV-005 ("Draft-Held") has no real
  // equivalent: the real app does not create a placeholder invoice row for
  // work that is not yet ready to bill; see the dispatch-D-004 gap above.
  const invoices = [];
  const invoice_lines = [];
  for (const inv of scenario.invoices) {
    if (inv.status !== "Authorised") {
      addGap(
        `invoice-${inv.id}`,
        "invoice_lifecycle",
        `Invoice ${inv.id} (status "${inv.status}") was not loaded. The real app creates an invoice record only once every ` +
        `stateMachine gate has passed (verified PO, no pending amendment, an approved field worksheet) — there is no "held/draft" ` +
        `invoice row for work that is not yet ready to bill. The corresponding dispatch (${inv.dispatchId}) and its worksheets/` +
        `timesheets are still loaded, so a role-scoped report can show the work as done-but-not-yet-invoiced.`
      );
      continue;
    }
    const dispatch = dispatch_cards.find((d) => d.id === dispatchId(inv.dispatchId));
    const po = purchase_orders.find((p) => p.id === poId(inv.poId));
    const jobTimesheets = timesheets.filter((t) => t.dispatch_card_id === dispatch?.id);
    const jobMaterials = material_usage.filter((m) => m.dispatch_card_id === dispatch?.id);
    const laborTotal = jobTimesheets.reduce((sum, t) => sum + t.hours_logged * t.hourly_rate, 0);
    const laborHours = jobTimesheets.reduce((sum, t) => sum + t.hours_logged, 0);
    const materialTotal = jobMaterials.reduce((sum, m) => sum + m.total_cost, 0);

    const invoice = {
      id: fx(inv.id),
      invoice_number: `FX-${inv.id}`,
      purchase_order_id: po?.id || null,
      dispatch_card_id: dispatch?.id || null,
      total_amount: laborTotal + materialTotal,
      status: "sent",
      generated_by: inv.authorisedBy ? userId(inv.authorisedBy) : null,
      generated_at: `${inv.authorisedDate}T12:00:00+02:00`,
      fixture_source_id: inv.id
    };
    invoices.push(invoice);

    if (laborTotal > 0 || materialTotal <= 0) {
      invoice_lines.push({
        id: fx(`il-${inv.id}-labour`),
        invoice_id: invoice.id,
        description: "Field service labour",
        quantity: laborHours || 1,
        unit_price: laborTotal > 0 && laborHours > 0 ? laborTotal / laborHours : invoice.total_amount,
        line_total: laborTotal || invoice.total_amount,
        gl_account_code: "SALES-SERVICE",
        cost_center: "FIELD"
      });
    }
    if (materialTotal > 0) {
      invoice_lines.push({
        id: fx(`il-${inv.id}-materials`),
        invoice_id: invoice.id,
        description: "Materials used",
        quantity: 1,
        unit_price: materialTotal,
        line_total: materialTotal,
        gl_account_code: "SALES-MATERIALS",
        cost_center: "FIELD"
      });
    }

    if (Math.abs(invoice.total_amount - inv.totalValue) > 0.01) {
      addGap(
        `invoice-${inv.id}`,
        "invoice_arithmetic_mismatch",
        `Invoice ${inv.id}: recomputed total ${invoice.total_amount} does not match the fixture's own totalValue ${inv.totalValue}. Loaded as recomputed (matches the real invoice-generation formula); mismatch flagged for owner review.`
      );
    }

    if (inv.disputeRaised) {
      addGap(
        `invoice-${inv.id}`,
        "dispute_not_modelled",
        `Invoice ${inv.id}: fixture records a client dispute (${inv.disputeReason}). The real app has no dispute/void-reissue field or workflow (only a single "void" action in src/controllers/coreController.js voidInvoice, which is not a dispute). The dispute is not represented as a stored field; see GAPS_REPORT.md item G-DISPUTE.`
      );
    }
  }

  // ── access_requests ───────────────────────────────────────────────────
  // Real schema (src/controllers/accessRequestsController.js) models a
  // pre-account request by name/email/requested_role — NOT a request by an
  // existing user to be linked to an additional client, which is what the
  // fixture's accessRequests actually describe. Loaded using the closest
  // real shape; the "link an existing viewer to another client" intent is
  // preserved only in a note. See GAPS_REPORT.md item G-ACCESS-REQUEST-SHAPE.
  const access_requests = scenario.accessRequests.map((ar) => {
    const requester = actorById.get(ar.requestedBy);
    const name = requester ? requester.name : "Unverified Contact";
    const email = requester
      ? `${ar.requestedBy.toLowerCase()}@pilot-fixture.orac.invalid`
      : `${String(ar.requestedBy).toLowerCase().replace(/[^a-z0-9]+/g, "-")}@pilot-fixture.orac.invalid`;
    return {
      id: fx(ar.id),
      name,
      email,
      requested_role: "Client Viewer",
      reason: ar.targetClientLink
        ? `Fixture: request to access client link ${ar.targetClientLink}.` + (ar.reason ? ` ${ar.reason}` : "")
        : ar.note || "Fixture role-elevation-style request.",
      status: ar.status,
      created_at: `${ar.requestedDate}T09:00:00+02:00`,
      reviewed_by: ar.decidedBy ? userId(ar.decidedBy) : null,
      reviewed_at: ar.decidedDate ? `${ar.decidedDate}T09:00:00+02:00` : null,
      fixture_source_id: ar.id
    };
  });

  // ── internal_work_requests ────────────────────────────────────────────
  // Every fixture IWR is checked against the REAL pairing policy
  // (isPairingAllowed, imported from the actual source file, not
  // reimplemented) before it is loaded. Any fixture IWR whose sender/
  // recipient pairing has no real match at all is recorded only as a gap.
  const IWR_REAL_TYPE_BY_FIXTURE_ID = {
    "IWR-001": { type: "STOCK_AVAILABILITY", relatedType: "quote", relatedFixtureId: "Q-004" },
    "IWR-002": { type: "STOCK_AVAILABILITY", relatedType: "quote", relatedFixtureId: "Q-002" },
    "IWR-004": { type: "FIELD_CLARIFICATION", relatedType: "dispatch_card", relatedFixtureId: "D-001" },
    "IWR-005": { type: "FIELD_CLARIFICATION", relatedType: "dispatch_card", relatedFixtureId: "D-002" },
    "IWR-006": { type: "PO_AMENDMENT_CONFIRMATION", relatedType: "purchase_order", relatedFixtureId: "PO-002" },
    "IWR-007": { type: "PO_AMENDMENT_CONFIRMATION", relatedType: "purchase_order", relatedFixtureId: "PO-002" },
    "IWR-008": { type: "PO_AMENDMENT_CONFIRMATION", relatedType: "purchase_order", relatedFixtureId: "PO-004" },
    "IWR-009": { type: "PO_AMENDMENT_CONFIRMATION", relatedType: "purchase_order", relatedFixtureId: "PO-003" },
    "IWR-010": { type: "ADMINISTRATIVE_SUPPORT", relatedType: null, relatedFixtureId: null }, // real type carries no related record; quote reference kept in description text only
    "IWR-012": { type: "MATERIAL_RECONCILIATION", relatedType: "purchase_order", relatedFixtureId: "PO-001" }
  };
  const RELATED_ID_RESOLVER = { quote: quoteId, purchase_order: poId, dispatch_card: dispatchId };

  const internal_work_requests = [];
  for (const iwr of scenario.internalWorkRequests) {
    const sender = actorById.get(iwr.senderId);
    const senderRole = ROLE_BY_FIXTURE_ROLE[sender.role];
    const recipientRole = ROLE_BY_FIXTURE_ROLE[iwr.recipientRole];
    const mapping = IWR_REAL_TYPE_BY_FIXTURE_ID[iwr.id];

    if (!mapping) {
      addGap(
        `iwr-${iwr.id}`,
        "iwr_no_real_pairing",
        `${iwr.id}: ${sender.role} -> ${iwr.recipientRole} has no matching real pairing in src/internalWorkRequestRules.js INTERNAL_WORK_REQUEST_POLICY. Not loaded. (Fixture's own note: "${iwr.compatibilityNote}")`
      );
      continue;
    }
    if (!isPairingAllowed(mapping.type, senderRole, recipientRole)) {
      addGap(
        `iwr-${iwr.id}`,
        "iwr_pairing_mismatch",
        `${iwr.id}: mapped type ${mapping.type} does not actually allow ${senderRole} -> ${recipientRole} per isPairingAllowed(). Not loaded. This indicates a mapping bug in build-fixture-records.mjs, not a fixture problem.`
      );
      continue;
    }

    const finalStatusEntry = iwr.existingStatusTimeline[iwr.existingStatusTimeline.length - 1];
    const history = iwr.existingStatusTimeline.map((entry, i) => ({
      at: `${entry.date}T10:00:00+02:00`,
      actor_user_id: i === 0 ? userId(iwr.senderId) : null,
      actor_role: i === 0 ? senderRole : recipientRole,
      action: i === 0 ? "submit" : entry.status.toLowerCase().replace(/\s+/g, "_"),
      from_status: i === 0 ? null : iwr.existingStatusTimeline[i - 1].status,
      to_status: entry.status,
      note: ""
    }));

    internal_work_requests.push({
      id: fx(iwr.id),
      request_type: mapping.type,
      subject: `Fixture ${iwr.id}: ${mapping.type.replace(/_/g, " ").toLowerCase()}`,
      description: `Fixture-generated Internal Work Request. Original fixture intent: "${iwr.proposedType}" (${iwr.compatibilityNote})`,
      priority: "Normal",
      status: finalStatusEntry.status,
      created_by_user_id: userId(iwr.senderId),
      created_by_role: senderRole,
      recipient_role: recipientRole,
      assigned_to_user_id: null,
      acknowledged_at: iwr.existingStatusTimeline.find((e) => e.status === "Acknowledged")?.date
        ? `${iwr.existingStatusTimeline.find((e) => e.status === "Acknowledged").date}T10:00:00+02:00`
        : null,
      related_entity_type: mapping.relatedType,
      related_entity_id: mapping.relatedFixtureId ? RELATED_ID_RESOLVER[mapping.relatedType](mapping.relatedFixtureId) : null,
      client_id: null,
      resolution_note: ["Completed", "Rejected", "Cancelled"].includes(finalStatusEntry.status) ? "Resolved via fixture timeline." : null,
      resolved_by_user_id: null,
      history,
      created_at: `${iwr.raisedDate}T10:00:00+02:00`,
      updated_at: `${finalStatusEntry.date}T10:00:00+02:00`,
      resolved_at: ["Completed", "Rejected", "Cancelled"].includes(finalStatusEntry.status) ? `${finalStatusEntry.date}T10:00:00+02:00` : null,
      fixture_source_id: iwr.id
    });
  }

  // Recalculate PO amendment-required flags the same way the real app does
  // (store.recalculateVariance), from the loaded timesheets/materials —
  // this is applied by the loader after insertion (needs the store helper),
  // not here; see load-pilot-fixture.mjs.

  // ── service_requests + leads (extension) ─────────────────────────────
  // NOT present in the original fixture package at all (it has no
  // "client request" array). Added here because the real app genuinely
  // supports this step (src/controllers/serviceRequestsController.js,
  // src/serviceRequestRules.js) and the plan's own client-request ->
  // quote -> ... pipeline names it as the first step. One request+lead per
  // client (3 total), dated shortly before that client's first quote this
  // month, carried through to its real terminal state (Converted_To_Lead)
  // using the exact field mutations triageServiceRequest/
  // convertServiceRequestToLead make.
  //
  // IMPORTANT: the real schema has NO field on a lead, quote, or service
  // request that links a lead back to the quote it presumably led to
  // (checked: no `lead_id`/`service_request_id` on quotes or
  // src/controllers/quoteController.js). The request/lead pair below is
  // therefore loaded as a real, freestanding record — not wired to any
  // specific fixture quote — and that missing link is logged as a gap
  // (G-REQUEST-TO-QUOTE-LINK) rather than invented.
  const service_requests = [];
  const leads = [];
  const CLIENT_REQUEST_SCENARIOS = {
    "UAT-CLI-01": { requestedDate: "2026-08-01", triagedBy: "SAL-01", need: "General fabrication and structural support labour for the month.", urgency: "standard" },
    "UAT-CLI-02": { requestedDate: "2026-08-09", triagedBy: "SAL-01", need: "Electrical and mechanical fitting support across two sites.", urgency: "planned_shutdown" },
    "UAT-CLI-03": { requestedDate: "2026-08-09", triagedBy: "SAL-02", need: "Rigging and boilermaking assistance for a short shutdown window.", urgency: "urgent_downtime" }
  };
  for (const c of scenario.clients) {
    const scenarioInfo = CLIENT_REQUEST_SCENARIOS[c.id];
    if (!scenarioInfo) continue;
    const clientRecordId = clientId(c.id);
    const requesterFixtureId = c.linkedViewer;
    const requesterId = requesterFixtureId ? userId(requesterFixtureId) : null;
    const triagedByUserId = userId(scenarioInfo.triagedBy);
    const firstSite = c.sites?.[0];
    const submittedAt = `${scenarioInfo.requestedDate}T08:00:00+02:00`;
    const triagedAt = `${scenarioInfo.requestedDate}T14:00:00+02:00`;
    const acceptedAt = `${scenarioInfo.requestedDate}T15:00:00+02:00`;
    const convertedAt = `${scenarioInfo.requestedDate}T15:30:00+02:00`;

    const requestId = fx(`sr-${c.id}`);
    const leadRecordId = fx(`lead-${c.id}`);

    service_requests.push({
      id: requestId,
      client_id: clientRecordId,
      created_by_user_id: requesterId,
      title: `${c.name} — ${scenarioInfo.urgency.replace(/_/g, " ")} labour request`,
      service_need: scenarioInfo.need,
      urgency: scenarioInfo.urgency,
      mine_site_id: firstSite ? siteId(firstSite) : null,
      equipment_tag_id: null,
      requested_date: scenarioInfo.requestedDate,
      status: "Converted_To_Lead",
      triaged_by_user_id: triagedByUserId,
      triaged_at: triagedAt,
      triage_note: "Fixture extension: accepted for quoting.",
      converted_lead_id: leadRecordId,
      converted_by_user_id: triagedByUserId,
      converted_at: convertedAt,
      created_at: submittedAt,
      updated_at: convertedAt,
      fixture_source_id: `extension:${c.id}`
    });

    const client = clientById.get(c.id);
    const requesterActor = actorById.get(requesterFixtureId);
    leads.push({
      id: leadRecordId,
      company_name: client?.name || "",
      contact_name: requesterActor?.name || "",
      email: requesterFixtureId ? `${requesterFixtureId.toLowerCase()}@pilot-fixture.orac.invalid` : "",
      phone: "",
      mine_site: firstSite || "",
      service_need: scenarioInfo.need,
      urgency: scenarioInfo.urgency,
      status: "New",
      created_at: convertedAt,
      service_request_id: requestId,
      fixture_source_id: `extension:${c.id}`
    });

    addGap(
      `service-request-${c.id}`,
      "request_to_quote_link",
      `Fixture extension ${requestId} / lead ${leadRecordId} for ${c.id}: the real schema has no field linking a lead ` +
      `(or its source service_request) forward to any quote (checked src/controllers/quoteController.js and src/schemas.js — ` +
      `quotes carry no lead_id/service_request_id). This client's fixture quotes exist as freestanding records, not linked ` +
      `to this request/lead pair. See GAPS_REPORT.md item G-REQUEST-TO-QUOTE-LINK.`
    );
  }

  // ── stock adjustment (extension) ──────────────────────────────────────
  // The real StockMovementSchema (src/schemas.js) supports
  // movement_type: "in" | "out" | "adjustment", but the original fixture
  // package's stockMovements array only ever uses actions that map to
  // "in"/"out" (see MOVEMENT_ACTION_MAP above) — no adjustment scenario
  // exists in the source fixture at all. One is added here, on STK-003
  // (Gasket set), which otherwise has zero movements all month, to
  // genuinely exercise the adjustment code path the real schema supports.
  const gasketItem = stock_items.find((s) => s.fixture_source_id === "STK-003");
  if (gasketItem) {
    const adjustmentQty = -2; // month-end cycle count found 2 fewer than recorded
    gasketItem.quantity_on_hand += adjustmentQty;
    stock_movements.push({
      id: fx("smv-extension-adjustment-stk-003"),
      stock_item_id: gasketItem.id,
      movement_type: "adjustment",
      quantity: adjustmentQty,
      quantity_after: gasketItem.quantity_on_hand,
      reason: "Fixture extension: month-end cycle count correction (2 short). Not present in the original fixture package; added because the real schema supports movement_type=adjustment and the source fixture never exercised it.",
      reference_id: null,
      override_negative: false,
      actor_id: null,
      created_at: "2026-08-31T17:00:00+02:00",
      fixture_source_id: "extension:adjustment-stk-003"
    });
  }

  addGap(
    "client-signed-evidence",
    "not_modelled",
    "The fixture's clientSignedEvidence array (EV-01..EV-05) was NOT extended into real records. The real app has no " +
    "document/evidence storage collection at all (checked: no `documents` table in src/store.js; " +
    "src/controllers/documentController.js only generates PDFs on demand from existing quote/dispatch/worksheet/invoice/PO " +
    "records, it stores nothing new) and no client-acknowledgement field or workflow anywhere (checked: every \"acknowledg\" " +
    "hit in src/ is the unrelated Client Service Request status, not field-work sign-off). This is an owner decision for " +
    "Chat B, not something this chat can invent. See GAPS_REPORT.md item G-EVIDENCE-GATE."
  );

  addGap(
    "checkpoints",
    "not_modelled",
    "The fixture's `checkpoints` array (point-in-time status snapshots) has no real schema equivalent beyond audit_logs. Not loaded as records; the timesheet/invoice end-states they describe are already reflected in the loaded records above."
  );
  addGap(
    "negative-and-edge-case-scenarios",
    "requires_execution",
    "The fixture's 12 negativeAndEdgeCaseScenarios (NT-01..NT-12) describe behaviour to exercise against running code, not data to load. A subset (NT-01, NT-02, NT-03, NT-04) is exercised as real automated tests in tests/pilotFixtureNegativeScenarios.test.js. The rest (NT-05..NT-12) are listed, unexecuted, in GAPS_REPORT.md for a later chat/session."
  );
  addGap(
    "out-of-scope-stubs",
    "not_modelled",
    "The fixture's 6 outOfScopeAcceptanceStubs (contracts, maintenance, etc.) are explicitly placeholders in the source package and are not loaded."
  );

  return {
    records: {
      users, clients, mine_sites,
      service_requests, leads,
      quotes, quote_lines,
      purchase_orders, po_amendments,
      dispatch_cards,
      timesheets, field_worksheets, material_usage,
      stock_items, stock_movements,
      invoices, invoice_lines,
      access_requests,
      internal_work_requests
    },
    gaps
  };
}

// ── Foreign-key validation against a real target database ─────────────────
//
// Pure function: given the target db's CURRENT collections (before any
// fixture write) and the candidate fixture records built above, decides
// which candidates may actually be inserted (`accepted`) and which must be
// `rejected` because a foreign key they depend on does not resolve — either
// in the existing target db or among the fixture records themselves.
//
// This is what makes "skipped" and "rejected" real, distinct, non-vacuous
// categories rather than just two names for the same thing:
//   - "skipped" (see `gaps` above) = never became a candidate at all,
//     because build-fixture-records.mjs itself decided not to map it.
//   - "rejected" = WAS a candidate, but failed validation against the
//     actual target database at load time (e.g. a referenced client was
//     deleted from the target between runs, or a required id collides).
//
// Processed in dependency order so a rejected parent record correctly
// cascades: nothing that depends on a rejected id can itself be accepted.
export const FK_VALIDATION_ORDER = [
  { collection: "users", fk: [] },
  { collection: "clients", fk: [] },
  { collection: "mine_sites", fk: [["client_id", "clients"]] },
  { collection: "service_requests", fk: [["client_id", "clients"]] },
  { collection: "leads", fk: [["service_request_id", "service_requests"]] },
  { collection: "quotes", fk: [["client_id", "clients"]] },
  { collection: "quote_lines", fk: [["quotation_id", "quotes"]] },
  { collection: "purchase_orders", fk: [["quotation_id", "quotes"]] },
  { collection: "po_amendments", fk: [["purchase_order_id", "purchase_orders"]] },
  { collection: "dispatch_cards", fk: [["purchase_order_id", "purchase_orders"]] },
  { collection: "timesheets", fk: [["dispatch_card_id", "dispatch_cards"], ["user_id", "users"]] },
  { collection: "field_worksheets", fk: [["dispatch_card_id", "dispatch_cards"], ["technician_id", "users"]] },
  { collection: "material_usage", fk: [["dispatch_card_id", "dispatch_cards"]] },
  { collection: "stock_items", fk: [] },
  { collection: "stock_movements", fk: [["stock_item_id", "stock_items"]] },
  { collection: "invoices", fk: [["purchase_order_id", "purchase_orders"], ["dispatch_card_id", "dispatch_cards"]] },
  { collection: "invoice_lines", fk: [["invoice_id", "invoices"]] },
  { collection: "access_requests", fk: [] },
  { collection: "internal_work_requests", fk: [["created_by_user_id", "users"]] }
];

export function validateRecordsAgainstTarget(existingDb, records) {
  // Seed known-id sets from whatever already exists in the target db, so a
  // fixture record referencing a real (non-fixture) client/quote/etc. is
  // valid too — this loader is additive into a live-shaped db, not into an
  // empty one.
  const knownIds = {};
  for (const { collection } of FK_VALIDATION_ORDER) {
    knownIds[collection] = new Set((existingDb[collection] || []).map((r) => r.id));
  }

  const accepted = {};
  const rejected = [];
  for (const { collection, fk } of FK_VALIDATION_ORDER) {
    accepted[collection] = [];
    for (const record of records[collection] || []) {
      let reason = null;
      for (const [field, targetCollection] of fk) {
        const value = record[field];
        if (value !== null && value !== undefined && !knownIds[targetCollection].has(value)) {
          reason = `${field}="${value}" does not resolve in ${targetCollection}`;
          break;
        }
      }
      if (reason) {
        rejected.push({ collection, id: record.id, fixture_source_id: record.fixture_source_id, reason });
        continue;
      }
      accepted[collection].push(record);
      knownIds[collection].add(record.id);
    }
  }
  return { accepted, rejected };
}
