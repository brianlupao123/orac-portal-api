import assert from "node:assert/strict";
import test from "node:test";
import {
  createV5ClientSupervisorContact, listV5ClientSupervisorContacts, withdrawV5ClientSupervisorContact,
  getV5SignatureState, recordV5PaperSignature, confirmV5Timesheet
} from "../src/controllers/v5SignatureController.js";
import { getV5BillingReadiness } from "../src/controllers/timesheetWorkflowController.js";
import { V5ClientSupervisorContactSchema } from "../src/v5SignatureSchemas.js";
import { effectivePermissionRoles } from "../src/permissions.js";
import { canonicalHoursByQuoteLine } from "../src/v5CommercialWorkflow.js";
import {
  isV5Verified, v5SignatureState, v5TimesheetHash, v5SupervisorAssignmentRefusal, paperEvidenceMissing, stableStringify
} from "../src/v5SignatureEvidence.js";
import { database, sheet, call, contactBody, paperBody, withV5, HEX64 } from "./helpers/v5SignatureFixture.js";

const record = (db, overrides, contactId) => {
  const contact = (contactId && { id: contactId }) || db.v5_client_supervisor_contacts[0] || call(createV5ClientSupervisorContact, db, "sales-1", { params: { id: "job-1" }, body: contactBody() }).body.data;
  return call(recordV5PaperSignature, db, "sales-1", { params: { id: "ws-1" }, body: paperBody(contact.id, overrides) });
};
const confirm = (db, user = "sup-1", overrides = {}) => {
  const state = v5SignatureState(db, db.field_worksheets[0]);
  return call(confirmV5Timesheet, db, user, { params: { id: "ws-1" }, body: { evidence_id: state.evidence?.id || "none", hours_hash: state.current_hash, attest: true, ...overrides } });
};
const verifiedDb = () => { const db = database(); assert.equal(record(db).statusCode, 201); assert.equal(confirm(db).statusCode, 201); return db; };

// ---- dark by default / legacy ------------------------------------------------
test("every V5 signature endpoint is dark and creates nothing while V5 is off", () => withV5(() => {
  const db = database();
  const before = JSON.stringify(db);
  const results = [
    call(createV5ClientSupervisorContact, db, "sales-1", { params: { id: "job-1" }, body: contactBody() }),
    call(listV5ClientSupervisorContacts, db, "sales-1", { params: { id: "job-1" } }),
    call(withdrawV5ClientSupervisorContact, db, "sales-1", { params: { id: "x" } }),
    call(getV5SignatureState, db, "sales-1", { params: { id: "ws-1" } }),
    call(recordV5PaperSignature, db, "sales-1", { params: { id: "ws-1" }, body: paperBody("c") }),
    call(confirmV5Timesheet, db, "sup-1", { params: { id: "ws-1" }, body: { evidence_id: "e", hours_hash: HEX64, attest: true } })
  ];
  for (const res of results) { assert.equal(res.statusCode, 409); assert.equal(res.body.code, "FEATURE_DISABLED"); }
  assert.equal(JSON.stringify(db), before);
}, false));

test("with V5 off nothing is V5-verified and legacy permissions and aggregation are unchanged", () => {
  const db = withV5(() => verifiedDb());
  withV5(() => assert.equal(isV5Verified(db, db.field_worksheets[0]), true));
  withV5(() => assert.equal(isV5Verified(db, db.field_worksheets[0]), false), false);
  assert.deepEqual(effectivePermissionRoles("captureTimesheetPaper"), ["Admin", "Sales"]);
  assert.deepEqual(effectivePermissionRoles("reviewWorksheet"), ["Admin", "Operations", "Supervisor"]);
  assert.deepEqual(effectivePermissionRoles("acknowledgeWorksheet"), ["Client Viewer"]);
  // the earlier legacy-status aggregation is untouched and still ignores V5 evidence
  const legacy = { field_worksheets: [{ id: "a", dispatch_card_id: "job-1", status: "Supervisor_Approved", hours: 4, quote_line_id: "line-1" }] };
  assert.deepEqual(canonicalHoursByQuoteLine(legacy, "job-1").by_quote_line, { "line-1": { hours: 4, source_ids: ["a"] } });
});

