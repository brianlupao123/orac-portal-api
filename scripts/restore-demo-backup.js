import { pool, ensureTableExists } from "../src/pool.js";

const backupId = Number(process.argv[2]);
const apply = process.argv.includes("--apply");

try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  if (!Number.isInteger(backupId) || backupId < 1) throw new Error("Provide a numeric backup id as the first argument.");
  if (!apply || process.env.ORAC_DEMO_RESTORE_CONFIRM !== "RESTORE_DEMO_BACKUP") {
    throw new Error("Refusing restore. Use --apply and ORAC_DEMO_RESTORE_CONFIRM=RESTORE_DEMO_BACKUP.");
  }
  await ensureTableExists();
  const backup = await pool.query("SELECT data FROM store_backups WHERE id = $1", [backupId]);
  if (!backup.rowCount) throw new Error("Backup was not found.");
  await pool.query("UPDATE store SET data = $1 WHERE id = 'main'", [backup.rows[0].data]);
  console.log(`Restored backup ${backupId}.`);
} catch (error) {
  console.error(`Restore failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
