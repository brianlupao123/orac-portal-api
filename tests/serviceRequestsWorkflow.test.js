import test from "node:test";
import assert from "node:assert/strict";
import {
  createServiceRequest, listOwnServiceRequests, listServiceRequestTriageQueue,
  triageServiceRequest, convertServiceRequestToLead
} from "../src/controllers/serviceRequestsController.js";
import { CreateServiceRequestSchema, TriageServiceRequestSchema } from "../src/schemas.js";
import { SERVICE_REQUEST_STATUSES, TRIAGE_DECISIONS } from "../src/serviceRequestRules.js";

const RECORD_KEYS = [
  "client_id", "converted_at", "converted_by_user_id", "converted_lead_id", "created_at", "created_by_user_id",
  "equipment_tag_id", "id", "mine_site_id", "requested_date", "service_need", "status", "title", "triage_note",
  "triaged_at", "triaged_by_user_id", "updated_at", "urgency"
];
const CLIENT_VIEW_KEYS = [
  "created_at", "equipment_tag_code", "equipment_tag_id", "id", "mine_site_id", "mine_site_name",
  "requested_date", "service_need", "status", "title", "triaged_at", "updated_at", "urgency"
];
const ROLE_USER = {
  Admin: "u_admin", Management: "u_management", Sales: "u_sales", Finance: "u_finance",
  Operations: "u_ops", Technician: "u_tech", Supervisor: "u_supervisor", "Client Viewer": "u_client_a"
};

function makeDb() {
  const person = (id, role, extra = {}) => ({ id, name: `${id} name`, email: `${id}@example.test`, role, is_active: true, ...extra });
  return {
    users: [
      person("u_admin", "Admin"), person("u_management", "Management"), person("u_sales", "Sales"),
      person("u_finance", "Finance"), person("u_ops", "Operations"), person("u_tech", "Technician"),
      person("u_supervisor", "Supervisor"),
      person("u_client_a", "Client Viewer", { client_id: "c_a", name: "Ann Client", email: "ann@a.example" }),
      person("u_client_a2", "Client Viewer", { client_id: "c_a" }),
      person("u_client_b", "Client Viewer", { client_id: "c_b" }),
      person("u_client_none", "Client Viewer"),
      person("u_sales_off", "Sales", { is_active: false })
    ],
    clients: [
      { id: "c_a", name: "Client A", contact_person: "A Office", email: "office@a.example" },
      { id: "c_b", name: "Client B", contact_person: "B Office", email: "office@b.example" }
    ],
    mine_sites: [
      { id: "ms_a", client_id: "c_a", name: "Site A" }, { id: "ms_a2", client_id: "c_a", name: "Site A2" },
      { id: "ms_b", client_id: "c_b", name: "Site B" }
    ],
    plants: [{ id: "pl_a", mine_site_id: "ms_a" }, { id: "pl_b", mine_site_id: "ms_b" }],
    plant_sections: [{ id: "ps_a", plant_id: "pl_a" }, { id: "ps_b", plant_id: "pl_b" }],
    equipment_tags: [
      { id: "eq_a", plant_section_id: "ps_a", tag_code: "EQ-A" }, { id: "eq_b", plant_section_id: "ps_b", tag_code: "EQ-B" }
    ],
    leads: [], quotes: [], quote_lines: [], purchase_orders: [], dispatch_cards: [], invoices: [],
    notifications: [], audit_logs: [], service_requests: []
  };
}

// The store stub exposes ONLY id() and audit(): any other store call would throw.
function makeStore(db, { failOnAuditCall } = {}) {
  let counter = 0;
  let audits = 0;
  return {
    id: (prefix) => `${prefix}_${++counter}`,
    audit(target, actor, entityType, entityId, action, oldValues, newValues) {
      audits += 1;
      if (failOnAuditCall === audits) throw new Error("audit hook failure");
      target.audit_logs.push({ actor_id: actor?.id, entity_type: entityType, entity_id: entityId, action, old_values: oldValues, new_values: newValues });
    }
  };
}

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function run(handler, db, store, userId, { body, params, query } = {}) {
  const res = response();
  handler({ db, store, user: { id: userId }, body, params: params || {}, query: query || {} }, res);
  return res;
}