// ---- permissions ---------------------------------------------------------------
test("only Sales/Admin record contacts and paper evidence; only the assigned Supervisor role confirms", () => withV5(() => {
  const db = database();
  for (const user of ["tech-1", "ops-1", "fin-1", "sup-1", "client-1"]) {
    assert.throws(() => call(createV5ClientSupervisorContact, db, user, { params: { id: "job-1" }, body: contactBody() }), /cannot perform/);
    assert.throws(() => call(recordV5PaperSignature, db, user, { params: { id: "ws-1" }, body: paperBody("c") }), /cannot perform/);
  }
  assert.equal(db.v5_client_supervisor_contacts.length, 0);
  assert.equal(record(db).statusCode, 201);
  for (const user of ["admin-1", "sales-1", "sales-2", "ops-1", "tech-1", "fin-1", "client-1"]) {
    assert.throws(() => confirm(db, user), /cannot perform/);
  }
  assert.equal(db.v5_supervisor_confirmations.length, 0);
  assert.throws(() => call(getV5SignatureState, db, "tech-1", { params: { id: "ws-1" } }), /cannot perform/);
  assert.throws(() => call(getV5SignatureState, db, "ops-1", { params: { id: "ws-1" } }), /cannot perform/);
}));

// ---- client-site Supervisor contact: evidence only -------------------------------
test("the client Supervisor is a named contact only: no account, role, login or OTP can be supplied or created", () => withV5(() => {
  const db = database();
  for (const extra of [{ password: "x" }, { otp: "123456" }, { role: "Client Viewer" }, { user_id: "client-1" }, { login: "chipo" }, { rate: 10 }]) {
    assert.equal(V5ClientSupervisorContactSchema.safeParse({ ...contactBody(), ...extra }).success, false);
    assert.equal(call(createV5ClientSupervisorContact, db, "sales-1", { params: { id: "job-1" }, body: { ...contactBody(), ...extra } }).statusCode, 400);
  }
  const users = db.users.length;
  const res = call(createV5ClientSupervisorContact, db, "sales-1", { params: { id: "job-1" }, body: contactBody({ dispatch_scoped: true }) });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.authentication, "none_evidence_only");
  assert.equal(res.body.data.quotation_id, "quote-1");
  assert.equal(res.body.data.dispatch_card_id, "job-1");
  assert.equal(db.users.length, users);
  assert.equal(JSON.stringify(res.body.data).match(/password|otp|token|role/i), null);
}));

test("a contact is scoped to its quotation and dispatch and a withdrawn contact cannot be used", () => withV5(() => {
  const db = database();
  db.quotes.push({ id: "quote-2", v5_commercial_workflow: true, created_by: "sales-1" });
  db.dispatch_cards.push({ id: "job-2", quotation_id: "quote-2", assigned_supervisor_id: "sup-1" });
  const foreign = call(createV5ClientSupervisorContact, db, "sales-1", { params: { id: "job-2" }, body: contactBody() }).body.data;
  const scoped = call(createV5ClientSupervisorContact, db, "sales-1", { params: { id: "job-1" }, body: contactBody({ dispatch_scoped: true }) }).body.data;
  db.dispatch_cards.push({ id: "job-3", quotation_id: "quote-1", assigned_supervisor_id: "sup-1" });
  assert.equal(call(listV5ClientSupervisorContacts, db, "sales-1", { params: { id: "job-1" } }).body.data.length, 1);
  assert.equal(call(listV5ClientSupervisorContacts, db, "sales-1", { params: { id: "job-3" } }).body.data.length, 0);
  const wrong = call(recordV5PaperSignature, db, "sales-1", { params: { id: "ws-1" }, body: paperBody(foreign.id) });
  assert.equal(wrong.statusCode, 409); assert.equal(wrong.body.code, "CONTACT_OUT_OF_SCOPE");
  assert.equal(call(recordV5PaperSignature, db, "sales-1", { params: { id: "ws-1" }, body: paperBody("missing") }).statusCode, 409);
  assert.equal(record(db, undefined, scoped.id).statusCode, 201);
  // withdraw: a later sheet cannot use it, the stored evidence keeps its snapshot
  const snapshot = JSON.stringify(db.v5_paper_signatures[0].client_supervisor_contact);
  assert.equal(call(withdrawV5ClientSupervisorContact, db, "sales-1", { params: { id: scoped.id } }).statusCode, 200);
  assert.equal(JSON.stringify(db.v5_paper_signatures[0].client_supervisor_contact), snapshot);
  db.field_worksheets.push(sheet({ id: "ws-9", work_date: "2026-10-06", technician_id: "tech-9", worker_name: "Other" }));
  const withdrawn = call(recordV5PaperSignature, db, "sales-1", { params: { id: "ws-9" }, body: paperBody(scoped.id) });
  assert.equal(withdrawn.statusCode, 409); assert.equal(withdrawn.body.code, "CONTACT_WITHDRAWN");
}));

