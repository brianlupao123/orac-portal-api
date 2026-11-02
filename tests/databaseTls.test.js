import assert from "node:assert/strict";
import test from "node:test";
import { sslConfig, secureConnectionString } from "../src/pool.js";

// ---------------------------------------------------------------------------
// Behavioural tests for sslConfig()
// The function is called at pool creation time. These tests exercise the
// actual output, not the source text.
// ---------------------------------------------------------------------------

test("localhost with sslmode=disable disables SSL", () => {
  const result = sslConfig("postgresql://user:pw@localhost:5432/orac?sslmode=disable");
  assert.equal(result, false);
});

test("127.0.0.1 with sslmode=disable disables SSL", () => {
  const result = sslConfig("postgresql://user:pw@127.0.0.1:5432/orac?sslmode=disable");
  assert.equal(result, false);
});

test("IPv6 loopback ::1 with sslmode=disable disables SSL", () => {
  const result = sslConfig("postgresql://user:pw@[::1]:5432/orac?sslmode=disable");
  assert.equal(result, false);
});

test("hosted URL with sslmode=disable still enforces rejectUnauthorized", () => {
  const result = sslConfig("postgresql://user:pw@db.neon.tech:5432/orac?sslmode=disable");
  assert.deepEqual(result, { rejectUnauthorized: true });
});

test("hosted URL without sslmode=disable enforces rejectUnauthorized", () => {
  const result = sslConfig("postgresql://user:pw@db.neon.tech:5432/orac");
  assert.deepEqual(result, { rejectUnauthorized: true });
});

test("undefined DATABASE_URL enforces rejectUnauthorized", () => {
  const result = sslConfig(undefined);
  assert.deepEqual(result, { rejectUnauthorized: true });
});

test("localhost without sslmode=disable enforces rejectUnauthorized", () => {
  const result = sslConfig("postgresql://user:pw@localhost:5432/orac");
  assert.deepEqual(result, { rejectUnauthorized: true });
});

// ---------------------------------------------------------------------------
// Existing test — URL stripping policy (secureConnectionString)
// ---------------------------------------------------------------------------

test("database URL cannot override the reviewed TLS policy", () => {
  const connectionString = secureConnectionString(
    "postgresql://user:password@db.example.com:5432/orac?sslmode=require&sslrootcert=ignored&channel_binding=require"
  );
  const url = new URL(connectionString);

  assert.equal(url.searchParams.has("sslmode"), false);
  assert.equal(url.searchParams.has("sslrootcert"), false);
  assert.equal(url.searchParams.get("channel_binding"), "require");
});
