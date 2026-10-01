// Single shared source for how a stock-movement ledger entry is decided,
// applied, and described. inventoryController.js (manual receipts/issues/
// adjustments AND authorised direct-sale issue) and dispatchController.js
// (worksheet material-usage stock deduction) all call into this module, so
// there is exactly one place that decides whether a stock change is allowed,
// exactly one place that mutates on-hand balance, and exactly one ledger
// shape — never a second, divergent deduction path for the same evidence
// (the same discipline the Timesheet/signature rule asks for on the Chat B/D
// boundary applies here to inventory movements, and now explicitly to the
// Chat C direct-sale boundary too — see CHAT_C_DIRECT_SALE_STOCK_ISSUE_CONTRACT.md).
import { createHash } from "node:crypto";
import { roles } from "./permissions.js";

/**
 * Walks Equipment Tag -> Plant Section -> Plant -> Mine Site to find a
 * readable site name for a piece of equipment. Returns null if any link in
 * the chain is missing rather than throwing, since a movement's reference
 * label is explanatory metadata, not a control.
 */
export function resolveEquipmentSiteName(db, equipmentTagId) {
  if (!equipmentTagId) return null;
  const tag = (db.equipment_tags || []).find((e) => e.id === equipmentTagId);
  if (!tag) return null;
  const section = (db.plant_sections || []).find((s) => s.id === tag.plant_section_id);
  const plant = section ? (db.plants || []).find((p) => p.id === section.plant_id) : null;
  const site = plant ? (db.mine_sites || []).find((m) => m.id === plant.mine_site_id) : null;
  return site ? site.name : null;
}

/**
 * Produces a human-readable description of what a stock movement is linked
 * to (a dispatch, a purchase order, a supplier, a worksheet material-usage
 * record, an authorised direct sale, a return, or a scrap/write-off),
 * including the client/site when that chain is reachable. Returns null when
 * there is nothing to describe, and a "(not found)" label rather than
 * throwing when a reference points at a record that no longer resolves, so a
 * corrupted or stale reference is visible instead of silently hidden. Never
 * invents a client/site/amount that the source data doesn't actually have.
 */
export function describeStockReference(db, referenceType, referenceId, clientId) {
  if (!referenceType) return null;
  switch (referenceType) {
    case "dispatch_card": {
      if (!referenceId) return null;
      const job = (db.dispatch_cards || []).find((j) => j.id === referenceId);
      if (!job) return `Dispatch ${referenceId} (not found)`;
      const quote = (db.quotes || []).find((q) => q.id === job.quotation_id);
      const client = quote ? (db.clients || []).find((c) => c.id === quote.client_id) : null;
      const siteName = quote ? resolveEquipmentSiteName(db, quote.equipment_tag_id) : null;
      return [`Dispatch ${job.dispatch_number || job.id}`, client?.name, siteName].filter(Boolean).join(" — ");
    }
    case "purchase_order": {
      if (!referenceId) return null;
      const po = (db.purchase_orders || []).find((p) => p.id === referenceId);
      if (!po) return `Purchase Order ${referenceId} (not found)`;
      return `Purchase Order ${po.po_reference || po.id}`;
    }
    case "supplier": {
      if (!referenceId) return null;
      const supplier = (db.suppliers || []).find((s) => s.id === referenceId);
      return supplier ? `Supplier receipt — ${supplier.name}` : `Supplier ${referenceId} (not found)`;
    }
    case "material_usage": {
      if (!referenceId) return null;
      const usage = (db.material_usage || []).find((m) => m.id === referenceId);
      if (!usage) return `Material usage ${referenceId} (not found)`;
      const job = (db.dispatch_cards || []).find((j) => j.id === usage.dispatch_card_id);
      return `Material usage on dispatch ${job?.dispatch_number || usage.dispatch_card_id}`;
    }
    // Chat C's authorised direct-sale stock issue. This ledger only records
    // that an issue happened against whatever sale/order id Chat C's system
    // gives it, plus the client it was told about — it does not know about,
    // and does not invent, pricing, invoicing, or sale-approval status. See
    // CHAT_C_DIRECT_SALE_STOCK_ISSUE_CONTRACT.md.
    case "direct_sale": {
      const client = clientId ? (db.clients || []).find((c) => c.id === clientId) : null;
      const base = referenceId ? `Direct sale issue — sale ${referenceId}` : "Direct sale issue";
      if (clientId && !client) return `${base} (client ${clientId} not found)`;
      return client ? `${base} — ${client.name}` : base;
    }
    // Opening balance recorded when an item is registered with stock already
    // on hand. No supplier, price or valuation is implied.
    case "opening_balance":
      return "Opening balance at registration";
    // A return can be against a known dispatch or PO (try both, since the
    // caller isn't required to know which), or unattached to either — never
    // guessed, just plainly stated when it can't be matched.
    case "return": {
      if (!referenceId) return "Return to stock";
      const dispatchLabel = describeStockReference(db, "dispatch_card", referenceId, clientId);
      if (dispatchLabel && !dispatchLabel.endsWith("(not found)")) return `Return — ${dispatchLabel}`;
      const poLabel = describeStockReference(db, "purchase_order", referenceId, clientId);
      if (poLabel && !poLabel.endsWith("(not found)")) return `Return — ${poLabel}`;
      return `Return — reference ${referenceId} (not matched to a known dispatch or purchase order)`;
    }
    // Scrap/write-off never claims a linked business record — the `reason`
    // field is where the write-off justification lives; this label only
    // marks the category.
    case "scrap": {
      return referenceId ? `Scrap / write-off — reference ${referenceId}` : "Scrap / write-off";
    }
    default:
      return null;
  }
}