// ---- paper data completeness -------------------------------------------------------
test("incomplete or untrue paper evidence is refused and nothing is stored", () => withV5(() => {
  const db = database();
  const contact = call(createV5ClientSupervisorContact, db, "sales-1", { params: { id: "job-1" }, body: contactBody() }).body.data;
  const bodyOf = (o) => paperBody(contact.id, o);
  const cases = [
    { worker_signed_on_paper: false }, { client_supervisor_signed_on_paper: false }, { paper_attestation: false },
    { worker_signed_on_paper: undefined }, { client_supervisor_signed_on_paper: undefined }, { paper_attestation: undefined },
    { evidence_reference: "" }, { source_channel: "" }, { custodian_user_id: "" }, { received_date: "" }, { received_date: "06/10/2026" },
    { scan_hash: "" }, { scan_hash: "abc" }, { worker_name_on_paper: "" }, { client_supervisor_name_on_paper: "" }, { client_supervisor_contact_id: "" },
    { rate: 25 }, { amount: 1 }
  ];
  for (const overrides of cases) {
    const res = call(recordV5PaperSignature, db, "sales-1", { params: { id: "ws-1" }, body: bodyOf(overrides) });
    assert.equal(res.statusCode, 400, JSON.stringify(overrides));
  }
  assert.equal(call(recordV5PaperSignature, db, "sales-1", { params: { id: "ws-1" }, body: bodyOf({ custodian_user_id: "ghost" }) }).statusCode, 400);
  assert.equal(call(recordV5PaperSignature, db, "sales-1", { params: { id: "ws-1" }, body: bodyOf({ received_date: "2099-01-01" }) }).statusCode, 400);
  assert.equal(call(recordV5PaperSignature, db, "sales-1", { params: { id: "ws-1" }, body: bodyOf({ received_date: "2026-10-01" }) }).statusCode, 400);
  assert.equal(db.v5_paper_signatures.length, 0);
  // a stored record that has lost a required field is not complete evidence
  assert.equal(record(db).statusCode, 201);
  const stored = db.v5_paper_signatures[0];
  assert.deepEqual(paperEvidenceMissing(stored, db), []);
  assert.deepEqual(paperEvidenceMissing({ ...stored, scan_hash: "" }, db), ["scan_hash"]);
  assert.deepEqual(paperEvidenceMissing({ ...stored, paper: { ...stored.paper, client_supervisor_signed: false } }, db), ["client_supervisor_signed_on_paper"]);
}));

test("paper evidence needs an enabled method and a submitted, V5-linked, single-version Timesheet", () => withV5(() => {
  const off = database(); off.company_profile.v5_commercial_policy.client_signature_methods = [];
  const contact = call(createV5ClientSupervisorContact, off, "sales-1", { params: { id: "job-1" }, body: contactBody() }).body.data;
  const refused = call(recordV5PaperSignature, off, "sales-1", { params: { id: "ws-1" }, body: paperBody(contact.id) });
  assert.equal(refused.statusCode, 409); assert.equal(refused.body.code, "METHOD_NOT_ENABLED");
  for (const [patch, code] of [[{ status: "Draft" }, "NOT_SUBMITTED"], [{ status: "Returned_For_Correction" }, "NOT_SUBMITTED"], [{ timesheet_version: undefined, hours_breakdown: undefined }, "NOT_V5_TIMESHEET"],
    [{ quote_line_id: null }, "NO_QUOTE_LINE"], [{ superseded_by: "ws-2" }, "SUPERSEDED"], [{ hours: 7 }, "HOURS_MISMATCH"]]) {
    const db = database(); Object.assign(db.field_worksheets[0], patch);
    const c = call(createV5ClientSupervisorContact, db, "sales-1", { params: { id: "job-1" }, body: contactBody() }).body.data;
    const res = call(recordV5PaperSignature, db, "sales-1", { params: { id: "ws-1" }, body: paperBody(c.id) });
    assert.equal(res.statusCode, 409, code); assert.match(res.body.message, new RegExp(code));
  }
  const legacy = database(); legacy.quotes[0].v5_commercial_workflow = false;
  assert.equal(call(recordV5PaperSignature, legacy, "sales-1", { params: { id: "ws-1" }, body: paperBody("c") }).body.code, "NOT_V5_QUOTATION");
}));

