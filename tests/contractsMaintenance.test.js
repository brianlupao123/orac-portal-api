import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as contractsController from "../src/controllers/contractsController.js";
import { normalizeDb } from "../src/store.js";
import { permissions, roles } from "../src/permissions.js";

const {
  listContracts, createContract, updateContract,
  listMaintenanceSchedules, createMaintenanceSchedule, updateMaintenanceSchedule
} = contractsController;

const ALL_ROLES = Object.values(roles);
const CONTRACT_MANAGERS = [roles.ADMIN, roles.MANAGEMENT];
const SCHEDULE_MANAGERS = [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS];
const READERS = [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.CLIENT_VIEWER];

// ------------------------------------------------------------------ fixtures

function actorFor(role, overrides = {}) {
  const slug = role.toLowerCase().replace(/\s+/g, "-");
  return {
    id: `${slug}-1`,
    role,
    is_active: true,
    ...(role === roles.CLIENT_VIEWER ? { client_id: "client-a" } : {}),
    ...overrides
  };
}

function createDb() {
  return {
    users: ALL_ROLES.map((role) => actorFor(role)),
    clients: [
      { id: "client-a", name: "Client A" },
      { id: "client-b", name: "Client B" },
      { id: "client-archived", name: "Archived", is_active: false }
    ],
    mine_sites: [{ id: "site-a", client_id: "client-a" }, { id: "site-b", client_id: "client-b" }],
    plants: [{ id: "plant-a", mine_site_id: "site-a" }, { id: "plant-b", mine_site_id: "site-b" }],
    plant_sections: [{ id: "section-a", plant_id: "plant-a" }, { id: "section-b", plant_id: "plant-b" }],
    equipment_tags: [
      { id: "tag-a", plant_section_id: "section-a", tag_code: "EQ-A-1" },
      { id: "tag-b", plant_section_id: "section-b", tag_code: "EQ-B-1" },
      { id: "tag-archived", plant_section_id: "section-a", tag_code: "EQ-A-OLD", is_active: false },
      { id: "tag-orphan", plant_section_id: "section-missing", tag_code: "EQ-ORPHAN" }
    ],
    contracts: [],
    maintenance_schedules: [],
    audit_logs: []
  };
}

function createStore() {
  const audits = [];
  let counter = 0;
  return {
    audits,
    id: (prefix) => `${prefix}_test_${++counter}`,
    audit: (...args) => audits.push(args)
  };
}

function createResponse() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function call(handler, { role = roles.ADMIN, actor, db = createDb(), store = createStore(), body, params, unauthenticated = false } = {}) {
  const resolvedActor = actor || db.users.find((user) => user.role === role);
  const request = { db, store, body, params: params || {} };
  if (!unauthenticated) request.user = { id: resolvedActor.id };
  const res = createResponse();
  handler(request, res);
  return { res, db, store, audits: store.audits };
}

const validContract = (overrides = {}) => ({
  client_id: "client-a",
  title: "Annual cyclone maintenance",
  start_date: "2026-01-01",
  end_date: "2026-12-31",
  total_value: 12000,
  ...overrides
});

const validSchedule = (contractId, overrides = {}) => ({
  contract_id: contractId,
  frequency: "Monthly",
  next_due_date: "2026-06-15",
  ...overrides
});

function addContract(db, overrides = {}) {
  const record = {
    id: `contract_seed_${db.contracts.length + 1}`,
    contract_number: `CTR-${String(db.contracts.length + 1).padStart(4, "0")}`,
    client_id: "client-a",
    title: "Seed contract",
    start_date: "2026-01-01",
    end_date: "2026-12-31",
    total_value: null,
    status: "Active",
    created_by_user_id: "admin-1",
    created_at: `2026-01-0${db.contracts.length + 1}T00:00:00.000Z`,
    updated_at: `2026-01-0${db.contracts.length + 1}T00:00:00.000Z`,
    ...overrides
  };
  db.contracts.push(record);
  return record;
}

