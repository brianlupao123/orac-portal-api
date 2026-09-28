#!/usr/bin/env node
// scripts/pilot-fixture/load-pilot-fixture.mjs
//
// Guarded, idempotent, DRY-RUN-BY-DEFAULT loader for the ORAC-IOS one-month
// pilot fixture.
//
// Default (no flags): DRY RUN. Reads the target store, computes exactly what
// a real load would do (inserted / reused / skipped / rejected, per
// collection), prints it, and writes NOTHING. Safe to run at any time with
// no environment variables set, except that it still refuses outright
// against a production-configured process (see below) — a dry run never
// reads production data either.
//
// Actually writing requires --apply AND every one of the following:
//   - NODE_ENV is not "production" (config.isProduction is false)
//   - ORAC_FIXTURE_MODE=PILOT_FIXTURE is set (the "explicit fixture flag")
//   - ORAC_FIXTURE_TARGET=non-production is set (the "explicit non-production target")
//   - --confirm=LOAD_ORAC_PILOT_FIXTURE is passed (exact match)
//   - if STORE_DRIVER=postgres: --allow-postgres is also passed
//
// The four report categories are genuinely distinct, not two names for the
// same thing:
//   inserted = fixture record written this run (id was not already present)
//   reused   = fixture record already present in the target (by id) — no-op
//   skipped  = never became a candidate at all; build-fixture-records.mjs
//              itself decided not to map it (see the `gaps` list — printed
//              separately, these are counted per area, not per record)
//   rejected = WAS a candidate, but failed validation against the actual
//              target database (a foreign key it depends on does not
//              resolve there) — see validateRecordsAgainstTarget()
//
// Usage:
//   node scripts/pilot-fixture/load-pilot-fixture.mjs                 # dry run
//   ORAC_FIXTURE_MODE=PILOT_FIXTURE ORAC_FIXTURE_TARGET=non-production \
//     node scripts/pilot-fixture/load-pilot-fixture.mjs --apply --confirm=LOAD_ORAC_PILOT_FIXTURE

import { config } from "../../src/config.js";
import { buildFixtureRecords, validateRecordsAgainstTarget } from "./build-fixture-records.mjs";

const REQUIRED_CONFIRM = "LOAD_ORAC_PILOT_FIXTURE";

function refuse(message) {
  console.error(`Refusing to run: ${message}`);
  process.exitCode = 1;
}

async function loadScenario() {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(join(__dirname, "fixture-scenarios.source.json"), "utf8"));
}

async function openStore() {
  const storeModule = config.storeDriver === "postgres"
    ? await import("../../src/postgresStore.js")
    : await import("../../src/store.js");
  const store = config.storeDriver === "postgres"
    ? storeModule.createStore()
    : storeModule.createStore(config.jsonDbPath);
  return { store };
}

