import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { collectionGuards, getCollection } from "../src/controllers/coreController.js";
import { permissions, roles } from "../src/permissions.js";
import { normalizeDb } from "../src/store.js";

const routerSource = readFileSync(new URL("../src/router.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test("service requests are not exposed through the generic collection route", () => {
  assert.equal("service_requests" in collectionGuards, false);
  const collectionsBlock = /const collections = \[([\s\S]*?)\];/.exec(routerSource)?.[1] || "";
  assert.ok(collectionsBlock.length > 0, "generic collections list must still exist");
  assert.equal(collectionsBlock.includes("service_requests"), false);

  for (const role of Object.values(roles)) {
    const actor = { id: `${role}-1`, role, is_active: true, client_id: role === roles.CLIENT_VIEWER ? "c_a" : undefined };
    const res = response();
    getCollection("service_requests")({ user: { id: actor.id }, db: { users: [actor], service_requests: [{ id: "sr_1", client_id: "c_a" }] } }, res);
    assert.equal(res.statusCode, 403, `${role} must not read service_requests through the generic route`);
  }
});

test("the five approved routes are registered behind authentication and nothing else", () => {
  const authIndex = routerSource.indexOf("router.use(authMiddleware);");
  assert.ok(authIndex > 0);
  const routes = [...routerSource.matchAll(/router\.(get|post|patch|put|delete)\("(\/service-requests[^"]*)"/g)].map((match) => `${match[1].toUpperCase()} ${match[2]}`);
  assert.deepEqual(routes.sort(), [
    "GET /service-requests/mine", "GET /service-requests/triage", "POST /service-requests",
    "POST /service-requests/:id/convert-lead", "POST /service-requests/:id/triage"
  ].sort());
  for (const match of routerSource.matchAll(/router\.(?:get|post)\("(\/service-requests[^"]*)"/g)) {
    assert.ok(match.index > authIndex, `${match[1]} must be registered after authMiddleware`);
  }
  assert.match(routerSource, /router\.post\("\/service-requests", validate\(CreateServiceRequestSchema\), createServiceRequest\)/);
  assert.match(routerSource, /router\.post\("\/service-requests\/:id\/triage", validate\(TriageServiceRequestSchema\), triageServiceRequest\)/);
});

test("service request permissions are explicit and exclude every unrelated role", () => {
  assert.deepEqual(permissions.createServiceRequest, [roles.CLIENT_VIEWER]);
  assert.deepEqual(permissions.viewOwnServiceRequests, [roles.CLIENT_VIEWER]);
  assert.deepEqual([...permissions.triageServiceRequests].sort(), [roles.OPERATIONS, roles.SALES].sort());
  assert.deepEqual([...permissions.convertServiceRequest].sort(), [roles.OPERATIONS, roles.SALES].sort());
  for (const name of ["createServiceRequest", "viewOwnServiceRequests", "triageServiceRequests", "convertServiceRequest"]) {
    for (const role of [roles.ADMIN, roles.MANAGEMENT, roles.FINANCE, roles.SUPERVISOR, roles.TECHNICIAN]) {
      assert.equal(permissions[name].includes(role), false, `${role} must not hold ${name}`);
    }
  }
});

test("the persisted aggregate gains an empty service_requests array without touching existing data", () => {
  const fresh = normalizeDb({ users: [] });
  assert.ok(Array.isArray(fresh.service_requests));
  assert.equal(fresh.service_requests.length, 0);

  const existing = { id: "sr_keep", client_id: "c_a", status: "Accepted" };
  const kept = normalizeDb({ users: [], service_requests: [existing] });
  assert.deepEqual(kept.service_requests, [existing]);

  const repaired = normalizeDb({ users: [], service_requests: "corrupt" });
  assert.deepEqual(repaired.service_requests, []);
});
