import assert from "node:assert/strict";
import test from "node:test";
import { linkV5AmendmentToDispatch } from "../src/controllers/v5AmendmentLinkController.js";
import { database, call, withV5 } from "./helpers/v5SignatureFixture.js";

function setup() {
  const db = database();
  db.users.push({ id: "fin-1", role: "Finance", is_active: true });
  db.purchase_orders = [{ id: "po-amend-1", quotation_id: "quote-amend-1", po_reference: "PO-AMEND-1", po_amount: 100, status: "verified" }];
  db.quotes.push({
    id: "quote-amend-1", quote_number: "Q-0001-R2", v5_commercial_workflow: true,
    root_quote_id: "quote-1", revision_of_quote_id: "quote-1", commercial_acceptance_status: "po_verified",
    commercial_acceptance_po_id: "po-amend-1", v5_amendment_approval: { approved_by: "fin-1", approved_at: "2026-10-20T10:00:00.000Z" }
  });
  return db;
}

function link(db, actor = "sales-1", body = {}) {
  return call(linkV5AmendmentToDispatch, db, actor, {
    params: { id: "job-1" },
    body: { amendment_quote_id: "quote-amend-1", idempotency_key: "v5-amendment-link-0001", ...body }
  });
}

test("V5 amendment-to-dispatch linking is dark by default", () => {
  const db = setup();
  assert.equal(link(db).statusCode, 409);
  assert.equal(db.v5_amendment_dispatch_links, undefined);
});

test("Sales can append one approved, same-lineage V5 amendment link without exposing retry internals", () => withV5(() => {
  const db = setup();
  const created = link(db);
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.data.dispatch_card_id, "job-1");
  assert.equal(created.body.data.amendment_quote_id, "quote-amend-1");
  assert.equal(created.body.data.amendment_purchase_order_id, "po-amend-1");
  assert.equal(JSON.stringify(created.body.data).includes("idempotency"), false);
  assert.equal(db.v5_amendment_dispatch_links.length, 1);
  assert.equal(db.audit_logs.at(-1).action, "V5_AMENDMENT_LINKED_TO_DISPATCH");
}));

test("V5 amendment links replay exact retries and reject duplicate or mismatched links", () => withV5(() => {
  const db = setup();
  assert.equal(link(db).statusCode, 201);
  const replay = link(db);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.idempotent_replay, true);
  assert.equal(link(db, "sales-1", { amendment_quote_id: "quote-1" }).statusCode, 409);
  assert.equal(link(db, "sales-1", { idempotency_key: "v5-amendment-link-0002" }).body.code, "V5_AMENDMENT_ALREADY_LINKED");
}));

test("linking refuses unapproved, unverified, cross-lineage and unauthorized amendments", () => withV5(() => {
  const db = setup();
  delete db.quotes[1].v5_amendment_approval;
  assert.equal(link(db).body.code, "V5_AMENDMENT_NOT_APPROVED");
  db.quotes[1].v5_amendment_approval = { approved_by: "fin-1", approved_at: "2026-10-20T10:00:00.000Z" };
  db.quotes[1].root_quote_id = "other-root";
  assert.equal(link(db).body.code, "V5_AMENDMENT_LINEAGE_MISMATCH");
  db.quotes[1].root_quote_id = "quote-1";
  assert.throws(() => link(db, "fin-1"), /cannot perform manageV5AmendmentLink/);
}));
