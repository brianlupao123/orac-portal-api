import { requirePermission } from "../permissions.js";
import {
  applyStockChange, buildMovementRecord, decorateMovementForDisplay, buildReconciliation,
  validateManualMovement, readIdempotencyKey, requestFingerprint, findIdempotentRecord, publicMovement, newestFirst
} from "../inventoryLedger.js";

function getActor(req) {
  return req.db.users.find((u) => u.id === req.user.id);
}

function reorderExplanation(item, supplier) {
  const onHand = `${item.quantity_on_hand} ${item.unit_of_measure}`;
  const level = item.reorder_level ?? 0;
  const isLow = item.quantity_on_hand <= level;
  if (!isLow) {
    return `${onHand} on hand is above the reorder level of ${level} ${item.unit_of_measure}.`;
  }
  const leadTime = supplier?.lead_time_days
    ? ` Ordering from ${supplier.name} typically takes ${supplier.lead_time_days} day${supplier.lead_time_days === 1 ? "" : "s"}.`
    : supplier
      ? ` Supplier ${supplier.name} is linked, but no lead time is recorded.`
      : " No supplier is linked to this item yet.";
  return `${onHand} on hand is at or below the reorder level of ${level} ${item.unit_of_measure}.${leadTime}`;
}

// ── Suppliers ────────────────────────────────────────────────────────────────

export const getSuppliers = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageInventory");
  res.json({ success: true, data: req.db.suppliers });
};

export const createSupplier = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageInventory");
  const body = req.body;
  const supplier = {
    id: req.store.id("sup"),
    name: body.name,
    contact_person: body.contact_person || null,
    email: body.email || null,
    phone: body.phone || null,
    lead_time_days: body.lead_time_days ?? null
  };
  req.db.suppliers.push(supplier);
  req.store.audit(req.db, actor, "supplier", supplier.id, "SUPPLIER_CREATED", null, supplier);
  res.json({ success: true, data: supplier });
};

export const updateSupplier = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageInventory");
  const supplier = req.db.suppliers.find((s) => s.id === req.params.id);
  if (!supplier) return res.status(404).json({ success: false, message: "Supplier not found." });
  const before = { ...supplier };
  ["name", "contact_person", "email", "phone", "lead_time_days"].forEach((k) => {
    if (req.body[k] !== undefined) supplier[k] = req.body[k];
  });
  req.store.audit(req.db, actor, "supplier", supplier.id, "SUPPLIER_UPDATED", before, supplier);
  res.json({ success: true, data: supplier });
};

// ── Stock Items ───────────────────────────────────────────────────────────────

export const getStockItems = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageInventory");
  const items = req.db.stock_items.map((item) => {
    const isLow = item.quantity_on_hand <= (item.reorder_level ?? 0);
    const supplier = req.db.suppliers.find((s) => s.id === item.supplier_id);
    return {
      ...item,
      is_low_stock: isLow,
      reorder_status: isLow ? "reorder_now" : "ok",
      reorder_explanation: reorderExplanation(item, supplier)
    };
  });
  res.json({ success: true, data: items });
};

export const createStockItem = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageInventory");
  const body = req.body;
  if (req.db.stock_items.find((s) => s.item_code === body.item_code)) {
    return res.status(409).json({ success: false, message: `Stock item with code ${body.item_code} already exists.` });
  }
  const item = {
    id: req.store.id("si"),
    catalog_item_id: body.catalog_item_id || null,
    item_code: body.item_code,
    item_name: body.item_name,
    unit_of_measure: body.unit_of_measure,
    quantity_on_hand: body.quantity_on_hand ?? 0,
    reorder_level: body.reorder_level ?? 0,
    unit_cost: body.unit_cost ?? 0,
    supplier_id: body.supplier_id || null,
    location: body.location || null
  };
  req.db.stock_items.push(item);
  // Registration with an opening balance must not create unexplained stock:
  // the opening quantity gets its own ledger entry (balance 0 -> opening),
  // built by the same shared builder as every other movement. No valuation
  // is attached - costing is an owner decision, not assumed here.
  if (item.quantity_on_hand > 0) {
    const opening = item.quantity_on_hand;
    if (!req.db.stock_movements) req.db.stock_movements = [];
    req.db.stock_movements.push(buildMovementRecord({
      store: req.store,
      db: req.db,
      stockItem: item,
      movementType: "in",
      effectiveQty: opening,
      quantityBefore: 0,
      quantityAfter: opening,
      reason: "Opening balance recorded at item registration",
      referenceType: "opening_balance",
      actor
    }));
  }
  req.store.audit(req.db, actor, "stock_item", item.id, "STOCK_ITEM_CREATED", null, item);
  res.json({ success: true, data: item });
};

