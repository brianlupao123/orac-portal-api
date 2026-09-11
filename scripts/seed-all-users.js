import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import bcrypt from "bcrypt";
import { pool, ensureTableExists } from "../src/pool.js";

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
