import test from "node:test";
import assert from "node:assert/strict";
import { collectionGuards } from "../src/controllers/coreController.js";
import { permissions, roles } from "../src/permissions.js";
import {
  INTERNAL_WORK_REQUEST_ACTIONS, INTERNAL_WORK_REQUEST_POLICY, INTERNAL_WORK_REQUEST_STATUS, INTERNAL_WORK_REQUEST_TYPE_CODES,
  RELATED_ENTITY_TYPES, allowedActionsFor, belongsInInbox, canReadRequest, findLifecycleAction, findRequestType, isPairingAllowed,
  pairingRows, parseCreateBody, parseTransitionBody, policyRecipientRoles, policySenderRoles, recipientsFor, requestTypesFor, toAuditSnapshot
} from "../src/internalWorkRequestRules.js";

const person = (id, role, extra = {}) => ({ id, role, is_active: true, ...extra });

// The proposed pairing matrix, pinned as a literal. Changing the owner-decision
// table must be a deliberate edit to THIS table as well.
const PINNED_MATRIX = [
  ["STOCK_AVAILABILITY", "Sales", "Operations"],
  ["STOCK_FULFILMENT", "Sales", "Operations"],
  ["STOCK_FULFILMENT", "Operations", "Operations"],
  ["PO_AMENDMENT_CONFIRMATION", "Finance", "Sales"],
  ["PO_AMENDMENT_CONFIRMATION", "Finance", "Operations"],
  ["MATERIAL_RECONCILIATION", "Operations", "Finance"],
  ["FIELD_CLARIFICATION", "Technician", "Operations"],
  ["FIELD_CLARIFICATION", "Supervisor", "Operations"],
  ["COMMERCIAL_CLARIFICATION", "Operations", "Sales"],
  ["COMMERCIAL_CLARIFICATION", "Operations", "Finance"],
  ...["Sales", "Finance", "Operations", "Supervisor", "Technician"].flatMap((sender) => [
    ["ADMINISTRATIVE_SUPPORT", sender, "Admin"], ["ADMINISTRATIVE_SUPPORT", sender, "Management"]
  ]),
  ["ADMINISTRATIVE_SUPPORT", "Management", "Admin"]
];

test("the sender / type / recipient policy equals the pinned owner-decision table", () => {
  const actual = pairingRows().map((row) => [row.type, row.sender, row.recipient]);
  const key = (row) => row.join("|");
  assert.deepEqual(actual.map(key).sort(), PINNED_MATRIX.map(key).sort());
  assert.equal(INTERNAL_WORK_REQUEST_TYPE_CODES.length, 7);
});

test("Client Viewer appears nowhere, and Admin is recipient-only", () => {
  const rows = pairingRows();
  assert.equal(rows.some((row) => row.sender === roles.CLIENT_VIEWER || row.recipient === roles.CLIENT_VIEWER), false);
  assert.equal(rows.some((row) => row.sender === roles.ADMIN), false, "Admin must not be a requester");
  assert.ok(rows.some((row) => row.recipient === roles.ADMIN), "Admin receives administrative support");
});

test("endpoint permissions are derived from, and stay in step with, the pairing policy", () => {
  assert.deepEqual([...permissions.createInternalWorkRequest].sort(), policySenderRoles().sort());
  assert.deepEqual([...permissions.viewInternalWorkRequestOutbox].sort(), policySenderRoles().sort());
  assert.deepEqual([...permissions.viewInternalWorkRequestInbox].sort(), policyRecipientRoles().sort());
  assert.deepEqual([...permissions.workInternalWorkRequest].sort(), policyRecipientRoles().sort());
  assert.deepEqual(permissions.auditInternalWorkRequests, [roles.ADMIN]);
  for (const name of ["createInternalWorkRequest", "viewInternalWorkRequestOutbox", "viewInternalWorkRequestInbox", "workInternalWorkRequest", "auditInternalWorkRequests"]) {
    assert.equal(permissions[name].includes(roles.CLIENT_VIEWER), false, `Client Viewer must not hold ${name}`);
  }
});

