import { hasPermission } from "../permissions.js";
import { scopeByClient } from "../middleware/clientScope.js";
import {
  CreateContractSchema,
  UpdateContractSchema,
  CreateMaintenanceScheduleSchema,
  UpdateMaintenanceScheduleSchema,
  isRealIsoDate
} from "../schemas.js";

// Contracts and preventative-maintenance schedules (pilot).
//
// Design rules enforced here, in the controller, so they hold no matter how a
// route is wired or whether the shared validate() middleware is in front:
//   - permission is checked before the body is parsed or any record is read;
//   - every write is validated in full BEFORE the database object is touched,
//     so a rejected request leaves no partial change and no audit entry;
//   - ids, contract numbers, creator and timestamps are always server-owned;
//   - a Client Viewer only ever sees records for their own authenticated client;
//   - there is no delete, no dispatch, no notification and no external call.

const OPEN_CONTRACT_STATUSES = ["Draft", "Active"];

// Expired and Cancelled are terminal: a closed contract cannot be revived or
// edited, and no new schedule can be attached to it.
const CONTRACT_STATUS_TRANSITIONS = {
  Draft: ["Active", "Cancelled"],
  Active: ["Expired", "Cancelled"],
  Expired: [],
  Cancelled: []
};

function resolveActor(req) {
  // Fail closed. coreController.getActor() falls back to users[0] when there is
  // no req.user; these records must never be readable through that fallback.
  if (!req.user?.id) return null;
  return (req.db?.users || []).find((user) => user.id === req.user.id) || null;
}

function fail(res, status, message, errors) {
  const body = { success: false, message };
  if (errors) body.errors = errors;
  return res.status(status).json(body);
}

function denied(res, actor, action) {
  return fail(res, 403, `Role ${actor?.role || "Unknown"} cannot ${action}.`);
}

function schemaFailure(res, error) {
  // Zod 3 exposes `errors`, Zod 4 only `issues`. Read either so the person sees
  // which field to fix instead of a generic message.
  const issues = error?.issues || error?.errors || [];
  const errors = issues.map((issue) => ({
    field: (issue.path || []).join(".") || "body",
    message: issue.message
  }));
  const message = errors.length
    ? errors.map((item) => (item.field === "body" ? item.message : `${item.field}: ${item.message}`)).join("; ")
    : "Invalid request payload.";
  return fail(res, 400, message, errors);
}

