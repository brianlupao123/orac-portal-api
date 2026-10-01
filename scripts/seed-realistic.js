// scripts/seed-realistic.js
// Seeds the Neon store with sensible, realistic data across every collection.
// Requires: DATABASE_URL in .env, bcrypt already installed.
// Run: node scripts/seed-realistic.js
import bcrypt from "bcrypt";
import { pool, ensureTableExists } from "../src/pool.js";
import { requireDestructiveApply, snapshotStore } from "./lib/destructiveGuard.js";

const now = () => new Date().toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

// ──────────────────────────────────────────────────────────────
// 1. USERS  (8 core roles, password: Test@123)
// ──────────────────────────────────────────────────────────────
import crypto from "crypto";

const generatePassword = () => crypto.randomBytes(6).toString("hex") + "!";
const adminPassword = generatePassword();
const clientPassword = generatePassword();

const hash = await bcrypt.hash("Test@123", 10);
const adminHash = await bcrypt.hash(adminPassword, 10);
const clientHash = await bcrypt.hash(clientPassword, 10);

const users = [
  { id: "u_admin",      name: "Admin User",       email: "admin@orac.co.zw",      role: "Admin",         is_active: true, password_hash: adminHash },
  { id: "u_management", name: "Management User",  email: "management@orac.co.zw", role: "Management",    is_active: true, password_hash: hash },
  { id: "u_sales",      name: "Sales User",       email: "sales@orac.co.zw",      role: "Sales",         is_active: true, password_hash: hash },
  { id: "u_finance",    name: "Finance User",     email: "finance@orac.co.zw",     role: "Finance",       is_active: true, password_hash: hash },
  { id: "u_ops",        name: "Operations User",  email: "ops@orac.co.zw",         role: "Operations",    is_active: true, password_hash: hash },
  { id: "u_tech",       name: "Technician User",  email: "tech@orac.co.zw",        role: "Technician",    is_active: true, password_hash: hash },
  { id: "u_supervisor", name: "Supervisor User",  email: "supervisor@orac.co.zw",  role: "Supervisor",    is_active: true, password_hash: hash },
  { id: "u_client",     name: "Client Viewer",    email: "client@orac.co.zw",      role: "Client Viewer", is_active: true, password_hash: clientHash, client_id: "c_zimplats" },
];

export const generatedPasswords = { admin: adminPassword, client: clientPassword };

// ──────────────────────────────────────────────────────────────
// 2. CLIENTS
// ──────────────────────────────────────────────────────────────
const clients = [
  { id: "c_zimplats", name: "Zimplats",               client_type: "permanent", contact_person: "Procurement Office",  email: "procurement@zimplats.example" },
  { id: "c_mimosa",   name: "Mimosa Mining Company",  client_type: "permanent", contact_person: "Maintenance Office",  email: "maintenance@mimosa.example" },
  { id: "c_walkin",   name: "Walk-in Client",         client_type: "walk_in",   contact_person: "Front Desk",          email: "" },
  { id: "c_unki",     name: "Unki Platinum Mine",     client_type: "permanent", contact_person: "Plant Manager",       email: "plant@unki.example" },
  { id: "c_trojan",   name: "Trojan Nickel Mine",     client_type: "permanent", contact_person: "Procurement Dept",    email: "procurement@trojan.example" },
];

// ──────────────────────────────────────────────────────────────
// 3. MINE SITES / PLANTS / SECTIONS / EQUIPMENT
// ──────────────────────────────────────────────────────────────
const mine_sites = [
  { id: "ms_ngezi",      client_id: "c_zimplats", name: "Ngezi",       location: "Zimbabwe" },
  { id: "ms_selous",     client_id: "c_zimplats", name: "Selous",      location: "Zimbabwe" },
  { id: "ms_zvishavane", client_id: "c_mimosa",   name: "Zvishavane",  location: "Zimbabwe" },
  { id: "ms_unki",       client_id: "c_unki",     name: "Unki Mine",   location: "Shurugwi" },
  { id: "ms_trojan",     client_id: "c_trojan",   name: "Trojan Mine", location: "Bindura" },
];