test("every pairing that requires a related record lets the sender read at least one allowed record type", () => {
  for (const { type, sender } of pairingRows()) {
    const policy = INTERNAL_WORK_REQUEST_POLICY[type];
    for (const related of policy.related_entity_types) {
      assert.ok(RELATED_ENTITY_TYPES[related], `${type}: unknown related type ${related}`);
      assert.ok(collectionGuards[RELATED_ENTITY_TYPES[related].collection], `${related} collection needs an explicit read guard`);
    }
    if (policy.related_required) {
      const readable = policy.related_entity_types.filter((related) => collectionGuards[RELATED_ENTITY_TYPES[related].collection].includes(sender));
      assert.ok(readable.length > 0, `${sender} can read none of the related records ${type} requires`);
    }
  }
  assert.deepEqual(INTERNAL_WORK_REQUEST_POLICY.ADMINISTRATIVE_SUPPORT.related_entity_types, [], "administrative support carries no related record");
});

test("policy lookups use own properties only and hand out copies", () => {
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "", null, undefined, 7]) {
    assert.equal(findRequestType(name), null);
    assert.equal(findLifecycleAction(name), null);
    assert.deepEqual(recipientsFor(name, "Sales"), []);
  }
  assert.deepEqual(recipientsFor("STOCK_AVAILABILITY", "constructor"), []);
  const list = recipientsFor("COMMERCIAL_CLARIFICATION", "Operations");
  list.push("Admin");
  assert.deepEqual(recipientsFor("COMMERCIAL_CLARIFICATION", "Operations"), ["Sales", "Finance"], "callers cannot mutate the policy");
  assert.equal(isPairingAllowed("STOCK_AVAILABILITY", "Sales", "Operations"), true);
  assert.equal(isPairingAllowed("STOCK_AVAILABILITY", "Operations", "Sales"), false);
  assert.throws(() => { INTERNAL_WORK_REQUEST_POLICY.STOCK_AVAILABILITY.pairings.Finance = ["Admin"]; }, TypeError);
  assert.deepEqual(requestTypesFor("Technician"), ["FIELD_CLARIFICATION", "ADMINISTRATIVE_SUPPORT"]);
  assert.deepEqual(requestTypesFor("Client Viewer"), []);
  assert.deepEqual(requestTypesFor("Admin"), []);
});

test("the lifecycle table is exactly the contract's and has no reopen or reassignment", () => {
  const S = INTERNAL_WORK_REQUEST_STATUS;
  const summary = Object.fromEntries(Object.entries(INTERNAL_WORK_REQUEST_ACTIONS).map(([name, a]) => [name, [a.from.join(","), a.to, a.note]]));
  assert.deepEqual(summary, {
    acknowledge: [S.SUBMITTED, S.ACKNOWLEDGED, "none"],
    start: [S.ACKNOWLEDGED, S.IN_PROGRESS, "optional"],
    complete: [`${S.ACKNOWLEDGED},${S.IN_PROGRESS}`, S.COMPLETED, "required"],
    reject: [`${S.SUBMITTED},${S.ACKNOWLEDGED}`, S.REJECTED, "required"],
    cancel: [`${S.SUBMITTED},${S.ACKNOWLEDGED}`, S.CANCELLED, "required"]
  });
  const targets = Object.values(INTERNAL_WORK_REQUEST_ACTIONS).map((a) => a.to);
  assert.equal(targets.includes(S.SUBMITTED), false, "nothing moves back to Submitted");
  for (const terminal of [S.COMPLETED, S.REJECTED, S.CANCELLED]) {
    assert.equal(Object.values(INTERNAL_WORK_REQUEST_ACTIONS).some((a) => a.from.includes(terminal)), false, `${terminal} is final`);
  }
});

