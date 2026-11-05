import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDb, SCHEMA_COLLECTIONS, DEFAULT_COMPANY_PROFILE } from "../src/store.js";

test("normalizeDb with NODE_ENV=production and seedDemoRecords=false normalizes cleanly without seeding", () => {
  const origEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const raw = {};
    const normalized = normalizeDb(raw, { seedDemoRecords: false });
    
    // Schema collections are initialized as empty arrays
    for (const key of SCHEMA_COLLECTIONS) {
      assert.ok(Array.isArray(normalized[key]), `Collection ${key} should be an array`);
      assert.equal(normalized[key].length, 0, `Collection ${key} should be empty in production`);
    }

    // Company profile is populated from DEFAULT_COMPANY_PROFILE without touching seedData
    assert.ok(normalized.company_profile);
    assert.equal(normalized.company_profile.company_name, DEFAULT_COMPANY_PROFILE.company_name);
    assert.deepEqual(normalized.company_profile.v5_commercial_policy, DEFAULT_COMPANY_PROFILE.v5_commercial_policy);
    assert.equal(normalized.users.length, 0, "No demo users should be seeded");
  } finally {
    process.env.NODE_ENV = origEnv;
  }
});

test("normalizeDb with NODE_ENV=production and seedDemoRecords=true strictly throws an Error", () => {
  const origEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(
      () => normalizeDb({}, { seedDemoRecords: true }),
      /Demo records cannot be seeded in production environments/
    );
  } finally {
    process.env.NODE_ENV = origEnv;
  }
});

test("normalizeDb with NODE_ENV=production default options defaults seedDemoRecords to false", () => {
  const origEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const db = {};
    assert.doesNotThrow(() => normalizeDb(db));
    assert.equal(db.users.length, 0);
  } finally {
    process.env.NODE_ENV = origEnv;
  }
});

test("normalizeDb with NODE_ENV=development and seedDemoRecords=true seeds demo collections", () => {
  const origEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    const db = {};
    normalizeDb(db, { seedDemoRecords: true });
    assert.ok(db.users.length > 0, "Users should be seeded in development");
    assert.ok(db.suppliers.length > 0, "Suppliers should be seeded in development");
    assert.ok(db.stock_items.length > 0, "Stock items should be seeded in development");
  } finally {
    process.env.NODE_ENV = origEnv;
  }
});