// ---- hash binding ----------------------------------------------------------------------
test("the hash binds worker, date, dispatch, Normal/1.5/2.0 and total and ignores unrelated fields", () => {
  const base = sheet(); const hash = v5TimesheetHash(base);
  const changed = [
    { hours_breakdown: { normal: 7, ot_15: 1, ot_20: 0 } }, { hours_breakdown: { normal: 8, ot_15: 0, ot_20: 1 } }, { hours_breakdown: { normal: 8, ot_15: 1, ot_20: 1 } },
    { hours_breakdown: { normal: 9, ot_15: 0, ot_20: 0 } }, { work_date: "2026-10-06" }, { dispatch_card_id: "job-2" }, { technician_id: "tech-2" }, { worker_name: "Another Person" }, { id: "ws-2" }
  ];
  for (const patch of changed) assert.notEqual(v5TimesheetHash({ ...base, ...patch }), hash, JSON.stringify(patch));
  assert.equal(v5TimesheetHash({ ...base, activity: "Reworded", tools_used: "spanner", status: "Client_Acknowledged" }), hash);
  assert.equal(v5TimesheetHash({ ...base, worker_name: "  technician   ONE " }), hash);
  assert.equal(v5TimesheetHash(JSON.parse(JSON.stringify(base))), hash);
  assert.equal(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] }), stableStringify({ a: [2, { c: 2, d: 1 }], b: 1 }));
  assert.match(hash, /^[a-f0-9]{64}$/);
});

// ---- verified = paper evidence + assigned Supervisor confirmation, same hash ---------------
test("V5 verified needs both complete paper evidence and the assigned Supervisor confirmation", () => withV5(() => {
  const db = database(); const ws = db.field_worksheets[0];
  assert.equal(isV5Verified(db, ws), false);
  const early = confirm(db);
  assert.equal(early.statusCode, 409); assert.equal(early.body.code, "NO_CURRENT_PAPER_EVIDENCE");
  assert.equal(record(db).statusCode, 201);
  assert.equal(isV5Verified(db, ws), false); // paper alone is not enough
  assert.deepEqual(v5SignatureState(db, ws).reasons, ["NO_CURRENT_SUPERVISOR_CONFIRMATION"]);
  const done = confirm(db);
  assert.equal(done.statusCode, 201); assert.equal(done.body.data.verified, true);
  assert.equal(isV5Verified(db, ws), true);
  assert.equal(db.v5_supervisor_confirmations[0].evidence_id, db.v5_paper_signatures[0].id);
  assert.equal(db.v5_supervisor_confirmations[0].hours_hash, v5TimesheetHash(ws));
  assert.equal(confirm(db).body.code, "ALREADY_CONFIRMED");
  // a confirmation with no matching evidence never verifies
  const forged = database(); forged.v5_supervisor_confirmations.push({ id: "c", sheet_id: "ws-1", evidence_id: "none", hours_hash: v5TimesheetHash(forged.field_worksheets[0]), supervisor_id: "sup-1", attested: true });
  assert.equal(isV5Verified(forged, forged.field_worksheets[0]), false);
}));

