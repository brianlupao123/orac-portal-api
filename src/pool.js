import pg from "pg";
import { config } from "./config.js";
import { secureConnectionString } from "./dbUrl.js";

const { Pool } = pg;

export { secureConnectionString };

/**
 * Determine the SSL configuration for a PostgreSQL connection.
 *
 * SSL is disabled only when ALL of the following are true:
 *   1. The hostname resolves to a local loopback address
 *      (localhost, 127.0.0.1, or ::1).
 *   2. The URL explicitly includes sslmode=disable.
 *
 * Any non-local host — including Neon or any other hosted endpoint —
 * always receives { rejectUnauthorized: true }, even if sslmode=disable
 * appears in the URL.
 *
 * @param {string|undefined} databaseUrl
 * @returns {false | { rejectUnauthorized: true }}
 */
export function sslConfig(databaseUrl) {
  if (!databaseUrl) return { rejectUnauthorized: true };

  let hostname;
  try {
    hostname = new URL(databaseUrl).hostname;
  } catch {
    // Malformed URL — keep TLS on and let node-postgres surface the error.
    return { rejectUnauthorized: true };
  }

  const normalizedHost = hostname ? hostname.replace(/^\[|\]$/g, "") : "";

  const isLocal =
    normalizedHost === "localhost" ||
    normalizedHost === "127.0.0.1" ||
    normalizedHost === "::1";

  const sslDisableRequested = /[?&]sslmode=disable(?:&|$)/i.test(databaseUrl);

  if (isLocal && sslDisableRequested) return false;

  return { rejectUnauthorized: true };
}

export const pool = new Pool({
  connectionString: secureConnectionString(process.env.DATABASE_URL),
  // A separate password is useful for local PostgreSQL passwords containing
  // URL-reserved characters. Hosted deployments continue to use DATABASE_URL.
  ...(process.env.PGPASSWORD ? { password: process.env.PGPASSWORD } : {}),
  // Keep certificate and hostname validation enabled for hosted PostgreSQL.
  // See sslConfig() above for the exact policy; the function is exported
  // so tests can exercise it behaviourally without reading source text.
  ssl: sslConfig(process.env.DATABASE_URL),
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
