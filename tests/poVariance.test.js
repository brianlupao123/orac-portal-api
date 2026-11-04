// Phase 3: certified hours vs quoted / PO hours. Dependency-free; synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { hasPermission } from "../src/permissions.js";
import * as P from "../src/poVariance.js";
import * as C from "../src/controllers/timesheetWorkflowController.js";
import { invoiceReadinessBlock, invoiceReadinessSummary } from "../src/invoiceReadiness.js";
import { issueLegacyInvoice } from "../src/stateMachine.js";
import { approvedLabourValue } from "../src/timesheetReview.js";
import { makeRes, makeReq } from "./_http.js";

const FLAG = "TIMESHEET_INVOICE_VARIANCE";
const withFlag = (on, fn) => async () => {
  const saved = process.env[FLAG];
  if (on) process.env[FLAG] = "enabled"; else delete process.env[FLAG];
  try { await fn(); } finally { if (saved === undefined) delete process.env[FLAG]; else process.env[FLAG] = saved; }
};

const u = (id, role) => ({ id, role, is_active: true, name: id });
// Supervisor_Approved is an eligible daily source under the default (pre-cutover) predicate.
const sheet = (id, hours, extra = {}) => ({ id, dispatch_card_id: "d1", work_date: "2026-03-02", status: "Supervisor_Approved", hours, hours_breakdown: { normal: hours, ot_15: 0, ot_20: 0 }, ...extra });
const hourLine = (qty, extra = {}) => ({ id: `ql_${qty}_${Math.random()}`, quotation_id: "q1", description: "Fitters", quantity: qty, unit_price: 10, unit_of_measure: "hours", cost_type: "labour", ...extra });

// One quote (100 quoted hours by default), one dispatch, one verified PO of 10 000.
function makeDb({ sheets = [], lines = [hourLine(100)], po = {}, extra = {} } = {}) {
  return {
    users: [u("sales1", "Sales"), u("sales2", "Sales"), u("fin1", "Finance"), u("fin2", "Finance"), u("admin", "Admin"), u("mgmt", "Management"), u("tech", "Technician"), u("ops", "Operations")],
    clients: [{ id: "c1", name: "C1" }],
    quotes: [{ id: "q1", quote_number: "Q-0001", client_id: "c1", total_amount: 100, status: "Field_Dispatch" }],
    quote_lines: lines,
    dispatch_cards: [{ id: "d1", quotation_id: "q1", purchase_order_id: "po1" }],
    purchase_orders: [{ id: "po1", quotation_id: "q1", status: "verified", po_reference: "PO-1", po_amount: 10000, requires_amendment: false, ...po }],
    field_worksheets: sheets, timesheets: [], material_usage: [], invoices: [], invoice_lines: [], stock_movements: [],
    po_scope_evidence: [], timesheet_variance_overrides: [], worksheet_registers: [], audit_logs: [], notifications: [], company_profile: {},
    ...extra
  };
}
const registerFor = (scope, lines = []) => ({ id: "reg1", status: "Submitted", scope, period: { start: "2026-03-01", end: "2026-03-31" }, lines });
const store = () => { let n = 0; return { id: (p) => `${p}_${++n}`, audit() {} }; };
const call = (fn, { db, user, params = {}, body = {} }) => {
  const res = makeRes();
  db.__store ||= store();
  fn(makeReq({ db, store: db.__store, user: { id: user }, params, body }), res);
  return res;
};
const core = (db, q = "q1") => P.computePoVarianceCore(db, q);

// ---------------------------------------------------------------- calculation
test("within budget: certified <= quoted is green with the exact wording", withFlag(true, () => {
  const c = core(makeDb({ sheets: [sheet("a", 60), sheet("b", 20)] }));
  assert.equal(c.status, "within_budget"); assert.equal(c.hours.certified, 80); assert.equal(c.hours.quoted, 100);
  assert.equal(c.blocks_invoicing, false);
  assert.equal(P.presentPoVariance(c).label, "Within PO Budget — Ready for Invoicing");
}));

