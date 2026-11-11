import pg from "pg";
import { secureConnectionString } from "../src/dbUrl.js";
import { AdminCompanyProfileSchema } from "../src/schemas.js";

const { Pool } = pg;

// Usage:
//   DATABASE_URL=<url> TAX_STATUS=taxable TAX_RATE=0.15 APPROVAL_REF="ZIMRA-BP-123456" ORAC_OPERATOR_NAME="brian.lupao" \
//     node scripts/set-company-tax-config.js
//
// Updates company_profile.quotation_tax_configuration in the production store safely
// using row-level locking (SELECT ... FOR UPDATE) and validates against AdminCompanyProfileSchema.

const databaseUrl = process.env.DATABASE_URL;
const taxStatus = process.env.TAX_STATUS || "taxable"; // taxable | zero-rated | exempt
const taxRate = process.env.TAX_RATE !== undefined ? Number(process.env.TAX_RATE) : (taxStatus === "taxable" ? 0.15 : 0);
const approvalRef = String(process.env.APPROVAL_REF || "").trim();
const operatorName = String(process.env.ORAC_OPERATOR_NAME || process.env.OPERATOR_NAME || "operator:cli").trim();
const operatorId = operatorName.startsWith("operator:") ? operatorName : `operator:${operatorName.toLowerCase()}`;

if (!databaseUrl) throw new Error("DATABASE_URL is required.");
if (!approvalRef) throw new Error("APPROVAL_REF is required (e.g. ZIMRA tax clearance, BP number, or accountant sign-off ref).");

const taxConfig = {
  tax_status: taxStatus,
  applied_tax_rate: taxRate,
  approved: true,
  approval_reference: approvalRef
};

// Validate schema
const validation = AdminCompanyProfileSchema.pick({ quotation_tax_configuration: true }).safeParse({
  quotation_tax_configuration: taxConfig
});

if (!validation.success) {
  console.error("Tax configuration schema validation failed:", JSON.stringify(validation.error.issues, null, 2));
  process.exit(1);
}

const pool = new Pool({
  connectionString: secureConnectionString(databaseUrl),
  ssl: { rejectUnauthorized: true },
  max: 1,
  connectionTimeoutMillis: 10000
});

try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT data FROM store WHERE id = 'main' FOR UPDATE");
    if (result.rowCount !== 1) throw new Error("The production store is not initialized.");

    const db = result.rows[0].data;
    if (!db.company_profile) db.company_profile = {};
    const oldTax = db.company_profile.quotation_tax_configuration || null;
    db.company_profile.quotation_tax_configuration = taxConfig;

    const auditEntry = {
      id: `audit_tax_${Date.now()}`,
      actor_id: operatorId,
      entity_type: "company_profile",
      entity_id: "quotation_tax_configuration",
      action: "COMPANY_TAX_CONFIGURATION_UPDATED",
      old_values: oldTax,
      new_values: taxConfig,
      created_at: new Date().toISOString()
    };
    if (!Array.isArray(db.audit_logs)) db.audit_logs = [];
    db.audit_logs.push(auditEntry);

    await client.query("UPDATE store SET data = $1 WHERE id = 'main'", [JSON.stringify(db)]);
    await client.query("COMMIT");

    console.log("Successfully updated production company tax configuration:");
    console.log(JSON.stringify(taxConfig, null, 2));
    console.log(`Audited by: ${operatorId}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