/**
 * Builds one immutable stock-movement ledger entry. `effectiveQty` is the
 * signed quantity already applied to on-hand stock (positive = increase,
 * negative = decrease); `quantityBefore`/`quantityAfter` are the on-hand
 * balances immediately either side of that change, so every entry is
 * self-explaining without needing to replay the whole ledger to know what
 * happened at that point in time.
 */
export function buildMovementRecord({
  store,
  db,
  stockItem,
  movementType,
  effectiveQty,
  quantityBefore,
  quantityAfter,
  reason,
  referenceId,
  referenceType,
  clientId,
  overrideNegative,
  sourceDocumentRef,
  idempotencyKey,
  idempotencyFingerprint,
  actor
}) {
  return {
    id: store.id("smv"),
    stock_item_id: stockItem.id,
    movement_type: movementType,
    // "direction" is deliberately independent of movement_type wording
    // ("in"/"out"/"adjustment" is the operator's chosen category; "increase"/
    // "decrease" is the arithmetic fact) so the ledger and the UI can always
    // say plainly which way the balance moved, even for an adjustment.
    direction: effectiveQty > 0 ? "increase" : "decrease",
    quantity: effectiveQty,
    quantity_before: quantityBefore,
    quantity_after: quantityAfter,
    unit_of_measure: stockItem.unit_of_measure,
    reason,
    reference_id: referenceId || null,
    reference_type: referenceType || null,
    // Only ever set when the caller actually told us a client (direct-sale
    // issue). Never inferred for dispatch/PO references — those already
    // resolve their own client through the real chain, and duplicating it
    // here would risk the two disagreeing after the fact.
    client_id: clientId || null,
    reference_label: describeStockReference(db, referenceType, referenceId, clientId),
    override_negative: Boolean(overrideNegative),
    // Free-text evidence for a supplier receipt (delivery note / supplier
    // invoice number). Null for every other movement.
    source_document_ref: sourceDocumentRef || null,
    // Duplicate-submission protection; null when the caller sent no key.
    idempotency_key: idempotencyKey || null,
    idempotency_fingerprint: idempotencyFingerprint || null,
    actor_id: actor.id,
    created_at: new Date().toISOString()
  };
}

/**
 * The single authority for whether a stock change is allowed, and the only
 * place that mutates `quantity_on_hand` and appends to the ledger. Every
 * caller in the system — the manual movement endpoint, the worksheet
 * material-usage deduction, and the direct-sale issue endpoint — goes
 * through this one function, so there is exactly one negative-stock rule,
 * one override rule, and one atomicity guarantee (nothing is mutated or
 * recorded unless `ok: true` comes back).
 *
 * `movementType` is "in" | "out" | "adjustment". For "out", `requestedQuantity`
 * is treated as a magnitude (its sign is ignored). For "adjustment", the
 * caller's sign is respected as-is. For "in", the magnitude is used.
 */