export const updateStockItem = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageInventory");
  const item = req.db.stock_items.find((s) => s.id === req.params.id);
  if (!item) return res.status(404).json({ success: false, message: "Stock item not found." });
  // Unit safety: once any movement exists for this item, its unit of measure
  // is part of the ledger's meaning. Changing it would silently reinterpret
  // historic quantities, so it is refused (conversion rules are an owner decision).
  if (req.body.unit_of_measure !== undefined && req.body.unit_of_measure !== item.unit_of_measure
      && (req.db.stock_movements || []).some((m) => m.stock_item_id === item.id)) {
    return res.status(409).json({ success: false, message: "Unit of measure cannot be changed once stock movements exist for this item." });
  }
  const before = { ...item };
  ["item_code", "item_name", "unit_of_measure", "reorder_level", "unit_cost", "supplier_id", "location"].forEach((k) => {
    if (req.body[k] !== undefined) item[k] = req.body[k];
  });
  req.store.audit(req.db, actor, "stock_item", item.id, "STOCK_ITEM_UPDATED", before, item);
  res.json({ success: true, data: item });
};

// ── Stock Movements ───────────────────────────────────────────────────────────

export const recordStockMovement = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageInventory");
  const body = req.body;

  const item = req.db.stock_items.find((s) => s.id === body.stock_item_id);
  if (!item) return res.status(404).json({ success: false, message: "Stock item not found." });

  // Duplicate-submission protection. The same key from the same user with the
  // same payload returns the original movement and changes nothing; the same
  // key with a different payload is refused. Checked before anything mutates.
  const keyResult = readIdempotencyKey(req);
  if (keyResult.error) return res.status(400).json({ success: false, message: keyResult.error });
  const fingerprint = requestFingerprint({
    stock_item_id: body.stock_item_id,
    movement_type: body.movement_type,
    quantity: Number(body.quantity),
    reason: body.reason,
    reference_type: body.reference_type || null,
    reference_id: body.reference_id || null,
    source_document_ref: (body.source_document_ref || "").trim() || null,
    client_id: body.client_id || null,
    override_negative: Boolean(body.override_negative)
  });
  const prior = findIdempotentRecord(req.db.stock_movements, actor.id, keyResult.key, fingerprint);
  if (prior.kind === "conflict") {
    return res.status(409).json({ success: false, message: "This idempotency key was already used for a different stock movement." });
  }
  if (prior.kind === "replay") {
    return res.json({ success: true, idempotent_replay: true, data: { movement: publicMovement(prior.record), stock_item: item } });
  }

  const shape = validateManualMovement({ db: req.db, stockItem: item, body });
  if (!shape.ok) return res.status(shape.status).json({ success: false, message: shape.message });

  const result = applyStockChange({
    store: req.store,
    db: req.db,
    stockItem: item,
    movementType: body.movement_type,
    requestedQuantity: body.quantity,
    reason: body.reason,
    referenceId: body.reference_id,
    referenceType: body.reference_type,
    clientId: body.client_id,
    overrideNegative: body.override_negative,
    sourceDocumentRef: (body.source_document_ref || "").trim() || null,
    idempotencyKey: keyResult.key,
    idempotencyFingerprint: keyResult.key ? fingerprint : null,
    actor
  });

  if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });

  req.store.audit(req.db, actor, "stock_movement", result.movement.id, "STOCK_MOVEMENT_RECORDED", result.before, { ...result.stockItem, movement: publicMovement(result.movement) });
  res.json({ success: true, data: { movement: publicMovement(result.movement), stock_item: result.stockItem } });
};

