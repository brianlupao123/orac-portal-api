import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import bcrypt from "bcrypt";
import { pool, ensureTableExists } from "../src/pool.js";

try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password || password.length < 16 || Buffer.byteLength(password) > 72) {
    throw new Error("Set BOOTSTRAP_ADMIN_EMAIL and a unique 16-72 byte BOOTSTRAP_ADMIN_PASSWORD before importing.");
  }
  if (password === "password123") throw new Error("Demo passwords are forbidden.");
  const input = resolve(process.argv[2] || "data/db.json");
  const data = JSON.parse(readFileSync(input, "utf8"));
  const admin = data.users?.find((user) => user.email?.toLowerCase() === email && user.role === "Admin");
  if (!admin) throw new Error("Bootstrap email must belong to an Admin in the import data.");
  for (const user of data.users) {
    delete user.password;
    delete user.password_hash;
    user.is_active = false;
  }
  admin.is_active = true;
  admin.password_hash = await bcrypt.hash(password, 12);
  await ensureTableExists();
  const inserted = await pool.query("INSERT INTO store (id, data) VALUES ('main', $1) ON CONFLICT (id) DO NOTHING RETURNING id", [data]);
  if (!inserted.rowCount) {
    console.log("Existing database preserved. No records changed.");
  } else {
    console.log(`Imported ${data.users.length} users. Only ${email} is enabled; create other accounts through controlled administration.`);
  }
} catch (error) {
  console.error("Seed failed:", error.code || error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