export function applyStockChange({
  store,
  db,
  stockItem,
  movementType,
  requestedQuantity,
  reason,
  referenceId,
  referenceType,
  clientId,
  overrideNegative,
  sourceDocumentRef,
  idempotencyKey,
  idempotencyFingerprint,
  actor
}) {
  const qty = Number(requestedQuantity);
  let effectiveQty;
  if (movementType === "out") {
    effectiveQty = -Math.abs(qty);
  } else if (movementType === "adjustment") {
    effectiveQty = qty;
  } else {
    effectiveQty = Math.abs(qty);
  }

  const quantityBefore = stockItem.quantity_on_hand;
  const projected = quantityBefore + effectiveQty;

  if (projected < 0) {
    if (!overrideNegative) {
      return {
        ok: false,
        status: 409,
        message: `Insufficient stock. On hand: ${quantityBefore} ${stockItem.unit_of_measure}. Pass override_negative:true with Admin or Operations role to force.`
      };
    }
    if (![roles.ADMIN, roles.OPERATIONS].includes(actor.role)) {
      return {
        ok: false,
        status: 403,
        message: "Only Admin or Operations may override a negative-stock movement."
      };
    }
  }

  const before = { ...stockItem };
  stockItem.quantity_on_hand = quantityBefore + effectiveQty;

  const movement = buildMovementRecord({
    store,
    db,
    stockItem,
    movementType,
    effectiveQty,
    quantityBefore,
    quantityAfter: stockItem.quantity_on_hand,
    reason,
    referenceId,
    referenceType,
    clientId,
    overrideNegative,
    sourceDocumentRef,
    idempotencyKey,
    idempotencyFingerprint,
    actor
  });
  if (!db.stock_movements) db.stock_movements = [];
  db.stock_movements.push(movement);

  return { ok: true, movement, before, stockItem };
}

/** Adds read-only display fields (item identity, actor name) for listing
 * endpoints. Never changes any ledger fact — this is presentation only, and
 * is deliberately tolerant of a movement whose item or actor record cannot
 * be found (e.g. in a minimal test fixture) so a listing never crashes on
 * incomplete data. */
export function decorateMovementForDisplay(db, movement) {
  const item = (db.stock_items || []).find((s) => s.id === movement.stock_item_id);
  const actorUser = (db.users || []).find((u) => u.id === movement.actor_id);
  const client = movement.client_id ? (db.clients || []).find((c) => c.id === movement.client_id) : null;
  return {
    ...publicMovement(movement),
    item_code: item?.item_code || null,
    item_name: item?.item_name || null,
    item_unit_of_measure: movement.unit_of_measure || item?.unit_of_measure || null,
    actor_name: actorUser?.name || null,
    client_name: client?.name || null
  };
}

// ── Purchase-to-use traceability (Task 02) ───────────────────────────────────
// Everything below is additive. It reuses the one ledger shape and the one
// mutation point above; it never mutates stock itself.

/**
 * Owner decision O1 (see BENCHMARK_AND_DECISIONS.md): ORAC has a `suppliers`
 * collection but NO supplier purchase-order or goods-received record — the
 * `purchase_orders` collection holds CLIENT purchase orders. A stock receipt
 * therefore cites a registered supplier plus a free-text source document
 * (delivery note / supplier invoice number). Set to false to require the
 * supplier only.
 */
export const RECEIPT_REQUIRES_SOURCE_DOCUMENT = true;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** Reads the optional duplicate-submission key from the body or the
 * `Idempotency-Key` header (IETF httpapi draft). Returns {key} or {error}. */
export function readIdempotencyKey(req) {
  const raw = req.body?.idempotency_key ?? req.headers?.["idempotency-key"] ?? null;
  if (raw === null || raw === undefined || raw === "") return { key: null };
  const key = String(raw).replace(/^"|"$/g, "");
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return { error: "Idempotency key must be 8-128 characters using letters, digits, dot, underscore, colon or hyphen." };
  }
  return { key };
}

/** Stable, order-independent fingerprint of the fields that define a request. */
export function requestFingerprint(fields) {
  const normalised = Object.keys(fields).sort().map((k) => [k, fields[k] === undefined ? null : fields[k]]);
  return createHash("sha256").update(JSON.stringify(normalised)).digest("hex").slice(0, 32);
}

/** Looks for an earlier record from the SAME actor with the SAME key.
 * Same key + same payload = replay; same key + different payload = conflict. */