function printReport(title, report, gaps) {
  console.log(`\n${title}`);
  for (const [collection, counts] of Object.entries(report)) {
    console.log(
      `  ${collection.padEnd(24)} inserted=${counts.inserted}  reused=${counts.reused}  ` +
      `rejected=${counts.rejected}  (candidates=${counts.candidates})`
    );
  }
  const skippedByArea = {};
  for (const g of gaps) skippedByArea[g.area] = (skippedByArea[g.area] || 0) + 1;
  const totalSkipped = gaps.length;
  console.log(`\n  skipped (never became a candidate — see GAPS_REPORT.md): ${totalSkipped} items across ${Object.keys(skippedByArea).length} areas`);
  for (const [area, count] of Object.entries(skippedByArea)) console.log(`    - ${area}: ${count}`);
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const confirmArg = args.find((a) => a.startsWith("--confirm="));
  const confirm = confirmArg ? confirmArg.slice("--confirm=".length) : "";
  const allowPostgres = args.includes("--allow-postgres");

  // This check applies unconditionally — dry run included. A dry run never
  // even reads a production-configured process.
  if (config.isProduction) {
    return refuse(`NODE_ENV=production. This script never runs against a production-configured process, no matter what flags are passed, not even a dry run.`);
  }

  if (apply) {
    if (process.env.ORAC_FIXTURE_MODE !== "PILOT_FIXTURE") return refuse(`--apply requires ORAC_FIXTURE_MODE=PILOT_FIXTURE (explicit fixture flag).`);
    if (process.env.ORAC_FIXTURE_TARGET !== "non-production") return refuse(`--apply requires ORAC_FIXTURE_TARGET=non-production (explicit non-production target declaration).`);
    if (confirm !== REQUIRED_CONFIRM) return refuse(`--apply requires --confirm=${REQUIRED_CONFIRM}`);
    if (config.storeDriver === "postgres" && !allowPostgres) {
      return refuse(`STORE_DRIVER=postgres requires --allow-postgres. Point DATABASE_URL at an isolated pilot/UAT database before adding that flag — this script cannot verify which database DATABASE_URL points at.`);
    }
  }

  console.log(apply ? "APPLY mode — guards passed. This run WILL write." : "DRY RUN — nothing will be written. Pass --apply (plus the required flags) to actually load.");
  console.log(`  store driver: ${config.storeDriver}`);
  if (config.storeDriver === "json") console.log(`  json db path: ${config.jsonDbPath}`);

  const scenario = await loadScenario();
  console.log(`  fixture spec: ${scenario.meta.name} (${scenario.meta.version})`);

  const { records, gaps } = buildFixtureRecords(scenario);
  const { store } = await openStore();
  const { db, release } = await store.read();

  try {
    const { accepted, rejected } = validateRecordsAgainstTarget(db, records);
    const rejectedByCollection = {};
    for (const r of rejected) (rejectedByCollection[r.collection] ||= []).push(r);

    const report = {};
    const toInsert = {};
    for (const [collection, candidateRecords] of Object.entries(records)) {
      const existingIds = new Set((db[collection] || []).map((r) => r.id));
      const acceptedRecords = accepted[collection] || [];
      const willInsert = acceptedRecords.filter((r) => !existingIds.has(r.id));
      const willReuse = acceptedRecords.filter((r) => existingIds.has(r.id));
      toInsert[collection] = willInsert;
      report[collection] = {
        candidates: candidateRecords.length,
        inserted: willInsert.length,
        reused: willReuse.length,
        rejected: (rejectedByCollection[collection] || []).length
      };
    }

    printReport(apply ? "Inserted / reused / rejected per collection:" : "Would insert / would reuse / would reject per collection:", report, gaps);

    if (rejected.length) {
      console.log(`\nRejected records (${rejected.length}) — reason each was refused:`);
      for (const r of rejected) console.log(`  - ${r.collection}/${r.id} (${r.fixture_source_id}): ${r.reason}`);
    }

    if (!apply) {
      console.log(`\nDry run complete. No writes were made. Re-run with --apply (plus ORAC_FIXTURE_MODE, ORAC_FIXTURE_TARGET, --confirm) to actually load.`);
      if (config.storeDriver === "postgres") await store.release(release);
      else if (release) store.release(release);
      return;
    }

    for (const [collection, willInsert] of Object.entries(toInsert)) {
      if (!Array.isArray(db[collection])) db[collection] = [];
      db[collection].push(...willInsert);
    }

    // Re-derive each fixture PO's requires_amendment flag from the actually
    // loaded timesheets/materials, using the app's own recalculateVariance —
    // never asserted, always recomputed against what is really in the db.
    for (const po of accepted.purchase_orders || []) {
      store.recalculateVariance(db, po.id);
    }

    store.audit(
      db,
      null,
      "system",
      "pilot_fixture",
      "PILOT_FIXTURE_LOADED",
      null,
      { fixture_version: scenario.meta.version, report, rejected_count: rejected.length, gap_count: gaps.length }
    );

    if (config.storeDriver === "postgres") await store.write(db, release);
    else store.write(db, release);

    console.log(`\n${gaps.length} mapping gaps recorded (skipped, never candidates) — see GAPS_REPORT.md for the full list.`);
    console.log("\nDone. Run verify-pilot-fixture.mjs next.");
  } catch (error) {
    if (config.storeDriver === "postgres") await store.release(release);
    else if (release) store.release(release);
    throw error;
  }
}

main().catch((error) => {
  console.error("Fixture load failed:", error.message);
  process.exitCode = 1;
});