test("exactly on budget is NOT an overrun (actual <= quoted)", withFlag(true, () => {
  const c = core(makeDb({ sheets: [sheet("a", 100)] }));
  assert.equal(c.status, "within_budget"); assert.equal(c.hours.overrun_hours, 0);
}));

test("over budget: overrun status, the exact alert wording, and invoicing blocked", withFlag(true, () => {
  const c = core(makeDb({ sheets: [sheet("a", 112.5)] }));
  assert.equal(c.status, "overrun"); assert.equal(c.hours.overrun_hours, 12.5); assert.equal(c.blocks_invoicing, true);
  const v = P.presentPoVariance(c);
  assert.equal(v.label, "Scope Overrun Detected: +12.5 Hours over PO");
  assert.match(v.issue_disabled_reason, /amendment note or revised PO reference/);
  assert.equal(P.overrunHoursLabel(3), "Scope Overrun Detected: +3 Hours over PO", "whole hours print without decimals");
}));

test("two-decimal comparison and the owner tolerance (variance_tolerance_hours) are respected", withFlag(true, () => {
  assert.equal(core(makeDb({ sheets: [sheet("a", 100.004)] })).status, "within_budget", "rounds to two decimals first");
  assert.equal(core(makeDb({ sheets: [sheet("a", 100.01)] })).status, "overrun");
  const tol = makeDb({ sheets: [sheet("a", 100.5)], extra: { company_profile: { timesheet_policy: { variance_tolerance_hours: 1 } } } });
  assert.equal(core(tol).status, "within_budget");
  tol.field_worksheets[0] = sheet("a", 101.01);
  assert.equal(core(tol).status, "overrun");
}));

test("certified hours are cumulative across dispatches and months, and only eligible Timesheets count", withFlag(true, () => {
  const db = makeDb({ sheets: [sheet("a", 40, { work_date: "2026-01-10" }), sheet("b", 40, { work_date: "2026-02-10" }), sheet("c", 40, { work_date: "2026-03-10", dispatch_card_id: "d2" }),
    sheet("draft", 500, { status: "Draft" }), sheet("submitted", 500, { status: "Submitted" }), sheet("returned", 500, { status: "Returned_For_Correction" })] });
  db.dispatch_cards.push({ id: "d2", quotation_id: "q1" });
  const c = core(db);
  assert.equal(c.hours.certified, 120, "40+40+40; unapproved sheets are ignored");
  assert.equal(c.hours.overrun_hours, 20);
  assert.deepEqual(c.scope.dispatch_card_ids.sort(), ["d1", "d2"]);
}));

test("another quote's hours never leak into this quote", withFlag(true, () => {
  const db = makeDb({ sheets: [sheet("a", 30), sheet("x", 900, { dispatch_card_id: "dx" })] });
  db.quotes.push({ id: "q2", client_id: "c1", status: "Field_Dispatch" }); db.dispatch_cards.push({ id: "dx", quotation_id: "q2" });
  assert.equal(core(db).hours.certified, 30);
}));

// ---------------------------------------------------------------- quoted hours definition
test("quoted hours: only hour-denominated labour lines; optional, materials, equipment and fixed lines are excluded", withFlag(true, () => {
  const db = makeDb({ lines: [
    hourLine(60), hourLine(40, { cost_type: undefined }),                       // labour + untyped legacy line
    hourLine(500, { item_type: "optional" }),                                   // not accepted work
    hourLine(500, { cost_type: "equipment" }), hourLine(500, { cost_type: "material" }),
    { id: "v5a", quotation_id: "q1", pricing_basis: "hourly", quantity: 20, unit_price: 5 },
    { id: "v5b", quotation_id: "q1", pricing_basis: "minimum_hours", quantity: 8, planned_hours: 30, unit_price: 5 },
    { id: "v5c", quotation_id: "q1", pricing_basis: "fixed", quantity: 1, unit_price: 900 },
    { id: "other", quotation_id: "q9", quantity: 999, unit_of_measure: "hours", cost_type: "labour" }
  ] });
  const q = P.quotedHours(db, db.quotes[0]);
  assert.equal(q.hours, 150, "60+40+20+30");
}));

