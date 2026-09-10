import { pool, ensureTableExists } from "../src/pool.js";

try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  await ensureTableExists();
  console.log("Pilot PostgreSQL store is ready.");
} catch (error) {
  console.error("Migration failed:", error.code || error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
