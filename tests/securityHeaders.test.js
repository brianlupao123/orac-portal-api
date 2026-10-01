import test from "node:test";
import assert from "node:assert/strict";
import { securityHeaders } from "../src/middleware/securityHeaders.js";
import { makeReq, run } from "./_http.js";

test("always sets nosniff, frame denial and no-referrer; calls next", () => {
  const { res, passed } = run(securityHeaders(), makeReq({ method: "GET", path: "/x" }));
  assert.equal(passed, true);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["x-frame-options"], "DENY");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
});
test("HSTS only in production, without includeSubDomains", () => {
  const dev = run(securityHeaders({ isProduction: false }), makeReq({ method: "GET" })).res;
  assert.equal(dev.headers["strict-transport-security"], undefined);
  const prod = run(securityHeaders({ isProduction: true }), makeReq({ method: "GET" })).res;
  assert.match(prod.headers["strict-transport-security"], /^max-age=\d+$/);
  assert.doesNotMatch(prod.headers["strict-transport-security"], /includeSubDomains/i);
});
test("no-store on /api paths only", () => {
  const api = run(securityHeaders(), { ...makeReq({ method: "GET" }), originalUrl: "/api/summary" }).res;
  assert.equal(api.headers["cache-control"], "no-store");
  const asset = run(securityHeaders(), { ...makeReq({ method: "GET" }), originalUrl: "/assets/app.js" }).res;
  assert.equal(asset.headers["cache-control"], undefined);
});