// ---- assignment scope -----------------------------------------------------------------------
test("confirmation is scoped to the dispatch assignment", () => withV5(() => {
  const db = database(); assert.equal(record(db).statusCode, 201);
  const other = confirm(db, "sup-2");
  assert.equal(other.statusCode, 403);
  // a Supervisor who only appears on a linked worksheet is not the assigned ORAC Supervisor
  db.field_worksheets.push(sheet({ id: "ws-2", technician_id: "tech-2", worker_name: "Linked", supervisor_id: "sup-2" }));
  assert.equal(confirm(db, "sup-2").statusCode, 403);
  assert.equal(call(getV5SignatureState, db, "sup-2", { params: { id: "ws-1" } }).statusCode, 403);
  assert.equal(call(getV5SignatureState, db, "sup-1", { params: { id: "ws-1" } }).statusCode, 200);
  assert.equal(db.v5_supervisor_confirmations.length, 0);
  assert.equal(confirm(db, "sup-1").statusCode, 201);
}));

test("a confirmation must name the exact current hash and evidence id", () => withV5(() => {
  const db = database(); assert.equal(record(db).statusCode, 201);
  assert.equal(confirm(db, "sup-1", { hours_hash: HEX64 }).body.code, "STALE_HASH");
  assert.equal(confirm(db, "sup-1", { evidence_id: "other" }).body.code, "STALE_HASH");
  assert.equal(confirm(db, "sup-1", { attest: false }).statusCode, 400);
  assert.equal(db.v5_supervisor_confirmations.length, 0);
}));

// ---- Sales / Supervisor separation ----------------------------------------------------------
test("the Sales owner of a quotation can neither be its Supervisor nor confirm its Timesheets", () => withV5(() => {
  const db = database(); assert.equal(record(db).statusCode, 201);
  // data drift: the quotation creator now holds the Supervisor role and is (wrongly) assigned
  db.users.find((u) => u.id === "sales-1").role = "Supervisor";
  db.dispatch_cards[0].assigned_supervisor_id = "sales-1";
  const res = confirm(db, "sales-1");
  assert.equal(res.statusCode, 403); assert.equal(res.body.code, "SALES_OWNER_SEPARATION");
  assert.match(v5SupervisorAssignmentRefusal(db, db.dispatch_cards[0], db.users.find((u) => u.id === "sales-1")), /Sales owner/);
  assert.equal(v5SupervisorAssignmentRefusal(db, db.dispatch_cards[0], db.users.find((u) => u.id === "sup-1")), null);
  // an explicit sales_owner_id and the root quotation owner are covered too
  db.quotes[0].sales_owner_id = "sup-1"; db.dispatch_cards[0].assigned_supervisor_id = "sup-1";
  assert.equal(confirm(db, "sup-1").body.code, "SALES_OWNER_SEPARATION");
  db.quotes[0].sales_owner_id = undefined; db.quotes.push({ id: "quote-r2", root_quote_id: "quote-1", v5_commercial_workflow: true, created_by: "sales-2" });
  db.users.find((u) => u.id === "sales-1").role = "Sales";
  assert.match(v5SupervisorAssignmentRefusal(db, { quotation_id: "quote-r2" }, { id: "sales-1" }), /Sales owner/);
  assert.equal(v5SupervisorAssignmentRefusal(db, { quotation_id: "quote-r2" }, { id: "sales-1" }), "The Sales owner of this quotation cannot be its assigned ORAC Supervisor.");
  assert.equal(v5SupervisorAssignmentRefusal(db, { quotation_id: "quote-r2" }, { id: "sup-2" }), null);
  // an existing confirmation by a later-discovered Sales owner stops counting
  const ok = database(); record(ok); confirm(ok);
  ok.quotes[0].sales_owner_id = "sup-1";
  assert.equal(isV5Verified(ok, ok.field_worksheets[0]), false);
}));

test("the assignment guard is dark: it only applies in V5 mode for V5 quotations", () => {
  const db = database(); const supervisor = db.users.find((u) => u.id === "sales-1");
  assert.equal(withV5(() => v5SupervisorAssignmentRefusal(db, db.dispatch_cards[0], supervisor), false), null);
  db.quotes[0].v5_commercial_workflow = false;
  assert.equal(withV5(() => v5SupervisorAssignmentRefusal(db, db.dispatch_cards[0], supervisor)), null);
});

