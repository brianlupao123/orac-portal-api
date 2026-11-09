import crypto from "crypto";
import bcrypt from "bcrypt";
import { pool, ensureTableExists } from "../src/pool.js";
import { requireDestructiveApply, snapshotStore } from "./lib/destructiveGuard.js";

function uuid() { return crypto.randomUUID(); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randFloat(min, max, decimals = 2) { return Number((Math.random() * (max - min) + min).toFixed(decimals)); }
function pastDate(daysBack) { return new Date(Date.now() - randInt(0, daysBack) * 86400000).toISOString(); }

const SHARED_DEMO_HASH = "$2b$10$wTf22.n2j2/5s/KjE31eoeLStx0Q11tP/V9WzG1qMofxG.W1L7V46"; // "Test@123"

function generateSecurePassword(length = 16) {
  return crypto.randomBytes(length).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, length);
}

// ---------------------------------------------------------------------------
// 1. CLIENTS (50) — 4 established real Orac clients + 46 generated
// ---------------------------------------------------------------------------
const FLAGSHIP_CLIENTS = ["Example North Mining", "Example South Minerals", "Example East Mine", "Example Ridge Gold"];
const TOWNS = ["Kadoma", "Kwekwe", "Gweru", "Bulawayo", "Mutare", "Masvingo", "Chinhoyi", "Karoi",
  "Zvishavane", "Shurugwi", "Bindura", "Chegutu", "Beitbridge", "Hwange", "Marondera", "Norton",
  "Redcliff", "Rusape", "Chiredzi", "Gokwe"];
const MINERALS = ["Gold", "Platinum", "Chrome", "Nickel", "Diamond", "Coal", "Copper", "Lithium"];
const SUFFIXES = ["Mine", "Mining Company", "Minerals", "Resources", "Operations", "Concentrator"];

function generateClientName(usedNames) {
  let name;
  do {
    name = `${pick(TOWNS)} ${pick(MINERALS)} ${pick(SUFFIXES)}`;
  } while (usedNames.has(name));
  usedNames.add(name);
  return name;
}

const clients = [];
const usedNames = new Set(FLAGSHIP_CLIENTS);
FLAGSHIP_CLIENTS.forEach((name) => clients.push({ id: uuid(), name, type: "permanent", contact_person: "Procurement", email: "procurement@example.com" }));
while (clients.length < 50) {
  clients.push({ id: uuid(), name: generateClientName(usedNames), type: Math.random() > 0.3 ? "permanent" : "walk_in", contact_person: "Procurement", email: "procurement@example.com" });
}

// Mine sites / plants / equipment tags per client
const mineSites = [];
const plants = [];
const equipmentTags = [];
const PLANT_TYPES = ["SMC Concentrator", "Smelter", "Flotation Circuit", "Main Crusher", "Processing Plant"];
const PLANT_SECTIONS = ["Feed Preparation", "Cyclone Cluster", "Discharge Conveyor Line", "Furnace Refractory Section", "Screening Deck"];