const plants = [
  { id: "pl_smc",         mine_site_id: "ms_ngezi",      name: "SMC Concentrator",     plant_code: "SMC-CON" },
  { id: "pl_smelter",     mine_site_id: "ms_selous",     name: "Smelter",              plant_code: "SMELTER" },
  { id: "pl_mimosa_conc", mine_site_id: "ms_zvishavane", name: "Concentrator",         plant_code: "MIM-CON" },
  { id: "pl_unki_conc",   mine_site_id: "ms_unki",       name: "Unki Concentrator",    plant_code: "UNKI-CON" },
  { id: "pl_trojan_mill", mine_site_id: "ms_trojan",     name: "Trojan Milling Plant", plant_code: "TRJ-MILL" },
];

const plant_sections = [
  { id: "ps_cyclone",    plant_id: "pl_smc",         name: "Cyclone Cluster",             section_code: "CYCLONE" },
  { id: "ps_conveyor",   plant_id: "pl_smc",         name: "Discharge Conveyor Line",     section_code: "CONV-DIS" },
  { id: "ps_furnace",    plant_id: "pl_smelter",     name: "Furnace Refractory Section",  section_code: "FURN-REF" },
  { id: "ps_ball_mill",  plant_id: "pl_unki_conc",   name: "Ball Mill Section",           section_code: "BALL-ML" },
  { id: "ps_flotation",  plant_id: "pl_trojan_mill", name: "Flotation Circuit",           section_code: "FLOT" },
];

const equipment_tags = [
  { id: "eq_smc_0102",   plant_section_id: "ps_cyclone",   tag_code: "EQ-TAG-SMC-0102",   equipment_name: "Cyclone Wear Liner Assembly",      criticality: "high",     status: "active" },
  { id: "eq_smc_0207",   plant_section_id: "ps_conveyor",  tag_code: "EQ-TAG-SMC-0207",   equipment_name: "Discharge Conveyor Idler Bank",    criticality: "medium",   status: "active" },
  { id: "eq_smelt_0041", plant_section_id: "ps_furnace",   tag_code: "EQ-TAG-SMELT-0041", equipment_name: "Furnace Lining Zone",              criticality: "critical", status: "active" },
  { id: "eq_unki_0301",  plant_section_id: "ps_ball_mill", tag_code: "EQ-TAG-UNKI-0301",  equipment_name: "Ball Mill Liner Set",              criticality: "high",     status: "active" },
  { id: "eq_trj_0401",   plant_section_id: "ps_flotation", tag_code: "EQ-TAG-TRJ-0401",   equipment_name: "Flotation Cell Impeller Assembly", criticality: "medium",   status: "active" },
];

// ──────────────────────────────────────────────────────────────
// 4. CATALOG ITEMS
// ──────────────────────────────────────────────────────────────
const catalog_items = [
  { id: "cat_ceramic", item_code: "ALU-CER-TILE", item_name: "Alumina Ceramic Tiles",    category: "Wear Protection",     unit_of_measure: "m2",   unit_price: 95,  material_grade: "92% alumina",      dimensions: "custom" },
  { id: "cat_rubber",  item_code: "RUB-LINING",   item_name: "Heavy Duty Rubber Lining", category: "Lining",              unit_of_measure: "m2",   unit_price: 70,  material_grade: "industrial rubber", dimensions: "10-25mm" },
  { id: "cat_idler",   item_code: "IDLER-ROLLER",  item_name: "Idler Roller",             category: "Conveyor Components", unit_of_measure: "each", unit_price: 120, material_grade: "steel/rubber",      dimensions: "site specific" },
  { id: "cat_labor",   item_code: "LAB-FIELD-HR",  item_name: "Field Service Labour",     category: "Labour",              unit_of_measure: "hour", unit_price: 45,  material_grade: "",                 dimensions: "" },
  { id: "cat_bolt",    item_code: "BOLT-M16-SS",   item_name: "M16 Stainless Bolt Kit",   category: "Fasteners",           unit_of_measure: "set",  unit_price: 12,  material_grade: "316 SS",           dimensions: "M16x50" },
];

