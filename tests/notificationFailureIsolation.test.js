import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../src/store.js";

test("a failure while generating a notification never fails or undoes the audited business change", () => {
  const store = createStore(":memory:");
  const db = { audit_logs: [], quotes: [] };
  Object.defineProperty(db, "notifications", { get() { throw new TypeError("boom"); }, set() {}, configurable: true });
  const lines = [];
  const original = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  try {
    assert.doesNotThrow(() => store.audit(db, { id: "u1" }, "access_request", "areq1", "ACCESS_REQUEST_CREATED", null, { id: "areq1" }));
  } finally { console.error = original; }
  assert.equal(db.audit_logs.length, 1, "the audit record is still written");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes("boom"), false, "only the error class is logged");
});

test("store.audit still produces the notification in the normal case", () => {
  const store = createStore(":memory:");
  const db = { audit_logs: [], notifications: [] };
  store.audit(db, { id: "u1" }, "access_request", "areq1", "ACCESS_REQUEST_CREATED", null, { id: "areq1" });
  assert.equal(db.notifications.length, 1);
});
