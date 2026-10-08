// PO position (acceptance C11) and Finance paper sampling (D5). Dependency-free; synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { hasPermission } from "../src/permissions.js";
import * as W from "../src/timesheetWorkflow.js";
import * as C from "../src/controllers/timesheetWorkflowController.js";
import { makeRes, makeReq } from "./_http.js";

const withFlags = (flags, fn) => async () => {
  const keys = ["TIMESHEET_PAPER_CAPTURE", "TIMESHEET_INVOICE_VARIANCE"]; const saved = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const k of flags) process.env[k] = "enabled";
  try { await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const u = (id, role) => ({ id, role, is_active: true, name: id });
const paper = (id, by, at, sampled = false) => ({ id, status: "Captured_From_Signed_Paper", work_date: "2026-03-02", dispatch_card_id: "d1", hours: 8,
  paper_capture: { captured_by: by, captured_at: at, finance_sampling: sampled, reason_code: "client_not_on_portal", client_paper_reference: "R", scan_hash: "h" } });
const db = (sheets = []) => ({ users: [u("fin1", "Finance"), u("sales1", "Sales"), u("admin", "Admin")], dispatch_cards: [{ id: "d1", quotation_id: "q1", purchase_order_id: "po1" }],
  purchase_orders: [{ id: "po1", quotation_id: "q1", po_amount: 1000, po_reference: "PO-1" }], invoices: [{ id: "i1", purchase_order_id: "po1", total_amount: 400 }],
  field_worksheets: sheets, timesheets: [], timesheet_variance_overrides: [], company_profile: {} });
const call = (fn, d, user, query = {}, params = {}) => { const res = makeRes(); fn(makeReq({ db: d, store: { audit() {}, id: (p) => p }, user: { id: user }, params })); return res; };
const callQ = (fn, d, user, query) => { const res = makeRes(); const req = makeReq({ db: d, user: { id: user }, params: { id: "d1" } }); req.query = query; fn(req, res); return res; };

test("PO position reports value remaining, never invents hours, and says so when no PO value exists", () => {
  const p = W.poPosition(db(), "d1");
  assert.equal(p.available, true); assert.equal(p.remaining_value, 600); assert.equal(p.remaining_hours, null);
  const none = db(); none.purchase_orders[0].po_amount = 0;
  assert.equal(W.poPosition(none, "d1").available, false);
  const full = db(); full.invoices[0].total_amount = 1000;
  assert.match(W.poPosition(full, "d1").warning, /fully invoiced/);
});

test("variance view includes the PO position for Finance only", withFlags(["TIMESHEET_INVOICE_VARIANCE"], () => {
  const d = db(); const res = callQ(C.getInvoiceVariance, d, "fin1", {});
  assert.equal(res.body.data.po_position.remaining_value, 600);
  assert.throws(() => callQ(C.getInvoiceVariance, d, "sales1", {}), /cannot perform/);
}));

test("paper sampling: per capturer, minimum and percent applied, flagged records always included, month filtered", () => {
  const rows = []; for (let i = 0; i < 30; i++) rows.push(paper(`p${String(i).padStart(2, "0")}`, "sales1", "2026-03-10T00:00:00Z", i === 29));
  rows.push(paper("x1", "sales1", "2026-04-01T00:00:00Z"), paper("y1", "sales2", "2026-03-11T00:00:00Z"));
  const plan = W.paperSamplingPlan(db(rows), "2026-03");
  const s1 = plan.find((c) => c.capturer_user_id === "sales1"); const s2 = plan.find((c) => c.capturer_user_id === "sales2");
  assert.equal(s1.captured_count, 30); assert.equal(s1.sample_size, 3); assert.ok(s1.sample.some((r) => r.id === "p29"));
  assert.equal(s2.sample_size, 1); // fewer than the minimum: sample everything
  assert.deepEqual(W.paperSamplingPlan(db(rows), "2026-03"), plan); // deterministic
  assert.ok(!JSON.stringify(plan).includes("rate"));
});

test("paper sampling endpoint: dark by default, Finance/Admin only, validates month", withFlags([], () => {
  const d = db(); assert.equal(callQ(C.getPaperSampling, d, "fin1", { month: "2026-03" }).statusCode, 409);
}));
test("paper sampling endpoint when enabled", withFlags(["TIMESHEET_PAPER_CAPTURE"], () => {
  const d = db([paper("p1", "sales1", "2026-03-10T00:00:00Z")]);
  assert.equal(callQ(C.getPaperSampling, d, "fin1", { month: "2026-03" }).body.data.capturers.length, 1);
  assert.equal(callQ(C.getPaperSampling, d, "fin1", { month: "March" }).statusCode, 400);
  assert.throws(() => callQ(C.getPaperSampling, d, "sales1", { month: "2026-03" }), /cannot perform/);
  assert.equal(hasPermission(u("a", "Admin"), "viewPaperSampling"), true);
}));
