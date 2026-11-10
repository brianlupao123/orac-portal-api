import bcrypt from "bcrypt";
import pg from "pg";
import { secureConnectionString } from "../src/dbUrl.js";

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;
const email = String(process.env.RESET_ADMIN_EMAIL || "").trim().toLowerCase();
const password = process.env.RESET_ADMIN_PASSWORD || "";

if (!databaseUrl) throw new Error("DATABASE_URL is required.");
if (!email) throw new Error("RESET_ADMIN_EMAIL is required.");
if (Buffer.byteLength(password) < 16 || Buffer.byteLength(password) > 72) {
  throw new Error("RESET_ADMIN_PASSWORD must be 16-72 bytes.");
}

// Same TLS policy as src/pool.js: certificate and host name validation stay on.
const pool = new Pool({
  connectionString: secureConnectionString(databaseUrl),
  ssl: { rejectUnauthorized: true },
  max: 1,
  connectionTimeoutMillis: 10000
});

try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT data FROM store WHERE id = 'main' FOR UPDATE");
    if (result.rowCount !== 1) throw new Error("The production store is not initialized.");

    const data = result.rows[0].data;
    const user = data.users?.find((item) => item.email?.toLowerCase() === email);
    if (!user) throw new Error(`No user found for ${email}.`);
    if (user.role !== "Admin") throw new Error("This script may reset only an Admin account.");
    if (!user.is_active) throw new Error("The Admin account is inactive.");

    user.password_hash = await bcrypt.hash(password, 12);
    // Ends every session issued before this moment (checked in src/middleware/auth.js).
    user.password_changed_at = new Date().toISOString();
    // Track provenance so TOTP enrollment tickets can be issued after a CLI reset.
    user.password_changed_by = "operator:cli";
    // Invalidate all existing sessions by bumping the epoch.
    user.session_epoch = (user.session_epoch || 0) + 1;
    // Clear any pending TOTP enrollment or ticket — they were bound to the old password.
    user.totp_enrollment_ticket = null;
    if (user.totp?.pending) user.totp.pending = null;
    delete user.password;
    data.audit_logs = Array.isArray(data.audit_logs) ? data.audit_logs : [];
    data.audit_logs.push({
      id: `audit_password_reset_${Date.now()}`,
      actor_id: "operator:cli",
      entity_type: "user",
      entity_id: user.id,
      action: "ADMIN_PASSWORD_RESET",
      old_values: null,
      new_values: { email: user.email },
      created_at: new Date().toISOString()
    });

    await client.query("UPDATE store SET data = $1 WHERE id = 'main'", [data]);
    await client.query("COMMIT");
    console.log(`Admin password reset successfully for ${email}.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
