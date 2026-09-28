import { requirePermission, roles } from "../permissions.js";
import bcrypt from "bcrypt";
import {
  validateParentAssignment,
  enrichClient,
  enrichMineSite,
  enrichPlant,
  enrichPlantSection,
  enrichEquipmentTag
} from "../services/entityHierarchy.js";

function getActor(req) {
  return req.db.users.find((u) => u.id === req.user.id);
}

function safeUser(user) {
  const {
    password_hash,
    password,
    reset_token,
    reset_token_expires_at,
    ...publicUser
  } = user;
  return publicUser;
}

// GAP FIX (Chat E): a Client Viewer with no client_id, or a client_id that
// does not match any real client, is not a security problem (clientScope.js
// already fails closed — such a user sees nothing) but it is a silently
// broken account: nobody would know until that person logs in and finds an
// empty portal. This checks the *final* role/client_id state a write would
// produce and rejects it up front instead. It never widens access — it only
// narrows which writes succeed.
function clientLinkProblem(db, role, clientId) {
  if (role !== roles.CLIENT_VIEWER) return null;
  if (!clientId) return "client_id is required when role is Client Viewer.";
  const client = (db.clients || []).find((c) => c.id === clientId);
  if (!client) return "client_id does not match an existing client.";
  return null;
}

// ── Users (Admin-only: role changes are gated entirely by manageUsers) ──
export const createUser = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageUsers");
  const body = req.body;
  const linkProblem = clientLinkProblem(req.db, body.role, body.client_id || null);
  if (linkProblem) return res.status(400).json({ success: false, message: linkProblem });
  const user = {
    id: req.store.id("u"),
    name: body.name,
    email: body.email,
    role: body.role,
    is_active: body.is_active !== undefined ? body.is_active : true,
    client_id: body.client_id || null,
    trade: body.role === "Technician" ? (body.trade || null) : null,
    password_hash: bcrypt.hashSync(body.password, 10),
    created_at: new Date().toISOString()
  };
  req.db.users.push(user);
  req.store.audit(req.db, actor, "user", user.id, "ADMIN_USER_CREATED", null, safeUser(user));
  res.json({ success: true, data: safeUser(user) });
};

export const updateUser = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageUsers");
  const target = req.db.users.find((u) => u.id === req.params.id);
  if (!target) return res.status(404).json({ success: false, message: "User not found." });
  // Validate the FINAL state (existing fields + this request's changes)
  // before mutating anything, the same discipline contractsController.js
  // uses: a rejected request must leave no partial change.
  const finalRole = req.body.role !== undefined ? req.body.role : target.role;
  const finalClientId = req.body.client_id !== undefined ? req.body.client_id : target.client_id;
  const linkProblem = clientLinkProblem(req.db, finalRole, finalClientId || null);
  if (linkProblem) return res.status(400).json({ success: false, message: linkProblem });
  const before = safeUser(target);
  ["name", "email", "role", "is_active", "client_id", "trade"].forEach((k) => {
    if (req.body[k] !== undefined) target[k] = req.body[k];
  });
  if (target.role !== "Technician") target.trade = null;
  if (req.body.password !== undefined) target.password_hash = bcrypt.hashSync(req.body.password, 10);
  req.store.audit(req.db, actor, "user", target.id, "ADMIN_USER_UPDATED", before, safeUser(target));
  res.json({ success: true, data: safeUser(target) });
};

// ── Clients (top of the master-data hierarchy; no parent of their own) ──
export const createClient = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageClients");
  const body = req.body;
  const client = {
    id: req.store.id("c"),
    name: body.name,
    client_type: body.client_type,
    contact_person: body.contact_person || "",
    email: body.email || "",
    is_active: true
  };
  req.db.clients.push(client);
  req.store.audit(req.db, actor, "client", client.id, "ADMIN_CLIENT_CREATED", null, client);
  res.json({ success: true, data: enrichClient(req.db, client) });
};

export const updateClient = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageClients");
  const item = req.db.clients.find((c) => c.id === req.params.id);
  if (!item) return res.status(404).json({ success: false, message: "Client not found." });
  const before = { ...item };
  ["name", "client_type", "contact_person", "email"].forEach((k) => {
    if (req.body[k] !== undefined) item[k] = req.body[k];
  });
  req.store.audit(req.db, actor, "client", item.id, "ADMIN_CLIENT_UPDATED", before, item);
  res.json({ success: true, data: enrichClient(req.db, item) });
};