// ──────────────────────────────────────────────────────────────
// 5. QUOTES  (covering the full pipeline)
// ──────────────────────────────────────────────────────────────
const quotes = [
  { id: "q_001", quote_number: "Q-2025-001", client_id: "c_zimplats", status: "Draft",               total_amount: 12500, created_at: daysAgo(30), updated_at: daysAgo(28), created_by: "u_sales" },
  { id: "q_002", quote_number: "Q-2025-002", client_id: "c_trojan",   status: "Draft",               total_amount: 8700,  created_at: daysAgo(25), updated_at: daysAgo(25), created_by: "u_sales" },
  { id: "q_003", quote_number: "Q-2025-003", client_id: "c_mimosa",   status: "Submitted",           total_amount: 34200, created_at: daysAgo(22), updated_at: daysAgo(20), created_by: "u_sales" },
  { id: "q_004", quote_number: "Q-2025-004", client_id: "c_unki",     status: "Submitted",           total_amount: 18500, created_at: daysAgo(18), updated_at: daysAgo(17), created_by: "u_sales" },
  { id: "q_005", quote_number: "Q-2025-005", client_id: "c_zimplats", status: "Approved_Pending_PO", total_amount: 45000, created_at: daysAgo(40), updated_at: daysAgo(15), created_by: "u_sales" },
  { id: "q_006", quote_number: "Q-2025-006", client_id: "c_mimosa",   status: "Approved_Pending_PO", total_amount: 22000, created_at: daysAgo(35), updated_at: daysAgo(12), created_by: "u_sales" },
  { id: "q_007", quote_number: "Q-2025-007", client_id: "c_zimplats", status: "Issued",              total_amount: 67500, created_at: daysAgo(60), updated_at: daysAgo(10), created_by: "u_sales" },
  { id: "q_008", quote_number: "Q-2025-008", client_id: "c_unki",     status: "Issued",              total_amount: 29800, created_at: daysAgo(50), updated_at: daysAgo(8),  created_by: "u_sales" },
  { id: "q_009", quote_number: "Q-2025-009", client_id: "c_trojan",   status: "Issued",              total_amount: 15400, created_at: daysAgo(45), updated_at: daysAgo(5),  created_by: "u_sales" },
  { id: "q_010", quote_number: "Q-2025-010", client_id: "c_zimplats", status: "Accepted",            total_amount: 52000, created_at: daysAgo(90), updated_at: daysAgo(3),  created_by: "u_sales" },
  { id: "q_011", quote_number: "Q-2025-011", client_id: "c_mimosa",   status: "Closed",              total_amount: 38000, created_at: daysAgo(120), updated_at: daysAgo(1), created_by: "u_sales" },
  { id: "q_012", quote_number: "Q-2025-012", client_id: "c_unki",     status: "Closed",              total_amount: 19500, created_at: daysAgo(100), updated_at: daysAgo(2), created_by: "u_sales" },
];

const quote_lines = [
  { id: "ql_001", quotation_id: "q_007", catalog_item_id: "cat_ceramic", description: "Cyclone ceramic lining - 48m2", quantity: 48,  unit_price: 95,  line_total: 4560 },
  { id: "ql_002", quotation_id: "q_007", catalog_item_id: "cat_rubber",  description: "Conveyor rubber lining - 120m2", quantity: 120, unit_price: 70, line_total: 8400 },
  { id: "ql_003", quotation_id: "q_007", catalog_item_id: "cat_labor",   description: "Field service labour - 200hrs", quantity: 200, unit_price: 45,  line_total: 9000 },
  { id: "ql_004", quotation_id: "q_008", catalog_item_id: "cat_idler",   description: "Replacement idler rollers x24", quantity: 24,  unit_price: 120, line_total: 2880 },
  { id: "ql_005", quotation_id: "q_009", catalog_item_id: "cat_ceramic", description: "Flotation cell ceramic tiles - 30m2", quantity: 30, unit_price: 95, line_total: 2850 },
  { id: "ql_006", quotation_id: "q_010", catalog_item_id: "cat_rubber",  description: "Ball mill rubber lining - 200m2", quantity: 200, unit_price: 70, line_total: 14000 },
  { id: "ql_007", quotation_id: "q_011", catalog_item_id: "cat_ceramic", description: "Furnace refractory tiles - 85m2", quantity: 85, unit_price: 95,  line_total: 8075 },
];