// ── Direct-Sale Stock Issue ───────────────────────────────────────────────────
// The authorised contract Chat C's commercial flow calls once a direct sale
// (a walk-in/once-off sale not tied to a service dispatch) has already been
// approved on their side. This endpoint owns only the stock mechanics —
// enough stock exists, the balance moves atomically, the ledger records it —
// never pricing, invoicing, or whether the sale itself was allowed to happen.
// See CHAT_C_DIRECT_SALE_STOCK_ISSUE_CONTRACT.md for the full contract.
//
// It is gated by the same `manageInventory` permission as every other
// movement endpoint (Admin/Management/Operations) rather than a new,
// guessed permission for Sales/Finance — see that contract doc for why this
// is logged as an owner decision, not assumed here.
export const issueDirectSaleStock = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageInventory");
  // PROVISIONAL: no Chat C output or role packet in the source defines a
  // direct sale, so this endpoint ships dormant. It is enabled only by an
  // explicit ENABLE_DIRECT_SALE_STOCK_ISSUE=true once Chat C has accepted or
  // replaced the contract. While disabled it changes neither balance nor ledger.
  if (process.env.ENABLE_DIRECT_SALE_STOCK_ISSUE !== "true") {
    return res.status(404).json({ success: false, message: "Direct-sale stock issue is not enabled. It is awaiting reconciliation with the commercial flow." });
  }
  const body = req.body;

  const item = req.db.stock_items.find((s) => s.id === body.stock_item_id);
  if (!item) return res.status(404).json({ success: false, message: "Stock item not found." });

  const result = applyStockChange({
    store: req.store,
    db: req.db,
    stockItem: item,
    movementType: "out",
    requestedQuantity: body.quantity,
    reason: body.reason,
    referenceId: body.sale_reference_id,
    referenceType: "direct_sale",
    clientId: body.client_id,
    overrideNegative: body.override_negative,
    actor
  });

  if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });

  req.store.audit(req.db, actor, "stock_movement", result.movement.id, "DIRECT_SALE_STOCK_ISSUED", result.before, { ...result.stockItem, movement: result.movement });
  res.json({ success: true, data: { movement: result.movement, stock_item: result.stockItem } });
};

// ── Movement History ─────────────────────────────────────────────────────────
// Read-only. There is deliberately no PATCH or DELETE route for stock
// movements anywhere in the router — once written, a ledger entry is
// immutable; a mistake is corrected with a new, reasoned adjustment
// movement, never by editing history.

export const getStockMovements = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageInventory");
  let movements = req.db.stock_movements || [];
  if (req.query.stock_item_id) {
    movements = movements.filter((m) => m.stock_item_id === req.query.stock_item_id);
  }
  if (req.query.reference_type) {
    movements = movements.filter((m) => m.reference_type === req.query.reference_type);
  }
  if (req.query.client_id) {
    movements = movements.filter((m) => m.client_id === req.query.client_id);
  }
  const sorted = newestFirst(movements);
  res.json({
    success: true,
    data: sorted.map((m) => decorateMovementForDisplay(req.db, m)),
    count: sorted.length
  });
};

export const getStockItemMovements = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageInventory");
  const item = req.db.stock_items.find((s) => s.id === req.params.id);
  if (!item) return res.status(404).json({ success: false, message: "Stock item not found." });
  const movements = newestFirst((req.db.stock_movements || []).filter((m) => m.stock_item_id === item.id))
    .map((m) => decorateMovementForDisplay(req.db, m));
  res.json({ success: true, data: { stock_item: item, movements } });
};

// ── Low-Stock Report ──────────────────────────────────────────────────────────

export const getLowStockReport = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageInventory");
  const lowStock = req.db.stock_items
    .filter((item) => item.quantity_on_hand <= (item.reorder_level ?? 0))
    .map((item) => {
      const supplier = req.db.suppliers.find((s) => s.id === item.supplier_id);
      return {
        ...item,
        supplier_name: supplier?.name || null,
        supplier_lead_time_days: supplier?.lead_time_days || null,
        deficit: (item.reorder_level ?? 0) - item.quantity_on_hand,
        reorder_status: "reorder_now",
        reorder_explanation: reorderExplanation(item, supplier)
      };
    });
  res.json({ success: true, data: lowStock, count: lowStock.length });
};

// ── Reconciliation ───────────────────────────────────────────────────────────
// Read-only. Compares each item's stored balance with what its ledger adds up
// to and lists every rule-breaking movement. It repairs nothing.

export const getInventoryReconciliation = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageInventory");
  const stockItemId = req.query?.stock_item_id || null;
  if (stockItemId && !(req.db.stock_items || []).some((s) => s.id === stockItemId)) {
    return res.status(404).json({ success: false, message: "Stock item not found." });
  }
  res.json({ success: true, data: buildReconciliation(req.db, { stockItemId }) });
};
