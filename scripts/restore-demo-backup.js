import { pool, ensureTableExists } from "../src/pool.js";
import { evaluateGuard } from "./lib/destructiveGuard.js";

const backupId = Number(process.argv[2]);
const PHRASE = "RESTORE_DEMO_BACKUP";

try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  if (!Number.isInteger(backupId) || backupId < 1) throw new Error("Provide a numeric backup id as the first argument.");

  // The original confirmation variable name is kept; the shared guard adds a
  // required target-host confirmation and a production refusal.
  const guard = evaluateGuard({
    phrase: PHRASE,
    argv: process.argv,
    env: { ...process.env, ORAC_CONFIRM_DESTRUCTIVE: process.env.ORAC_DEMO_RESTORE_CONFIRM }
  });
  if (guard.mode === "dry-run") {
    throw new Error(`Dry run only. Use --apply with ORAC_DEMO_RESTORE_CONFIRM=${PHRASE} and ORAC_TARGET_DB_HOST=<exact non-production database host>.`);
  }
  if (guard.mode === "refused") throw new Error(`Refusing restore. ${guard.problems.join(" ")}`);

  await ensureTableExists();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE TABLE IF NOT EXISTS store_backups (id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), label TEXT NOT NULL, data JSONB NOT NULL)");
    // The row lock also makes the running application wait for this restore.
    const current = await client.query("SELECT data FROM store WHERE id = 'main' FOR UPDATE");
    if (!current.rowCount) throw new Error("The main store does not exist; refusing to restore into an uninitialised database.");
    const backup = await client.query("SELECT data FROM store_backups WHERE id = $1", [backupId]);
    if (!backup.rowCount) throw new Error("Backup was not found.");
    const safety = await client.query(
      "INSERT INTO store_backups (label, data) VALUES ($1, $2) RETURNING id",
      [`before-restore-of-${backupId}`, current.rows[0].data]
    );
    await client.query("UPDATE store SET data = $1 WHERE id = 'main'", [backup.rows[0].data]);
    await client.query("COMMIT");
    console.log(`Restored backup ${backupId}. The previous state was saved as backup ${safety.rows[0].id}.`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
} catch (error) {
  console.error(`Restore failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