// ──────────────────────────────────────────────────────────────
// 6. PURCHASE ORDERS
// ──────────────────────────────────────────────────────────────
const purchase_orders = [
  { id: "po_001", quotation_id: "q_007", po_reference: "ZIM-PO-2025-4401", po_amount: 67500, status: "verified",  logged_value: 61200, requires_amendment: false, started_before_po: false, created_at: daysAgo(55) },
  { id: "po_002", quotation_id: "q_008", po_reference: "UNK-PO-2025-0088", po_amount: 29800, status: "verified",  logged_value: 32500, requires_amendment: true,  started_before_po: false, created_at: daysAgo(45) },
  { id: "po_003", quotation_id: "q_009", po_reference: "TRJ-PO-2025-0199", po_amount: 15400, status: "pending",   logged_value: 0,     requires_amendment: false, started_before_po: true,  created_at: daysAgo(40) },
  { id: "po_004", quotation_id: "q_010", po_reference: "ZIM-PO-2025-4502", po_amount: 52000, status: "verified",  logged_value: 49800, requires_amendment: false, started_before_po: false, created_at: daysAgo(85) },
  { id: "po_005", quotation_id: "q_011", po_reference: "MIM-PO-2025-0312", po_amount: 38000, status: "verified",  logged_value: 37200, requires_amendment: false, started_before_po: false, created_at: daysAgo(110) },
];

// ──────────────────────────────────────────────────────────────
// 7. DISPATCH CARDS
// ──────────────────────────────────────────────────────────────
const dispatch_cards = [
  { id: "dc_001", dispatch_number: "DC-2025-001", quotation_id: "q_007", purchase_order_id: "po_001", status: "In_Progress", scheduled_start: daysAgo(50), started_before_po: false, assigned_technician_id: "u_tech" },
  { id: "dc_002", dispatch_number: "DC-2025-002", quotation_id: "q_008", purchase_order_id: "po_002", status: "In_Progress", scheduled_start: daysAgo(40), started_before_po: false, assigned_technician_id: "u_tech" },
  { id: "dc_003", dispatch_number: "DC-2025-003", quotation_id: "q_009", purchase_order_id: "po_003", status: "Dispatched",  scheduled_start: daysAgo(35), started_before_po: true,  assigned_technician_id: "u_tech" },
  { id: "dc_004", dispatch_number: "DC-2025-004", quotation_id: "q_010", purchase_order_id: "po_004", status: "Completed",   scheduled_start: daysAgo(80), started_before_po: false, assigned_technician_id: "u_tech" },
  { id: "dc_005", dispatch_number: "DC-2025-005", quotation_id: "q_011", purchase_order_id: "po_005", status: "Completed",   scheduled_start: daysAgo(105), started_before_po: false, assigned_technician_id: "u_tech" },
];

// ──────────────────────────────────────────────────────────────
// 8. FIELD WORKSHEETS
// ──────────────────────────────────────────────────────────────
const field_worksheets = [
  { id: "fw_001", dispatch_card_id: "dc_001", work_date: daysAgo(10), hours: 8,  activity: "Removed old cyclone liners, prepared surfaces",       outcomes: "Surface prep complete",    status: "Supervisor_Approved", supervisor_comment: "Good work" },
  { id: "fw_002", dispatch_card_id: "dc_001", work_date: daysAgo(9),  hours: 10, activity: "Installed ceramic tiles on cyclone sections 1-3",     outcomes: "3 of 6 sections complete", status: "Supervisor_Approved", supervisor_comment: "" },
  { id: "fw_003", dispatch_card_id: "dc_001", work_date: daysAgo(8),  hours: 9,  activity: "Installed ceramic tiles on cyclone sections 4-6",     outcomes: "All sections lined",       status: "Submitted",           supervisor_comment: "" },
  { id: "fw_004", dispatch_card_id: "dc_002", work_date: daysAgo(12), hours: 8,  activity: "Replaced 12 idler rollers on upper conveyor section", outcomes: "Upper section complete",   status: "Supervisor_Approved", supervisor_comment: "Verified alignment" },
  { id: "fw_005", dispatch_card_id: "dc_002", work_date: daysAgo(11), hours: 7,  activity: "Replaced 12 idler rollers on lower conveyor section", outcomes: "Lower section complete",   status: "Returned_For_Correction", supervisor_comment: "Missing torque values for bolts" },
  { id: "fw_006", dispatch_card_id: "dc_004", work_date: daysAgo(75), hours: 10, activity: "Full ball mill liner removal",                        outcomes: "Old liner removed",        status: "Supervisor_Approved", supervisor_comment: "" },
  { id: "fw_007", dispatch_card_id: "dc_004", work_date: daysAgo(74), hours: 12, activity: "New rubber lining installation - mill body",          outcomes: "Mill body lined",          status: "Supervisor_Approved", supervisor_comment: "Quality confirmed" },
  { id: "fw_008", dispatch_card_id: "dc_004", work_date: daysAgo(73), hours: 8,  activity: "End-cap lining and final inspection",                outcomes: "Job complete, mill ready", status: "Supervisor_Approved", supervisor_comment: "Excellent finish" },
  { id: "fw_009", dispatch_card_id: "dc_005", work_date: daysAgo(100), hours: 10, activity: "Furnace refractory strip-out",                       outcomes: "Old refractory removed",   status: "Supervisor_Approved", supervisor_comment: "" },
  { id: "fw_010", dispatch_card_id: "dc_005", work_date: daysAgo(99),  hours: 12, activity: "New ceramic tile installation - zones 1-4",           outcomes: "4 zones complete",         status: "Supervisor_Approved", supervisor_comment: "" },
  { id: "fw_011", dispatch_card_id: "dc_005", work_date: daysAgo(98),  hours: 11, activity: "Zones 5-8 tiling and curing period",                 outcomes: "All zones tiled",          status: "Supervisor_Approved", supervisor_comment: "Signed off" },
];

