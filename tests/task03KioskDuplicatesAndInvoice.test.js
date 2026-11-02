import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { issueLegacyInvoice, transitionQuote } from "../src/stateMachine.js";
import { submitKioskTimesheets } from "../src/controllers/kioskController.js";
import { reviewKioskTimesheet, listKioskReviewQueue } from "../src/controllers/timesheetReviewController.js";
import { assignDispatchSupervisor, getDispatchRoster } from "../src/controllers/dispatchController.js";

// Real store + real state machine. The rate in these fixtures is a TEST-ONLY
// number; it is not a policy and nothing here asserts any approved rate.
const TEST_ONLY_RATE = 10;

function response() { return { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }

function world() {
  const store = createStore(":memory:");
  const db = {
    users: [
      { id: "u_admin", role: "Admin", name: "Admin", is_active: true },
      { id: "u_ops", role: "Operations", name: "Ops", is_active: true },
      { id: "u_sup", role: "Supervisor", name: "Sup", is_active: true },
      { id: "u_sup_off", role: "Supervisor", name: "Gone", is_active: false },
      { id: "u_t1", role: "Technician", name: "Tech One", is_active: true },
      { id: "u_t2", role: "Technician", name: "Tech Two", is_active: true },
      { id: "u_mgmt", role: "Management", name: "Mgmt", is_active: true }
    ],
    clients: [{ id: "c1", name: "Client" }],
    quote_lines: [{ id: "l1", quotation_id: "q1", description: "Labour", quantity: 1, unit_price: 100, line_total: 100 }],
    quotes: [{ id: "q1", quote_number: "Q-1", client_id: "c1", equipment_tag_id: "eq1", status: "Draft", total_amount: 100 }],
    purchase_orders: [], dispatch_cards: [], field_worksheets: [], timesheets: [], material_usage: [],
    invoices: [], invoice_lines: [], audit_logs: []
  };
  const admin = db.users[0];
  transitionQuote(db, store, "q1", "Sent", {}, admin);
  transitionQuote(db, store, "q1", "Approved_Pending_PO", { approval_exception_reason: "Sales approver unavailable during client operational deadline." }, admin);
  db.purchase_orders.push({ id: "po1", quotation_id: "q1", po_reference: "PO-1", po_amount: 100000, status: "verified", requires_amendment: false });
  transitionQuote(db, store, "q1", "PO_Verified", {}, admin);
  transitionQuote(db, store, "q1", "Field_Dispatch", {}, admin);
  const dispatch = db.dispatch_cards[0];
  dispatch.assigned_technician_ids = ["u_t1", "u_t2"];
  db.field_worksheets.push({ id: "ws1", dispatch_card_id: dispatch.id, status: "Supervisor_Approved", activity: "Work", hours: 1 });
  return { db, store, dispatch, admin };
}
function rq(w, userId, extra = {}) { return { user: { id: userId }, db: w.db, store: w.store, params: { id: w.dispatch.id }, query: {}, body: {}, ...extra }; }
function submit(w, body, userId = "u_ops") { const r = response(); submitKioskTimesheets(rq(w, userId, { body }), r); return r; }
function entry(over = {}) { return { technician_id: "u_t1", hours_logged: 4, hourly_rate: TEST_ONLY_RATE, ...over }; }
function batch(over = {}, entries = [entry()]) { return { work_date: "2026-09-21", entries, ...over }; }
function review(w, userId, id, body) { const r = response(); reviewKioskTimesheet(rq(w, userId, { params: { id }, body }), r); return r; }
function invoice(w) { return () => issueLegacyInvoice(w.db, w.store, "q1", w.admin); }

test("retry with the same batch_key replays the original result and creates nothing new", () => {
  const w = world();
  const a = submit(w, batch({ batch_key: "retry-key-0001" }));
  const b = submit(w, batch({ batch_key: "retry-key-0001" }));
  assert.equal(a.statusCode, 200); assert.equal(b.statusCode, 200);
  assert.equal(b.body.data.replayed, true);
  assert.equal(w.db.timesheets.length, 1);
  assert.equal(b.body.data.entries[0].id, a.body.data.entries[0].id);
});

test("same batch_key with different content is refused", () => {
  const w = world();
  submit(w, batch({ batch_key: "retry-key-0002" }));
  const r = submit(w, batch({ batch_key: "retry-key-0002" }, [entry({ hours_logged: 5 })]));
  assert.equal(r.statusCode, 409); assert.equal(w.db.timesheets.length, 1);
});

test("an identical entry in a NEW batch is refused as a possible duplicate (even without a key)", () => {
  const w = world();
  submit(w, batch());
  const r = submit(w, batch({ batch_key: "other-key-0003" }, [entry({ notes: "  ", })]));
  assert.equal(r.statusCode, 409);
  assert.match(r.body.message, /Possible duplicate/);
  assert.ok(r.body.duplicate_of);
  assert.equal(w.db.timesheets.length, 1);
});

test("legitimate separate shifts are accepted: different shift label, hours, date, technician, or a prior rejection", () => {
  const w = world();
  assert.equal(submit(w, batch({}, [entry({ shift: "day" })])).statusCode, 200);
  assert.equal(submit(w, batch({}, [entry({ shift: "night" })])).statusCode, 200);           // same hours, other shift
  assert.equal(submit(w, batch({}, [entry({ hours_logged: 3 })])).statusCode, 200);           // other hours
  assert.equal(submit(w, batch({ work_date: "2026-09-22" })).statusCode, 200);                // other date
  assert.equal(submit(w, batch({}, [entry({ technician_id: "u_t2" })])).statusCode, 200);     // other technician
  assert.equal(w.db.timesheets.length, 5);
  // rejected entry does not block its correction
  w.dispatch.assigned_supervisor_id = "u_sup";
  const rejected = w.db.timesheets.find((t) => t.shift === "day");
  assert.equal(review(w, "u_sup", rejected.id, { decision: "reject", comment: "Wrong hours" }).statusCode, 200);
  assert.equal(submit(w, batch({}, [entry({ shift: "day" })])).statusCode, 200);
});

test("a technician cannot exceed 24 kiosk hours on one date across batches", () => {
  const w = world();
  assert.equal(submit(w, batch({}, [entry({ hours_logged: 14, shift: "a" })])).statusCode, 200);
  const r = submit(w, batch({}, [entry({ hours_logged: 11, shift: "b" })]));
  assert.equal(r.statusCode, 400); assert.match(r.body.message, /24-hour daily limit/);
  assert.equal(submit(w, batch({}, [entry({ hours_logged: 10, shift: "b" })])).statusCode, 200);
});

test("duplicate detection also works for legacy kiosk rows that have no stored fingerprint", () => {
  const w = world();
  w.db.timesheets.push({ id: "legacy", dispatch_card_id: w.dispatch.id, technician_id: "u_t1", work_date: "2026-09-21", hours_logged: 4, entry_source: "kiosk", notes: "" });
  assert.equal(submit(w, batch()).statusCode, 409);
});

test("invoice-block path (real store): pending blocks, reason names the missing Supervisor, approval unblocks, rejected is excluded", () => {
  const w = world();
  assert.equal(submit(w, batch({}, [entry({ hours_logged: 2 }), entry({ technician_id: "u_t2", hours_logged: 3 })])).statusCode, 200);
  // Dispatch was created by Admin, so assigned_supervisor_id is an Admin, not a Supervisor.
  assert.throws(invoice(w), (e) => /awaiting Supervisor review/.test(e.message) && /No active Supervisor is assigned/.test(e.message) && e.status === 400);
  assert.equal(w.db.invoices.length, 0);

  // Admin and Operations cannot approve, even though they can see the queue.
  const [t1, t2] = w.db.timesheets;
  assert.throws(() => review(w, "u_admin", t1.id, { decision: "approve" }), /cannot perform/);
  assert.throws(() => review(w, "u_ops", t1.id, { decision: "approve" }), /cannot perform/);
  assert.throws(() => review(w, "u_mgmt", t1.id, { decision: "approve" }), /cannot perform/);
  assert.equal(w.db.timesheets.every((t) => t.review_status === "pending_review"), true);
  const q = response(); listKioskReviewQueue(rq(w, "u_ops"), q);
  assert.ok(q.body.data.every((row) => row.can_review === false && /No active Supervisor/.test(row.review_blocked_reason)));

  // Unassigned Supervisor cannot review; assignment is Admin/Operations only.
  assert.equal(review(w, "u_sup", t1.id, { decision: "approve" }).statusCode, 403);
  const denied = (() => { try { assignDispatchSupervisor(rq(w, "u_sup", { body: { supervisor_id: "u_sup" } }), response()); return null; } catch (e) { return e; } })();
  assert.ok(denied && /cannot perform/.test(denied.message));
  const bad = response(); assignDispatchSupervisor(rq(w, "u_ops", { body: { supervisor_id: "u_t1" } }), bad); assert.equal(bad.statusCode, 400);
  const inactive = response(); assignDispatchSupervisor(rq(w, "u_ops", { body: { supervisor_id: "u_sup_off" } }), inactive); assert.equal(inactive.statusCode, 400);
  const ok = response(); assignDispatchSupervisor(rq(w, "u_ops", { body: { supervisor_id: "u_sup" } }), ok);
  assert.equal(ok.statusCode, 200);
  assert.ok(w.db.audit_logs.some((a) => a.action === "DISPATCH_SUPERVISOR_ASSIGNED"));

  // Still blocked: assigned, but nothing approved yet.
  assert.throws(invoice(w), (e) => /2 kiosk timesheet entries are awaiting Supervisor review/.test(e.message) && !/No active Supervisor/.test(e.message));

  assert.equal(review(w, "u_sup", t1.id, { decision: "approve" }).statusCode, 200);
  assert.equal(review(w, "u_sup", t2.id, { decision: "reject", comment: "Not on site" }).statusCode, 200);
  const result = invoice(w)();
  assert.equal(result.status, "sent");
  assert.equal(w.db.quotes[0].status, "Invoiced");
  assert.equal(w.db.invoices.length, 1);
  assert.equal(w.db.invoices[0].total_amount, 2 * TEST_ONLY_RATE); // rejected 3h excluded
});

test("roster read exposes a Supervisor picker and blocked reason to Admin/Operations only", () => {
  const w = world();
  const ops = response(); getDispatchRoster(rq(w, "u_ops"), ops);
  assert.equal(ops.statusCode, 200);
  assert.match(ops.body.data.dispatch.review_blocked_reason, /No active Supervisor/);
  assert.deepEqual(ops.body.data.supervisors.map((s) => s.id), ["u_sup"]);
  assert.ok(ops.body.data.supervisors.every((s) => Object.keys(s).sort().join() === "assigned,id,name"));
});

test("retry protection never suppresses a legitimate separate shift (day shift, retry, then a second shift with identical hours)", () => {
  const w = world();
  // Day shift, sent twice because the first response was lost (same key): one row.
  const day = batch({ batch_key: "day-shift-key-1" }, [entry({ hours_logged: 8, shift: "Day" })]);
  assert.equal(submit(w, day).statusCode, 200);
  const replay = submit(w, day);
  assert.equal(replay.statusCode, 200); assert.equal(replay.body.data.replayed, true);
  assert.equal(w.db.timesheets.length, 1);

  // Night shift the same day with IDENTICAL hours and a NEW key: must be recorded, not treated as a retry.
  const night = batch({ batch_key: "night-shift-key-2" }, [entry({ hours_logged: 8, shift: "Night" })]);
  const n = submit(w, night);
  assert.equal(n.statusCode, 200); assert.notEqual(n.body.data.replayed, true);
  assert.equal(w.db.timesheets.length, 2);

  // Retrying the night shift is recognised as a retry of that shift only.
  assert.equal(submit(w, night).body.data.replayed, true);
  assert.equal(w.db.timesheets.length, 2);

  // Same day, same technician, same hours, NEW key, no shift label, different note: a separate legitimate entry.
  assert.equal(submit(w, batch({ batch_key: "extra-key-0003" }, [entry({ hours_logged: 8, notes: "Call-out for breakdown" })])).statusCode, 200);
  // 8 + 8 + 8 = 24 is allowed; a fourth would breach the daily limit and is refused for that reason, not as a duplicate.
  const over = submit(w, batch({ batch_key: "extra-key-0004" }, [entry({ hours_logged: 1, shift: "Other" })]));
  assert.equal(over.statusCode, 400); assert.match(over.body.message, /24-hour daily limit/);

  // A genuine accidental double entry (no key, same shift label, same everything) is still caught.
  assert.equal(submit(w, batch({}, [entry({ hours_logged: 8, shift: "Day" })])).statusCode, 409);

  // Two crew members in one batch with the same hours are two entries, not duplicates of each other.
  const crew = submit(w, batch({ work_date: "2026-09-22", batch_key: "crew-key-00005" }, [entry({ hours_logged: 8 }), entry({ technician_id: "u_t2", hours_logged: 8 })]));
  assert.equal(crew.statusCode, 200); assert.equal(w.db.timesheets.length, 5);

  // Legacy kiosk rows stay pending (never auto-approved) and do not count toward billing.
  w.db.timesheets.push({ id: "legacy-x", dispatch_card_id: w.dispatch.id, technician_id: "u_t2", work_date: "2026-09-01", hours_logged: 3, entry_source: "kiosk" });
  assert.equal(w.db.timesheets.find((t) => t.id === "legacy-x").review_status, undefined);
  assert.throws(invoice(w), /awaiting Supervisor review/);
});
