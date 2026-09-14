import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAiHealth, getAttentionItems, getBriefing, getMetricExplanation } from "../src/controllers/aiController.js";
import { buildScopedSummary } from "../src/controllers/coreController.js";
import { approvedKnowledgeArticles } from "../src/services/knowledgeBase.js";

function response() {
  return {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function request(role, body = {}) {
  const actor = { id: `${role.toLowerCase()}-1`, role, is_active: true };
  const auditEntries = [];
  const db = {
    users: [actor],
    clients: [{ id: "client-a" }],
    quotes: [{ id: "quote-a", client_id: "client-a", status: "Approved_Pending_PO" }],
    purchase_orders: [{ id: "po-a", quotation_id: "quote-a", requires_amendment: true }],
    invoices: [{ id: "invoice-a" }],
    dispatch_cards: [{ id: "dispatch-a", quotation_id: "quote-a" }],
    field_worksheets: [{ id: "worksheet-a", status: "Submitted" }],
    audit_logs: auditEntries
  };
  return {
    user: { id: actor.id },
    body,
    db,
    auditEntries,
    store: {
      audit(_db, auditActor, entityType, entityId, action, oldValues, newValues) {
        auditEntries.push({ auditActor, entityType, entityId, action, oldValues, newValues });
      }
    }
  };
}

test("providerless briefing claims are exact fields from the Operations scoped summary", () => {
  const req = request("Operations", { role: "Admin", clientId: "other-client" });
  const res = response();

  getBriefing(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.label, "Verified dashboard summary");
  const summary = buildScopedSummary(req.db, req.db.users[0]);
  for (const item of res.body.data.claims) {
    assert.ok(Object.hasOwn(summary, item.metric));
    assert.equal(item.value, summary[item.metric]);
    assert.ok(Array.isArray(item.evidenceRefs));
    for (const ref of item.evidenceRefs) {
      assert.equal(ref.metric, item.metric);
      assert.ok(Object.hasOwn(summary, ref.metric));
      assert.equal(ref.value, summary[ref.metric]);
      assert.match(ref.targetId, /^evidence-/);
    }
  }
  assert.ok(res.body.data.evidenceRefs.length > 0);
  assert.equal(req.auditEntries.length, 1);
  assert.equal(req.auditEntries[0].action, "AI_PHASE_0_5_RESPONSE");
  assert.deepEqual(req.auditEntries[0].newValues.metric_keys, res.body.data.claims.map((item) => item.metric));
  assert.deepEqual(req.auditEntries[0].newValues.evidence_targets, res.body.data.evidenceRefs.map((item) => item.targetId));
});

test("Finance attention items use only its current summary payload", () => {
  const req = request("Finance");
  const res = response();

  getAttentionItems(req, res);

  assert.equal(res.body.data.label, "Verified dashboard summary");
  const summary = buildScopedSummary(req.db, req.db.users[0]);
  for (const item of res.body.data.claims) {
    assert.equal(item.value, summary[item.metric]);
    assert.ok(item.value > 0);
    assert.ok(item.evidenceRefs.every((ref) => Object.hasOwn(summary, ref.metric)));
  }
});

test("unknown metric returns unavailable and is still audited", () => {
  const req = request("Finance", { metric: "clientId" });
  const res = response();

  getMetricExplanation(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.label, "Unavailable");
  assert.deepEqual(res.body.data.claims, []);
  assert.deepEqual(res.body.data.evidenceRefs, []);
  assert.equal(req.auditEntries.length, 1);
  assert.deepEqual(req.auditEntries[0].newValues.metric_keys, []);
  assert.deepEqual(req.auditEntries[0].newValues.evidence_targets, []);
});

test("assistant evidence references are limited to metrics exposed for each enabled role", () => {
  const expectedTargets = {
    Admin: new Set(["evidence-kpi-clients", "evidence-kpi-quotes", "evidence-kpi-blocked-amendments"]),
    Management: new Set(["evidence-kpi-quotes", "evidence-kpi-dispatches", "evidence-kpi-worksheets-review"]),
    Sales: new Set(["evidence-kpi-clients", "evidence-kpi-quotes"]),
    Finance: new Set([
      "evidence-kpi-blocked-amendments",
      "evidence-pipeline-approved-pending-po",
      "evidence-kpi-invoices"
    ]),
    Operations: new Set([
      "evidence-kpi-dispatches",
      "evidence-kpi-worksheets-review",
      "evidence-kpi-returned-for-correction"
    ]),
    Supervisor: new Set(["evidence-kpi-dispatches", "evidence-kpi-worksheets-review", "evidence-kpi-returned-for-correction"]),
    Technician: new Set(["evidence-kpi-dispatches", "evidence-kpi-worksheets", "evidence-kpi-worksheets-review"]),
    "Client Viewer": new Set(["evidence-kpi-quotes", "evidence-kpi-dispatches", "evidence-kpi-invoices"])
  };

  for (const role of ["Admin", "Management", "Sales", "Finance", "Operations", "Supervisor", "Technician", "Client Viewer"]) {
    const req = request(role);
    const res = response();
    getBriefing(req, res);

    const summary = buildScopedSummary(req.db, req.db.users[0]);
    const claimMetrics = new Set(res.body.data.claims.map((claim) => claim.metric));

    for (const ref of res.body.data.evidenceRefs) {
      assert.ok(claimMetrics.has(ref.metric));
      assert.ok(Object.hasOwn(summary, ref.metric));
      assert.equal(ref.value, summary[ref.metric]);
      assert.match(ref.targetId, /^evidence-/);
      assert.ok(expectedTargets[role].has(ref.targetId));
    }
  }
});

test("every active ORAC role receives only its scoped providerless assistant configuration", () => {
  for (const role of ["Admin", "Management", "Sales", "Finance", "Operations", "Supervisor", "Technician", "Client Viewer"]) {
    const req = request(role);
    const res = response();
    getAiHealth(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.enabled, true);
    assert.ok(res.body.data.metrics.length > 0);
  }
});

test("knowledge-base lookup excludes drafts and requires complete approved metadata", () => {
  const directory = mkdtempSync(join(tmpdir(), "orac-kb-"));
  try {
    writeFileSync(join(directory, "draft.md"), "**Status:** Draft\n**Owner:** Operations\n**Approver:** Finance\n**Version:** 1.0\n");
    writeFileSync(join(directory, "approved.md"), "**Status:** Approved\n**Owner:** Operations\n**Approver:** Finance\n**Version:** 1.0\n");
    writeFileSync(join(directory, "incomplete.md"), "**Status:** Approved\n**Version:** 1.0\n");

    assert.deepEqual(approvedKnowledgeArticles(directory).map((article) => article.name), ["approved.md"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("providerless assistant source has no outbound HTTP implementation", () => {
  const source = [
    readFileSync(new URL("../src/controllers/aiController.js", import.meta.url), "utf8"),
    readFileSync(new URL("../src/services/aiTemplates.js", import.meta.url), "utf8")
  ].join("\n");

  assert.doesNotMatch(source, /\bfetch\s*\(|https?:\/\/|node:(https|http)/i);
});