// ── Mine Sites (parent: Client) ──
export const createMineSite = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageAssets");
  const body = req.body;

  const parentCheck = validateParentAssignment(req.db, { collection: "mine_sites", parentId: body.client_id });
  if (!parentCheck.ok) return res.status(parentCheck.status).json({ success: false, message: parentCheck.message });

  const mineSite = { id: req.store.id("ms"), client_id: body.client_id, name: body.name, location: body.location || "", is_active: true };
  req.db.mine_sites.push(mineSite);
  req.store.audit(req.db, actor, "mine_site", mineSite.id, "ADMIN_MINE_SITE_CREATED", null, mineSite);
  res.json({ success: true, data: enrichMineSite(req.db, mineSite) });
};

export const updateMineSite = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageAssets");
  const item = req.db.mine_sites.find((m) => m.id === req.params.id);
  if (!item) return res.status(404).json({ success: false, message: "Mine site not found." });

  if (req.body.client_id !== undefined) {
    const parentCheck = validateParentAssignment(req.db, {
      collection: "mine_sites",
      parentId: req.body.client_id,
      previousParentId: item.client_id
    });
    if (!parentCheck.ok) return res.status(parentCheck.status).json({ success: false, message: parentCheck.message });
  }

  const before = { ...item };
  ["client_id", "name", "location"].forEach((k) => {
    if (req.body[k] !== undefined) item[k] = req.body[k];
  });
  req.store.audit(req.db, actor, "mine_site", item.id, "ADMIN_MINE_SITE_UPDATED", before, item);
  res.json({ success: true, data: enrichMineSite(req.db, item) });
};

// ── Plants (parent: Mine Site) ──
export const createPlant = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageAssets");
  const body = req.body;

  const parentCheck = validateParentAssignment(req.db, { collection: "plants", parentId: body.mine_site_id });
  if (!parentCheck.ok) return res.status(parentCheck.status).json({ success: false, message: parentCheck.message });

  const plant = { id: req.store.id("pl"), mine_site_id: body.mine_site_id, name: body.name, plant_code: body.plant_code, is_active: true };
  req.db.plants.push(plant);
  req.store.audit(req.db, actor, "plant", plant.id, "ADMIN_PLANT_CREATED", null, plant);
  res.json({ success: true, data: enrichPlant(req.db, plant) });
};

export const updatePlant = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageAssets");
  const item = req.db.plants.find((p) => p.id === req.params.id);
  if (!item) return res.status(404).json({ success: false, message: "Plant not found." });

  if (req.body.mine_site_id !== undefined) {
    const parentCheck = validateParentAssignment(req.db, {
      collection: "plants",
      parentId: req.body.mine_site_id,
      previousParentId: item.mine_site_id
    });
    if (!parentCheck.ok) return res.status(parentCheck.status).json({ success: false, message: parentCheck.message });
  }

  const before = { ...item };
  ["mine_site_id", "name", "plant_code"].forEach((k) => {
    if (req.body[k] !== undefined) item[k] = req.body[k];
  });
  req.store.audit(req.db, actor, "plant", item.id, "ADMIN_PLANT_UPDATED", before, item);
  res.json({ success: true, data: enrichPlant(req.db, item) });
};

// ── Plant Sections (parent: Plant) ──
export const createPlantSection = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageAssets");
  const body = req.body;

  const parentCheck = validateParentAssignment(req.db, { collection: "plant_sections", parentId: body.plant_id });
  if (!parentCheck.ok) return res.status(parentCheck.status).json({ success: false, message: parentCheck.message });

  const section = { id: req.store.id("ps"), plant_id: body.plant_id, name: body.name, section_code: body.section_code, is_active: true };
  req.db.plant_sections.push(section);
  req.store.audit(req.db, actor, "plant_section", section.id, "ADMIN_PLANT_SECTION_CREATED", null, section);
  res.json({ success: true, data: enrichPlantSection(req.db, section) });
};

export const updatePlantSection = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageAssets");
  const item = req.db.plant_sections.find((s) => s.id === req.params.id);
  if (!item) return res.status(404).json({ success: false, message: "Plant section not found." });

  if (req.body.plant_id !== undefined) {
    const parentCheck = validateParentAssignment(req.db, {
      collection: "plant_sections",
      parentId: req.body.plant_id,
      previousParentId: item.plant_id
    });
    if (!parentCheck.ok) return res.status(parentCheck.status).json({ success: false, message: parentCheck.message });
  }

  const before = { ...item };
  ["plant_id", "name", "section_code"].forEach((k) => {
    if (req.body[k] !== undefined) item[k] = req.body[k];
  });
  req.store.audit(req.db, actor, "plant_section", item.id, "ADMIN_PLANT_SECTION_UPDATED", before, item);
  res.json({ success: true, data: enrichPlantSection(req.db, item) });
};