test("day-priced labour is reported, never silently converted; minimum-hours without planned hours is flagged", withFlag(true, () => {
  const db = makeDb({ lines: [hourLine(100), hourLine(5, { unit_of_measure: "days" }), { id: "m", quotation_id: "q1", pricing_basis: "minimum_hours", quantity: 8, planned_hours: null }] });
  const c = core(db);
  assert.equal(c.hours.quoted, 100); assert.equal(c.hours.baseline_partial, true);
  assert.ok(c.notes.some((n) => /priced in days/.test(n))); assert.ok(c.notes.some((n) => /no planned hours/.test(n)));
}));

test("no hour baseline and no verified PO value: no_baseline, never invented, never blocks", withFlag(true, () => {
  const db = makeDb({ lines: [{ id: "f", quotation_id: "q1", pricing_basis: "fixed", quantity: 1, unit_price: 1 }], po: { status: "pending" }, sheets: [sheet("a", 999)] });
  const c = core(db);
  assert.equal(c.status, "no_baseline"); assert.equal(c.blocks_invoicing, false);
  assert.equal(P.presentPoVariance(c).label, P.NO_BASELINE_LABEL);
}));

// ---------------------------------------------------------------- amounts
test("amount: verified PO value vs approved labour + material; an amount-only overrun; unverified PO is not compared", withFlag(true, () => {
  const db = makeDb({ sheets: [sheet("a", 10)], po: { po_amount: 500 } });
  db.timesheets = [{ id: "t1", dispatch_card_id: "d1", hours_logged: 10, hourly_rate: 40, approved: true }]; // 400
  db.material_usage = [{ id: "m1", dispatch_card_id: "d1", total_cost: 150 }, { id: "m2", dispatch_card_id: "elsewhere", total_cost: 999 }];
  let c = core(db);
  assert.equal(c.amount.actual, 550, "400 labour + 150 materials on this quote's dispatches only");
  assert.equal(c.amount.quoted, 500); assert.equal(c.amount.difference, 50); assert.equal(c.amount.overrun, true);
  assert.equal(c.hours.overrun, false, "hours are within budget");
  assert.equal(c.status, "overrun", "an amount-only overrun is still an overrun");
  assert.equal(c.blocks_invoicing, true);
  db.purchase_orders[0].po_amount = 550; assert.equal(core(db).status, "within_budget", "exactly equal is not an overrun");
  db.purchase_orders[0].po_amount = 600; assert.equal(core(db).status, "within_budget");
  db.purchase_orders[0].po_amount = 500; db.purchase_orders[0].status = "pending";
  c = core(db);
  assert.equal(c.amount.available, false); assert.equal(c.status, "within_budget", "an unverified PO is never used to raise an overrun");
  assert.ok(c.notes.some((n) => /not verified/.test(n)));
}));

