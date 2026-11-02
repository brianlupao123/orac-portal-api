import { pool, ensureTableExists } from "../src/pool.js";
import { evaluateGuard } from "./lib/destructiveGuard.js";
import { restoreStoreBackup } from "./lib/restoreStoreBackup.js";

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
    const safetyBackupId = await restoreStoreBackup(client, backupId);
    console.log(`Restored backup ${backupId}. The previous state was saved as backup ${safetyBackupId}.`);
  } finally {
    client.release();
  }
} catch (error) {
  console.error(`Restore failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