// ──────────────────────────────────────────────────────────────
// 9. TIMESHEETS & MATERIAL USAGE
// ──────────────────────────────────────────────────────────────
const timesheets = [
  { id: "ts_001", dispatch_card_id: "dc_001", hours_logged: 27, hourly_rate: 45, created_at: daysAgo(8) },
  { id: "ts_002", dispatch_card_id: "dc_002", hours_logged: 15, hourly_rate: 45, created_at: daysAgo(11) },
  { id: "ts_003", dispatch_card_id: "dc_004", hours_logged: 30, hourly_rate: 45, created_at: daysAgo(73) },
  { id: "ts_004", dispatch_card_id: "dc_005", hours_logged: 33, hourly_rate: 45, created_at: daysAgo(98) },
];

const material_usage = [
  { id: "mu_001", dispatch_card_id: "dc_001", stock_item_id: "si_ceramic_tile",  description: "Ceramic tiles for cyclone",    quantity: 48,  unit_cost: 85,  total_cost: 4080 },
  { id: "mu_002", dispatch_card_id: "dc_002", stock_item_id: "si_idler_roller",  description: "Idler rollers replacement",    quantity: 24,  unit_cost: 100, total_cost: 2400 },
  { id: "mu_003", dispatch_card_id: "dc_004", stock_item_id: "si_rubber_lining", description: "Rubber lining for ball mill",  quantity: 200, unit_cost: 60,  total_cost: 12000 },
  { id: "mu_004", dispatch_card_id: "dc_005", stock_item_id: "si_ceramic_tile",  description: "Ceramic tiles for furnace",    quantity: 85,  unit_cost: 85,  total_cost: 7225 },
];

// ──────────────────────────────────────────────────────────────
// 10. INVOICES
// ──────────────────────────────────────────────────────────────
const invoices = [
  { id: "inv_001", dispatch_card_id: "dc_005", invoice_number: "INV-2025-001", status: "Sent", total_amount: 37200, created_at: daysAgo(90) },
];

const invoice_lines = [
  { id: "il_001", invoice_id: "inv_001", description: "Furnace refractory relining - labour",    quantity: 33, unit_price: 45, line_total: 1485 },
  { id: "il_002", invoice_id: "inv_001", description: "Furnace refractory relining - materials", quantity: 85, unit_price: 85, line_total: 7225 },
];

// ──────────────────────────────────────────────────────────────
// 11. INVENTORY
// ──────────────────────────────────────────────────────────────
const suppliers = [
  { id: "sup_ceramics", name: "African Ceramics Supply Co.", contact_person: "Tendai Moyo",        email: "tendai@africanceram.example",   phone: "+263 77 111 0001", lead_time_days: 14 },
  { id: "sup_rubber",   name: "Zimrubber Industrial",       contact_person: "Farai Ndlovu",       email: "farai@zimrubber.example",       phone: "+263 77 222 0002", lead_time_days: 7 },
  { id: "sup_conveyor",  name: "ConveyorTech Africa",        contact_person: "Blessing Chikwanda", email: "blessing@conveyortech.example", phone: "+263 77 333 0003", lead_time_days: 21 },
];