function addSchedule(db, contract, overrides = {}) {
  const record = {
    id: `maintenance_seed_${db.maintenance_schedules.length + 1}`,
    contract_id: contract.id,
    equipment_tag_id: null,
    frequency: "Monthly",
    next_due_date: "2026-06-15",
    notes: "",
    created_by_user_id: "admin-1",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
  db.maintenance_schedules.push(record);
  return record;
}

const snapshot = (value) => JSON.stringify(value);

// -------------------------------------------------------------- permissions

test("permission allow-lists match the approved access matrix", () => {
  assert.deepEqual([...permissions.viewContracts].sort(), [...READERS].sort());
  assert.deepEqual([...permissions.manageContracts].sort(), [...CONTRACT_MANAGERS].sort());
  assert.deepEqual([...permissions.manageMaintenanceSchedules].sort(), [...SCHEDULE_MANAGERS].sort());
});

test("only Admin, Management, Operations and Client Viewer can list; everyone else gets 403", () => {
  for (const role of ALL_ROLES) {
    for (const handler of [listContracts, listMaintenanceSchedules]) {
      const { res } = call(handler, { role });
      assert.equal(res.statusCode, READERS.includes(role) ? 200 : 403, `${role} via ${handler.name}`);
      assert.equal(res.body.success, READERS.includes(role));
    }
  }
});

test("Supervisor is denied contract and schedule reads (no source-proven assignment relation)", () => {
  assert.equal(call(listContracts, { role: roles.SUPERVISOR }).res.statusCode, 403);
  assert.equal(call(listMaintenanceSchedules, { role: roles.SUPERVISOR }).res.statusCode, 403);
});

test("only Admin and Management can create or update contracts", () => {
  for (const role of ALL_ROLES) {
    const create = call(createContract, { role, body: validContract() });
    assert.equal(create.res.statusCode, CONTRACT_MANAGERS.includes(role) ? 201 : 403, `${role} create`);

    const db = createDb();
    const contract = addContract(db);
    const update = call(updateContract, { role, db, params: { id: contract.id }, body: { title: "Renamed" } });
    assert.equal(update.res.statusCode, CONTRACT_MANAGERS.includes(role) ? 200 : 403, `${role} update`);
  }
});

test("Operations can manage schedules but not contracts; Client Viewer can change nothing", () => {
  const ops = call(createContract, { role: roles.OPERATIONS, body: validContract() });
  assert.equal(ops.res.statusCode, 403);

  for (const role of ALL_ROLES) {
    const db = createDb();
    const contract = addContract(db);
    const create = call(createMaintenanceSchedule, { role, db, body: validSchedule(contract.id) });
    assert.equal(create.res.statusCode, SCHEDULE_MANAGERS.includes(role) ? 201 : 403, `${role} create schedule`);

    const db2 = createDb();
    const contract2 = addContract(db2);
    const schedule = addSchedule(db2, contract2);
    const update = call(updateMaintenanceSchedule, { role, db: db2, params: { id: schedule.id }, body: { notes: "Checked" } });
    assert.equal(update.res.statusCode, SCHEDULE_MANAGERS.includes(role) ? 200 : 403, `${role} update schedule`);
  }
});

test("denied writes change nothing and write no audit entry", () => {
  for (const role of [roles.SALES, roles.FINANCE, roles.TECHNICIAN, roles.SUPERVISOR, roles.CLIENT_VIEWER, roles.OPERATIONS]) {
    const db = createDb();
    const before = snapshot(db);
    const { res, audits } = call(createContract, { role, db, body: validContract() });
    assert.equal(res.statusCode, 403);
    assert.equal(snapshot(db), before);
    assert.equal(audits.length, 0);
  }
});

test("permission is checked before the body is parsed", () => {
  const { res } = call(createContract, { role: roles.CLIENT_VIEWER, body: { nonsense: true } });
  assert.equal(res.statusCode, 403);
});

test("inactive and unauthenticated callers fail closed (no users[0] fallback)", () => {
  const db = createDb();
  const inactive = actorFor(roles.ADMIN, { id: "admin-off", is_active: false });
  db.users.push(inactive);
  assert.equal(call(listContracts, { db, actor: inactive }).res.statusCode, 403);
  assert.equal(call(createContract, { db, actor: inactive, body: validContract() }).res.statusCode, 403);

  // db.users[0] is an active Admin; an unauthenticated request must still be refused.
  assert.equal(call(listContracts, { db, unauthenticated: true }).res.statusCode, 403);
  assert.equal(call(createContract, { db, unauthenticated: true, body: validContract() }).res.statusCode, 403);
});

// ------------------------------------------------------------ tenant isolation

test("Client Viewer receives only contracts for their own client", () => {
  const db = createDb();
  addContract(db, { client_id: "client-a", title: "A one" });
  addContract(db, { client_id: "client-b", title: "B one" });
  addContract(db, { client_id: "client-a", title: "A two" });

  const viewerA = call(listContracts, { role: roles.CLIENT_VIEWER, db });
  assert.deepEqual(viewerA.res.body.data.map((c) => c.title).sort(), ["A one", "A two"]);

  const viewerB = actorFor(roles.CLIENT_VIEWER, { id: "viewer-b", client_id: "client-b" });
  db.users.push(viewerB);
  const forB = call(listContracts, { db, actor: viewerB });
  assert.deepEqual(forB.res.body.data.map((c) => c.title), ["B one"]);

  const admin = call(listContracts, { role: roles.ADMIN, db });
  assert.equal(admin.res.body.data.length, 3);
});

test("Client Viewer receives only schedules linked to their own client's contracts", () => {
  const db = createDb();
  const contractA = addContract(db, { client_id: "client-a" });
  const contractB = addContract(db, { client_id: "client-b" });
  addSchedule(db, contractA, { notes: "for A" });
  addSchedule(db, contractB, { notes: "for B" });
  db.maintenance_schedules.push({ id: "maintenance_orphan", contract_id: "contract_missing", frequency: "Weekly", next_due_date: "2026-03-01", notes: "orphan" });

  const viewer = call(listMaintenanceSchedules, { role: roles.CLIENT_VIEWER, db });
  assert.deepEqual(viewer.res.body.data.map((s) => s.notes), ["for A"]);

  const admin = call(listMaintenanceSchedules, { role: roles.ADMIN, db });
  assert.equal(admin.res.body.data.length, 3);
});

test("Client Viewer without a client_id sees nothing, not everything", () => {
  const db = createDb();
  const contract = addContract(db);
  addSchedule(db, contract);
  const stray = actorFor(roles.CLIENT_VIEWER, { id: "viewer-stray", client_id: undefined });
  db.users.push(stray);
  assert.deepEqual(call(listContracts, { db, actor: stray }).res.body.data, []);
  assert.deepEqual(call(listMaintenanceSchedules, { db, actor: stray }).res.body.data, []);
});

test("Client Viewer cannot reach another client's schedule by id", () => {
  const db = createDb();
  const other = addContract(db, { client_id: "client-b" });
  const schedule = addSchedule(db, other);
  const { res } = call(updateMaintenanceSchedule, { role: roles.CLIENT_VIEWER, db, params: { id: schedule.id }, body: { notes: "x" } });
  assert.equal(res.statusCode, 403);
  assert.equal(schedule.notes, "");
});

test("schedule responses expose the tag code derived server-side, without persisting it", () => {
  const db = createDb();
  const contract = addContract(db, { client_id: "client-a" });
  addSchedule(db, contract, { equipment_tag_id: "tag-a" });
  const viewer = call(listMaintenanceSchedules, { role: roles.CLIENT_VIEWER, db });
  assert.equal(viewer.res.body.data[0].equipment_tag_code, "EQ-A-1");
  assert.equal("equipment_tag_code" in db.maintenance_schedules[0], false);
});

test("a tag that does not belong to the contract's client is never revealed", () => {
  const db = createDb();
  const contract = addContract(db, { client_id: "client-a" });
  addSchedule(db, contract, { equipment_tag_id: "tag-b" }); // legacy/bad data
  const viewer = call(listMaintenanceSchedules, { role: roles.CLIENT_VIEWER, db });
  assert.equal(viewer.res.body.data[0].equipment_tag_code, null);
});

// ------------------------------------------------------- contract validation

test("creating a contract stores server-owned fields and defaults", () => {
  const { res, db, audits } = call(createContract, { role: roles.MANAGEMENT, body: validContract({ total_value: undefined }) });
  assert.equal(res.statusCode, 201);
  const record = res.body.data;
  assert.match(record.id, /^contract_/);
  assert.equal(record.contract_number, "CTR-0001");
  assert.equal(record.status, "Draft");
  assert.equal(record.total_value, null);
  assert.equal(record.created_by_user_id, "management-1");
  assert.ok(record.created_at && record.created_at === record.updated_at);
  assert.equal(db.contracts.length, 1);
  assert.equal(audits.length, 1);
});

test("contract numbers are sequential, server-generated and never caller-controlled", () => {
  const db = createDb();
  const store = createStore();
  const first = call(createContract, { db, store, body: validContract() }).res.body.data;
  const second = call(createContract, { db, store, body: validContract({ title: "Second" }) }).res.body.data;
  assert.deepEqual([first.contract_number, second.contract_number], ["CTR-0001", "CTR-0002"]);

  db.contracts.push({ ...second, id: "contract_gap", contract_number: "CTR-0041" });
  const third = call(createContract, { db, store, body: validContract({ title: "Third" }) }).res.body.data;
  assert.equal(third.contract_number, "CTR-0042");

  const forged = call(createContract, { db, store, body: validContract({ contract_number: "CTR-9999" }) });
  assert.equal(forged.res.statusCode, 400);
});

test("server-owned fields are rejected on create and update, not silently dropped", () => {
  for (const key of ["id", "contract_number", "created_by_user_id", "created_at", "updated_at"]) {
    const create = call(createContract, { body: validContract({ [key]: "forged" }) });
    assert.equal(create.res.statusCode, 400, `create with ${key}`);
    assert.equal(create.db.contracts.length, 0);

    const db = createDb();
    const contract = addContract(db);
    const update = call(updateContract, { db, params: { id: contract.id }, body: { [key]: "forged" } });
    assert.equal(update.res.statusCode, 400, `update with ${key}`);
  }
});

test("a contract cannot be re-homed to another client", () => {
  const db = createDb();
  const contract = addContract(db);
  const { res } = call(updateContract, { db, params: { id: contract.id }, body: { client_id: "client-b" } });
  assert.equal(res.statusCode, 400);
  assert.equal(contract.client_id, "client-a");
});

test("contract dates must be real and end cannot precede start", () => {
  const cases = [
    validContract({ start_date: "01/01/2026" }),
    validContract({ end_date: "2026-13-01" }),
    validContract({ start_date: "2026-02-30" }),
    validContract({ start_date: "2026-12-31", end_date: "2026-01-01" }),
    validContract({ start_date: "" })
  ];
  for (const body of cases) {
    const { res, db } = call(createContract, { body });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(db.contracts.length, 0);
  }
  // start == end is a valid one-day contract
  assert.equal(call(createContract, { body: validContract({ start_date: "2026-05-01", end_date: "2026-05-01" }) }).res.statusCode, 201);
});

test("client must exist and be active", () => {
  assert.equal(call(createContract, { body: validContract({ client_id: "client-missing" }) }).res.statusCode, 400);
  assert.equal(call(createContract, { body: validContract({ client_id: "client-archived" }) }).res.statusCode, 400);
  assert.equal(call(createContract, { body: validContract({ client_id: "" }) }).res.statusCode, 400);
  const { res } = call(createContract, { body: { title: "No client", start_date: "2026-01-01", end_date: "2026-02-01" } });
  assert.equal(res.statusCode, 400);
});

test("status, title and value are validated", () => {
  for (const body of [
    validContract({ status: "Bogus" }),
    validContract({ status: "Expired" }),   // reachable only through an update
    validContract({ status: "Cancelled" }),
    validContract({ title: "   " }),
    validContract({ title: "x".repeat(161) }),
    validContract({ total_value: -1 }),
    validContract({ total_value: "12000" }),
    validContract({ total_value: Number.POSITIVE_INFINITY })
  ]) {
    assert.equal(call(createContract, { body }).res.statusCode, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal(call(createContract, { body: validContract({ status: "Active" }) }).res.body.data.status, "Active");
  assert.equal(call(createContract, { body: validContract({ total_value: 0 }) }).res.body.data.total_value, 0);
});

test("validation failures name the field so the person can fix it", () => {
  const { res } = call(createContract, { body: validContract({ title: "" }) });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /title/i);
  assert.ok(Array.isArray(res.body.errors) && res.body.errors[0].field === "title");
});

test("an empty update body is rejected", () => {
  const db = createDb();
  const contract = addContract(db);
  assert.equal(call(updateContract, { db, params: { id: contract.id }, body: {} }).res.statusCode, 400);
  assert.equal(call(updateContract, { db, params: { id: contract.id }, body: undefined }).res.statusCode, 400);
});

test("updating an unknown contract returns 404", () => {
  assert.equal(call(updateContract, { params: { id: "contract_nope" }, body: { title: "x" } }).res.statusCode, 404);
});

test("explicit undefined in an update never overwrites a stored field", () => {
  const db = createDb();
  const contract = addContract(db, { title: "Keep me" });
  const { res } = call(updateContract, { db, params: { id: contract.id }, body: { title: undefined, total_value: 500 } });
  assert.equal(res.statusCode, 200);
  assert.equal(contract.title, "Keep me");
  assert.equal(contract.total_value, 500);
});

// ---------------------------------------------------------- contract lifecycle

test("contract status follows Draft -> Active -> Expired, with Cancelled allowed before closure", () => {
  const allowed = [["Draft", "Active"], ["Draft", "Cancelled"], ["Active", "Expired"], ["Active", "Cancelled"]];
  for (const [from, to] of allowed) {
    const db = createDb();
    const contract = addContract(db, { status: from });
    const { res } = call(updateContract, { db, params: { id: contract.id }, body: { status: to } });
    assert.equal(res.statusCode, 200, `${from} -> ${to}`);
    assert.equal(contract.status, to);
  }
  const blocked = [["Draft", "Expired"], ["Active", "Draft"]];
  for (const [from, to] of blocked) {
    const db = createDb();
    const contract = addContract(db, { status: from });
    assert.equal(call(updateContract, { db, params: { id: contract.id }, body: { status: to } }).res.statusCode, 409, `${from} -> ${to}`);
    assert.equal(contract.status, from);
  }
});

test("Expired and Cancelled contracts are read-only", () => {
  for (const status of ["Expired", "Cancelled"]) {
    const db = createDb();
    const contract = addContract(db, { status });
    for (const body of [{ title: "Edit" }, { status: "Active" }]) {
      const { res, audits } = call(updateContract, { db, params: { id: contract.id }, body });
      assert.equal(res.statusCode, 409);
      assert.equal(audits.length, 0);
    }
    assert.equal(contract.title, "Seed contract");
  }
});

test("shrinking contract dates cannot strand an existing schedule", () => {
  const db = createDb();
  const contract = addContract(db);
  addSchedule(db, contract, { next_due_date: "2026-11-01" });
  const before = snapshot(contract);
  const { res, audits } = call(updateContract, { db, params: { id: contract.id }, body: { end_date: "2026-10-01" } });
  assert.equal(res.statusCode, 409);
  assert.equal(snapshot(contract), before);
  assert.equal(audits.length, 0);
  assert.equal(call(updateContract, { db, params: { id: contract.id }, body: { end_date: "2027-03-01" } }).res.statusCode, 200);
});

// -------------------------------------------------------- schedule validation

test("creating a schedule stores server-owned fields and optional tag", () => {
  const db = createDb();
  const contract = addContract(db);
  const { res, audits } = call(createMaintenanceSchedule, {
    role: roles.OPERATIONS, db,
    body: validSchedule(contract.id, { equipment_tag_id: "tag-a", notes: " Grease bearings " })
  });
  assert.equal(res.statusCode, 201);
  const record = res.body.data;
  assert.match(record.id, /^maintenance_/);
  assert.equal(record.contract_id, contract.id);
  assert.equal(record.equipment_tag_id, "tag-a");
  assert.equal(record.equipment_tag_code, "EQ-A-1");
  assert.equal(record.notes, "Grease bearings");
  assert.equal(record.created_by_user_id, "operations-1");
  assert.equal(db.maintenance_schedules.length, 1);
  assert.equal("equipment_tag_code" in db.maintenance_schedules[0], false);
  assert.equal(audits.length, 1);

  const noTag = call(createMaintenanceSchedule, { db, body: validSchedule(contract.id) }).res.body.data;
  assert.equal(noTag.equipment_tag_id, null);
  assert.equal(noTag.notes, "");
});

test("schedule requires an existing contract", () => {
  assert.equal(call(createMaintenanceSchedule, { body: validSchedule("contract_missing") }).res.statusCode, 400);
  assert.equal(call(createMaintenanceSchedule, { body: { frequency: "Weekly", next_due_date: "2026-06-15" } }).res.statusCode, 400);
});

test("a schedule cannot be attached to an Expired or Cancelled contract", () => {
  for (const status of ["Expired", "Cancelled"]) {
    const db = createDb();
    const contract = addContract(db, { status });
    const { res, audits } = call(createMaintenanceSchedule, { db, body: validSchedule(contract.id) });
    assert.equal(res.statusCode, 409, status);
    assert.equal(db.maintenance_schedules.length, 0);
    assert.equal(audits.length, 0);
  }
  const db = createDb();
  const draft = addContract(db, { status: "Draft" });
  assert.equal(call(createMaintenanceSchedule, { db, body: validSchedule(draft.id) }).res.statusCode, 201);
});

test("schedule frequency and date are validated", () => {
  const db = createDb();
  const contract = addContract(db);
  for (const frequency of ["Daily", "monthly", "", undefined]) {
    assert.equal(call(createMaintenanceSchedule, { db, body: validSchedule(contract.id, { frequency }) }).res.statusCode, 400, String(frequency));
  }
  for (const frequency of ["Weekly", "Monthly", "Quarterly", "Biannual", "Annual"]) {
    assert.equal(call(createMaintenanceSchedule, { db, body: validSchedule(contract.id, { frequency }) }).res.statusCode, 201, frequency);
  }
  for (const next_due_date of ["2026-6-15", "2026-02-30", "not-a-date", ""]) {
    assert.equal(call(createMaintenanceSchedule, { db, body: validSchedule(contract.id, { next_due_date }) }).res.statusCode, 400, next_due_date);
  }
});

test("next due date must fall inside the contract period", () => {
  const db = createDb();
  const contract = addContract(db, { start_date: "2026-03-01", end_date: "2026-09-30" });
  for (const next_due_date of ["2026-02-28", "2026-10-01"]) {
    assert.equal(call(createMaintenanceSchedule, { db, body: validSchedule(contract.id, { next_due_date }) }).res.statusCode, 400, next_due_date);
  }
  for (const next_due_date of ["2026-03-01", "2026-09-30"]) {
    assert.equal(call(createMaintenanceSchedule, { db, body: validSchedule(contract.id, { next_due_date }) }).res.statusCode, 201, next_due_date);
  }
});

test("equipment tag must exist, be active, and belong to the contract's client", () => {
  const db = createDb();
  const contract = addContract(db, { client_id: "client-a" });
  for (const equipment_tag_id of ["tag-missing", "tag-archived", "tag-b", "tag-orphan"]) {
    const { res, audits } = call(createMaintenanceSchedule, { db, body: validSchedule(contract.id, { equipment_tag_id }) });
    assert.equal(res.statusCode, 400, equipment_tag_id);
    assert.equal(audits.length, 0);
  }
  assert.equal(db.maintenance_schedules.length, 0);
  assert.equal(call(createMaintenanceSchedule, { db, body: validSchedule(contract.id, { equipment_tag_id: "tag-a" }) }).res.statusCode, 201);
  assert.equal(call(createMaintenanceSchedule, { db, body: validSchedule(contract.id, { equipment_tag_id: null }) }).res.statusCode, 201);
});

test("server-owned fields are rejected on schedules and contract_id cannot be changed", () => {
  const db = createDb();
  const contract = addContract(db);
  const other = addContract(db, { title: "Other" });
  for (const key of ["id", "created_by_user_id", "created_at", "updated_at", "equipment_tag_code"]) {
    assert.equal(call(createMaintenanceSchedule, { db, body: validSchedule(contract.id, { [key]: "forged" }) }).res.statusCode, 400, `create ${key}`);
  }
  const schedule = addSchedule(db, contract);
  const { res } = call(updateMaintenanceSchedule, { db, params: { id: schedule.id }, body: { contract_id: other.id } });
  assert.equal(res.statusCode, 400);
  assert.equal(schedule.contract_id, contract.id);
});

test("schedule update validates changed fields and supports clearing the tag", () => {
  const db = createDb();
  const contract = addContract(db);
  const schedule = addSchedule(db, contract, { equipment_tag_id: "tag-a" });

  assert.equal(call(updateMaintenanceSchedule, { db, params: { id: schedule.id }, body: { frequency: "Daily" } }).res.statusCode, 400);
  assert.equal(call(updateMaintenanceSchedule, { db, params: { id: schedule.id }, body: { next_due_date: "2027-06-01" } }).res.statusCode, 400);
  assert.equal(call(updateMaintenanceSchedule, { db, params: { id: schedule.id }, body: { equipment_tag_id: "tag-b" } }).res.statusCode, 400);
  assert.equal(call(updateMaintenanceSchedule, { db, params: { id: schedule.id }, body: {} }).res.statusCode, 400);
  assert.equal(schedule.frequency, "Monthly");

  const cleared = call(updateMaintenanceSchedule, { db, params: { id: schedule.id }, body: { equipment_tag_id: null, frequency: "Quarterly", next_due_date: "2026-09-01" } });
  assert.equal(cleared.res.statusCode, 200);
  assert.equal(schedule.equipment_tag_id, null);
  assert.equal(schedule.frequency, "Quarterly");
  assert.equal(cleared.res.body.data.equipment_tag_code, null);
});

test("an archived tag already on a schedule does not block editing other fields", () => {
  const db = createDb();
  const contract = addContract(db);
  const schedule = addSchedule(db, contract, { equipment_tag_id: "tag-archived" });
  assert.equal(call(updateMaintenanceSchedule, { db, params: { id: schedule.id }, body: { notes: "Still editable" } }).res.statusCode, 200);
});

test("schedules of a closed contract cannot be edited; unknown schedule is 404", () => {
  const db = createDb();
  const contract = addContract(db, { status: "Cancelled" });
  const schedule = addSchedule(db, contract);
  assert.equal(call(updateMaintenanceSchedule, { db, params: { id: schedule.id }, body: { notes: "x" } }).res.statusCode, 409);
  assert.equal(call(updateMaintenanceSchedule, { db, params: { id: "maintenance_nope" }, body: { notes: "x" } }).res.statusCode, 404);

  const orphanDb = createDb();
  const orphan = { id: "maintenance_orphan", contract_id: "contract_gone", frequency: "Weekly", next_due_date: "2026-03-01" };
  orphanDb.maintenance_schedules.push(orphan);
  assert.equal(call(updateMaintenanceSchedule, { db: orphanDb, params: { id: orphan.id }, body: { notes: "x" } }).res.statusCode, 409);
});

// ------------------------------------------------------------------- auditing

test("every contract and schedule create/update is audited with actor, entity and before/after", () => {
  const db = createDb();
  const store = createStore();

  const created = call(createContract, { db, store, role: roles.MANAGEMENT, body: validContract() }).res.body.data;
  const updated = call(updateContract, { db, store, role: roles.ADMIN, params: { id: created.id }, body: { title: "Renamed" } }).res.body.data;
  const schedule = call(createMaintenanceSchedule, { db, store, role: roles.OPERATIONS, body: validSchedule(created.id) }).res.body.data;
  call(updateMaintenanceSchedule, { db, store, role: roles.ADMIN, params: { id: schedule.id }, body: { notes: "Done" } });

  assert.equal(store.audits.length, 4);
  const [[dbA, actorA, typeA, idA, actionA, oldA, newA], [, actorB, typeB, , actionB, oldB, newB], [, actorC, typeC, idC, actionC, oldC], [, actorD, typeD, , actionD, oldD, newD]] = store.audits;

  assert.equal(dbA, db);
  assert.deepEqual([actorA.id, typeA, idA, actionA, oldA], ["management-1", "contract", created.id, "CONTRACT_CREATED", null]);
  assert.equal(newA.contract_number, "CTR-0001");

  assert.deepEqual([actorB.id, typeB, actionB], ["admin-1", "contract", "CONTRACT_UPDATED"]);
  assert.equal(oldB.title, "Annual cyclone maintenance");
  assert.equal(newB.title, "Renamed");
  assert.equal(updated.title, "Renamed");

  assert.deepEqual([actorC.id, typeC, idC, actionC, oldC], ["operations-1", "maintenance_schedule", schedule.id, "MAINTENANCE_SCHEDULE_CREATED", null]);
  assert.deepEqual([actorD.id, typeD, actionD], ["admin-1", "maintenance_schedule", "MAINTENANCE_SCHEDULE_UPDATED"]);
  assert.equal(oldD.notes, "");
  assert.equal(newD.notes, "Done");
});

test("audit snapshots are copies, not live references to the stored record", () => {
  const db = createDb();
  const store = createStore();
  const created = call(createContract, { db, store, body: validContract() }).res.body.data;
  call(updateContract, { db, store, params: { id: created.id }, body: { title: "Changed later" } });
  assert.equal(store.audits[0][6].title, "Annual cyclone maintenance");
  assert.equal(store.audits[1][5].title, "Annual cyclone maintenance");
});

test("rejected requests never audit and never mutate the database", () => {
  const db = createDb();
  const contract = addContract(db);
  addSchedule(db, contract);
  const before = snapshot(db);
  const store = createStore();
  const attempts = [
    () => call(createContract, { db, store, body: validContract({ end_date: "2020-01-01" }) }),
    () => call(updateContract, { db, store, params: { id: contract.id }, body: { status: "Draft" } }),
    () => call(createMaintenanceSchedule, { db, store, body: validSchedule(contract.id, { frequency: "Daily" }) }),
    () => call(updateMaintenanceSchedule, { db, store, params: { id: "maintenance_seed_1" }, body: { next_due_date: "2099-01-01" } })
  ];
  for (const attempt of attempts) assert.ok(attempt().res.statusCode >= 400);
  assert.equal(snapshot(db), before);
  assert.equal(store.audits.length, 0);
});

// ------------------------------------------------- no delete / no generic route

test("the controller exposes no delete operation", () => {
  const exported = Object.keys(contractsController);
  assert.deepEqual(exported.sort(), [
    "createContract", "createMaintenanceSchedule", "listContracts",
    "listMaintenanceSchedules", "updateContract", "updateMaintenanceSchedule"
  ]);
  assert.ok(!exported.some((name) => /delete|remove|destroy|dispatch|notify|email/i.test(name)));
});

test("router wires six explicit protected routes and no delete or generic collection route", () => {
  const router = readFileSync(new URL("../src/router.js", import.meta.url), "utf8");
  const authAt = router.indexOf("router.use(authMiddleware)");
  assert.ok(authAt > 0);

  const expected = [
    ['get', '/contracts', 'listContracts'],
    ['post', '/contracts', 'createContract'],
    ['patch', '/contracts/:id', 'updateContract'],
    ['get', '/maintenance-schedules', 'listMaintenanceSchedules'],
    ['post', '/maintenance-schedules', 'createMaintenanceSchedule'],
    ['patch', '/maintenance-schedules/:id', 'updateMaintenanceSchedule']
  ];
  for (const [verb, path, handler] of expected) {
    const line = `router.${verb}("${path}", ${handler});`;
    const at = router.indexOf(line);
    assert.ok(at > authAt, `${line} must be registered after authMiddleware`);
  }
  assert.doesNotMatch(router, /router\.delete\(/);
  assert.doesNotMatch(router, /router\.(?:get|post|patch|put|delete|all)\(["'`][^"'`]*(?:contracts|maintenance)[^"'`]*["'`],\s*getCollection/);

  const collections = /const collections = \[([\s\S]*?)\];/.exec(router)[1];
  assert.doesNotMatch(collections, /contracts|maintenance_schedules/, "must not join the generic collection list");
});

// ----------------------------------------------------------- persistence shape

test("existing stores gain empty contracts and schedules on read, without a migration", () => {
  const legacy = { users: [], clients: [{ id: "client-a" }] };
  const normalized = normalizeDb(legacy);
  assert.deepEqual(normalized.contracts, []);
  assert.deepEqual(normalized.maintenance_schedules, []);
  assert.equal(normalized.clients.length, 1);

  const existing = normalizeDb({ users: [], contracts: [{ id: "contract_1" }], maintenance_schedules: [{ id: "maintenance_1" }] });
  assert.equal(existing.contracts[0].id, "contract_1");
  assert.equal(existing.maintenance_schedules[0].id, "maintenance_1");
});
