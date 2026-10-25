import pg from "pg";
import bcrypt from "bcrypt";
import { database, response, request, contactBody, paperBody } from "../tests/helpers/v5SignatureFixture.js";
import { createV5ClientSupervisorContact, recordV5PaperSignature, confirmV5Timesheet } from "../src/controllers/v5SignatureController.js";
import { v5SignatureState } from "../src/v5SignatureEvidence.js";

const url = process.env.ORAC_BROWSER_UAT_DATABASE_URL || "";
process.env.ORAC_V5_COMMERCIAL_WORKFLOW = "enabled";
process.env.ORAC_V5_INVOICE_WRITER = "enabled";
const parsed = new URL(url);
if (parsed.protocol !== "postgres:") throw new Error("UAT requires a PostgreSQL URL.");
if (!parsed.pathname.endsWith("orac_v5_browser_test")) throw new Error("Refusing to seed a non-browser-test database.");

const pool = new pg.Pool({ connectionString: url });
const db = database();
const uatPassword = "OracUAT2026!";
const uatPasswordHash = await bcrypt.hash(uatPassword, 10);
const roles = ["Finance", "Admin", "Management", "Sales", "Operations", "Supervisor", "Technician", "Client Viewer"];
const emails = {
  Finance: "uat-finance@fixture.invalid", Admin: "uat-admin@fixture.invalid", Management: "uat-management@fixture.invalid",
  Sales: "uat-sales@fixture.invalid", Operations: "uat-operations@fixture.invalid", Supervisor: "uat-supervisor@fixture.invalid",
  Technician: "uat-technician@fixture.invalid", "Client Viewer": "uat-client@fixture.invalid"
};
for (const [index, role] of roles.entries()) {
  const email = emails[role];
  const existing = db.users.find((user) => user.email === email);
  const user = { id: existing?.id || `uat-${role.toLowerCase().replace(/\s+/g, "-")}-${index}`, email, name: `UAT ${role}`, role, is_active: true, password_hash: uatPasswordHash };
  if (existing) Object.assign(existing, user);
  else db.users.push(user);
}
function callAs(handler, actor, options) {
  const req = request(db, actor.id, options);
  req.user = actor;
  const res = response();
  handler(req, res);
  return res;
}
const sales = db.users.find((user) => user.id === "sales-1");
const operations = db.users.find((user) => user.id === "sales-1");
const supervisor = db.users.find((user) => user.id === "sup-1");
db.quotes[0].currency = "USD";
db.quotes[0].tax_status = "unconfigured";
db.quotes[0].commercial_acceptance_po_id = "uat-po-1";
db.quote_lines[0].quantity = 16;
db.quote_lines[0].unit_price_cents = 2500;
db.purchase_orders = [{ id: "uat-po-1", po_reference: "UAT-PO-1", po_amount: 1000, status: "verified" }];
db.dispatch_cards[0].purchase_order_id = "uat-po-1";
db.dispatch_cards[0].quotation_id = "quote-1";
const contact = callAs(createV5ClientSupervisorContact, sales, { params: { id: "job-1" }, body: contactBody() }).body.data;
const signature = callAs(recordV5PaperSignature, operations, { params: { id: "ws-1" }, body: paperBody(contact.id) });
if (signature.statusCode !== 201) throw new Error("Could not create fictional signature evidence.");
const evidence = v5SignatureState(db, db.field_worksheets[0]);
const confirmation = callAs(confirmV5Timesheet, supervisor, { params: { id: "ws-1" }, body: { evidence_id: evidence.evidence.id, hours_hash: evidence.current_hash, attest: true } });
if (confirmation.statusCode !== 201) throw new Error("Could not create fictional supervisor confirmation.");

try {
  await pool.query("CREATE TABLE IF NOT EXISTS store (id TEXT PRIMARY KEY, data JSONB NOT NULL)");
  await pool.query("INSERT INTO store (id, data) VALUES ('main', $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data", [db]);
  console.log(JSON.stringify({ database: parsed.pathname.slice(1), users: db.users.length, dispatch: "job-1", quote: "quote-1", purchase_order: "uat-po-1", worksheet: "ws-1", uat_login_password: uatPassword, uat_login_accounts: emails }, null, 2));
} finally {
  await pool.end();
}