test("the person who recorded or holds the paper, or who entered the Timesheet, cannot confirm it", () => withV5(() => {
  const db = database(); assert.equal(record(db, { custodian_user_id: "sup-1" }).statusCode, 201);
  assert.equal(confirm(db, "sup-1").body.code, "SEPARATION_OF_DUTIES");
  const second = database(); record(second); second.field_worksheets[0].submitted_by = "sup-1";
  assert.equal(confirm(second, "sup-1").body.code, "SEPARATION_OF_DUTIES");
  const third = database(); record(third); third.v5_paper_signatures[0].recorded_by = "sup-1";
  // altering a stored record also breaks its integrity hash
  assert.equal(confirm(third, "sup-1").body.code, "NO_CURRENT_PAPER_EVIDENCE");
}));

// ---- immutability and correction ------------------------------------------------------------
test("evidence is append-only: later events never edit it and tampering is detected", () => withV5(() => {
  const db = database(); record(db); const snapshot = JSON.stringify(db.v5_paper_signatures[0]);
  confirm(db);
  assert.equal(JSON.stringify(db.v5_paper_signatures[0]), snapshot);
  const dup = record(db);
  assert.equal(dup.statusCode, 409); assert.equal(dup.body.code, "EVIDENCE_ALREADY_CURRENT");
  assert.equal(db.v5_paper_signatures.length, 1);
  db.v5_paper_signatures[0].scan_hash = "b".repeat(64);
  const state = v5SignatureState(db, db.field_worksheets[0]);
  assert.equal(state.verified, false);
  assert.equal(state.evidence_history[0].status, "integrity_failed");
}));

test("a Timesheet correction makes evidence and confirmation non-current without deleting history", () => withV5(() => {
  const db = verifiedDb(); const ws = db.field_worksheets[0];
  const oldEvidence = JSON.stringify(db.v5_paper_signatures[0]); const oldConfirmation = JSON.stringify(db.v5_supervisor_confirmations[0]);
  const oldHash = v5TimesheetHash(ws);
  const audits = db.audit_logs.length;
  for (const patch of [{ hours_breakdown: { normal: 8, ot_15: 0, ot_20: 1 }, hours: 9 }, { hours_breakdown: { normal: 7, ot_15: 1, ot_20: 0 }, hours: 8 }, { work_date: "2026-10-04" }]) {
    const copy = JSON.parse(JSON.stringify(db)); Object.assign(copy.field_worksheets[0], patch);
    const state = v5SignatureState(copy, copy.field_worksheets[0]);
    assert.equal(state.verified, false, JSON.stringify(patch));
    assert.equal(state.evidence, null); assert.equal(state.confirmation, null);
    assert.equal(state.evidence_history[0].status, "stale_hours_changed");
    assert.equal(state.confirmation_history[0].current, false);
  }
  Object.assign(ws, { hours_breakdown: { normal: 7, ot_15: 1, ot_20: 0 }, hours: 8 });
  assert.equal(isV5Verified(db, ws), false);
  assert.equal(db.v5_paper_signatures.length, 1); assert.equal(db.v5_supervisor_confirmations.length, 1);
  assert.equal(JSON.stringify(db.v5_paper_signatures[0]), oldEvidence); assert.equal(JSON.stringify(db.v5_supervisor_confirmations[0]), oldConfirmation);
  assert.equal(db.audit_logs.length, audits);
  // the old hash can no longer be confirmed, even with the old evidence id
  assert.equal(confirm(db, "sup-1", { hours_hash: oldHash, evidence_id: db.v5_paper_signatures[0].id }).statusCode, 409);
  // re-verifying needs fresh paper evidence and a fresh confirmation, both bound to the new hash
  assert.equal(record(db).statusCode, 201);
  assert.equal(isV5Verified(db, ws), false);
  assert.equal(confirm(db).statusCode, 201);
  assert.equal(isV5Verified(db, ws), true);
  assert.equal(db.v5_paper_signatures.length, 2); assert.notEqual(db.v5_paper_signatures[1].hours_hash, oldHash);
  assert.equal(db.v5_paper_signatures[1].replaces_evidence_id, db.v5_paper_signatures[0].id);
  assert.deepEqual(db.v5_paper_signatures[0].hours_hash, oldHash);
}));

