import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { approvedLabourValue } from "./timesheetReview.js";
import { dirname } from "node:path";
import { handleAuditForNotifications } from "./notifications.js";
import bcrypt from "bcrypt";

const now = () => new Date().toISOString();

/* ── Mutex: guarantees sequential access to db.json on Windows ── */
class Mutex {
  constructor() {
    this._tail = Promise.resolve();
  }

  acquire() {
    let release;
    const prev = this._tail;
    this._tail = new Promise((resolve) => {
      release = () => resolve();
    });

    // Make release idempotent (safe to call twice)
    let called = false;
    const safeRelease = () => {
      if (called) return;
      called = true;
      release();
    };

    return prev.then(() => safeRelease);
  }
}

/* ── Seed data ── */
function seedData() {
  // Default password: password123
  const defaultHash = bcrypt.hashSync("password123", 10);
  const users = [
    { id: "u_admin", name: "Admin User", email: "admin@orac.co.zw", role: "Admin", is_active: true, password_hash: defaultHash },
    { id: "u_management", name: "Management User", email: "management@orac.co.zw", role: "Management", is_active: true, password_hash: defaultHash },
    { id: "u_sales", name: "Sales User", email: "sales@orac.co.zw", role: "Sales", is_active: true, password_hash: defaultHash },
    { id: "u_finance", name: "Finance User", email: "finance@orac.co.zw", role: "Finance", is_active: true, password_hash: defaultHash },
    { id: "u_ops", name: "Operations User", email: "ops@orac.co.zw", role: "Operations", is_active: true, password_hash: defaultHash },
    { id: "u_tech", name: "Technician User", email: "tech@orac.co.zw", role: "Technician", trade: "Fitter", is_active: true, password_hash: defaultHash },
    { id: "u_supervisor", name: "Supervisor User", email: "supervisor@orac.co.zw", role: "Supervisor", is_active: true, password_hash: defaultHash },
    { id: "u_client", name: "Client Viewer", email: "client@orac.co.zw", role: "Client Viewer", is_active: true, client_id: "c_zimplats", password_hash: defaultHash }
  ];

  const clients = [
    { id: "c_zimplats", name: "Zimplats", client_type: "permanent", contact_person: "Procurement Office", email: "procurement@zimplats.example" },
    { id: "c_mimosa", name: "Mimosa Mining Company", client_type: "permanent", contact_person: "Maintenance Office", email: "maintenance@mimosa.example" },
    { id: "c_walkin", name: "Walk-in Client", client_type: "walk_in", contact_person: "Front Desk", email: "" }
  ];

  const mine_sites = [
    { id: "ms_ngezi", client_id: "c_zimplats", name: "Ngezi", location: "Zimbabwe" },
    { id: "ms_selous", client_id: "c_zimplats", name: "Selous", location: "Zimbabwe" },
    { id: "ms_zvishavane", client_id: "c_mimosa", name: "Zvishavane", location: "Zimbabwe" }
  ];

  const plants = [
    { id: "pl_smc", mine_site_id: "ms_ngezi", name: "SMC Concentrator", plant_code: "SMC-CON" },
    { id: "pl_smelter", mine_site_id: "ms_selous", name: "Smelter", plant_code: "SMELTER" },
    { id: "pl_mimosa_conc", mine_site_id: "ms_zvishavane", name: "Concentrator", plant_code: "MIM-CON" }
  ];

  const plant_sections = [
    { id: "ps_cyclone", plant_id: "pl_smc", name: "Cyclone Cluster", section_code: "CYCLONE" },
    { id: "ps_conveyor", plant_id: "pl_smc", name: "Discharge Conveyor Line", section_code: "CONV-DIS" },
    { id: "ps_furnace", plant_id: "pl_smelter", name: "Furnace Refractory Section", section_code: "FURN-REF" }
  ];

  const equipment_tags = [
    { id: "eq_smc_0102", plant_section_id: "ps_cyclone", tag_code: "EQ-TAG-SMC-0102", equipment_name: "Cyclone Wear Liner Assembly", criticality: "high", status: "active" },
    { id: "eq_smc_0207", plant_section_id: "ps_conveyor", tag_code: "EQ-TAG-SMC-0207", equipment_name: "Discharge Conveyor Idler Bank", criticality: "medium", status: "active" },
    { id: "eq_smelt_0041", plant_section_id: "ps_furnace", tag_code: "EQ-TAG-SMELT-0041", equipment_name: "Furnace Lining Zone", criticality: "critical", status: "active" }
  ];

  const catalog_items = [
    { id: "cat_ceramic", item_code: "ALU-CER-TILE", item_name: "Alumina Ceramic Tiles", category: "Wear Protection", unit_of_measure: "m2", unit_price: 95, material_grade: "92% alumina", dimensions: "custom" },
    { id: "cat_rubber", item_code: "RUB-LINING", item_name: "Heavy Duty Rubber Lining", category: "Lining", unit_of_measure: "m2", unit_price: 70, material_grade: "industrial rubber", dimensions: "10-25mm" },
    { id: "cat_idler", item_code: "IDLER-ROLLER", item_name: "Idler Roller", category: "Conveyor Components", unit_of_measure: "each", unit_price: 120, material_grade: "steel/rubber", dimensions: "site specific" },
    { id: "cat_labor", item_code: "LAB-FIELD-HR", item_name: "Field Service Labour", category: "Labour", unit_of_measure: "hour", unit_price: 45, material_grade: "", dimensions: "" }
  ];

  return {
    users,
    clients,
    mine_sites,
    plants,
    plant_sections,
    equipment_tags,
    catalog_items,
    company_profile: {
      company_name: "Orac Systems",
      legal_name: "Handon Enterprises (Pvt) Ltd",
      address: "Harare, Zimbabwe",
      phone: "",
      email: "info@orac.co.zw",
      brand_primary: "#6EC1E4",
      brand_slate: "#54595F",
      // V5 remains inert until ORAC_V5_COMMERCIAL_WORKFLOW is enabled. A
      // signature method is never selected implicitly from a deployment.
      v5_commercial_policy: {
        invoice_self_approval: "allowed_if_clean",
        client_signature_methods: [],
        unbilled_age_days: 30,
        variance_warning_percent: 80,
        currency: "USD",
        tax_rate: null
      }
    },
    leads: [],
    quotes: [],
    quote_lines: [],
    purchase_orders: [],
    po_amendments: [],
    dispatch_cards: [],
    field_worksheets: [],
    timesheets: [],
    // Daily Time Sheet / Contractors Log Sheet (paper-form digitisation).
    // New, dedicated collections rather than reusing field_worksheets or
    // timesheets — neither existing shape preserves a per-day NORMAL/1.5/2.0
    // breakdown (confirmed by reading kioskController.js and schemas.js;
    // see the feature README). normalizeDb() below backfills these onto any
    // pre-existing local db.json automatically; no migration script needed.
    daily_timesheets: [],
    contractor_log_sheets: [],
    // Worksheet: register consolidated from approved daily_timesheets rows.
    // Auto-backfilled onto an existing data file by normalizeDb() below.
    worksheet_registers: [],
    // Timesheet workflow packet (dark): authoriser/delegate records, paper custody log, variance overrides.
    timesheet_authorities: [],
    timesheet_paper_custody: [],
    timesheet_variance_overrides: [],
    // V5 paper-signature evidence (dark, append-only). Auto-backfilled onto an existing data file by normalizeDb().
    v5_client_supervisor_contacts: [],
    v5_paper_signatures: [],
    v5_supervisor_confirmations: [],
    material_usage: [],
    invoices: [],
    invoice_lines: [],
    pastel_export_batches: [],
    pastel_export_lines: [],
    suppliers: [
      { id: "sup_ceramics", name: "African Ceramics Supply Co.", contact_person: "Tendai Moyo", email: "tendai@africanceram.example", phone: "+263 77 111 0001", lead_time_days: 14 },
      { id: "sup_rubber", name: "Zimrubber Industrial", contact_person: "Farai Ndlovu", email: "farai@zimrubber.example", phone: "+263 77 222 0002", lead_time_days: 7 },
      { id: "sup_conveyor", name: "ConveyorTech Africa", contact_person: "Blessing Chikwanda", email: "blessing@conveyortech.example", phone: "+263 77 333 0003", lead_time_days: 21 }
    ],
    stock_items: [
      { id: "si_ceramic_tile", catalog_item_id: "cat_ceramic", item_code: "ALU-CER-TILE", item_name: "Alumina Ceramic Tiles", unit_of_measure: "m2", quantity_on_hand: 48, reorder_level: 20, unit_cost: 85, supplier_id: "sup_ceramics", location: "Store A - Shelf 1" },
      { id: "si_rubber_lining", catalog_item_id: "cat_rubber", item_code: "RUB-LINING", item_name: "Heavy Duty Rubber Lining", unit_of_measure: "m2", quantity_on_hand: 30, reorder_level: 15, unit_cost: 60, supplier_id: "sup_rubber", location: "Store A - Shelf 2" },
      { id: "si_idler_roller", catalog_item_id: "cat_idler", item_code: "IDLER-ROLLER", item_name: "Idler Roller", unit_of_measure: "each", quantity_on_hand: 12, reorder_level: 8, unit_cost: 100, supplier_id: "sup_conveyor", location: "Store B - Rack 3" },
      { id: "si_fasteners", catalog_item_id: null, item_code: "FAST-M16-SS", item_name: "M16 Stainless Fastener Kit", unit_of_measure: "set", quantity_on_hand: 60, reorder_level: 25, unit_cost: 12, supplier_id: "sup_ceramics", location: "Store A - Shelf 4" }
    ],
    stock_movements: [],
    contracts: [],
    maintenance_schedules: [],
    audit_logs: [
      { id: "audit_seed", actor_id: "u_admin", entity_type: "system", entity_id: "seed", action: "SYSTEM_SEEDED", old_values: null, new_values: null, created_at: now() }
    ],
    notifications: [],
    // NEW — Phase 6: "Request Access" queue (see accessRequestsController.js).
    access_requests: [],
    // Client Service Requests: Client Viewer -> Sales/Operations triage -> lead.
    service_requests: [],
    // Internal Work Requests: controlled staff-to-staff requests (never client-facing).
    internal_work_requests: []
  };
}