export function findIdempotentRecord(records, actorId, key, fingerprint, actorField = "actor_id") {
  if (!key) return { kind: "none" };
  const hit = (records || []).find((r) => r.idempotency_key === key && r[actorField] === actorId);
  if (!hit) return { kind: "none" };
  return hit.idempotency_fingerprint === fingerprint ? { kind: "replay", record: hit } : { kind: "conflict", record: hit };
}

/** Internal bookkeeping never leaves the API. */
export function publicMovement(movement) {
  if (!movement) return movement;
  const { idempotency_fingerprint, ...rest } = movement;
  return rest;
}

const clean = (v) => (typeof v === "string" ? v.trim() : v);

/**
 * Decides whether a MANUAL movement (POST /inventory/movements) carries a
 * coherent type/reference/sign combination. Pure: reads `db`, changes nothing.
 * Returns { ok: true } or { ok: false, status, message }.
 *
 * Rules (each is a stock-integrity control, not a business policy):
 *  - material_usage is reserved for the worksheet deduction path, so a manual
 *    movement can never fabricate or duplicate worksheet-use evidence.
 *  - a receipt ("in") must name a registered supplier and a source document;
 *    a client PO is not supplier purchase evidence.
 *  - a return must increase stock; scrap must decrease it; neither may be
 *    posted as the opposite direction.
 *  - a return tied to a known dispatch cannot exceed what that dispatch used.
 */
export function validateManualMovement({ db, stockItem, body }) {
  const fail = (status, message) => ({ ok: false, status, message });
  const type = body.movement_type;
  const refType = body.reference_type || null;
  const refId = body.reference_id || null;
  const qty = Number(body.quantity);

  if (refType === "material_usage") {
    return fail(409, "Material-usage movements are created only by recording material on a dispatch worksheet; they cannot be posted manually.");
  }

  if (type === "in") {
    if (refType === "supplier") {
      const supplier = refId ? (db.suppliers || []).find((s) => s.id === refId) : null;
      if (!supplier) return fail(400, "A receipt must reference a registered supplier.");
      if (RECEIPT_REQUIRES_SOURCE_DOCUMENT && !clean(body.source_document_ref)) {
        return fail(400, "A receipt needs a source document reference (for example a delivery note or supplier invoice number).");
      }
      return { ok: true };
    }
    if (refType === "return") {
      const job = refId ? (db.dispatch_cards || []).find((j) => j.id === refId) : null;
      if (job) {
        const catalogId = stockItem.catalog_item_id;
        const used = catalogId
          ? (db.material_usage || [])
              .filter((u) => u.dispatch_card_id === job.id && u.catalog_item_id === catalogId)
              .reduce((sum, u) => sum + Number(u.quantity_used || 0), 0)
          : 0;
        const alreadyReturned = (db.stock_movements || [])
          .filter((m) => m.reference_type === "return" && m.reference_id === job.id && m.stock_item_id === stockItem.id && m.quantity > 0)
          .reduce((sum, m) => sum + m.quantity, 0);
        if (Math.abs(qty) + alreadyReturned > used) {
          return fail(409, `Return exceeds the quantity used on dispatch ${job.dispatch_number || job.id} for this item (used ${used}, already returned ${alreadyReturned}, ${stockItem.unit_of_measure}).`);
        }
      }
      return { ok: true };
    }
    if (!refType) {
      return fail(400, "A receipt needs a supplier and a source document reference. Choose Return to stock if this is a return.");
    }
    if (refType === "purchase_order") {
      return fail(400, "Client purchase orders are not supplier purchase evidence. Reference the supplier and the delivery/supplier document instead.");
    }
    return fail(400, `A stock increase cannot be recorded against "${refType}". Use a supplier receipt or a return to stock.`);
  }

  if (type === "out") {
    if (refType === "supplier" || refType === "return") {
      return fail(400, `A stock decrease cannot be recorded as "${refType}".`);
    }
    return { ok: true };
  }

  if (type === "adjustment") {
    if (refType === "supplier" || refType === "return" || refType === "purchase_order") {
      return fail(400, `A correction cannot be recorded as "${refType}".`);
    }
    if (refType === "scrap" && !(qty < 0)) {
      return fail(400, "Scrap must decrease stock: enter a negative quantity.");
    }
    return { ok: true };
  }
  return { ok: true };
}