test("allowed actions follow the requester / recipient / assignee roles and status", () => {
  const requester = person("u_sales", "Sales");
  const ops = person("u_ops", "Operations");
  const ops2 = person("u_ops2", "Operations");
  const finance = person("u_finance", "Finance");
  const admin = person("u_admin", "Admin");
  const base = { recipient_role: "Operations", created_by_user_id: "u_sales", assigned_to_user_id: null, resolved_by_user_id: null };
  const at = (status, extra = {}) => ({ ...base, status, ...extra });

  assert.deepEqual(allowedActionsFor(at("Submitted"), ops), ["acknowledge", "reject"]);
  assert.deepEqual(allowedActionsFor(at("Submitted"), requester), ["cancel"]);
  assert.deepEqual(allowedActionsFor(at("Submitted"), finance), []);
  assert.deepEqual(allowedActionsFor(at("Submitted"), admin), [], "Admin audit access carries no action");
  assert.deepEqual(allowedActionsFor(at("Acknowledged", { assigned_to_user_id: "u_ops" }), ops), ["start", "complete", "reject"]);
  assert.deepEqual(allowedActionsFor(at("Acknowledged", { assigned_to_user_id: "u_ops" }), ops2), []);
  assert.deepEqual(allowedActionsFor(at("Acknowledged", { assigned_to_user_id: "u_ops" }), requester), ["cancel"]);
  assert.deepEqual(allowedActionsFor(at("In Progress", { assigned_to_user_id: "u_ops" }), ops), ["complete"]);
  assert.deepEqual(allowedActionsFor(at("In Progress", { assigned_to_user_id: "u_ops" }), requester), [], "no cancel once work has progressed");
  for (const status of ["Completed", "Rejected", "Cancelled"]) {
    for (const actor of [requester, ops, admin]) assert.deepEqual(allowedActionsFor(at(status, { assigned_to_user_id: "u_ops" }), actor), []);
  }
  assert.deepEqual(allowedActionsFor(at("Submitted"), { ...ops, is_active: false }), []);
  assert.deepEqual(allowedActionsFor(at("Acknowledged", { assigned_to_user_id: "u_ops" }), { ...ops, role: "Finance" }), [], "an assignee whose role changed can no longer act");
  // Same-role requester (Operations -> Operations) is never the recipient.
  assert.deepEqual(allowedActionsFor({ ...at("Submitted"), created_by_user_id: "u_ops" }, ops), ["cancel"]);
});

test("read and inbox membership are participant-scoped", () => {
  const record = { recipient_role: "Operations", created_by_user_id: "u_sales", assigned_to_user_id: null, resolved_by_user_id: null, status: "Submitted" };
  const ops = person("u_ops", "Operations");
  assert.equal(canReadRequest(record, person("u_sales", "Sales")), true);
  assert.equal(canReadRequest(record, ops), true);
  assert.equal(canReadRequest(record, person("u_sales2", "Sales")), false);
  assert.equal(canReadRequest(record, person("u_finance", "Finance")), false);
  assert.equal(canReadRequest(record, person("u_tech", "Technician")), false);
  assert.equal(canReadRequest(record, person("u_client_a", "Client Viewer", { client_id: "c_a" })), false);
  assert.equal(canReadRequest(record, person("u_admin", "Admin")), true, "Admin has read-only audit access");
  const claimed = { ...record, status: "Acknowledged", assigned_to_user_id: "u_ops" };
  assert.equal(canReadRequest(claimed, ops), true);
  assert.equal(canReadRequest(claimed, person("u_ops2", "Operations")), false, "a colleague loses sight once it is claimed");
  assert.equal(belongsInInbox(record, ops), true);
  assert.equal(belongsInInbox(claimed, person("u_ops2", "Operations")), false);
  assert.equal(belongsInInbox({ ...record, created_by_user_id: "u_ops" }, ops), false, "a requester never sees own request in the inbox");
  assert.equal(belongsInInbox({ ...record, status: "Cancelled", resolved_by_user_id: "u_sales" }, person("u_sales", "Sales")), false);
  assert.equal(belongsInInbox(record, person("u_tech", "Technician")), false);
});

