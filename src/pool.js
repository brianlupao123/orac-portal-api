import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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
