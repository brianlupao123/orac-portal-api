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
  referenceLabel,
  clientId,
  overrideNegative,
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
    reference_label: referenceLabel || describeStockReference(db, referenceType, referenceId, clientId),
    override_negative: Boolean(overrideNegative),
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
  referenceLabel,
  clientId,
  overrideNegative,
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
    referenceLabel,
    clientId,
    overrideNegative,
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
    ...movement,
    item_code: item?.item_code || null,
    item_name: item?.item_name || null,
    item_unit_of_measure: movement.unit_of_measure || item?.unit_of_measure || null,
    actor_name: actorUser?.name || null,
    client_name: client?.name || null
  };
}
