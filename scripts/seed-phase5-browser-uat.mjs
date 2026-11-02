import pg from "pg";
import { buildPhase5BrowserUatFixture, phase5BrowserUatPassword } from "./phase5BrowserUatFixture.mjs";

const databaseUrl = process.env.ORAC_PHASE5_BROWSER_UAT_DATABASE_URL || "";
if (!databaseUrl) throw new Error("ORAC_PHASE5_BROWSER_UAT_DATABASE_URL is required.");

const parsed = new URL(databaseUrl);
if (parsed.protocol !== "postgres:") throw new Error("Phase 5 browser UAT requires a PostgreSQL URL.");
if (parsed.pathname !== "/orac_phase5_browser_test") {
  throw new Error("Refusing to seed a database other than orac_phase5_browser_test.");
}

const { db, accounts, financePreparerEmail, financeReviewerEmail } = await buildPhase5BrowserUatFixture();
const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  await pool.query("CREATE TABLE IF NOT EXISTS store (id TEXT PRIMARY KEY, data JSONB NOT NULL)");
  await pool.query(
    "INSERT INTO store (id, data) VALUES ('main', $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data",
    [db]
  );
  console.log(JSON.stringify({
    database: parsed.pathname.slice(1),
    fictional: true,
    v5_records_seeded: false,
    dispatch: "phase5-uat-dispatch",
    purchase_order: "phase5-uat-po",
    uat_login_password: phase5BrowserUatPassword,
    finance_preparer: financePreparerEmail,
    finance_reviewer: financeReviewerEmail,
    accounts
  }, null, 2));
} finally {
  await pool.end();
}
