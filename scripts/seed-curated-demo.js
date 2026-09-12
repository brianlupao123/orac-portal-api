import { pool, ensureTableExists } from "../src/pool.js";
import { buildCuratedDemoData } from "../src/curatedDemoData.js";

const apply = process.argv.includes("--apply");
const confirmation = process.env.ORAC_DEMO_SEED_CONFIRM === "REPLACE_DEMO_DATA";

function describe(data) {
  return Object.entries(data)
    .filter(([, value]) => Array.isArray(value))
    .map(([name, value]) => `${name}: ${value.length}`)
    .join(", ");
}

try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  await ensureTableExists();
  const currentResult = await pool.query("SELECT data FROM store WHERE id = 'main'");
  if (!currentResult.rowCount) throw new Error("No existing main store was found. Bootstrap the database before seeding a demo.");

  const current = currentResult.rows[0].data;
  const demo = buildCuratedDemoData(current.users || []);
  console.log(`Curated demo preview: ${describe(demo)}`);

  if (!apply) {
    console.log("Dry run only. No data was changed. Use --apply together with ORAC_DEMO_SEED_CONFIRM=REPLACE_DEMO_DATA to apply.");
  } else {
    if (!confirmation) throw new Error("Refusing to replace operational demo data without ORAC_DEMO_SEED_CONFIRM=REPLACE_DEMO_DATA.");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE TABLE IF NOT EXISTS store_backups (id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), label TEXT NOT NULL, data JSONB NOT NULL)");
      const backup = await client.query("INSERT INTO store_backups (label, data) VALUES ($1, $2) RETURNING id", ["before-curated-demo-seed", current]);
      const users = (current.users || []).map((user) => user.role === "Client Viewer" ? { ...user, client_id: "c_zimplats" } : user);
      const next = { ...current, ...demo, users };
      await client.query("UPDATE store SET data = $1 WHERE id = 'main'", [next]);
      await client.query("COMMIT");
      console.log(`Curated demonstration data applied. Backup id: ${backup.rows[0].id}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
} catch (error) {
  console.error(`Demo seed failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