function categoryOf(m) {
  switch (m.reference_type) {
    case "opening_balance": return "opening_balance";
    case "supplier": return "supplier_receipt";
    case "purchase_order": return m.movement_type === "in" ? "client_po_labelled_receipt" : "client_po_linked";
    case "return": return "return";
    case "scrap": return "scrap";
    case "material_usage": return "worksheet_use";
    case "direct_sale": return "direct_sale";
    case "dispatch_card": return "dispatch_issue";
    default:
      if (m.movement_type === "in") return "unsourced_receipt";
      if (m.movement_type === "out") return "issue";
      return "correction";
  }
}

/**
 * Read-only reconciliation of the ledger against on-hand balances. It never
 * repairs anything: it reports, per stock item, what the movements add up to,
 * where they disagree with the stored balance, and which movements break a
 * rule. Quantities are only ever summed within one unit of measure.
 */
export function buildReconciliation(db, { stockItemId = null } = {}) {
  const items = (db.stock_items || []).filter((i) => !stockItemId || i.id === stockItemId);
  const allMovements = db.stock_movements || [];
  const report = items.map((item) => {
    const movements = allMovements
      .map((m, index) => ({ m, index }))
      .filter(({ m }) => m.stock_item_id === item.id)
      .sort((a, b) => String(a.m.created_at).localeCompare(String(b.m.created_at)) || a.index - b.index)
      .map(({ m }) => m);
    const exceptions = [];
    const flag = (code, message, movement) => exceptions.push({ code, message, movement_id: movement?.id ?? null });

    // Records written before the ledger carried quantity_before/after and a unit cannot be
    // checked arithmetically. They are reported as incomplete instead of being given a
    // false precision (no invented balances, no guessed units).
    const isComplete = (m) => typeof m.quantity === "number" && typeof m.quantity_before === "number"
      && typeof m.quantity_after === "number" && Boolean(m.unit_of_measure);
    const units = new Set(movements.filter((m) => m.unit_of_measure).map((m) => m.unit_of_measure));
    if (units.size > 1) flag("MIXED_UNITS", `Movements use more than one unit (${[...units].join(", ")}); totals are kept per unit and never combined.`);
    const inUnit = movements.filter((m) => m.unit_of_measure === item.unit_of_measure);
    movements.filter((m) => m.unit_of_measure && m.unit_of_measure !== item.unit_of_measure).forEach((m) =>
      flag("UNIT_MISMATCH", `Movement unit ${m.unit_of_measure} differs from the item's unit ${item.unit_of_measure}.`, m));

    const byCategory = {};
    const byUnit = {};
    for (const m of movements) {
      const cat = categoryOf(m);
      byCategory[cat] = byCategory[cat] || { count: 0, net_quantity: 0 };
      byCategory[cat].count += 1;
      if (m.unit_of_measure === item.unit_of_measure) byCategory[cat].net_quantity += Number(m.quantity);
      if (m.unit_of_measure) byUnit[m.unit_of_measure] = (byUnit[m.unit_of_measure] || 0) + Number(m.quantity);
    }

    const seenUsage = new Map();
    movements.forEach((m, i) => {
      if (!isComplete(m)) {
        flag("LEGACY_INCOMPLETE_MOVEMENT", "Movement lacks a unit or before/after balance, so it cannot be checked arithmetically.", m);
      } else {
        if (Math.abs(Number(m.quantity_before) + Number(m.quantity) - Number(m.quantity_after)) > 1e-9) flag("BALANCE_MATH", `Before ${m.quantity_before} + quantity ${m.quantity} is not after ${m.quantity_after}.`, m);
        if (i > 0 && isComplete(movements[i - 1]) && Number(movements[i - 1].quantity_after) !== Number(m.quantity_before)) flag("CHAIN_BREAK", `Previous balance ${movements[i - 1].quantity_after} does not match this movement's starting balance ${m.quantity_before}.`, m);
        if ((m.direction === "increase") !== (Number(m.quantity) > 0)) flag("SIGN", "Direction disagrees with the sign of the quantity.", m);
      }
      if (m.movement_type === "in" && !(Number(m.quantity) > 0)) flag("SIGN", "A receipt must increase stock.", m);
      if (m.movement_type === "out" && !(Number(m.quantity) < 0)) flag("SIGN", "An issue must decrease stock.", m);
      if (typeof m.quantity_after === "number" && Number(m.quantity_after) < 0 && !m.override_negative) flag("NEGATIVE_WITHOUT_OVERRIDE", `Balance went to ${m.quantity_after} without a recorded override.`, m);
      const cat = categoryOf(m);
      if (cat === "unsourced_receipt") flag("UNSOURCED_RECEIPT", "Stock increase with no supplier, return or opening-balance source.", m);
      if (cat === "client_po_labelled_receipt") flag("CLIENT_PO_AS_RECEIPT", "Receipt references a client purchase order, which is not supplier purchase evidence.", m);
      if (cat === "supplier_receipt" && !(db.suppliers || []).some((s) => s.id === m.reference_id)) flag("SUPPLIER_NOT_FOUND", "Receipt references a supplier that no longer resolves.", m);
      if (cat === "return" && !(db.dispatch_cards || []).some((j) => j.id === m.reference_id)) flag("UNMATCHED_RETURN", "Return is not matched to a known dispatch.", m);
      if (cat === "worksheet_use") {
        if (seenUsage.has(m.reference_id)) flag("DOUBLE_DEDUCTION", `Material usage ${m.reference_id} deducted stock more than once.`, m);
        seenUsage.set(m.reference_id, true);
      }
    });

    const last = movements[movements.length - 1];
    const ledgerBalance = last && typeof last.quantity_after === "number" ? Number(last.quantity_after) : null;
    if (!movements.length && Number(item.quantity_on_hand) !== 0) {
      flag("UNEXPLAINED_STOCK", `On hand is ${item.quantity_on_hand} ${item.unit_of_measure} but no movement explains it (no opening balance recorded).`);
    }
    if (last && isComplete(last) && ledgerBalance !== Number(item.quantity_on_hand)) {
      flag("ONHAND_DRIFT", `Stored on-hand ${item.quantity_on_hand} differs from the ledger's last balance ${ledgerBalance}.`, last);
    }
    const first = movements[0];
    const movementSum = inUnit.reduce((sum, m) => sum + Number(m.quantity), 0);
    if (first && units.size === 1 && movements.every(isComplete) && Number(first.quantity_before) + movementSum !== Number(item.quantity_on_hand)) {
      flag("SUM_MISMATCH", `Starting balance ${first.quantity_before} plus movements ${movementSum} is not the stored on-hand ${item.quantity_on_hand}.`);
    }

    return {
      stock_item_id: item.id,
      item_code: item.item_code || null,
      item_name: item.item_name || null,
      unit_of_measure: item.unit_of_measure,
      quantity_on_hand: item.quantity_on_hand,
      ledger_balance: ledgerBalance,
      movement_count: movements.length,
      movement_sum: movementSum,
      by_category: byCategory,
      by_unit: byUnit,
      exceptions,
      status: exceptions.length ? "exceptions" : "reconciled"
    };
  });

  // Worksheet usage on a tracked item that never produced a movement is a
  // ledger gap (for example usage recorded before server-side deduction).
  const systemExceptions = [];
  const scopedItemIds = new Set(items.map((i) => i.id));
  for (const usage of db.material_usage || []) {
    if (!usage.catalog_item_id) continue;
    const tracked = (db.stock_items || []).find((s) => s.catalog_item_id === usage.catalog_item_id);
    if (!tracked || !scopedItemIds.has(tracked.id)) continue;
    const hasMovement = allMovements.some((m) => m.reference_type === "material_usage" && m.reference_id === usage.id);
    if (!hasMovement) systemExceptions.push({ code: "USAGE_WITHOUT_MOVEMENT", message: `Material usage ${usage.id} on a tracked item has no stock movement.`, stock_item_id: tracked.id, material_usage_id: usage.id });
  }

  return {
    generated_at: new Date().toISOString(),
    totals: {
      items: report.length,
      reconciled: report.filter((r) => r.status === "reconciled").length,
      with_exceptions: report.filter((r) => r.status === "exceptions").length,
      system_exceptions: systemExceptions.length
    },
    items: report,
    system_exceptions: systemExceptions
  };
}

/** Newest first. Movements created in the same millisecond keep a deterministic
 * order (later insertion = newer), so a history screen never shows a chain
 * whose before/after balances run backwards. */
export function newestFirst(movements) {
  return (movements || [])
    .map((m, index) => ({ m, index }))
    .sort((a, b) => (new Date(b.m.created_at) - new Date(a.m.created_at)) || (b.index - a.index))
    .map(({ m }) => m);
}
