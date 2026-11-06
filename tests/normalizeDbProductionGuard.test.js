import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDb, SCHEMA_COLLECTIONS, DEFAULT_COMPANY_PROFILE } from "../src/store.js";
import { computeLabourCost } from "../src/payroll.js";
import { effectivePermissionRoles, roles } from "../src/permissions.js";

function withEnv(envObj, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(envObj)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("normalizeDb with NODE_ENV=production and seedDemoRecords=false normalizes cleanly without seeding", () => {
  withEnv({ NODE_ENV: "production" }, () => {
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
    // Ensure client_signature_methods is cloned and not a shared array reference
    assert.notEqual(normalized.company_profile.v5_commercial_policy.client_signature_methods, DEFAULT_COMPANY_PROFILE.v5_commercial_policy.client_signature_methods);
    assert.equal(normalized.users.length, 0, "No demo users should be seeded");
  });
});

test("normalizeDb with NODE_ENV=production and seedDemoRecords=true strictly throws an Error", () => {
  withEnv({ NODE_ENV: "production" }, () => {
    assert.throws(
      () => normalizeDb({}, { seedDemoRecords: true }),
      /Demo records cannot be seeded in production environments/
    );
  });
});

test("normalizeDb with NODE_ENV=production default options defaults seedDemoRecords to false", () => {
  withEnv({ NODE_ENV: "production" }, () => {
    const db = {};
    assert.doesNotThrow(() => normalizeDb(db));
    assert.equal(db.users.length, 0);
  });
});

test("normalizeDb with NODE_ENV=development and seedDemoRecords=true seeds demo collections", () => {
  withEnv({ NODE_ENV: "development" }, () => {
    const db = {};
    normalizeDb(db, { seedDemoRecords: true });
    assert.ok(db.users.length > 0, "Users should be seeded in development");
    assert.ok(db.suppliers.length > 0, "Suppliers should be seeded in development");
    assert.ok(db.stock_items.length > 0, "Stock items should be seeded in development");
  });
});

test("computeLabourCost fail-closed: rejects missing, zero, negative rates and invalid multipliers", () => {
  const payroll = {
    employees: [
      { technician_id: "t1", full_name: "John Doe", trade: "Fitter", normal_hours: 8, overtime_15_hours: 2, overtime_20_hours: 0 }
    ]
  };

  // Missing rate
  assert.throws(() => computeLabourCost(payroll, {}), /Missing wage rate for technician/);

  // Default key is dropped (fails closed)
  assert.throws(() => computeLabourCost(payroll, { default: 10 }), /Missing wage rate for technician/);

  // Zero rate
  assert.throws(() => computeLabourCost(payroll, { Fitter: 0 }), /must be finite numbers greater than zero/);

  // Negative rate
  assert.throws(() => computeLabourCost(payroll, { Fitter: -5 }), /must be finite numbers greater than zero/);

  // NaN multiplier
  assert.throws(() => computeLabourCost(payroll, { Fitter: 10 }, { ot_15_multiplier: NaN }), /Invalid overtime multipliers/);
  assert.throws(() => computeLabourCost(payroll, { Fitter: 10 }, { ot_15_multiplier: -1.5 }), /Invalid overtime multipliers/);

  // Valid rates calculate correctly
  const result = computeLabourCost(payroll, { Fitter: 10 }, { ot_15_multiplier: 1.5, ot_20_multiplier: 2.0 });
  assert.equal(result.total_cost, 110.00); // 8*10 = 80, 2*15 = 30
});

test("Production guard: TIMESHEET_SALES_ACCESS cannot grant register approval in production", () => {
  withEnv({ NODE_ENV: "production", TIMESHEET_SALES_ACCESS: "enabled" }, () => {
    assert.throws(
      () => effectivePermissionRoles("reviewWorksheetRegister"),
      /cannot be enabled in production environments/
    );
  });
});
