import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { approvedLabourValue } from "./timesheetReview.js";
import { dirname } from "node:path";
import { handleAuditForNotifications } from "./notifications.js";
import bcrypt from "bcrypt";

const now = () => new Date().toISOString();

// The PO ceiling is based only on recorded dispatch evidence. Keeping this
// calculation reusable lets the amendment controller validate the evidence
// before it changes an authorization amount.
export function calculatePurchaseOrderEvidenceValue(db, purchaseOrderId) {
  const po = db.purchase_orders.find((item) => item.id === purchaseOrderId);
  if (!po) return 0;

  const jobs = db.dispatch_cards.filter((job) => job.purchase_order_id === po.id);
  const jobIds = new Set(jobs.map((job) => job.id));
  const labor = approvedLabourValue(db, jobIds);
  const materials = db.material_usage
    .filter((item) => jobIds.has(item.dispatch_card_id))
    .reduce((sum, item) => sum + Number(item.total_cost || 0), 0);

  return labor + materials;
}
// Local JSON demo seed only; PostgreSQL normalization does not add demo records.
const DEFAULT_DEMO_PASSWORD_HASH = bcrypt.hashSync("password123", 10);

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
  if (process.env.NODE_ENV === "production") {
    throw new Error("seedData() must never run in production. Demo accounts and default passwords cannot be seeded.");
  }
  const users = [
    { id: "u_admin", name: "Admin User", email: "admin@orac.co.zw", role: "Admin", is_active: true, password_hash: DEFAULT_DEMO_PASSWORD_HASH },
    { id: "u_management", name: "Management User", email: "management@orac.co.zw", role: "Management", is_active: true, password_hash: DEFAULT_DEMO_PASSWORD_HASH },
    { id: "u_sales", name: "Sales User", email: "sales@orac.co.zw", role: "Sales", is_active: true, password_hash: DEFAULT_DEMO_PASSWORD_HASH },
    { id: "u_finance", name: "Finance User", email: "finance@orac.co.zw", role: "Finance", is_active: true, password_hash: DEFAULT_DEMO_PASSWORD_HASH },
    { id: "u_ops", name: "Operations User", email: "ops@orac.co.zw", role: "Operations", is_active: true, password_hash: DEFAULT_DEMO_PASSWORD_HASH },
    { id: "u_tech", name: "Technician User", email: "tech@orac.co.zw", role: "Technician", trade: "Fitter", is_active: true, password_hash: DEFAULT_DEMO_PASSWORD_HASH },
    { id: "u_supervisor", name: "Supervisor User", email: "supervisor@orac.co.zw", role: "Supervisor", is_active: true, password_hash: DEFAULT_DEMO_PASSWORD_HASH },
    { id: "u_client", name: "Client Viewer", email: "client@orac.co.zw", role: "Client Viewer", is_active: true, client_id: "c_example_north", password_hash: DEFAULT_DEMO_PASSWORD_HASH }
  ];

  const clients = [
    { id: "c_example_north", name: "Example North Mining", client_type: "permanent", contact_person: "Procurement Office", email: "procurement@example-north.invalid" },
    { id: "c_example_south", name: "Example South Minerals", client_type: "permanent", contact_person: "Maintenance Office", email: "maintenance@example-south.invalid" },
    { id: "c_walkin", name: "Walk-in Client", client_type: "walk_in", contact_person: "Front Desk", email: "" }
  ];

  const mine_sites = [
    { id: "ms_north_site", client_id: "c_example_north", name: "North Site", location: "Zimbabwe" },
    { id: "ms_west_site", client_id: "c_example_north", name: "West Site", location: "Zimbabwe" },
    { id: "ms_zvishavane", client_id: "c_example_south", name: "Zvishavane", location: "Zimbabwe" }
  ];

  const plants = [
    { id: "pl_smc", mine_site_id: "ms_north_site", name: "SMC Concentrator", plant_code: "SMC-CON" },
    { id: "pl_smelter", mine_site_id: "ms_west_site", name: "Smelter", plant_code: "SMELTER" },
    { id: "pl_example_south_conc", mine_site_id: "ms_zvishavane", name: "Concentrator", plant_code: "EXS-CON" }
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
        tax_rate: null,
        tax_status: "unconfigured"
      }
    },
    leads: [],
    // Persistent Idempotency-Key records (see src/idempotency.js). Internal:
    // never exposed through the generic collection routes.
    idempotency_keys: [],
    // Bulk-import job records (see src/importers/masterDataImport.js): ids and counts only.
    import_jobs: [],
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
    // Phase 3: Sales-attached amendment notes / revised PO references that clear a quoted-scope overrun.
    po_scope_evidence: [],
    // V5 paper-signature evidence (dark, append-only). Auto-backfilled onto an existing data file by normalizeDb().
    v5_client_supervisor_contacts: [],
    v5_paper_signatures: [],
    v5_supervisor_confirmations: [],
    // Controlled commercial links for material evidence. This is separate
    // from operational material_usage: field staff record what was consumed;
    // Sales/Admin allocates it to an accepted V5 quote line later.
    v5_material_allocations: [],
    // Approved V5 amendment revisions are linked to their exact dispatch
    // append-only. This is not invoice coverage by itself.
    v5_amendment_dispatch_links: [],
    v5_amendment_evidence_allocations: [],
    // V5 invoice writer records are append-only and deliberately separate
    // from legacy invoices. The writer remains disabled until both V5 flags
    // are enabled, so merely normalizing these collections changes nothing.
    v5_invoice_drafts: [],
    v5_invoices: [],
    v5_invoice_lines: [],
    v5_invoice_source_consumption: [],
    v5_invoice_events: [],
    v5_invoice_number_ledger: [],
    v5_line_completions: [],
    v5_amendment_supersessions: [],
    v5_allocation_remaps: [],
    v5_invoice_idempotency: [],
    material_usage: [],
    invoices: [],
    legacy_invoice_drafts: [],
    legacy_invoice_idempotency: [],
    invoice_lines: [],
    invoice_payments: [],
    // Legacy credit notes are controlled correction records. They remain
    // separate from V5 invoices and are never accounting-posting records.
    invoice_credit_notes: [],
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

