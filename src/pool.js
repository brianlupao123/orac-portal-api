import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Keep certificate and hostname validation enabled for hosted PostgreSQL.
  // The deployment connection string must use sslmode=verify-full as well.
  ssl: { rejectUnauthorized: true },
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
});

// Run this once at startup to ensure the table exists
export async function ensureTableExists() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL
    );
  `);
}

// Keep-alive ping to prevent Neon cold starts (scales to zero after 5 mins)
if (process.env.DATABASE_URL) {
  setInterval(() => {
    pool.query("SELECT 1").catch(err => console.error("Keep-alive ping failed:", err.message));
  }, 4.5 * 60 * 1000); // 4.5 minutes
}
