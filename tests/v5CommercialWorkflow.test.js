import assert from "node:assert/strict";
import test from "node:test";
import {
  V5_MASTER_FLAG, getV5Policy, hoursToHundredths, hundredthsToHours,
  signatureHash, signatureRefusal, sheetIsVerified, validateV5PolicyPatch
} from "../src/v5CommercialWorkflow.js";

const db = { company_profile: { v5_commercial_policy: { client_signature_methods: ["paper_attested"] } } };
const sheet = { sheet_id: "sheet-1", dispatch_card_id: "dispatch-1", worker_id: "worker-1", work_date: "2026-10-12", hours_hundredths: 800, buckets: { normal: 800 } };

test("V5 policy is dark and defaults do not choose a client signing method", () => {
  const old = process.env[V5_MASTER_FLAG];
  delete process.env[V5_MASTER_FLAG];
  assert.deepEqual(getV5Policy({ company_profile: {} }).client_signature_methods, []);
  if (old !== undefined) process.env[V5_MASTER_FLAG] = old;
});

test("new V5 hours use fixed hundredths", () => {
  assert.equal(hoursToHundredths(8), 800);
  assert.equal(hoursToHundredths("8.25"), 825);
  assert.equal(hundredthsToHours(825), 8.25);
  assert.throws(() => hoursToHundredths(8.257));
  assert.throws(() => hoursToHundredths(25));
});

test("signature evidence must match the current hours hash and allowed method", () => {
  const old = process.env[V5_MASTER_FLAG];
  process.env[V5_MASTER_FLAG] = "enabled";
  const hash = signatureHash(sheet);
  const signature = { hours_hash: hash, signer_ref: "orac-supervisor-1", evidence_ref: "paper-123", custodian_user_id: "orac-supervisor-1" };
  assert.equal(signatureRefusal(db, "paper_attested", hash, signature), null);
  assert.match(signatureRefusal(db, "paper_attested", `${hash}x`, signature), /current hours/);
  assert.match(signatureRefusal(db, "electronic_otp", hash, signature), /not enabled/);
  if (old === undefined) delete process.env[V5_MASTER_FLAG]; else process.env[V5_MASTER_FLAG] = old;
});

test("a V5 sheet is verified only when both signatures bind to the same hash", () => {
  const old = process.env[V5_MASTER_FLAG];
  process.env[V5_MASTER_FLAG] = "enabled";
  const hash = signatureHash(sheet);
  const evidence = { hours_hash: hash, signer_ref: "signer", evidence_ref: "scan-1", custodian_user_id: "sup-1" };
  assert.equal(sheetIsVerified(db, { ...sheet, client_signature_method: "paper_attested", signatures: { orac: evidence, client: evidence } }), true);
  assert.equal(sheetIsVerified(db, { ...sheet, client_signature_method: "paper_attested", signatures: { orac: evidence, client: { ...evidence, hours_hash: "stale" } } }), false);
  if (old === undefined) delete process.env[V5_MASTER_FLAG]; else process.env[V5_MASTER_FLAG] = old;
});

test("V5 policy only accepts explicit pilot values", () => {
  assert.deepEqual(validateV5PolicyPatch({ client_signature_methods: ["paper_attested"], tax_rate: null }), []);
  assert.equal(validateV5PolicyPatch({ client_signature_methods: ["email"] }).length, 1);
  assert.equal(validateV5PolicyPatch({ invoice_self_approval: "anything" }).length, 1);
});