test("replacement evidence for the same hours needs a reason and withdraws the old confirmation", () => withV5(() => {
  const db = verifiedDb(); const ws = db.field_worksheets[0];
  const replaced = record(db, { replacement_reason: "Custodian corrected after audit", custodian_user_id: "sales-2" });
  assert.equal(replaced.statusCode, 201);
  assert.equal(isV5Verified(db, ws), false);
  assert.equal(v5SignatureState(db, ws).confirmation, null);
  assert.equal(db.v5_paper_signatures.length, 2);
  assert.equal(confirm(db).statusCode, 201);
  assert.equal(isV5Verified(db, ws), true);
}));

// ---- billing readiness ------------------------------------------------------------------------
const readiness = (db, user = "sales-1") => call(getV5BillingReadiness, db, user, { params: { id: "job-1" } });

test("billing readiness counts only V5-verified Timesheets and stays rate-free and read-only", () => withV5(() => {
  const db = database();
  db.field_worksheets[0].status = "Supervisor_Approved"; // legacy approval alone is not V5 verification
  const none = readiness(db);
  assert.equal(none.statusCode, 200);
  assert.equal(none.body.data.ready_for_pricing_review, false);
  assert.equal(none.body.data.lines[0].canonical_hours, 0);
  assert.deepEqual(none.body.data.verification.unverified_timesheets, [{ id: "ws-1", hours: 9, reasons: ["NO_PAPER_EVIDENCE", "NO_CURRENT_SUPERVISOR_CONFIRMATION"] }]);

  record(db); assert.equal(readiness(db).body.data.ready_for_pricing_review, false); // paper alone
  confirm(db);
  db.field_worksheets.push(sheet({ id: "ws-2", technician_id: "tech-2", worker_name: "Second", status: "Supervisor_Approved" })); // approved but unverified
  const before = JSON.stringify(db);
  const res = readiness(db);
  assert.equal(JSON.stringify(db), before); // read-only: no record, audit or invoice change
  assert.equal(res.body.data.ready_for_pricing_review, true);
  assert.equal(res.body.data.lines[0].canonical_hours, 9);
  assert.deepEqual(res.body.data.lines[0].source_timesheet_ids, ["ws-1"]);
  assert.equal(res.body.data.verification.unverified_hours, 9);
  const text = JSON.stringify(res.body.data);
  for (const word of ["unit_price", "hourly_rate", "rate", "amount", "line_total", "price"]) assert.equal(text.includes(word), false, word);
  assert.equal(db.invoices.length, 0);
}));

test("billing readiness drops hours the moment a verified Timesheet is corrected or superseded", () => withV5(() => {
  const db = verifiedDb();
  assert.equal(readiness(db).body.data.lines[0].canonical_hours, 9);
  db.field_worksheets[0].hours_breakdown = { normal: 8, ot_15: 0, ot_20: 0 }; db.field_worksheets[0].hours = 8;
  const corrected = readiness(db);
  assert.equal(corrected.body.data.ready_for_pricing_review, false);
  assert.equal(corrected.body.data.lines[0].canonical_hours, 0);
  const db2 = verifiedDb(); db2.field_worksheets[0].superseded_by = "ws-new";
  assert.equal(readiness(db2).body.data.lines[0].canonical_hours, 0);
  assert.deepEqual(readiness(db2).body.data.verification.unverified_timesheets, []);
}));

test("billing readiness stays dark, permissioned and V5-only", () => {
  const db = withV5(() => verifiedDb());
  const off = readiness(db); assert.equal(off.statusCode, 409); assert.equal(off.body.code, "FEATURE_DISABLED");
  withV5(() => {
    assert.throws(() => readiness(db, "tech-1"), /cannot perform/);
    db.quotes[0].v5_commercial_workflow = false;
    assert.equal(readiness(db).statusCode, 409);
  });
});

test("verified signature state is rate-free", () => withV5(() => {
  const db = verifiedDb();
  const res = call(getV5SignatureState, db, "sales-1", { params: { id: "ws-1" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.verified, true);
  const text = JSON.stringify(res.body.data);
  for (const word of ["unit_price", "hourly_rate", "line_total"]) assert.equal(text.includes(word), false, word);
}));
