import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { secureConnectionString } from "../src/pool.js";

test("application pool requires PostgreSQL certificate validation", () => {
  const source = readFileSync(new URL("../src/pool.js", import.meta.url), "utf8");

  assert.match(source, /ssl:\s*\{\s*rejectUnauthorized:\s*true\s*\}/);
});

test("database URL cannot override the reviewed TLS policy", () => {
  const connectionString = secureConnectionString(
    "postgresql://user:password@db.example.com:5432/orac?sslmode=require&sslrootcert=ignored&channel_binding=require"
  );
  const url = new URL(connectionString);

  assert.equal(url.searchParams.has("sslmode"), false);
  assert.equal(url.searchParams.has("sslrootcert"), false);
  assert.equal(url.searchParams.get("channel_binding"), "require");
});
