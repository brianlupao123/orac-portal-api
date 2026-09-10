import { requirePermission } from "../permissions.js";
import { roles } from "../permissions.js";

function getActor(req) {
  return req.db.users.find((u) => u.id === req.user.id);
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
  const items = req.db.stock_items.map((item) => ({
    ...item,
    is_low_stock: item.quantity_on_hand <= (item.reorder_level ?? 0)
  }));
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
  req.store.audit(req.db, actor, "stock_item", item.id, "STOCK_ITEM_CREATED", null, item);
  res.json({ success: true, data: item });
};

export const updateStockItem = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageInventory");
  const item = req.db.stock_items.find((s) => s.id === req.params.id);
  if (!item) return res.status(404).json({ success: false, message: "Stock item not found." });
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

  const qty = Number(body.quantity);
  const effectiveQty = body.movement_type === "out" ? -Math.abs(qty) : qty;
  const projected = item.quantity_on_hand + effectiveQty;

  if (projected < 0) {
    if (!body.override_negative) {
      return res.status(409).json({
        success: false,
        message: `Insufficient stock. On hand: ${item.quantity_on_hand} ${item.unit_of_measure}. Pass override_negative:true with Admin or Operations role to force.`
      });
    }
    if (![roles.ADMIN, roles.OPERATIONS].includes(actor.role)) {
      return res.status(403).json({
        success: false,
        message: "Only Admin or Operations may override a negative-stock movement."
      });
    }
  }

  const before = { ...item };
  item.quantity_on_hand = item.quantity_on_hand + effectiveQty;

  const movement = {
    id: req.store.id("smv"),
    stock_item_id: body.stock_item_id,
    movement_type: body.movement_type,
    quantity: effectiveQty,
    quantity_after: item.quantity_on_hand,
    reason: body.reason,
    reference_id: body.reference_id || null,
    override_negative: body.override_negative || false,
    actor_id: actor.id,
    created_at: new Date().toISOString()
  };
  req.db.stock_movements.push(movement);
  req.store.audit(req.db, actor, "stock_movement", movement.id, "STOCK_MOVEMENT_RECORDED", before, { ...item, movement });

  res.json({ success: true, data: { movement, stock_item: item } });
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
        deficit: (item.reorder_level ?? 0) - item.quantity_on_hand
      };
    });
  res.json({ success: true, data: lowStock, count: lowStock.length });
};