const stock_items = [
  { id: "si_ceramic_tile",  catalog_item_id: "cat_ceramic", item_code: "ALU-CER-TILE", item_name: "Alumina Ceramic Tiles",      unit_of_measure: "m2",   quantity_on_hand: 48,  reorder_level: 20, unit_cost: 85,  supplier_id: "sup_ceramics", location: "Store A - Shelf 1" },
  { id: "si_rubber_lining", catalog_item_id: "cat_rubber",  item_code: "RUB-LINING",   item_name: "Heavy Duty Rubber Lining",   unit_of_measure: "m2",   quantity_on_hand: 30,  reorder_level: 15, unit_cost: 60,  supplier_id: "sup_rubber",   location: "Store A - Shelf 2" },
  { id: "si_idler_roller",  catalog_item_id: "cat_idler",   item_code: "IDLER-ROLLER",  item_name: "Idler Roller",               unit_of_measure: "each", quantity_on_hand: 12,  reorder_level: 8,  unit_cost: 100, supplier_id: "sup_conveyor",  location: "Store B - Rack 3" },
  { id: "si_fasteners",     catalog_item_id: "cat_bolt",    item_code: "FAST-M16-SS",   item_name: "M16 Stainless Fastener Kit", unit_of_measure: "set",  quantity_on_hand: 60,  reorder_level: 25, unit_cost: 12,  supplier_id: "sup_ceramics", location: "Store A - Shelf 4" },
];

const stock_movements = [
  { id: "sm_001", stock_item_id: "si_ceramic_tile",  movement_type: "out", quantity: 48,  reason: "Issued to DC-2025-001 (cyclone lining)",   reference_id: "dc_001", created_at: daysAgo(10) },
  { id: "sm_002", stock_item_id: "si_idler_roller",  movement_type: "out", quantity: 24,  reason: "Issued to DC-2025-002 (idler replacement)", reference_id: "dc_002", created_at: daysAgo(12) },
  { id: "sm_003", stock_item_id: "si_rubber_lining", movement_type: "out", quantity: 200, reason: "Issued to DC-2025-004 (ball mill lining)",  reference_id: "dc_004", created_at: daysAgo(75) },
  { id: "sm_004", stock_item_id: "si_ceramic_tile",  movement_type: "in",  quantity: 100, reason: "Restock from African Ceramics Supply",      reference_id: null,     created_at: daysAgo(5) },
];

// ──────────────────────────────────────────────────────────────
// 12. ACCESS REQUESTS
// ──────────────────────────────────────────────────────────────
const access_requests = [
  { id: "ar_001", name: "Tatenda Moyo",    email: "tatenda.moyo@example.com",    requested_role: "Technician",    reason: "Joining field service team at Ngezi site",           status: "Pending",  created_at: daysAgo(3) },
  { id: "ar_002", name: "Rumbidzai Choto", email: "rumbi.choto@example.com",     requested_role: "Sales",         reason: "New sales representative for Southern region",       status: "Pending",  created_at: daysAgo(5) },
  { id: "ar_003", name: "Brian Mapfumo",   email: "brian.mapfumo@example.com",   requested_role: "Operations",    reason: "Promoted to operations coordinator",                 status: "Approved", created_at: daysAgo(15) },
  { id: "ar_004", name: "Grace Mutasa",    email: "grace.mutasa@zimplats.co.zw", requested_role: "Client Viewer", reason: "Need access to view Zimplats quotes and invoices",   status: "Approved", created_at: daysAgo(20) },
  { id: "ar_005", name: "Tinashe Dube",    email: "tinashe.dube@example.com",    requested_role: "Finance",       reason: "New finance clerk",                                  status: "Rejected", created_at: daysAgo(30) },
];