export function normalizeDb(db) {
  const seeded = seedData();
  for (const [key, value] of Object.entries(seeded)) {
    if (!Array.isArray(value)) continue;
    if (!Array.isArray(db[key])) db[key] = [];
  }

  const existingUserIds = new Set(db.users.map((user) => user.id));
  for (const user of seeded.users) {
    if (!existingUserIds.has(user.id)) db.users.push(user);
  }

  if (db.suppliers.length === 0 && seeded.suppliers) {
    db.suppliers = [...seeded.suppliers];
  }
  if (db.stock_items.length === 0 && seeded.stock_items) {
    db.stock_items = [...seeded.stock_items];
  }
  if (!db.notifications) {
    db.notifications = [];
  }

  // Backfill client_id onto pre-existing seeded users where missing
  // (covers a local db.json created before Phase 06 introduced this field).
  for (const seededUser of seeded.users) {
    if (seededUser.client_id) {
      const existing = db.users.find((u) => u.id === seededUser.id);
      if (existing && !existing.client_id) existing.client_id = seededUser.client_id;
    }
  }

  if (!db.company_profile || typeof db.company_profile !== "object") {
    db.company_profile = seeded.company_profile;
  }
  if (!db.company_profile.v5_commercial_policy || typeof db.company_profile.v5_commercial_policy !== "object") {
    db.company_profile.v5_commercial_policy = seeded.company_profile.v5_commercial_policy;
  }

  // Backfill is_active on master-data records seeded before this field
  // existed (plain store.js seedData() never set it, unlike
  // curatedDemoData.js). Without this, AdminEntitiesTab.jsx's
  // `row.is_active ? "Active" : "Inactive"` badge renders every one of
  // these perfectly-active records as "Inactive". Missing is_active has
  // always meant "active" everywhere else in the app (see isRecordActive()
  // in services/entityHierarchy.js); this just makes that explicit on disk
  // too, and only ever changes `undefined` — an explicit `false` is a real
  // archived record and is left alone.
  for (const collectionName of ["clients", "mine_sites", "plants", "plant_sections", "equipment_tags"]) {
    for (const record of db[collectionName] || []) {
      if (record.is_active === undefined) record.is_active = true;
    }
  }

  return db;
}

