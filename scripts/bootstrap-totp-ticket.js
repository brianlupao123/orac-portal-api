import crypto from "node:crypto";
import pg from "pg";
import { secureConnectionString } from "../src/dbUrl.js";
import { digestOpaque } from "../src/totp.js";

const { Pool } = pg;

// Usage:
//   ORAC_TOTP_ENCRYPTION_KEY=<key> DATABASE_URL=<url> BOOTSTRAP_ADMIN_EMAIL=<email> \
//     node scripts/bootstrap-totp-ticket.js
//
// Generates a TOTP enrollment ticket for an Admin account, bypassing the
// normal Admin-to-Admin issuance rule. The ticket is issued by "operator:cli",
// which is not a real user ID, so no Admin is marked as the issuer of their
// own password or setup link. The Admin then uses the ticket on the public
// enrollment route with their own password.
//
// This script must be run from a trusted server console by an authorized
// operator. It writes an audit log entry with action TOTP_ENROLLMENT_TICKET_ISSUED.

const TICKET_TTL_MS = 30 * 60_000; // 30 minutes, matches totpController.js

const databaseUrl = process.env.DATABASE_URL;
const email = String(process.env.BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase();

if (!databaseUrl) throw new Error("DATABASE_URL is required.");
if (!email) throw new Error("BOOTSTRAP_ADMIN_EMAIL is required.");

// Validate the encryption key is configured (enrollment start will need it).
// This import will throw if the key is missing or malformed.
import { validateTotpEncryptionKey } from "../src/totp.js";
validateTotpEncryptionKey();

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
    const user = data.users?.find((item) => item.is_active && item.email?.toLowerCase() === email);
    if (!user) throw new Error(`No active user found for ${email}.`);
    if (user.role !== "Admin") throw new Error("This script may issue tickets only for Admin accounts.");
    if (!user.password_hash) throw new Error("The account has no password set.");
    if (user.totp?.secret) throw new Error("The account already has an enrolled authenticator.");

    // Generate the ticket — same format as totpController.issueTotpEnrollmentTicket.
    const ticket = crypto.randomBytes(32).toString("base64url");
    user.totp_enrollment_ticket = {
      digest: digestOpaque(ticket),
      expires_at: Date.now() + TICKET_TTL_MS,
      issued_by: "operator:cli",
      password_digest: digestOpaque(user.password_hash),
      session_epoch: user.session_epoch || 0,
      role: user.role,
      email: String(user.email || "").trim().toLowerCase()
    };
    // Revoke any unfinished enrollment — same as totpController.
    if (user.totp?.pending) user.totp.pending = null;
    if (user.totp_factor_reset_request) user.totp_factor_reset_request = null;

    data.audit_logs = Array.isArray(data.audit_logs) ? data.audit_logs : [];
    data.audit_logs.push({
      id: `audit_totp_bootstrap_${Date.now()}`,
      actor_id: "operator:cli",
      entity_type: "user",
      entity_id: user.id,
      action: "TOTP_ENROLLMENT_TICKET_ISSUED",
      old_values: null,
      new_values: { id: user.id },
      created_at: new Date().toISOString()
    });

    await client.query("UPDATE store SET data = $1 WHERE id = 'main'", [data]);
    await client.query("COMMIT");

    // Show the ticket exactly once. The operator must deliver it securely.
    console.log(`\nTOTP enrollment ticket issued for ${email}.`);
    console.log(`Expires in ${TICKET_TTL_MS / 60_000} minutes.\n`);
    console.log(`TICKET: ${ticket}\n`);
    console.log("Deliver this ticket to the Admin through a secure, verified channel.");
    console.log("The Admin must use it with their current password on the enrollment route.");
    console.log("This ticket is shown once and cannot be retrieved again.\n");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