// ──────────────────────────────────────────────────────────────
// 13. LEADS
// ──────────────────────────────────────────────────────────────
const leads = [
  { id: "lead_001", company_name: "Hwange Colliery",       contact_name: "Peter Nyathi",   email: "peter@hwange.example",     phone: "+263 77 444 0001", mine_site: "Hwange",     service_need: "Conveyor belt relining",        urgency: "urgent",   status: "New",       created_at: daysAgo(2) },
  { id: "lead_002", company_name: "Mhangura Copper Mines", contact_name: "Chiedza Rwizi",  email: "chiedza@mhangura.example", phone: "+263 77 555 0002", mine_site: "Mhangura",   service_need: "Crusher liner replacement",     urgency: "standard", status: "Contacted", created_at: daysAgo(7) },
  { id: "lead_003", company_name: "Bikita Minerals",       contact_name: "Leonard Shumba", email: "leonard@bikita.example",   phone: "+263 77 666 0003", mine_site: "Bikita",     service_need: "Flotation cell ceramic lining", urgency: "standard", status: "Qualified", created_at: daysAgo(14) },
  { id: "lead_004", company_name: "RioZim Limited",        contact_name: "Nyasha Gumbo",   email: "nyasha@riozim.example",    phone: "+263 77 777 0004", mine_site: "Renco Mine",  service_need: "General wear protection survey", urgency: "low",     status: "New",       created_at: daysAgo(1) },
];

// ──────────────────────────────────────────────────────────────
// 14. NOTIFICATIONS & AUDIT
// ──────────────────────────────────────────────────────────────
const notifications = [
  { id: "notif_001", user_id: "u_admin",      type: "access_request",      message: "New access request from Tatenda Moyo (Technician)",                                read: false, created_at: daysAgo(3) },
  { id: "notif_002", user_id: "u_admin",      type: "access_request",      message: "New access request from Rumbidzai Choto (Sales)",                                   read: false, created_at: daysAgo(5) },
  { id: "notif_003", user_id: "u_finance",    type: "po_amendment",        message: "PO UNK-PO-2025-0088 requires amendment - logged value exceeds PO amount",            read: false, created_at: daysAgo(8) },
  { id: "notif_004", user_id: "u_supervisor", type: "worksheet_submitted", message: "Worksheet fw_003 submitted for review (DC-2025-001)",                                read: false, created_at: daysAgo(8) },
];

const audit_logs = [
  { id: "audit_seed", actor_id: "u_admin", entity_type: "system", entity_id: "seed", action: "SYSTEM_SEEDED", old_values: null, new_values: null, created_at: now() },
];

// ──────────────────────────────────────────────────────────────
// ASSEMBLE & WRITE TO NEON
// ──────────────────────────────────────────────────────────────
const data = {
  users, clients, mine_sites, plants, plant_sections, equipment_tags, catalog_items,
  leads, quotes, quote_lines, purchase_orders, po_amendments: [],
  dispatch_cards, field_worksheets, timesheets, material_usage,
  invoices, invoice_lines, pastel_export_batches: [], pastel_export_lines: [],
  suppliers, stock_items, stock_movements,
  audit_logs, notifications, access_requests,
  company_profile: {
    company_name: "Orac Systems",
    legal_name: "Handon Enterprises (Pvt) Ltd",
    address: "Harare, Zimbabwe",
    phone: "+263 242 700 123",
    email: "info@orac.co.zw",
    brand_primary: "#6EC1E4",
    brand_slate: "#54595F"
  }
};

requireDestructiveApply({
  scriptName: "seed-realistic.js",
  phrase: "REPLACE_ALL_DATA",
  effect: "REPLACES the entire main store with generated demonstration data and resets every account password."
});

try {
  await ensureTableExists();
  const backupId = await snapshotStore(pool, "before-seed-realistic");
  console.log(`Previous state saved as store_backups id ${backupId ?? "(none - no prior main row)"}.`);
  await pool.query(
    "INSERT INTO store (id, data) VALUES ('main', $1) ON CONFLICT (id) DO UPDATE SET data = $1",
    [data]
  );

  console.log("===  Realistic seed complete! ===");
  console.log("");
  console.log("Entity counts:");
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      console.log("  " + key + ": " + value.length);
    }
  }
  console.log("");
  console.log("Login credentials:");
  for (const u of users) {
    let pw = "Test@123";
    if (u.role === "Admin") pw = generatedPasswords.admin;
    if (u.role === "Client Viewer") pw = generatedPasswords.client;
    console.log("  " + u.email.padEnd(28) + " " + u.role.padEnd(16) + " (PW: " + pw + ")");
  }
} catch (error) {
  console.error("Seed failed:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
