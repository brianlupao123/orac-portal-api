// tests/pilotFixtureLoaderValidation.test.js
//
// Real, automated tests for validateRecordsAgainstTarget() — the function
// that makes "rejected" a genuine, non-vacuous report category in
// load-pilot-fixture.mjs (as opposed to "skipped", which is decided purely
// by build-fixture-records.mjs before any database is involved).
//
// No I/O: this only ever calls the exported pure functions.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildFixtureRecords, validateRecordsAgainstTarget } from "../scripts/pilot-fixture/build-fixture-records.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scenario = JSON.parse(readFileSync(join(__dirname, "../scripts/pilot-fixture/fixture-scenarios.source.json"), "utf8"));

function emptyDbFor(records) {
  return Object.fromEntries(Object.keys(records).map((k) => [k, []]));
}

test("validateRecordsAgainstTarget accepts every fixture record against an empty target db", () => {
  const { records } = buildFixtureRecords(scenario);
  const { accepted, rejected } = validateRecordsAgainstTarget(emptyDbFor(records), records);

  assert.equal(rejected.length, 0, "nothing should be rejected against a clean, empty target");
  for (const [collection, candidateRecords] of Object.entries(records)) {
    assert.equal(accepted[collection].length, candidateRecords.length, `all ${collection} candidates should be accepted`);
  }
});

test("validateRecordsAgainstTarget cascades rejection when a referenced client is missing from the target", () => {
  const { records } = buildFixtureRecords(scenario);
  const db = emptyDbFor(records);

  const brokenRecords = structuredClone(records);
  const removedClientId = brokenRecords.clients.find((c) => c.fixture_source_id === "UAT-CLI-02").id;
  brokenRecords.clients = brokenRecords.clients.filter((c) => c.id !== removedClientId);

  const { accepted, rejected } = validateRecordsAgainstTarget(db, brokenRecords);

  assert.ok(rejected.length > 0, "at least the dependents of the removed client must be rejected");
  assert.ok(
    rejected.some((r) => r.collection === "quotes" && r.reason.includes(removedClientId)),
    "a quote referencing the removed client must be rejected, with the missing id named in the reason"
  );
  assert.equal(
    accepted.quotes.some((q) => q.client_id === removedClientId),
    false,
    "no accepted quote may reference the removed client"
  );
  // Every quote_line whose quote was rejected must itself be rejected too
  // (cascading), never silently accepted as an orphan.
  const acceptedQuoteIds = new Set(accepted.quotes.map((q) => q.id));
  for (const line of accepted.quote_lines) {
    assert.ok(acceptedQuoteIds.has(line.quotation_id), `accepted quote_line ${line.id} must reference an accepted quote`);
  }
});

test("validateRecordsAgainstTarget accepts a fixture record that references an existing NON-fixture record already in the target", () => {
  const { records } = buildFixtureRecords(scenario);
  const db = emptyDbFor(records);
  // Simulate a real, pre-existing (non-fixture) client already in the
  // target db, then point one fixture quote at it instead of a fixture
  // client — this must be accepted, proving the validator checks against
  // the live target db, not only against other fixture records.
  db.clients.push({ id: "real_client_not_fixture", name: "Real Non-Fixture Client" });
  const patched = structuredClone(records);
  patched.quotes[0] = { ...patched.quotes[0], client_id: "real_client_not_fixture" };

  const { accepted, rejected } = validateRecordsAgainstTarget(db, patched);

  assert.equal(rejected.some((r) => r.id === patched.quotes[0].id), false);
  assert.ok(accepted.quotes.some((q) => q.id === patched.quotes[0].id && q.client_id === "real_client_not_fixture"));
});