function seedRecord(db, overrides = {}) {
  const record = {
    id: `sr_seed_${db.service_requests.length + 1}`, client_id: "c_a", created_by_user_id: "u_client_a",
    title: "Conveyor inspection", service_need: "Inspect the discharge conveyor idlers.", urgency: "standard",
    mine_site_id: null, equipment_tag_id: null, requested_date: null, status: "Submitted",
    triaged_by_user_id: null, triaged_at: null, triage_note: "", converted_lead_id: null,
    converted_by_user_id: null, converted_at: null,
    created_at: `2026-09-2${db.service_requests.length}T08:00:00.000Z`, updated_at: "2026-09-20T08:00:00.000Z",
    ...overrides
  };
  db.service_requests.push(record);
  return record;
}

const validBody = (extra = {}) => ({ title: "Cyclone liner check", service_need: "Wear liners need inspection.", urgency: "planned_shutdown", ...extra });

test("create derives client, creator, status and timestamps from authentication, never from the body", () => {
  const db = makeDb(); const store = makeStore(db);
  const res = run(createServiceRequest, db, store, "u_client_a", {
    body: validBody({
      mine_site_id: "ms_a", equipment_tag_id: "eq_a", requested_date: "2026-10-05",
      // forged fields: all must be ignored
      id: "sr_forged", client_id: "c_b", created_by_user_id: "u_admin", status: "Accepted",
      triaged_by_user_id: "u_sales", triaged_at: "2020-01-01T00:00:00.000Z", triage_note: "pre-approved",
      converted_lead_id: "lead_9", converted_by_user_id: "u_ops", converted_at: "2020-01-01T00:00:00.000Z",
      history: [{ status: "Accepted" }], created_at: "2000-01-01T00:00:00.000Z"
    })
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
  assert.equal(db.service_requests.length, 1);
  const stored = db.service_requests[0];
  assert.deepEqual(Object.keys(stored).sort(), RECORD_KEYS);
  assert.equal(stored.id, "sr_1");
  assert.equal(stored.client_id, "c_a");
  assert.equal(stored.created_by_user_id, "u_client_a");
  assert.equal(stored.status, "Submitted");
  assert.equal(stored.triaged_by_user_id, null);
  assert.equal(stored.triaged_at, null);
  assert.equal(stored.triage_note, "");
  assert.equal(stored.converted_lead_id, null);
  assert.equal(stored.converted_by_user_id, null);
  assert.equal(stored.converted_at, null);
  assert.notEqual(stored.created_at, "2000-01-01T00:00:00.000Z");
  assert.equal(stored.created_at, stored.updated_at);
  assert.equal(stored.mine_site_id, "ms_a");
  assert.equal(stored.equipment_tag_id, "eq_a");
  assert.equal(stored.requested_date, "2026-10-05");
  assert.deepEqual(Object.keys(res.body.data).sort(), CLIENT_VIEW_KEYS);
  assert.equal(res.body.data.mine_site_name, "Site A");
  assert.equal(res.body.data.equipment_tag_code, "EQ-A");
});

test("create writes exactly one SERVICE_REQUEST_CREATED audit event", () => {
  const db = makeDb(); const store = makeStore(db);
  run(createServiceRequest, db, store, "u_client_a", { body: validBody() });
  assert.equal(db.audit_logs.length, 1);
  const [entry] = db.audit_logs;
  assert.equal(entry.action, "SERVICE_REQUEST_CREATED");
  assert.equal(entry.entity_type, "service_request");
  assert.equal(entry.entity_id, db.service_requests[0].id);
  assert.equal(entry.actor_id, "u_client_a");
  assert.equal(entry.old_values, null);
});

test("urgency defaults to standard; text is trimmed; empty optional values become null", () => {
  const db = makeDb(); const store = makeStore(db);
  const res = run(createServiceRequest, db, store, "u_client_a", {
    body: { title: "  Idler bank  ", service_need: "  Replace rollers  ", mine_site_id: "", equipment_tag_id: null, requested_date: "" }
  });
  assert.equal(res.statusCode, 201);
  const stored = db.service_requests[0];
  assert.equal(stored.title, "Idler bank");
  assert.equal(stored.service_need, "Replace rollers");
  assert.equal(stored.urgency, "standard");
  assert.equal(stored.mine_site_id, null);
  assert.equal(stored.equipment_tag_id, null);
  assert.equal(stored.requested_date, null);
});

test("route schemas reject every identity, tenant, lifecycle and lead field supplied by the caller", () => {
  assert.equal(CreateServiceRequestSchema.safeParse(validBody()).success, true);
  assert.equal(CreateServiceRequestSchema.safeParse({ title: "T", service_need: "N", mine_site_id: null, equipment_tag_id: null, requested_date: null }).success, true);
  for (const forged of [
    "id", "client_id", "created_by_user_id", "status", "triaged_by_user_id", "triaged_at", "triage_note",
    "converted_lead_id", "converted_by_user_id", "converted_at", "history", "created_at", "updated_at", "lead_id"
  ]) {
    assert.equal(CreateServiceRequestSchema.safeParse(validBody({ [forged]: "x" })).success, false, `${forged} must be rejected`);
  }
  assert.equal(CreateServiceRequestSchema.safeParse(validBody({ urgency: "whenever" })).success, false);
  assert.equal(CreateServiceRequestSchema.safeParse(validBody({ title: "" })).success, false);
  assert.equal(CreateServiceRequestSchema.safeParse(validBody({ title: "x".repeat(161) })).success, false);
  assert.equal(CreateServiceRequestSchema.safeParse(validBody({ service_need: "x".repeat(2001) })).success, false);
  assert.equal(CreateServiceRequestSchema.safeParse(validBody({ requested_date: "05/10/2026" })).success, false);

  assert.equal(TriageServiceRequestSchema.safeParse({ decision: "accept", note: "ok" }).success, true);
  assert.equal(TriageServiceRequestSchema.safeParse({ decision: "convert" }).success, false);
  assert.equal(TriageServiceRequestSchema.safeParse({ decision: "accept", status: "Accepted" }).success, false);
  assert.equal(TriageServiceRequestSchema.safeParse({ decision: "accept", triaged_by_user_id: "u_x" }).success, false);
  assert.equal(TriageServiceRequestSchema.safeParse({ decision: "accept", note: "x".repeat(1001) }).success, false);
});

test("controller-level validation holds even if route validation were bypassed", () => {
  const cases = [
    validBody({ title: "" }), validBody({ title: "x".repeat(161) }), validBody({ service_need: "   " }),
    validBody({ service_need: "x".repeat(2001) }), validBody({ urgency: "whenever" }),
    validBody({ requested_date: "2026-02-30" }), validBody({ requested_date: "2026-1-5" }), validBody({ requested_date: 20261005 }),
    validBody({ mine_site_id: 5 }), validBody({ equipment_tag_id: { id: "eq_a" } })
  ];
  for (const body of cases) {
    const db = makeDb(); const store = makeStore(db);
    const res = run(createServiceRequest, db, store, "u_client_a", { body });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(db.service_requests.length, 0);
    assert.equal(db.audit_logs.length, 0);
  }
  const db = makeDb(); const store = makeStore(db);
  assert.equal(run(createServiceRequest, db, store, "u_client_a", { body: undefined }).statusCode, 400);
});

test("a Client Viewer without a client fails closed before any read or write", () => {
  const db = makeDb(); const store = makeStore(db);
  seedRecord(db);
  const created = run(createServiceRequest, db, store, "u_client_none", { body: validBody() });
  const listed = run(listOwnServiceRequests, db, store, "u_client_none");
  assert.equal(created.statusCode, 403);
  assert.equal(listed.statusCode, 403);
  assert.equal(db.service_requests.length, 1);
  assert.equal(db.audit_logs.length, 0);
});

test("an archived client account cannot raise requests", () => {
  const db = makeDb(); const store = makeStore(db);
  db.clients.find((client) => client.id === "c_a").is_active = false;
  assert.equal(run(createServiceRequest, db, store, "u_client_a", { body: validBody() }).statusCode, 403);
  assert.equal(db.service_requests.length, 0);
});

test("mine site and equipment references must belong to the caller's own client", () => {
  const messages = new Set();
  const reject = (label, body, mutate) => {
    const db = makeDb(); const store = makeStore(db);
    if (mutate) mutate(db);
    const res = run(createServiceRequest, db, store, "u_client_a", { body: validBody(body) });
    assert.equal(res.statusCode, 400, label);
    assert.equal(db.service_requests.length, 0, label);
    assert.equal(db.audit_logs.length, 0, label);
    return res.body.message;
  };
  const otherClientSite = reject("other client's mine site", { mine_site_id: "ms_b" });
  const missingSite = reject("non-existent mine site", { mine_site_id: "ms_missing" });
  assert.equal(otherClientSite, missingSite, "other-client and missing must be indistinguishable");
  const otherClientEquipment = reject("other client's equipment", { equipment_tag_id: "eq_b" });
  const missingEquipment = reject("non-existent equipment", { equipment_tag_id: "eq_missing" });
  assert.equal(otherClientEquipment, missingEquipment);
  reject("equipment on a different own mine site than the one sent", { mine_site_id: "ms_a2", equipment_tag_id: "eq_a" });
  reject("own equipment paired with another client's mine site", { mine_site_id: "ms_b", equipment_tag_id: "eq_a" });
  reject("archived mine site", { mine_site_id: "ms_a" }, (db) => { db.mine_sites.find((item) => item.id === "ms_a").is_active = false; });
  reject("broken hierarchy (missing plant)", { equipment_tag_id: "eq_a" }, (db) => { db.plants = db.plants.filter((item) => item.id !== "pl_a"); });
  reject("archived plant section", { equipment_tag_id: "eq_a" }, (db) => { db.plant_sections.find((item) => item.id === "ps_a").is_active = false; });
  messages.add(otherClientSite);
  assert.ok(![...messages].join(" ").includes("Site B") && ![...messages].join(" ").includes("c_b"));

  const db = makeDb(); const store = makeStore(db);
  assert.equal(run(createServiceRequest, db, store, "u_client_a", { body: validBody({ mine_site_id: "ms_a", equipment_tag_id: "eq_a" }) }).statusCode, 201);
  assert.equal(run(createServiceRequest, db, store, "u_client_a", { body: validBody({ equipment_tag_id: "eq_a" }) }).statusCode, 201);
  assert.equal(run(createServiceRequest, db, store, "u_client_a", { body: validBody({ mine_site_id: "ms_a2" }) }).statusCode, 201);
});

test("Client Viewer lists only their own client's requests, newest first, without internal fields", () => {
  const db = makeDb(); const store = makeStore(db);
  const a1 = seedRecord(db, { title: "A first", created_at: "2026-09-10T08:00:00.000Z" });
  const a2 = seedRecord(db, { title: "A second", created_by_user_id: "u_client_a2", created_at: "2026-09-12T08:00:00.000Z", triaged_by_user_id: "u_sales", triage_note: "internal remark", status: "Acknowledged", triaged_at: "2026-09-12T09:00:00.000Z" });
  const b1 = seedRecord(db, { title: "B only", client_id: "c_b", created_by_user_id: "u_client_b" });

  const asA = run(listOwnServiceRequests, db, store, "u_client_a");
  assert.equal(asA.statusCode, 200);
  assert.deepEqual(asA.body.data.map((item) => item.id), [a2.id, a1.id]);
  for (const item of asA.body.data) {
    assert.deepEqual(Object.keys(item).sort(), CLIENT_VIEW_KEYS);
    assert.notEqual(item.id, b1.id);
  }
  assert.ok(!JSON.stringify(asA.body).includes("internal remark"));
  assert.ok(!JSON.stringify(asA.body).includes("u_sales"));

  const asB = run(listOwnServiceRequests, db, store, "u_client_b");
  assert.deepEqual(asB.body.data.map((item) => item.id), [b1.id]);
});

test("role matrix: only the permitted roles can use each endpoint; every other role gets 403", () => {
  const endpoints = {
    create: { handler: createServiceRequest, allowed: ["Client Viewer"], ok: 201, input: () => ({ body: validBody() }) },
    mine: { handler: listOwnServiceRequests, allowed: ["Client Viewer"], ok: 200, input: () => ({}) },
    queue: { handler: listServiceRequestTriageQueue, allowed: ["Sales", "Operations"], ok: 200, input: () => ({}) },
    triage: { handler: triageServiceRequest, allowed: ["Sales", "Operations"], ok: 200, prepare: (db) => seedRecord(db, { id: "sr_m" }), input: () => ({ params: { id: "sr_m" }, body: { decision: "acknowledge" } }) },
    convert: { handler: convertServiceRequestToLead, allowed: ["Sales", "Operations"], ok: 201, prepare: (db) => seedRecord(db, { id: "sr_m", status: "Accepted" }), input: () => ({ params: { id: "sr_m" } }) }
  };
  for (const [name, spec] of Object.entries(endpoints)) {
    for (const [role, userId] of Object.entries(ROLE_USER)) {
      const db = makeDb(); const store = makeStore(db);
      if (spec.prepare) spec.prepare(db);
      const before = JSON.stringify(db);
      const res = run(spec.handler, db, store, userId, spec.input());
      if (spec.allowed.includes(role)) assert.equal(res.statusCode, spec.ok, `${role} must be allowed to ${name}`);
      else {
        assert.equal(res.statusCode, 403, `${role} must be denied ${name}`);
        assert.equal(JSON.stringify(db), before, `${role} denied ${name} must not change data`);
      }
    }
  }
});

test("inactive and unknown accounts are denied on every endpoint", () => {
  for (const handler of [createServiceRequest, listOwnServiceRequests, listServiceRequestTriageQueue, triageServiceRequest, convertServiceRequestToLead]) {
    for (const userId of ["u_sales_off", "u_nobody"]) {
      const db = makeDb(); const store = makeStore(db); seedRecord(db, { id: "sr_x", status: "Accepted" });
      const res = run(handler, db, store, userId, { body: validBody({ decision: "accept" }), params: { id: "sr_x" } });
      assert.equal(res.statusCode, 403);
      assert.equal(db.audit_logs.length, 0);
      assert.equal(db.leads.length, 0);
    }
  }
});

test("Client Viewers cannot triage or convert, including their own client's request", () => {
  for (const userId of ["u_client_a", "u_client_b"]) {
    const db = makeDb(); const store = makeStore(db);
    const own = seedRecord(db, { status: "Accepted" });
    assert.equal(run(triageServiceRequest, db, store, userId, { params: { id: own.id }, body: { decision: "decline" } }).statusCode, 403);
    assert.equal(run(convertServiceRequestToLead, db, store, userId, { params: { id: own.id } }).statusCode, 403);
    assert.equal(run(listServiceRequestTriageQueue, db, store, userId).statusCode, 403);
    assert.equal(own.status, "Accepted");
    assert.equal(db.leads.length, 0);
  }
});

test("Sales and Operations see the queue across clients; status filter is whitelisted", () => {
  const db = makeDb(); const store = makeStore(db);
  const a = seedRecord(db, { created_at: "2026-09-10T08:00:00.000Z", mine_site_id: "ms_a", equipment_tag_id: "eq_a" });
  const b = seedRecord(db, { client_id: "c_b", created_by_user_id: "u_client_b", status: "Acknowledged", created_at: "2026-09-11T08:00:00.000Z" });
  for (const userId of ["u_sales", "u_ops"]) {
    const all = run(listServiceRequestTriageQueue, db, store, userId);
    assert.equal(all.statusCode, 200);
    assert.deepEqual(all.body.data.map((item) => item.id), [a.id, b.id]);
    assert.equal(all.body.data[0].client_name, "Client A");
    assert.equal(all.body.data[0].mine_site_name, "Site A");
    assert.equal(all.body.data[0].equipment_tag_code, "EQ-A");
    assert.equal(all.body.data[1].client_name, "Client B");
    const filtered = run(listServiceRequestTriageQueue, db, store, userId, { query: { status: "Acknowledged" } });
    assert.deepEqual(filtered.body.data.map((item) => item.id), [b.id]);
  }
  for (const status of ["submitted", "Approved", "", "Submitted,Accepted", ["Submitted", "Accepted"], { $ne: "x" }, "constructor"]) {
    const res = run(listServiceRequestTriageQueue, db, store, "u_sales", { query: { status } });
    assert.equal(res.statusCode, 400, JSON.stringify(status));
  }
  for (const status of SERVICE_REQUEST_STATUSES) {
    assert.equal(run(listServiceRequestTriageQueue, db, store, "u_sales", { query: { status } }).statusCode, 200);
  }
});

test("lifecycle: acknowledge, accept and decline record the acting triager and one audit event each", () => {
  const db = makeDb(); const store = makeStore(db);
  const record = seedRecord(db, { id: "sr_life" });

  const acknowledged = run(triageServiceRequest, db, store, "u_sales", { params: { id: "sr_life" }, body: { decision: "acknowledge", note: "  Received  ", triaged_by_user_id: "u_admin", status: "Converted_To_Lead" } });
  assert.equal(acknowledged.statusCode, 200);
  assert.equal(record.status, "Acknowledged");
  assert.equal(record.triaged_by_user_id, "u_sales");
  assert.equal(record.triage_note, "Received");
  assert.ok(record.triaged_at);
  assert.equal(acknowledged.body.data.triaged_by_name, "u_sales name");

  const accepted = run(triageServiceRequest, db, store, "u_ops", { params: { id: "sr_life" }, body: { decision: "accept" } });
  assert.equal(accepted.statusCode, 200);
  assert.equal(record.status, "Accepted");
  assert.equal(record.triaged_by_user_id, "u_ops");
  assert.equal(record.triage_note, "Received", "a decision without a note keeps the existing note");

  assert.deepEqual(db.audit_logs.map((entry) => entry.action), ["SERVICE_REQUEST_ACKNOWLEDGED", "SERVICE_REQUEST_ACCEPTED"]);
  assert.equal(db.audit_logs[0].actor_id, "u_sales");
  assert.equal(db.audit_logs[0].old_values.status, "Submitted");
  assert.equal(db.audit_logs[0].new_values.status, "Acknowledged");
  assert.equal(db.audit_logs[1].actor_id, "u_ops");
  assert.equal(db.leads.length, 0, "accepting never creates a lead");

  for (const from of ["Submitted", "Acknowledged"]) {
    const d = makeDb(); const s = makeStore(d); const r = seedRecord(d, { id: "sr_d", status: from });
    const res = run(triageServiceRequest, d, s, "u_sales", { params: { id: "sr_d" }, body: { decision: "decline", note: "Out of scope" } });
    assert.equal(res.statusCode, 200);
    assert.equal(r.status, "Declined");
    assert.equal(r.triage_note, "Out of scope");
    assert.deepEqual(d.audit_logs.map((entry) => entry.action), ["SERVICE_REQUEST_DECLINED"]);
  }
});

test("every disallowed (status, decision) pair returns 409 and changes nothing", () => {
  const allowed = new Set(Object.entries(TRIAGE_DECISIONS).flatMap(([name, rule]) => rule.from.map((from) => `${from}|${name}`)));
  let checked = 0;
  for (const status of SERVICE_REQUEST_STATUSES) {
    for (const decision of Object.keys(TRIAGE_DECISIONS)) {
      const db = makeDb(); const store = makeStore(db);
      const record = seedRecord(db, { id: "sr_t", status });
      const before = JSON.stringify(record);
      const res = run(triageServiceRequest, db, store, "u_sales", { params: { id: "sr_t" }, body: { decision } });
      if (allowed.has(`${status}|${decision}`)) assert.equal(res.statusCode, 200, `${status} -> ${decision}`);
      else {
        assert.equal(res.statusCode, 409, `${status} -> ${decision}`);
        assert.equal(JSON.stringify(record), before);
        assert.equal(db.audit_logs.length, 0);
      }
      checked += 1;
    }
  }
  assert.equal(checked, 15);
  assert.equal(allowed.size, 4, "exactly four triage transitions exist");
});

test("invalid decisions, notes and ids are rejected", () => {
  for (const body of [{ decision: "convert" }, { decision: "constructor" }, { decision: "__proto__" }, { decision: "toString" }, { decision: "ACCEPT" }, {}, undefined, { decision: "accept", note: 5 }, { decision: "accept", note: "x".repeat(1001) }]) {
    const db = makeDb(); const store = makeStore(db); const record = seedRecord(db, { id: "sr_v", status: "Acknowledged" });
    const res = run(triageServiceRequest, db, store, "u_sales", { params: { id: "sr_v" }, body });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(record.status, "Acknowledged");
    assert.equal(db.audit_logs.length, 0);
  }
  const db = makeDb(); const store = makeStore(db);
  assert.equal(run(triageServiceRequest, db, store, "u_sales", { params: { id: "sr_missing" }, body: { decision: "accept" } }).statusCode, 404);
  assert.equal(run(convertServiceRequestToLead, db, store, "u_sales", { params: { id: "sr_missing" } }).statusCode, 404);
});

test("conversion creates exactly one traceable lead, updates the request and writes both audit events", () => {
  const db = makeDb(); const store = makeStore(db);
  const record = seedRecord(db, { id: "sr_conv", status: "Accepted", urgency: "urgent_downtime", mine_site_id: "ms_a", equipment_tag_id: "eq_a", requested_date: "2026-10-05", service_need: "Replace idler bank." });

  const res = run(convertServiceRequestToLead, db, store, "u_ops", { params: { id: "sr_conv" }, body: { company_name: "Forged", status: "Won", client_id: "c_b" } });
  assert.equal(res.statusCode, 201);
  assert.equal(db.leads.length, 1);
  const [lead] = db.leads;
  assert.deepEqual(res.body.data.lead, lead);
  assert.equal(lead.id, "lead_1");
  assert.equal(lead.company_name, "Client A");
  assert.equal(lead.contact_name, "Ann Client");
  assert.equal(lead.email, "ann@a.example");
  assert.equal(lead.phone, "");
  assert.equal(lead.mine_site, "Site A");
  assert.equal(lead.service_need, "Replace idler bank.");
  assert.equal(lead.urgency, "urgent_downtime");
  assert.equal(lead.status, "New");
  assert.equal(lead.service_request_id, "sr_conv");
  assert.equal(lead.client_id, "c_a");
  assert.equal(lead.requested_date, "2026-10-05");
  assert.ok(lead.created_at);

  assert.equal(record.status, "Converted_To_Lead");
  assert.equal(record.converted_lead_id, lead.id);
  assert.equal(record.converted_by_user_id, "u_ops");
  assert.ok(record.converted_at);
  assert.equal(res.body.data.service_request.id, "sr_conv");

  assert.deepEqual(db.audit_logs.map((entry) => `${entry.entity_type}:${entry.action}`), [
    "service_request:SERVICE_REQUEST_CONVERTED_TO_LEAD", "lead:LEAD_CREATED_FROM_SERVICE_REQUEST"
  ]);
  assert.equal(db.audit_logs[0].old_values.status, "Accepted");
  assert.equal(db.audit_logs[0].new_values.converted_lead_id, lead.id);
  assert.equal(db.audit_logs[1].entity_id, lead.id);
  assert.equal(db.audit_logs[1].actor_id, "u_ops");
});

test("conversion twice fails with 409 and creates nothing further", () => {
  const db = makeDb(); const store = makeStore(db);
  seedRecord(db, { id: "sr_twice", status: "Accepted" });
  assert.equal(run(convertServiceRequestToLead, db, store, "u_sales", { params: { id: "sr_twice" } }).statusCode, 201);
  const auditsAfterFirst = db.audit_logs.length;
  const second = run(convertServiceRequestToLead, db, store, "u_ops", { params: { id: "sr_twice" } });
  assert.equal(second.statusCode, 409);
  assert.equal(db.leads.length, 1);
  assert.equal(db.audit_logs.length, auditsAfterFirst);
  // a record that carries a lead link is never converted again, whatever its status says
  const linked = seedRecord(db, { id: "sr_linked", status: "Accepted", converted_lead_id: "lead_old" });
  assert.equal(run(convertServiceRequestToLead, db, store, "u_sales", { params: { id: linked.id } }).statusCode, 409);
  assert.equal(db.leads.length, 1);
});

test("only Accepted requests convert; Declined, Submitted and Acknowledged never do", () => {
  for (const status of ["Submitted", "Acknowledged", "Declined", "Converted_To_Lead"]) {
    const db = makeDb(); const store = makeStore(db);
    const record = seedRecord(db, { id: "sr_no", status });
    const res = run(convertServiceRequestToLead, db, store, "u_sales", { params: { id: "sr_no" } });
    assert.equal(res.statusCode, 409, status);
    assert.equal(db.leads.length, 0);
    assert.equal(db.audit_logs.length, 0);
    assert.equal(record.status, status);
  }
});

test("a failed conversion leaves no lead, no request change and no audit entry", () => {
  for (const failOnAuditCall of [1, 2]) {
    const db = makeDb(); const store = makeStore(db, { failOnAuditCall });
    const record = seedRecord(db, { id: "sr_atomic", status: "Accepted" });
    const before = JSON.parse(JSON.stringify(record));
    assert.throws(() => run(convertServiceRequestToLead, db, store, "u_sales", { params: { id: "sr_atomic" } }), /audit hook failure/);
    assert.equal(db.leads.length, 0);
    assert.equal(db.audit_logs.length, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(record)), before);
  }
});

test("lead contact data comes only from ORAC records and is never invented", () => {
  const withoutRequester = makeDb(); const store1 = makeStore(withoutRequester);
  withoutRequester.users = withoutRequester.users.filter((user) => user.id !== "u_client_a");
  seedRecord(withoutRequester, { id: "sr_c", status: "Accepted" });
  run(convertServiceRequestToLead, withoutRequester, store1, "u_sales", { params: { id: "sr_c" } });
  assert.equal(withoutRequester.leads[0].contact_name, "A Office");
  assert.equal(withoutRequester.leads[0].email, "office@a.example");

  const bare = makeDb(); const store2 = makeStore(bare);
  bare.users = bare.users.filter((user) => user.id !== "u_client_a");
  Object.assign(bare.clients.find((client) => client.id === "c_a"), { contact_person: undefined, email: "" });
  seedRecord(bare, { id: "sr_c", status: "Accepted" });
  run(convertServiceRequestToLead, bare, store2, "u_sales", { params: { id: "sr_c" } });
  assert.equal(bare.leads[0].contact_name, "");
  assert.equal(bare.leads[0].email, "");
  assert.equal(bare.leads[0].phone, "");

  const noClient = makeDb(); const store3 = makeStore(noClient);
  noClient.clients = noClient.clients.filter((client) => client.id !== "c_a");
  seedRecord(noClient, { id: "sr_c", status: "Accepted" });
  assert.equal(run(convertServiceRequestToLead, noClient, store3, "u_sales", { params: { id: "sr_c" } }).statusCode, 409);
  assert.equal(noClient.leads.length, 0);
});

test("the whole workflow creates no quote, PO, dispatch, invoice, notification or external call", () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("external call attempted"); };
  try {
    const db = makeDb(); const store = makeStore(db);
    const created = run(createServiceRequest, db, store, "u_client_a", { body: validBody({ mine_site_id: "ms_a" }) });
    const id = db.service_requests[0].id;
    run(listOwnServiceRequests, db, store, "u_client_a");
    run(listServiceRequestTriageQueue, db, store, "u_sales");
    run(triageServiceRequest, db, store, "u_sales", { params: { id }, body: { decision: "acknowledge" } });
    run(triageServiceRequest, db, store, "u_ops", { params: { id }, body: { decision: "accept" } });
    const converted = run(convertServiceRequestToLead, db, store, "u_sales", { params: { id } });
    assert.equal(created.statusCode, 201);
    assert.equal(converted.statusCode, 201);
    for (const collection of ["quotes", "quote_lines", "purchase_orders", "dispatch_cards", "invoices", "notifications"]) {
      assert.equal(db[collection].length, 0, `${collection} must stay empty`);
    }
    assert.equal(db.leads.length, 1);
    assert.deepEqual(db.audit_logs.map((entry) => entry.action), [
      "SERVICE_REQUEST_CREATED", "SERVICE_REQUEST_ACKNOWLEDGED", "SERVICE_REQUEST_ACCEPTED",
      "SERVICE_REQUEST_CONVERTED_TO_LEAD", "LEAD_CREATED_FROM_SERVICE_REQUEST"
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a missing service_requests collection is created on demand and never leaks another client's data", () => {
  const db = makeDb(); const store = makeStore(db);
  delete db.service_requests;
  assert.equal(run(listOwnServiceRequests, db, store, "u_client_a").body.data.length, 0);
  assert.equal(run(listServiceRequestTriageQueue, db, store, "u_sales").body.data.length, 0);
  assert.equal(run(createServiceRequest, db, store, "u_client_a", { body: validBody() }).statusCode, 201);
  assert.equal(db.service_requests.length, 1);
});