// Writes to a temporary file and renames it over the target so a crash or power
// loss mid-write cannot leave a truncated data file.
function writeJsonAtomically(filePath, text) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, text);
  try {
    renameSync(tempPath, filePath);
  } catch {
    // Some Windows setups refuse to replace a file another process has open.
    try { unlinkSync(tempPath); } catch { /* best effort */ }
    writeFileSync(filePath, text);
  }
}

export function createStore(filePath) {
  const mutex = new Mutex();
  const inMemory = filePath === ":memory:";

  if (!inMemory) {
    // Ensure data directory exists on startup
    mkdirSync(dirname(filePath), { recursive: true });

    // Seed if file doesn't exist
    if (!existsSync(filePath)) {
      writeFileSync(filePath, JSON.stringify(seedData(), null, 2));
    }
  }

  return {
    id(prefix) {
      return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    },

    /* Acquire the mutex, then read the file synchronously (no race window). */
    async read() {
      const release = await mutex.acquire();
      if (inMemory) {
        return { db: seedData(), release };
      }
      try {
        const raw = readFileSync(filePath, "utf8");
        const db = normalizeDb(JSON.parse(raw));
        return { db, release };
      } catch (err) {
        if (err?.code === "ENOENT") {
          // The file was removed: there is nothing to lose, start from seed data.
          const db = seedData();
          writeFileSync(filePath, JSON.stringify(db, null, 2));
          return { db, release };
        }
        // Unreadable or corrupt data must NEVER be replaced by seed data: that
        // silently destroys the only copy. Free the mutex and fail loudly.
        release();
        throw Object.assign(
          new Error("The local JSON data file could not be read or parsed. It has not been modified."),
          { status: 503 }
        );
      }
    },

    /* Write synchronously, then release the mutex. */
    write(db, release) {
      try {
        if (!inMemory) {
          writeJsonAtomically(filePath, JSON.stringify(db, null, 2));
        }
      } finally {
        if (release) release();
      }
    },

    /* Release the mutex without writing (for read-only requests). */
    release(releaseFn) {
      if (releaseFn) releaseFn();
    },

    audit(db, actor, entityType, entityId, action, oldValues, newValues) {
      const entry = {
        id: this.id("audit"),
        actor_id: actor?.id || "system",
        entity_type: entityType,
        entity_id: entityId,
        action,
        old_values: oldValues,
        new_values: newValues,
        created_at: now()
      };
      db.audit_logs.push(entry);
      // Notifications are a side effect of a committed domain event. A failure
      // while generating one must never fail or corrupt the business change that
      // is being audited, so it is contained here. Only the error class is
      // logged: messages can echo record content, and nothing here needs it.
      try {
        handleAuditForNotifications(db, entry);
      } catch (error) {
        console.error(`Notification generation skipped for ${entry.action}: ${error?.name || "Error"}`);
      }
    },

    recalculateVariance(db, purchaseOrderId) {
      if (!purchaseOrderId) return;
      const po = db.purchase_orders.find((item) => item.id === purchaseOrderId);
      if (!po) return;

      const jobs = db.dispatch_cards.filter((job) => job.purchase_order_id === po.id);
      const jobIds = new Set(jobs.map((job) => job.id));
      const labor = approvedLabourValue(db, jobIds);
      const materials = db.material_usage
        .filter((item) => jobIds.has(item.dispatch_card_id))
        .reduce((sum, item) => sum + Number(item.total_cost || 0), 0);

      po.logged_value = labor + materials;
      const previouslyRequired = po.requires_amendment;
      po.requires_amendment = po.logged_value > po.po_amount;
      
      if (!previouslyRequired && po.requires_amendment) {
        this.audit(db, null, "purchase_order", po.id, "PO_AMENDMENT_REQUIRED", { requires_amendment: false }, po);
      }
    }
  };
}
