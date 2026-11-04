import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { collectionGuards, getCollection } from "../src/controllers/coreController.js";
import { permissions, roles } from "../src/permissions.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const routerSource = read("src/router.js");
const controllerSource = read("src/controllers/internalWorkRequestsController.js");
const rulesSource = read("src/internalWorkRequestRules.js");
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test("internal work requests are not exposed or archivable through the generic collection routes", () => {
  assert.equal("internal_work_requests" in collectionGuards, false);
  const collectionsBlock = /const collections = \[([\s\S]*?)\];/.exec(routerSource)?.[1] || "";
  assert.ok(collectionsBlock.length > 0, "generic collections list must still exist");
  assert.equal(collectionsBlock.includes("internal_work_requests"), false);
  for (const role of Object.values(roles)) {
    const actor = { id: `${role}-1`, role, is_active: true, client_id: role === roles.CLIENT_VIEWER ? "c_a" : undefined };
    const res = response();
    getCollection("internal_work_requests")({ user: { id: actor.id }, db: { users: [actor], internal_work_requests: [{ id: "iwr_1", created_by_user_id: "someone" }] } }, res);
    assert.equal(res.statusCode, 403, `${role} must not read internal_work_requests through the generic route`);
  }
});

test("exactly the eight approved routes exist, behind authentication, with fixed paths before /:id", () => {
  const authIndex = routerSource.indexOf("router.use(authMiddleware);");
  assert.ok(authIndex > 0);
  const routes = [...routerSource.matchAll(/router\.(get|post|patch|put|delete)\("(\/internal-work-requests[^"]*)"/g)];
  assert.deepEqual(routes.map((match) => `${match[1].toUpperCase()} ${match[2]}`), [
    "GET /internal-work-requests/options", "GET /internal-work-requests/outbox", "GET /internal-work-requests/inbox", "GET /internal-work-requests/:id",
    "POST /internal-work-requests", "POST /internal-work-requests/:id/acknowledge", "POST /internal-work-requests/:id/approve-technician",
    "POST /internal-work-requests/:id/transition"
  ], "no generic write, PATCH, PUT or DELETE route exists");
  for (const match of routes) assert.ok(match.index > authIndex, `${match[2]} must be registered after authMiddleware`);
  assert.match(routerSource, /router\.post\("\/internal-work-requests", validate\(CreateInternalWorkRequestSchema\), createInternalWorkRequest\)/);
  assert.match(routerSource, /router\.post\("\/internal-work-requests\/:id\/transition", validate\(TransitionInternalWorkRequestSchema\), transitionInternalWorkRequest\)/);
});

test("only the technician registration controller creates an account, and only behind Admin permissions", () => {
  const registrationSource = read("src/controllers/technicianRegistrationController.js");
  // The pinned controller and rules still never touch users (the test above
  // enforces that); the single exception is this one file.
  assert.match(registrationSource, /users\.push\(user\)/);
  assert.match(registrationSource, /hasPermission\(actor, "workInternalWorkRequest"\) \|\| !hasPermission\(actor, "manageUsers"\)/);
  assert.match(routerSource, /router\.post\("\/internal-work-requests\/:id\/approve-technician", approveTechnicianRegistration\)/);
  assert.doesNotMatch(controllerSource, /approveTechnicianRegistration|users\s*\.\s*push/);
  // Same fences as the main controller: no outside channel, only id() and audit() on the store.
  assert.doesNotMatch(registrationSource, /nodemailer|sendMail|socket|WebSocket|\bfetch\s*\(|node:fs|node:http|from "pg"|pool\b|\.query\s*\(/);
  assert.deepEqual([...new Set([...registrationSource.matchAll(/req\.store\.(\w+)/g)].map((match) => match[1]))].sort(), ["audit", "id"]);
  assert.doesNotMatch(registrationSource, /req\.(body|query)\b/, "the account is built from the stored request, never from the call");
  // The ID and phone number must never be written to an audit record.
  const auditCalls = [...registrationSource.matchAll(/req\.store\.audit\([\s\S]*?\);/g)].map((match) => match[0]);
  assert.equal(auditCalls.length, 2);
  for (const call of auditCalls) assert.doesNotMatch(call, /\bnational_id\b|\bphone_number\b|\bpayload\b/);
});

test("named permissions are explicit, exclude Client Viewer, and make Admin read-only", () => {
  assert.deepEqual([...permissions.createInternalWorkRequest].sort(), ["Finance", "Management", "Operations", "Sales", "Supervisor", "Technician"]);
  assert.deepEqual([...permissions.viewInternalWorkRequestInbox].sort(), ["Admin", "Finance", "Management", "Operations", "Sales"]);
  assert.deepEqual(permissions.auditInternalWorkRequests, ["Admin"]);
  assert.equal(permissions.createInternalWorkRequest.includes("Admin"), false);
  assert.equal(permissions.viewInternalWorkRequestOutbox.includes("Admin"), false);
});

test("the controller reads scope only from the session and touches no other business record, channel or store call", () => {
  // The only query input is the status filter.
  const queryReads = [...controllerSource.matchAll(/req\.query[^\n;]*/g)].map((match) => match[0]);
  assert.ok(queryReads.length > 0);
  for (const read of queryReads) assert.match(read, /req\.query\?\.status/, `unexpected query read: ${read}`);
  // No identity, role, tenant or office is read from the request.
  assert.doesNotMatch(controllerSource, /req\.(body|query|params)\??\.(created_by|client_id|role|office|tenant|user_id|assigned)/);
  assert.doesNotMatch(controllerSource, /req\.(headers|cookies)/);
  // Never mutates another business collection or stock.
  for (const source of [controllerSource, rulesSource]) {
    assert.doesNotMatch(source, /\.(quotes|quote_lines|purchase_orders|dispatch_cards|invoices|invoice_lines|timesheets|material_usage|stock_items|stock_movements|leads|users|notifications)\s*\.\s*(push|splice|pop|shift|unshift)\b/);
    assert.doesNotMatch(source, /quantity_on_hand\s*[-+]?=|recalculateVariance|transitionQuote|recordStockMovement/);
  }
  // No email, socket, HTTP client, filesystem or database access.
  for (const source of [controllerSource, rulesSource]) {
    assert.doesNotMatch(source, /nodemailer|sendMail|socket|WebSocket|\bfetch\s*\(|node:fs|node:http|from "pg"|pool\b|\.query\s*\(/);
  }
  // The only store calls are id() and audit().
  assert.deepEqual([...new Set([...controllerSource.matchAll(/req\.store\.(\w+)/g)].map((match) => match[1]))].sort(), ["audit", "id"]);
  // The fail-closed actor lookup is used, not the users[0] fallback. Strip
  // line comments first so an explanatory comment naming the avoided call
  // (e.g. "Deliberately NOT coreController.getActor()") cannot itself trip
  // this check; only a real call in code should fail it.
  const controllerCodeOnly = controllerSource.replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(controllerCodeOnly, /getActor\s*\(/);
  assert.match(controllerSource, /const actorFor = /);
});