test("rate privacy: Sales/Management get no money figures, Finance/Admin do; everyone sees the PO-value yes/no", withFlag(true, () => {
  const db = makeDb({ sheets: [sheet("a", 10)], po: { po_amount: 300 } });
  db.timesheets = [{ id: "t1", dispatch_card_id: "d1", hours_logged: 10, hourly_rate: 40, approved: true }]; // actual 400 vs PO 300
  const c = core(db);
  assert.equal(c.amount.actual, 400);
  const sales = P.presentPoVariance(c, { canSeeAmounts: false });
  assert.equal(sales.amount.restricted, true); assert.equal(sales.amount.overrun, true);
  for (const k of ["quoted", "actual", "difference"]) assert.equal(k in sales.amount, false, `${k} must not be present for Sales`);
  assert.equal(sales.label, "Scope Overrun Detected: PO value exceeded");
  // Structural scan (a substring check would trip on the hex hash): no money-bearing key and no numeric value equal to a money figure.
  const walk = (v, path = "") => {
    if (Array.isArray(v)) return v.flatMap((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [...(["hourly_rate", "overrun_amount", "actual", "quoted_amount", "actual_amount"].includes(k) ? [`key ${path}.${k}`] : []), ...walk(x, `${path}.${k}`)]);
    return typeof v === "number" && [400, 300].includes(v) ? [`value ${path}=${v}`] : [];
  };
  assert.deepEqual(walk(sales), [], "money leaked into the Sales payload");
  const fin = P.presentPoVariance(c, { canSeeAmounts: true });
  assert.equal(fin.amount.actual, 400); assert.equal(fin.amount.quoted, 300);
  assert.equal(fin.label, "Scope Overrun Detected: +100 over PO value");
}));

// end-to-end through the handlers: what each role's response actually contains
test("HTTP redaction: the same overrun returns money to Finance/Admin and none to Sales/Management", withFlag(true, () => {
  const mk = () => { const db = makeDb({ sheets: [sheet("a", 10)], po: { po_amount: 300 } }); db.timesheets = [{ id: "t1", dispatch_card_id: "d1", hours_logged: 10, hourly_rate: 40, approved: true }]; return db; };
  for (const who of ["fin1", "admin"]) assert.equal(call(C.getDispatchPoVariance, { db: mk(), user: who, params: { id: "d1" } }).body.data.amount.actual, 400, who);
  for (const who of ["sales1", "mgmt"]) {
    const body = call(C.getDispatchPoVariance, { db: mk(), user: who, params: { id: "d1" } }).body.data;
    assert.equal(body.amount.restricted, true, who); assert.equal("actual" in body.amount, false, who);
  }
}));

// ---------------------------------------------------------------- HTTP: the alert on the monthly Worksheet
test("ACCEPTANCE: an over-budget Worksheet triggers the variance alert; a within-budget one shows the green badge", withFlag(true, () => {
  const over = makeDb({ sheets: [sheet("a", 90), sheet("b", 22)] });
  over.worksheet_registers.push(registerFor({ client_id: "c1", quote_id: "q1" }, [{ normal: 30, ot_15: 2, ot_20: 0 }]));
  const res = call(C.getRegisterPoVariance, { db: over, user: "sales1", params: { id: "reg1" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.status, "overrun");
  assert.equal(res.body.data.label, "Scope Overrun Detected: +12 Hours over PO");
  assert.equal(res.body.data.blocks_invoicing, true);
  assert.equal(res.body.data.hours.this_period, 32, "the month's own hours are shown, but the comparison is cumulative");
  assert.equal(res.body.data.hours.certified, 112);

  const ok = makeDb({ sheets: [sheet("a", 50)] });
  ok.worksheet_registers.push(registerFor({ client_id: "c1", purchase_order_id: "po1" }));
  const res2 = call(C.getRegisterPoVariance, { db: ok, user: "sales1", params: { id: "reg1" } });
  assert.equal(res2.body.data.status, "within_budget"); assert.equal(res2.body.data.label, "Within PO Budget — Ready for Invoicing"); assert.equal(res2.body.data.blocks_invoicing, false);
}));

test("a client-only Worksheet scope is not compared (no baseline is invented)", withFlag(true, () => {
  const db = makeDb({ sheets: [sheet("a", 500)] }); db.worksheet_registers.push(registerFor({ client_id: "c1" }));
  const res = call(C.getRegisterPoVariance, { db, user: "sales1", params: { id: "reg1" } });
  assert.equal(res.body.data.status, "no_baseline"); assert.match(res.body.data.reason, /quote or PO/); assert.equal(res.body.data.blocks_invoicing, false);
}));

test("endpoint permissions: Sales/Finance/Admin/Management may read; Technician and Operations may not; flag off refuses", async () => {
  const mk = () => { const db = makeDb({ sheets: [sheet("a", 5)] }); db.worksheet_registers.push(registerFor({ client_id: "c1", quote_id: "q1" })); return db; };
  await withFlag(true, () => {
    for (const who of ["sales1", "admin"]) assert.equal(call(C.getRegisterPoVariance, { db: mk(), user: who, params: { id: "reg1" } }).statusCode, 200, who);
    for (const who of ["tech", "ops", "fin1"]) assert.throws(() => call(C.getRegisterPoVariance, { db: mk(), user: who, params: { id: "reg1" } }), /cannot perform/, `${who} register view`);
    for (const who of ["sales1", "fin1", "admin", "mgmt"]) assert.equal(call(C.getDispatchPoVariance, { db: mk(), user: who, params: { id: "d1" } }).statusCode, 200, who);
    for (const who of ["tech", "ops"]) assert.throws(() => call(C.getDispatchPoVariance, { db: mk(), user: who, params: { id: "d1" } }), /cannot perform/);
    assert.equal(call(C.getRegisterPoVariance, { db: mk(), user: "sales1", params: { id: "nope" } }).statusCode, 404);
  })();
  await withFlag(false, () => {
    const res = call(C.getRegisterPoVariance, { db: mk(), user: "sales1", params: { id: "reg1" } });
    assert.equal(res.statusCode, 409); assert.equal(res.body.code, "FEATURE_DISABLED");
  })();
});

test("only Sales and Admin may attach evidence; Finance, Management and Operations may not", () => {
  const can = (role) => hasPermission(u("x", role), "attachPoScopeEvidence");
  assert.equal(can("Sales"), true); assert.equal(can("Admin"), true);
  for (const r of ["Finance", "Management", "Operations", "Supervisor", "Technician", "Client Viewer"]) assert.equal(can(r), false, r);
});

// ---------------------------------------------------------------- invoice gate
const overDb = () => makeDb({ sheets: [sheet("a", 112)], po: { po_amount: 100000 } });
const hashOf = (db) => core(db).hash;
const attach = (db, user, body, quote = "q1") => call(C.attachPoScopeEvidence, { db, user, params: { id: quote }, body: { variance_hash: hashOf(db), ...body } });

test("GATE: an over-budget dispatch cannot be drafted or issued until Sales attaches evidence; flag off changes nothing", async () => {
  await withFlag(false, () => assert.equal(invoiceReadinessBlock(overDb(), overDb().dispatch_cards[0]), null))();
  await withFlag(true, () => {
    const db = overDb(); const job = db.dispatch_cards[0];
    const block = invoiceReadinessBlock(db, job);
    assert.equal(block.code, "PO_SCOPE_OVERRUN_UNRESOLVED"); assert.equal(block.status, 409);
    assert.match(block.message, /exceed quoted hours by 12/);
    assert.equal(invoiceReadinessSummary(db, job).readiness.ready_for_invoice_review, false, "the read-only summary cannot drift from the gate");
    assert.equal(attach(db, "sales1", { kind: "amendment_note", note: "Client emailed approval for 15 extra hours on 2 March." }).statusCode, 201);
    assert.equal(invoiceReadinessBlock(db, job), null);
    assert.equal(invoiceReadinessSummary(db, job).readiness.ready_for_invoice_review, true);
  })();
});

test("GATE: within-budget work is not blocked by this gate", withFlag(true, () => {
  const db = makeDb({ sheets: [sheet("a", 100)], po: { po_amount: 100000 } });
  assert.equal(invoiceReadinessBlock(db, db.dispatch_cards[0]), null);
}));

test("GATE: the evidence is bound to the exact overrun; more hours make it stale", withFlag(true, () => {
  const db = overDb(); const job = db.dispatch_cards[0];
  assert.equal(attach(db, "sales1", { kind: "revised_po", revised_po_reference: "PO-1-REV-A" }).statusCode, 201);
  assert.equal(invoiceReadinessBlock(db, job), null);
  db.field_worksheets.push(sheet("late", 3));
  assert.equal(invoiceReadinessBlock(db, job).code, "PO_SCOPE_OVERRUN_UNRESOLVED", "the earlier note no longer covers the larger overrun");
}));

test("GATE: the owner policy variance_hard_block=false downgrades the block to a warning", withFlag(true, () => {
  const db = overDb(); db.company_profile.timesheet_policy = { variance_hard_block: false };
  assert.equal(invoiceReadinessBlock(db, db.dispatch_cards[0]), null);
  assert.equal(P.presentPoVariance(core(db)).warn_only, true);
}));

test("GATE: V5 quotations are informational only; their own amendment workflow stays in charge", withFlag(true, () => {
  const db = overDb(); db.quotes[0].v5_commercial_workflow = true;
  const c = core(db);
  assert.equal(c.status, "overrun"); assert.equal(c.blocks_invoicing, false); assert.equal(c.evidence_required, false);
  assert.equal(P.poScopeGate(db, db.dispatch_cards[0]).allow, true);
  const res = attach(db, "sales1", { kind: "amendment_note", note: "A long enough amendment note." });
  assert.equal(res.statusCode, 409); assert.equal(res.body.code, "V5_AMENDMENT_PATH_REQUIRED");
}));

// ---------------------------------------------------------------- evidence rules
test("evidence validation: kind, note length, PO reference format, and the revised reference must differ", withFlag(true, () => {
  const db = overDb();
  assert.equal(attach(db, "sales1", { kind: "other" }).statusCode, 400);
  assert.match(attach(db, "sales1", { kind: "amendment_note", note: "too short" }).body.message, /at least 10/);
  assert.equal(attach(db, "sales1", { kind: "revised_po", revised_po_reference: "x" }).statusCode, 400);
  assert.match(attach(db, "sales1", { kind: "revised_po", revised_po_reference: "po-1" }).body.message, /must differ/);
  assert.equal(attach(db, "sales1", { kind: "revised_po", revised_po_reference: "PO 1 / bad chars!" }).statusCode, 400);
  assert.equal(db.po_scope_evidence.length, 0, "nothing is stored on a rejected request");
}));

test("evidence: needs the current variance_hash (409 STALE_VARIANCE), and refuses when there is no overrun", withFlag(true, () => {
  const db = overDb();
  const stale = call(C.attachPoScopeEvidence, { db, user: "sales1", params: { id: "q1" }, body: { variance_hash: "deadbeef", kind: "amendment_note", note: "A long enough amendment note." } });
  assert.equal(stale.statusCode, 409); assert.equal(stale.body.code, "STALE_VARIANCE");
  const missing = call(C.attachPoScopeEvidence, { db, user: "sales1", params: { id: "q1" }, body: { kind: "amendment_note", note: "A long enough amendment note." } });
  assert.equal(missing.statusCode, 409);
  const fine = makeDb({ sheets: [sheet("a", 10)] });
  const none = call(C.attachPoScopeEvidence, { db: fine, user: "sales1", params: { id: "q1" }, body: { variance_hash: hashOf(fine), kind: "amendment_note", note: "A long enough amendment note." } });
  assert.equal(none.statusCode, 400); assert.equal(none.body.code, "NO_SCOPE_OVERRUN");
  assert.equal(call(C.attachPoScopeEvidence, { db, user: "sales1", params: { id: "nope" }, body: {} }).statusCode, 404);
}));

test("evidence: Finance cannot attach; Sales can; a newer note supersedes the older; the audit trail carries hours, not money", withFlag(true, () => {
  const db = overDb(); const audits = []; db.__store = { id: (() => { let n = 0; return (p) => `${p}_${++n}`; })(), audit: (d, a, t, id, action, b, after) => audits.push({ action, after }) };
  assert.throws(() => attach(db, "fin1", { kind: "amendment_note", note: "A long enough amendment note." }), /cannot perform/);
  const first = attach(db, "sales1", { kind: "amendment_note", note: "First note, long enough to count." });
  const second = attach(db, "sales2", { kind: "revised_po", revised_po_reference: "PO-1-REV-B", note: "Revised PO received." });
  assert.equal(first.statusCode, 201); assert.equal(second.statusCode, 201);
  const [a, b] = db.po_scope_evidence;
  assert.ok(a.voided_at && /Superseded/.test(a.voided_reason)); assert.equal(b.voided_at, null);
  assert.equal(b.attached_by, "sales2"); assert.equal(b.revised_po_reference, "PO-1-REV-B");
  assert.deepEqual(audits.map((x) => x.action), ["PO_SCOPE_EVIDENCE_ATTACHED", "PO_SCOPE_EVIDENCE_ATTACHED"]);
  assert.equal(JSON.stringify(b).includes("hourly_rate"), false); assert.deepEqual(Object.keys(b.hours_at_attach).sort(), ["certified", "overrun_hours", "quoted"]);
  assert.equal(second.body.data.variance.blocks_invoicing, false, "the response carries the refreshed variance so the UI can update at once");
}));

test("evidence is single-use: issuing the invoice consumes it, and a later invoice needs fresh evidence", withFlag(true, () => {
  const db = makeDb({ sheets: [sheet("a", 112, { hours_breakdown: { normal: 112, ot_15: 0, ot_20: 0 } })], po: { po_amount: 100000 } });
  db.timesheets = [{ id: "b1", dispatch_card_id: "d1", hours_logged: 112, hourly_rate: 1, approved: true, created_by: "fin2" }];
  const fin = db.users.find((x) => x.id === "fin1");
  db.__store = store();
  assert.throws(() => issueLegacyInvoice(db, db.__store, "q1", fin), (e) => e.code === "PO_SCOPE_OVERRUN_UNRESOLVED" || /exceed quoted hours/.test(e.message), "blocked before evidence");
  assert.equal(db.invoices.length, 0);
  assert.equal(attach(db, "sales1", { kind: "amendment_note", note: "Client approved the extra 12 hours." }).statusCode, 201);
  issueLegacyInvoice(db, db.__store, "q1", fin);
  assert.equal(db.invoices.length, 1);
  assert.equal(db.po_scope_evidence[0].consumed_invoice_id, db.invoices[0].id);
  assert.equal(P.activeScopeEvidence(db, "q1", db.po_scope_evidence[0].variance_hash), null, "consumed evidence no longer clears the gate");
}));

// ---------------------------------------------------------------- consistency with the existing PO evidence formula
test("actual amount equals calculatePurchaseOrderEvidenceValue() in store.js (skipped when its dependencies are not installed)", async (t) => {
  let store_;
  try { store_ = await import("../src/store.js"); } catch { return t.skip("store.js needs bcrypt, which is not installed here"); }
  await withFlag(true, () => {
    const db = makeDb({ sheets: [sheet("a", 10)], po: { po_amount: 5 } });
    db.timesheets = [{ id: "t1", dispatch_card_id: "d1", hours_logged: 10, hourly_rate: 40, approved: true }, { id: "t2", dispatch_card_id: "d1", hours_logged: 2, hourly_rate: 7 }];
    db.material_usage = [{ id: "m1", dispatch_card_id: "d1", total_cost: 150 }, { id: "m2", dispatch_card_id: "other", total_cost: 999 }];
    assert.equal(core(db).amount.actual, store_.calculatePurchaseOrderEvidenceValue(db, "po1"));
  })();
});