export const DEFAULT_COMPANY_PROFILE = Object.freeze({
  company_name: "Orac Systems",
  legal_name: "Handon Enterprises (Pvt) Ltd",
  address: "Harare, Zimbabwe",
  phone: "",
  email: "info@orac.co.zw",
  brand_primary: "#6EC1E4",
  brand_slate: "#54595F",
  v5_commercial_policy: Object.freeze({
    invoice_self_approval: "allowed_if_clean",
    client_signature_methods: [],
    unbilled_age_days: 30,
    variance_warning_percent: 80,
    currency: "USD",
    tax_rate: null,
    tax_status: "unconfigured"
  })
});

export const SCHEMA_COLLECTIONS = [
  "users", "clients", "mine_sites", "plants", "plant_sections", "equipment_tags",
  "catalog_items", "leads", "idempotency_keys", "import_jobs", "quotes", "quote_lines",
  "purchase_orders", "po_amendments", "dispatch_cards", "field_worksheets",
  "timesheets", "daily_timesheets", "contractor_log_sheets", "worksheet_registers",
  "timesheet_authorities", "timesheet_paper_custody", "timesheet_variance_overrides",
  "po_scope_evidence", "v5_client_supervisor_contacts", "v5_paper_signatures",
  "v5_supervisor_confirmations", "v5_material_allocations", "v5_amendment_dispatch_links",
  "v5_amendment_evidence_allocations", "v5_invoice_drafts", "v5_invoices",
  "v5_invoice_lines", "v5_invoice_source_consumption", "v5_invoice_events",
  "v5_invoice_number_ledger", "v5_line_completions", "v5_amendment_supersessions",
  "v5_allocation_remaps", "v5_invoice_idempotency", "material_usage", "invoices",
  "legacy_invoice_drafts", "legacy_invoice_idempotency", "invoice_lines",
  "invoice_payments", "invoice_credit_notes", "pastel_export_batches",
  "pastel_export_lines", "suppliers", "stock_items", "stock_movements",
  "contracts", "maintenance_schedules", "audit_logs", "notifications",
  "access_requests", "service_requests", "internal_work_requests"
];