// ── Equipment Tags (parent: Plant Section) ──
export const createEquipmentTag = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageAssets");
  const body = req.body;

  const parentCheck = validateParentAssignment(req.db, { collection: "equipment_tags", parentId: body.plant_section_id });
  if (!parentCheck.ok) return res.status(parentCheck.status).json({ success: false, message: parentCheck.message });

  const equipment = {
    id: req.store.id("eq"),
    plant_section_id: body.plant_section_id,
    tag_code: body.tag_code,
    equipment_name: body.equipment_name,
    criticality: body.criticality || "medium",
    status: body.status || "active",
    is_active: true
  };
  req.db.equipment_tags.push(equipment);
  req.store.audit(req.db, actor, "equipment_tag", equipment.id, "ADMIN_EQUIPMENT_TAG_CREATED", null, equipment);
  res.json({ success: true, data: enrichEquipmentTag(req.db, equipment) });
};

export const updateEquipmentTag = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageAssets");
  const item = req.db.equipment_tags.find((e) => e.id === req.params.id);
  if (!item) return res.status(404).json({ success: false, message: "Equipment tag not found." });

  if (req.body.plant_section_id !== undefined) {
    const parentCheck = validateParentAssignment(req.db, {
      collection: "equipment_tags",
      parentId: req.body.plant_section_id,
      previousParentId: item.plant_section_id
    });
    if (!parentCheck.ok) return res.status(parentCheck.status).json({ success: false, message: parentCheck.message });
  }

  const before = { ...item };
  ["plant_section_id", "tag_code", "equipment_name", "criticality", "status"].forEach((k) => {
    if (req.body[k] !== undefined) item[k] = req.body[k];
  });
  req.store.audit(req.db, actor, "equipment_tag", item.id, "ADMIN_EQUIPMENT_TAG_UPDATED", before, item);
  res.json({ success: true, data: enrichEquipmentTag(req.db, item) });
};

// ── Catalog Items (negative-price guard enforced twice: schema + here) ──
export const createCatalogItem = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageCatalog");
  const body = req.body;
  if (Number(body.unit_price) < 0) {
    return res.status(400).json({ success: false, message: "Unit price cannot be negative." });
  }
  const item = {
    id: req.store.id("cat"),
    item_code: body.item_code,
    item_name: body.item_name,
    category: body.category || "",
    unit_of_measure: body.unit_of_measure || "",
    unit_price: Number(body.unit_price),
    material_grade: body.material_grade || "",
    dimensions: body.dimensions || ""
  };
  req.db.catalog_items.push(item);
  req.store.audit(req.db, actor, "catalog_item", item.id, "ADMIN_CATALOG_ITEM_CREATED", null, item);
  res.json({ success: true, data: item });
};

export const updateCatalogItem = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageCatalog");
  const item = req.db.catalog_items.find((c) => c.id === req.params.id);
  if (!item) return res.status(404).json({ success: false, message: "Catalog item not found." });
  if (req.body.unit_price !== undefined && Number(req.body.unit_price) < 0) {
    return res.status(400).json({ success: false, message: "Unit price cannot be negative." });
  }
  const before = { ...item };
  ["item_code", "item_name", "category", "unit_of_measure", "unit_price", "material_grade", "dimensions"].forEach((k) => {
    if (req.body[k] !== undefined) item[k] = req.body[k];
  });
  req.store.audit(req.db, actor, "catalog_item", item.id, "ADMIN_CATALOG_ITEM_UPDATED", before, item);
  res.json({ success: true, data: item });
};

// ── Company Profile (read open to any authenticated user for document
//    headers; write gated to manageCompanyProfile) ──
export const getCompanyProfile = (req, res) => {
  res.json({ success: true, data: req.db.company_profile || {} });
};

export const updateCompanyProfile = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageCompanyProfile");
  const before = { ...req.db.company_profile };
  req.db.company_profile = { ...req.db.company_profile, ...req.body };
  req.store.audit(req.db, actor, "company_profile", "company_profile", "ADMIN_COMPANY_PROFILE_UPDATED", before, req.db.company_profile);
  res.json({ success: true, data: req.db.company_profile });
};
