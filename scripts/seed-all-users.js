import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import bcrypt from "bcrypt";
import { pool, ensureTableExists } from "../src/pool.js";
import { requireDestructiveApply, snapshotStore } from "./lib/destructiveGuard.js";

requireDestructiveApply({
  scriptName: "seed-all-users.js",
  phrase: "REPLACE_ALL_DATA_AND_RESET_ALL_PASSWORDS",
  effect: "REPLACES the entire main store from data/db.json and sets ONE shared, publicly known password on EVERY account, activating all of them."
});

try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required. Create .env first.");
  
  const input = resolve("data/db.json");
  const data = JSON.parse(readFileSync(input, "utf8"));
  
  console.log(`Found ${data.users.length} users. Hashing passwords...`);
  
  for (const user of data.users) {
    user.password_hash = await bcrypt.hash("Test@123", 12);
    user.is_active = true;
    delete user.password;
  }
  
  await ensureTableExists();
  const backupId = await snapshotStore(pool, "before-seed-all-users");
  console.log(`Previous state saved as store_backups id ${backupId ?? "(none - no prior main row)"}.`);

  const result = await pool.query(
    "INSERT INTO store (id, data) VALUES ('main', $1) ON CONFLICT (id) DO UPDATE SET data = $1 RETURNING id",
    [data]
  );
  
  console.log("Database seeded successfully!");
  console.log("Users seeded:");
  for (const user of data.users) {
    console.log(`  ${user.email} (${user.role}) - Password: Test@123`);
  }
} catch (error) {
  console.error("Seed failed:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