export function normalizeDb(db, { seedDemoRecords = process.env.NODE_ENV !== "production" } = {}) {
  if (process.env.NODE_ENV === "production" && seedDemoRecords) {
    throw new Error("Demo records cannot be seeded in production environments.");
  }
  for (const key of SCHEMA_COLLECTIONS) {
    if (!Array.isArray(db[key])) db[key] = [];
  }

  if (seedDemoRecords) {
    const seeded = seedData();
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
    for (const seededUser of seeded.users) {
      if (seededUser.client_id) {
        const existing = db.users.find((u) => u.id === seededUser.id);
        if (existing && !existing.client_id) existing.client_id = seededUser.client_id;
      }
    }
  }

  if (!db.notifications) {
    db.notifications = [];
  }

  if (!db.company_profile || typeof db.company_profile !== "object") {
    db.company_profile = {
      ...DEFAULT_COMPANY_PROFILE,
      v5_commercial_policy: {
        ...DEFAULT_COMPANY_PROFILE.v5_commercial_policy,
        client_signature_methods: [...(DEFAULT_COMPANY_PROFILE.v5_commercial_policy.client_signature_methods || [])]
      }
    };
  }
  if (!db.company_profile.v5_commercial_policy || typeof db.company_profile.v5_commercial_policy !== "object") {
    db.company_profile.v5_commercial_policy = {
      ...DEFAULT_COMPANY_PROFILE.v5_commercial_policy,
      client_signature_methods: [...(DEFAULT_COMPANY_PROFILE.v5_commercial_policy.client_signature_methods || [])]
    };
  } else if (!Array.isArray(db.company_profile.v5_commercial_policy.client_signature_methods)) {
    db.company_profile.v5_commercial_policy.client_signature_methods = [];
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

  // Controlled Quotations (Phase 2): Backfill legacy quotes and quote lines
  // without altering historical issued totals or assigning unapproved VAT.
  for (const quote of db.quotes || []) {
    if (!quote.currency) quote.currency = "USD";
    if (quote.grand_total_cents === undefined) {
      quote.grand_total_cents = Math.round(Number(quote.total_amount || 0) * 100);
    }
    if (quote.pre_tax_total_cents === undefined) {
      quote.pre_tax_total_cents = quote.grand_total_cents;
    }
    if (quote.tax_total_cents === undefined) {
      quote.tax_total_cents = 0;
    }
    if (quote.tax_status === undefined) {
      quote.tax_status = "unconfigured";
    }
    if (quote.applied_tax_rate === undefined) {
      quote.applied_tax_rate = null;
    }
    if (quote.discount_percent === undefined) {
      quote.discount_percent = 0;
    }
    if (quote.validity_days === undefined) {
      quote.validity_days = 30;
    }
  }

  for (const line of db.quote_lines || []) {
    if (!line.unit_of_measure) line.unit_of_measure = "each";
    if (!line.cost_type) line.cost_type = "material";
    if (!line.work_package_id) line.work_package_id = "wp_01";
    if (!line.item_type) line.item_type = "standard";
    if (line.unit_price_cents === undefined) {
      line.unit_price_cents = Math.round(Number(line.unit_price || 0) * 100);
    }
    if (line.line_total_cents === undefined) {
      const calcTotal = line.line_total != null ? line.line_total : (line.quantity * line.unit_price);
      line.line_total_cents = Math.round(Number(calcTotal || 0) * 100);
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
      if (process.env.NODE_ENV === "production") {
        throw new Error("Production file store cannot be auto-seeded with demo records.");
      }
      writeFileSync(filePath, JSON.stringify(seedData(), null, 2));
    }
  }

  return {
    driver: "json",
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
          if (process.env.NODE_ENV === "production") {
            release();
            throw new Error("Production file store missing; auto-seeding with demo records is forbidden.");
          }
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

      po.logged_value = calculatePurchaseOrderEvidenceValue(db, po.id);
      const previouslyRequired = po.requires_amendment;
      po.requires_amendment = po.logged_value > po.po_amount;
      
      if (!previouslyRequired && po.requires_amendment) {
        this.audit(db, null, "purchase_order", po.id, "PO_AMENDMENT_REQUIRED", { requires_amendment: false }, po);
      }
    }
  };
}