test("audit projections carry metadata only, never the subject, description or any note", () => {
  const record = {
    id: "iwr_1", request_type: "STOCK_AVAILABILITY", subject: "SUBJECT-SECRET", description: "DESCRIPTION-SECRET", priority: "High", status: "Completed",
    created_by_user_id: "u_sales", created_by_role: "Sales", recipient_role: "Operations", assigned_to_user_id: "u_ops",
    related_entity_type: "quote", related_entity_id: "q_a", client_id: "c_a", resolution_note: "NOTE-SECRET",
    history: [{ note: "HISTORY-SECRET" }], created_at: "t1", updated_at: "t2", resolved_at: "t3"
  };
  const snapshot = toAuditSnapshot(record);
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "assigned_to_user_id", "client_id", "created_at", "created_by_role", "created_by_user_id", "has_resolution_note", "id", "priority",
    "recipient_role", "related_entity_id", "related_entity_type", "request_type", "resolved_at", "status", "updated_at"
  ]);
  assert.equal(snapshot.has_resolution_note, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET/);
});

test("create-body parsing whitelists fields, trims text and enforces limits", () => {
  const good = parseCreateBody({
    request_type: "STOCK_AVAILABILITY", subject: "  Availability  ", description: " Need 10 m2 ", recipient_role: "Operations",
    related_entity_type: "quote", related_entity_id: " q_a ", created_by_user_id: "u_admin", client_id: "c_b", status: "Completed", history: [1]
  });
  assert.equal(good.ok, true);
  assert.deepEqual(good.value, {
    request_type: "STOCK_AVAILABILITY", subject: "Availability", description: "Need 10 m2", priority: "Normal", recipient_role: "Operations",
    related_entity_type: "quote", related_entity_id: "q_a"
  });
  const bad = (body) => parseCreateBody(body);
  assert.equal(bad(null).ok, false);
  assert.equal(bad([]).ok, false);
  assert.equal(bad({ request_type: "constructor", subject: "s", description: "d" }).ok, false);
  assert.equal(bad({ request_type: "STOCK_AVAILABILITY", subject: "   ", description: "d" }).ok, false);
  assert.equal(bad({ request_type: "STOCK_AVAILABILITY", subject: "s", description: "d".repeat(2001) }).ok, false);
  assert.equal(bad({ request_type: "STOCK_AVAILABILITY", subject: "s".repeat(161), description: "d" }).ok, false);
  assert.equal(bad({ request_type: "STOCK_AVAILABILITY", subject: 5, description: "d" }).ok, false);
  assert.equal(bad({ request_type: "STOCK_AVAILABILITY", subject: "s", description: "d", priority: "Whenever" }).ok, false);
  assert.equal(bad({ request_type: "STOCK_AVAILABILITY", subject: "s", description: "d", related_entity_type: "quote" }).ok, false, "type without id");
  assert.equal(bad({ request_type: "STOCK_AVAILABILITY", subject: "s", description: "d", related_entity_id: "q_a" }).ok, false, "id without type");
  assert.equal(bad({ request_type: "STOCK_AVAILABILITY", subject: "s", description: "d", related_entity_type: "user", related_entity_id: "u_admin" }).ok, false);
  assert.equal(bad({ request_type: "STOCK_AVAILABILITY", subject: "s", description: "d", related_entity_type: { a: 1 }, related_entity_id: "x" }).ok, false);
});

test("transition-body parsing accepts only the four transition verbs", () => {
  assert.deepEqual(parseTransitionBody({ action: "complete", note: "  Done  ", status: "Completed" }), { ok: true, value: { action: "complete", note: "Done" } });
  assert.deepEqual(parseTransitionBody({ action: "start" }), { ok: true, value: { action: "start", note: "" } });
  for (const action of ["acknowledge", "Completed", "constructor", "__proto__", "", null, undefined, 3]) {
    assert.equal(parseTransitionBody({ action }).ok, false, String(action));
  }
  assert.equal(parseTransitionBody(null).ok, false);
  assert.equal(parseTransitionBody({ action: "cancel", note: "n".repeat(1001) }).ok, false);
  assert.equal(parseTransitionBody({ action: "cancel", note: 5 }).ok, false);
});