clients.forEach((client) => {
  const siteCount = randInt(1, 3);
  for (let s = 0; s < siteCount; s++) {
    const site = { id: uuid(), client_id: client.id, name: `${client.name.split(" ")[0]} Site ${s + 1}`, location: pick(TOWNS) };
    mineSites.push(site);
    const plantCount = randInt(1, 2);
    for (let p = 0; p < plantCount; p++) {
      const plant = { id: uuid(), mine_site_id: site.id, name: pick(PLANT_TYPES), plant_code: `PLT-${randInt(100, 999)}` };
      plants.push(plant);
      const tagCount = randInt(2, 5);
      for (let t = 0; t < tagCount; t++) {
        equipmentTags.push({
          id: uuid(),
          plant_id: plant.id,
          tag_code: `EQ-TAG-${plant.name.split(" ")[0].slice(0, 4).toUpperCase()}-${randInt(1000, 9999)}`,
          description: pick(PLANT_SECTIONS),
          criticality: pick(["low", "medium", "high", "critical"]),
        });
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 2. USERS (memorable names based on roles)
// ---------------------------------------------------------------------------
const MEMORABLE_USERS = [
  { name: "Admin", role: "Admin", email: "admin@orac.co.zw" },
  { name: "Management", role: "Management", email: "management@orac.co.zw" },
  { name: "Sales", role: "Sales", email: "sales@orac.co.zw" },
  { name: "Finance", role: "Finance", email: "finance@orac.co.zw" },
  { name: "Operations", role: "Operations", email: "ops@orac.co.zw" },
  { name: "Supervisor", role: "Supervisor", email: "supervisor@orac.co.zw" },
  { name: "Technician", role: "Technician", email: "tech@orac.co.zw" },
  { name: "Client", role: "Client Viewer", email: "client@orac.co.zw" }
];

async function buildUsers() {
  const users = [];
  const credentialsLog = [];

  for (const u of MEMORABLE_USERS) {
    if (u.role === "Admin") {
      const plain = "CalvinAdmin123!"; // Memorable but strong enough for demo
      credentialsLog.push(`Admin           ${u.email}  password: ${plain}`);
      users.push({ id: uuid(), email: u.email, name: u.name, role: u.role, password_hash: await bcrypt.hash(plain, 10), is_active: true });
    } else if (u.role === "Client Viewer") {
      const plain = "ClientView123!";
      credentialsLog.push(`Client Viewer   ${u.email}  password: ${plain}`);
      users.push({
        id: uuid(), email: u.email, name: u.name, role: u.role,
        client_id: pick(clients).id,
        password_hash: await bcrypt.hash(plain, 10), is_active: true,
      });
    } else {
      users.push({ id: uuid(), email: u.email, name: u.name, role: u.role, password_hash: SHARED_DEMO_HASH, is_active: true });
    }
  }
  return { users, credentialsLog };
}

// ---------------------------------------------------------------------------
// 3-8. PIPELINE DATA
// ---------------------------------------------------------------------------
const QUOTE_STATUSES = ["Draft", "Submitted_To_Client", "Client_Approved", "Client_Rejected"];
const SERVICE_DESCRIPTIONS = [
  "Alumina ceramic lining installation", "Heavy duty rubber lining replacement",
  "Conveyor idler roller replacement", "Hot splice belt repair", "Plant shutdown maintenance",
  "Emergency breakdown response", "Shaft laser alignment", "Pulley lagging application",
  "Fabrication and installation of steel platework", "Sandblasting and corrosion protection",
];
const WORKSHEET_ACTIVITIES = [
  "Replaced conveyor belt idlers", "Calibrated primary crusher sensors", "Re-lined discharge chute with ceramic tile",
  "Performed shaft alignment on drive motor", "Hot-spliced main conveyor belt", "Inspected and greased pulley bearings",
  "Replaced worn rubber lining in cyclone cluster", "Conducted emergency breakdown repair on crusher",
  "Installed new idler rollers on incline conveyor", "Performed scheduled preventive maintenance on flotation cells",
];
const CATALOG_CATEGORIES = ["Bearings", "Sensors", "PPE", "Motors", "Valves", "Fasteners", "Lubricants", "Conveyor Parts"];

function buildQuotes(users) {
  const quotes = [];
  for (let i = 0; i < 105; i++) {
    const client = pick(clients);
    quotes.push({
      id: uuid(),
      quote_number: `Q-${(1000 + i)}`,
      client_id: client.id,
      description: pick(SERVICE_DESCRIPTIONS),
      total_amount: randFloat(500, 250000, 2),
      status: pick(QUOTE_STATUSES),
      created_by: pick(users.filter((u) => u.role === "Sales" || u.role === "Admin")).id,
      created_at: pastDate(180),
    });
  }
  return quotes;
}

function buildPurchaseOrders(quotes) {
  const approved = quotes.filter((q) => q.status === "Client_Approved");
  const pos = [];
  const pool = approved.length >= 62 ? approved : quotes; // fallback if too few approved
  const chosen = [...pool].sort(() => Math.random() - 0.5).slice(0, Math.max(62, Math.min(70, pool.length)));
  chosen.forEach((quote, i) => {
    pos.push({
      id: uuid(),
      quote_id: quote.id,
      po_reference: `PO-${(88000 + i)}`,
      po_amount: quote.total_amount,
      status: Math.random() > 0.15 ? "verified" : "pending",
      started_before_po: Math.random() > 0.85,
      date_received: pastDate(120),
    });
  });
  return pos;
}

function buildDispatchCards(purchaseOrders, equipmentTags) {
  const dispatchCards = [];
  const chosen = [...purchaseOrders].sort(() => Math.random() - 0.5).slice(0, Math.min(55, purchaseOrders.length));
  chosen.forEach((po) => {
    dispatchCards.push({
      id: uuid(),
      purchase_order_id: po.id,
      equipment_tag_id: pick(equipmentTags).id,
      status: pick(["Scheduled", "In_Progress", "Completed"]),
      started_before_po: po.started_before_po,
      created_at: pastDate(100),
    });
  });
  return dispatchCards;
}

function buildWorksheets(dispatchCards, users) {
  const technicians = users.filter((u) => u.role === "Technician");
  const worksheets = [];
  for (let i = 0; i < 155; i++) {
    const dispatchCard = pick(dispatchCards);
    worksheets.push({
      id: uuid(),
      dispatch_card_id: dispatchCard.id,
      technician_id: pick(technicians).id,
      activity: pick(WORKSHEET_ACTIVITIES),
      hours: randFloat(2, 12, 1),
      status: pick(["Draft", "Submitted", "Supervisor_Approved", "Returned_For_Correction"]),
      work_date: pastDate(90),
    });
  }
  return worksheets;
}

function buildTimesheets(worksheets, users) {
  const technicians = users.filter((u) => u.role === "Technician");
  const timesheets = [];
  for (let i = 0; i < 310; i++) {
    const worksheet = pick(worksheets);
    timesheets.push({
      id: uuid(),
      worksheet_id: worksheet.id,
      technician_id: pick(technicians).id,
      hours_logged: randFloat(1, 10, 1),
      hourly_rate: randFloat(8, 35, 2),
      date: pastDate(90),
    });
  }
  return timesheets;
}

function buildInvoices(dispatchCards, purchaseOrders) {
  const completed = dispatchCards.filter((d) => d.status === "Completed");
  const invoices = [];
  const pool = completed.length >= 40 ? completed : dispatchCards;
  const chosen = [...pool].sort(() => Math.random() - 0.5).slice(0, Math.min(45, pool.length));
  chosen.forEach((dispatchCard, i) => {
    const po = purchaseOrders.find((p) => p.id === dispatchCard.purchase_order_id);
    invoices.push({
      id: uuid(),
      dispatch_card_id: dispatchCard.id,
      purchase_order_id: dispatchCard.purchase_order_id,
      invoice_number: `INV-${(5000 + i)}`,
      total_amount: po ? po.po_amount : randFloat(500, 100000),
      status: pick(["draft", "sent", "paid"]),
      date: pastDate(60),
    });
  });
  return invoices;
}

function buildInventory() {
  const suppliers = [];
  for (let i = 0; i < 15; i++) {
    suppliers.push({
      id: uuid(),
      name: `${pick(TOWNS)} Industrial Supplies`,
      lead_time_days: randInt(3, 30),
      contact_person: "Sales",
      email: "sales@example.com",
    });
  }
  const catalogItems = [];
  const stockItems = [];
  for (let i = 0; i < 105; i++) {
    const category = pick(CATALOG_CATEGORIES);
    const reorderLevel = randInt(5, 50);
    const item = {
      id: uuid(),
      item_code: `${category.slice(0, 3).toUpperCase()}-${randInt(1000, 9999)}`,
      item_name: `${category.slice(0, -1)} - ${pick(["Standard", "Heavy Duty", "Industrial Grade", "Premium"])}`,
      category,
      unit_of_measure: pick(["each", "box", "meter", "kg", "liter"]),
      quantity_on_hand: randInt(0, 200),
      reorder_level: reorderLevel,
      unit_cost: randFloat(2, 850, 2),
      supplier_id: pick(suppliers).id,
    };
    catalogItems.push(item);
    stockItems.push(item);
  }
  return { suppliers, catalogItems, stockItems };
}

// ---------------------------------------------------------------------------
// ASSEMBLE + WRITE
// ---------------------------------------------------------------------------
async function main() {
  requireDestructiveApply({
    scriptName: "load-massive-seed.js",
    phrase: "REPLACE_ALL_DATA",
    effect: "REPLACES the entire main store with a large generated demonstration data set and resets account passwords."
  });
  const { users, credentialsLog } = await buildUsers();
  const quotes = buildQuotes(users);
  const purchaseOrders = buildPurchaseOrders(quotes);
  const dispatchCards = buildDispatchCards(purchaseOrders, equipmentTags);
  const worksheets = buildWorksheets(dispatchCards, users);
  const timesheets = buildTimesheets(worksheets, users);
  const invoices = buildInvoices(dispatchCards, purchaseOrders);
  const { suppliers, catalogItems, stockItems } = buildInventory();

  // Make sure we have empty arrays for everything else so normalization works
  const MASSIVE_SEED_DATA = {
    clients, mine_sites: mineSites, plants, plant_sections: [], equipment_tags: equipmentTags,
    users, quotes, quote_lines: [], purchase_orders: purchaseOrders, po_amendments: [],
    dispatch_cards: dispatchCards, worksheets, timesheets, material_usage: [], invoices, invoice_lines: [],
    suppliers, catalog_items: catalogItems, stock_items: stockItems, stock_movements: [],
    leads: [], audit_logs: [], notifications: [], access_requests: [],
    company_profile: {
      legal_name: "ORAC (Pvt) Ltd",
      address: "Harare, Zimbabwe",
      phone: "+263 242 700 123",
      email: "info@orac.co.zw",
    }
  };

  try {
    await ensureTableExists();
    const backupId = await snapshotStore(pool, "before-load-massive-seed");
    console.log(`Previous state saved as store_backups id ${backupId ?? "(none - no prior main row)"}.`);
    // Use the idempotent upsert approach over the entire blob
    await pool.query(
      "INSERT INTO store (id, data) VALUES ('main', $1) ON CONFLICT (id) DO UPDATE SET data = $1",
      [MASSIVE_SEED_DATA]
    );

    console.log("\n=== MASSIVE SEED COMPLETE (INSERTED INTO NEON) ===");
    console.log(`Clients: ${clients.length}, Mine Sites: ${mineSites.length}, Plants: ${plants.length}, Equipment Tags: ${equipmentTags.length}`);
    console.log(`Users: ${users.length}, Quotes: ${quotes.length}, POs: ${purchaseOrders.length}, Dispatch Cards: ${dispatchCards.length}`);
    console.log(`Worksheets: ${worksheets.length}, Timesheets: ${timesheets.length}, Invoices: ${invoices.length}`);
    console.log(`Suppliers: ${suppliers.length}, Catalog Items: ${catalogItems.length}`);

    console.log("\n=== CREDENTIALS (shown once - copy now, do not commit or paste into chat) ===");
    credentialsLog.forEach((line) => console.log(line));
    console.log("(All other users share the Test@123 demo password - internal roles only.)");
  } catch (err) {
    console.error("Seed failed:", err.message);
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