function definedOnly(values) {
  // An explicit `undefined` must never overwrite a stored field.
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function nextContractNumber(contracts) {
  let highest = 0;
  for (const contract of contracts) {
    const match = /^CTR-(\d+)$/.exec(String(contract.contract_number || ""));
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `CTR-${String(highest + 1).padStart(4, "0")}`;
}

function contractDateProblem(startDate, endDate) {
  if (!isRealIsoDate(startDate) || !isRealIsoDate(endDate)) return "Contract dates must be real calendar dates (YYYY-MM-DD).";
  if (endDate < startDate) return "Contract end date cannot be before the start date.";
  return null;
}

function activeClient(db, clientId) {
  const client = (db.clients || []).find((item) => item.id === clientId);
  return client && client.is_active !== false ? client : null;
}

// equipment tag -> plant section -> plant -> mine site -> client.
// Returns null when any link is missing so an unresolvable tag is never
// treated as belonging to the caller's client.
function equipmentTagClientId(db, tag) {
  const section = (db.plant_sections || []).find((item) => item.id === tag.plant_section_id);
  const plant = section && (db.plants || []).find((item) => item.id === section.plant_id);
  const site = plant && (db.mine_sites || []).find((item) => item.id === plant.mine_site_id);
  return site?.client_id || null;
}

function equipmentTagProblem(db, tagId, contract) {
  const tag = (db.equipment_tags || []).find((item) => item.id === tagId);
  if (!tag || tag.is_active === false) return "Equipment tag not found or inactive.";
  if (equipmentTagClientId(db, tag) !== contract.client_id) {
    return "Equipment tag does not belong to this contract's client.";
  }
  return null;
}

function scheduleDateProblem(nextDueDate, contract) {
  if (!isRealIsoDate(nextDueDate)) return "Next due date must be a real calendar date (YYYY-MM-DD).";
  if (nextDueDate < contract.start_date || nextDueDate > contract.end_date) {
    return `Next due date must fall within the contract period (${contract.start_date} to ${contract.end_date}).`;
  }
  return null;
}

// Derived, read-only, never persisted: lets a Client Viewer see the tag code
// without needing read access to the internal equipment_tags collection.
function presentSchedule(db, schedule) {
  const contract = (db.contracts || []).find((item) => item.id === schedule.contract_id);
  const tag = schedule.equipment_tag_id
    ? (db.equipment_tags || []).find((item) => item.id === schedule.equipment_tag_id)
    : null;
  const tagVisible = tag && contract && equipmentTagClientId(db, tag) === contract.client_id;
  return { ...schedule, equipment_tag_code: tagVisible ? tag.tag_code : null };
}

// ---------------------------------------------------------------- contracts

export function listContracts(req, res) {
  const actor = resolveActor(req);
  if (!hasPermission(actor, "viewContracts")) return denied(res, actor, "view contracts");

  const visible = scopeByClient(req.db.contracts || [], actor, (contract) => contract.client_id);
  const data = [...visible].sort((a, b) =>
    String(b.created_at || "").localeCompare(String(a.created_at || "")) ||
    String(b.contract_number || "").localeCompare(String(a.contract_number || ""), undefined, { numeric: true })
  );
  return res.json({ success: true, data });
}

export function createContract(req, res) {
  const actor = resolveActor(req);
  if (!hasPermission(actor, "manageContracts")) return denied(res, actor, "create contracts");

  const parsed = CreateContractSchema.safeParse(req.body);
  if (!parsed.success) return schemaFailure(res, parsed.error);
  const body = parsed.data;

  if (!activeClient(req.db, body.client_id)) return fail(res, 400, "Client not found or inactive.");
  const dateProblem = contractDateProblem(body.start_date, body.end_date);
  if (dateProblem) return fail(res, 400, dateProblem);

  if (!Array.isArray(req.db.contracts)) req.db.contracts = [];
  const now = new Date().toISOString();
  const record = {
    id: req.store.id("contract"),
    contract_number: nextContractNumber(req.db.contracts),
    client_id: body.client_id,
    title: body.title,
    start_date: body.start_date,
    end_date: body.end_date,
    total_value: body.total_value ?? null,
    status: body.status ?? "Draft",
    created_by_user_id: actor.id,
    created_at: now,
    updated_at: now
  };

  req.db.contracts.push(record);
  req.store.audit(req.db, actor, "contract", record.id, "CONTRACT_CREATED", null, { ...record });
  return res.status(201).json({ success: true, data: record });
}

export function updateContract(req, res) {
  const actor = resolveActor(req);
  if (!hasPermission(actor, "manageContracts")) return denied(res, actor, "update contracts");

  const contract = (req.db.contracts || []).find((item) => item.id === req.params?.id);
  if (!contract) return fail(res, 404, "Contract not found.");

  const parsed = UpdateContractSchema.safeParse(req.body);
  if (!parsed.success) return schemaFailure(res, parsed.error);
  const changes = definedOnly(parsed.data);

  if (!OPEN_CONTRACT_STATUSES.includes(contract.status)) {
    return fail(res, 409, `${contract.contract_number} is ${contract.status} and can no longer be edited.`);
  }
  if (changes.status && changes.status !== contract.status &&
      !CONTRACT_STATUS_TRANSITIONS[contract.status].includes(changes.status)) {
    return fail(res, 409, `A ${contract.status} contract cannot change to ${changes.status}.`);
  }

  const startDate = changes.start_date ?? contract.start_date;
  const endDate = changes.end_date ?? contract.end_date;
  const dateProblem = contractDateProblem(startDate, endDate);
  if (dateProblem) return fail(res, 400, dateProblem);

  if (changes.start_date !== undefined || changes.end_date !== undefined) {
    const stranded = (req.db.maintenance_schedules || []).filter((schedule) =>
      schedule.contract_id === contract.id &&
      (schedule.next_due_date < startDate || schedule.next_due_date > endDate)
    );
    if (stranded.length > 0) {
      return fail(res, 409, `${stranded.length} maintenance schedule(s) fall due outside the new contract dates. Update those schedules first.`);
    }
  }

  const before = { ...contract };
  Object.assign(contract, changes, { updated_at: new Date().toISOString() });
  req.store.audit(req.db, actor, "contract", contract.id, "CONTRACT_UPDATED", before, { ...contract });
  return res.json({ success: true, data: contract });
}

// ------------------------------------------------------ maintenance schedules

export function listMaintenanceSchedules(req, res) {
  const actor = resolveActor(req);
  if (!hasPermission(actor, "viewContracts")) return denied(res, actor, "view maintenance schedules");

  const contractClient = new Map((req.db.contracts || []).map((contract) => [contract.id, contract.client_id]));
  // A schedule whose contract cannot be found resolves to null, so it is hidden
  // from a Client Viewer rather than shown by default.
  const visible = scopeByClient(req.db.maintenance_schedules || [], actor, (schedule) =>
    contractClient.get(schedule.contract_id) ?? null
  );
  const data = [...visible]
    .sort((a, b) =>
      String(a.next_due_date || "").localeCompare(String(b.next_due_date || "")) ||
      String(a.id).localeCompare(String(b.id))
    )
    .map((schedule) => presentSchedule(req.db, schedule));
  return res.json({ success: true, data });
}

export function createMaintenanceSchedule(req, res) {
  const actor = resolveActor(req);
  if (!hasPermission(actor, "manageMaintenanceSchedules")) return denied(res, actor, "create maintenance schedules");

  const parsed = CreateMaintenanceScheduleSchema.safeParse(req.body);
  if (!parsed.success) return schemaFailure(res, parsed.error);
  const body = parsed.data;

  const contract = (req.db.contracts || []).find((item) => item.id === body.contract_id);
  if (!contract) return fail(res, 400, "Contract not found.");
  if (!OPEN_CONTRACT_STATUSES.includes(contract.status)) {
    return fail(res, 409, `${contract.contract_number} is ${contract.status}. Schedules can only be added to Draft or Active contracts.`);
  }
  const dateProblem = scheduleDateProblem(body.next_due_date, contract);
  if (dateProblem) return fail(res, 400, dateProblem);
  if (body.equipment_tag_id) {
    const tagProblem = equipmentTagProblem(req.db, body.equipment_tag_id, contract);
    if (tagProblem) return fail(res, 400, tagProblem);
  }

  if (!Array.isArray(req.db.maintenance_schedules)) req.db.maintenance_schedules = [];
  const now = new Date().toISOString();
  const record = {
    id: req.store.id("maintenance"),
    contract_id: contract.id,
    equipment_tag_id: body.equipment_tag_id ?? null,
    frequency: body.frequency,
    next_due_date: body.next_due_date,
    notes: body.notes ?? "",
    created_by_user_id: actor.id,
    created_at: now,
    updated_at: now
  };

  req.db.maintenance_schedules.push(record);
  req.store.audit(req.db, actor, "maintenance_schedule", record.id, "MAINTENANCE_SCHEDULE_CREATED", null, { ...record });
  return res.status(201).json({ success: true, data: presentSchedule(req.db, record) });
}

export function updateMaintenanceSchedule(req, res) {
  const actor = resolveActor(req);
  if (!hasPermission(actor, "manageMaintenanceSchedules")) return denied(res, actor, "update maintenance schedules");

  const schedule = (req.db.maintenance_schedules || []).find((item) => item.id === req.params?.id);
  if (!schedule) return fail(res, 404, "Maintenance schedule not found.");

  const parsed = UpdateMaintenanceScheduleSchema.safeParse(req.body);
  if (!parsed.success) return schemaFailure(res, parsed.error);
  const changes = definedOnly(parsed.data);

  const contract = (req.db.contracts || []).find((item) => item.id === schedule.contract_id);
  if (!contract) return fail(res, 409, "The contract for this schedule could not be found.");
  if (!OPEN_CONTRACT_STATUSES.includes(contract.status)) {
    return fail(res, 409, `${contract.contract_number} is ${contract.status}. Its schedules can no longer be edited.`);
  }

  const nextDueDate = changes.next_due_date ?? schedule.next_due_date;
  const dateProblem = scheduleDateProblem(nextDueDate, contract);
  if (dateProblem) return fail(res, 400, dateProblem);

  // Only a tag being set now is re-checked. A contract's client never changes,
  // so an unchanged tag stays valid even if it was archived later.
  if (changes.equipment_tag_id) {
    const tagProblem = equipmentTagProblem(req.db, changes.equipment_tag_id, contract);
    if (tagProblem) return fail(res, 400, tagProblem);
  }

  const before = { ...schedule };
  Object.assign(schedule, changes, { updated_at: new Date().toISOString() });
  req.store.audit(req.db, actor, "maintenance_schedule", schedule.id, "MAINTENANCE_SCHEDULE_UPDATED", before, { ...schedule });
  return res.json({ success: true, data: presentSchedule(req.db, schedule) });
}
