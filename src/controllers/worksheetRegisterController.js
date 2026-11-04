import { hasPermission, requirePermission, roles } from "../permissions.js";
import { registerReviewRefusal, reviewPaused, flag as tsFlag } from "../timesheetWorkflow.js";
import { legacyTimesheetViews } from "../legacyAdapters.js";
import {
  REGISTER_STATUS, RECONCILIATION_STATE, SEVERITY,
  consolidate, mergeAcknowledgements, deriveReconciliationState, countExceptions,
  blockingExceptions, unacknowledgedWarnings, buildGridView, computeTotals, linesHash, stateHash,
  validatePeriod, normaliseName, reconciliationEvidence, verifySourceLineage, sourceRecordIds, DEFAULT_LOOK_AROUND_DAYS
} from "../worksheetRegisterLogic.js";
import { createHash } from "node:crypto";

// Worksheet: explicit routes only (not in the generic `collections`
// list), so list/get always pass through the role check below.
//
// Hours only. Nothing in this controller reads, accepts, stores or returns a
// rate, amount or cost, and nothing here writes to db.timesheets.

const EDITABLE = [REGISTER_STATUS.DRAFT, REGISTER_STATUS.RETURNED];

function getActor(req) {
  return req.db.users.find((u) => u.id === req.user.id);
}

const fail = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });
const userName = (db, id) => (id ? (db.users.find((u) => u.id === id)?.name || null) : null);
const nowIso = () => new Date().toISOString();
const slug = (s) => normaliseName(s).replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60);

function historyEntry(db, actor, action, comment = "") {
  return { at: nowIso(), by: actor.id, by_name: actor.name || null, action, comment: String(comment || "") };
}

// Compact audit payload: the grid itself is derivable, so the audit log carries
// identity, state and counts rather than every consolidated cell.
function auditView(db, record) {
  return {
    id: record.id, reference: record.reference, title: record.title, period: record.period, scope: record.scope,
    status: record.status, reconciliation_state: record.reconciliation_state,
    lines_hash: record.lines_hash || null, totals: record.lines ? computeTotals(record.lines, record.roster).grand : null,
    exception_counts: countExceptions(record.exceptions), roster_size: (record.roster || []).length,
    exclusions: (record.exclusions || []).map(({ source_type, record_id, row_index, reason, by, at }) => ({ source_type, record_id, row_index, reason, by, at })),
    carry_overs: (record.carry_overs || []).map(({ source_type, record_id, row_index, reason, by, at }) => ({ source_type, record_id, row_index, reason, by, at })),
    source_record_ids: sourceRecordIds(record.lines),
    acknowledged: (record.exceptions || []).filter((e) => e.acknowledged_at).map((e) => ({ key: e.key, by: e.acknowledged_by, at: e.acknowledged_at, note: e.acknowledgement_note })),
    approved_by: record.approved_by || null, submitted_by: record.submitted_by || null, built_by: record.built_by || null,
    ...(tsFlag("SALES_ACCESS") && record.status === "Submitted" ? { review_paused: reviewPaused(db, record), review_state_label: reviewPaused(db, record) ? "Review Paused: no independent reviewer" : "Awaiting independent Sales review" } : {}),
    has_reconciliation: Boolean(record.reconciliation)
  };
}

function approvalBlockReason(record, actor) {
  if (record.submitted_by === actor.id) return "The user who submitted this Worksheet cannot approve it. Assign an independent reviewer.";
  if (record.built_by === actor.id) return "The user who last consolidated this Worksheet cannot approve it. Assign an independent reviewer.";
  if ((record.roster || []).some((r) => r.technician_id && r.technician_id === actor.id)) return "You are on this Worksheet's roster and cannot approve your own time.";
  return null;
}

function nextReference(db, periodStart) {
  const prefix = `WKS-${periodStart.slice(0, 7).replace("-", "")}`;
  const count = (db.worksheet_registers || []).filter((m) => (m.reference || "").startsWith(prefix)).length;
  return `${prefix}-${String(count + 1).padStart(3, "0")}`;
}

function actionsFor(db, record, actor) {
  const editable = EDITABLE.includes(record.status);
  const counts = countExceptions(record.exceptions);
  const canManage = hasPermission(actor, "manageWorksheetRegister");
  const reviewBlock = record.status === REGISTER_STATUS.SUBMITTED ? approvalBlockReason(record, actor) : null;
  return {
    can_edit: canManage && editable,
    can_build: canManage && editable,
    can_acknowledge: canManage && editable,
    can_submit: hasPermission(actor, "submitWorksheetRegister") && editable && counts.blocking === 0 && counts.warning_unacknowledged === 0 && (record.lines || []).length > 0,
    can_review: hasPermission(actor, "reviewWorksheetRegister") && record.status === REGISTER_STATUS.SUBMITTED && !reviewBlock,
    review_blocked_reason: reviewBlock,
    can_cancel: canManage && [REGISTER_STATUS.DRAFT, REGISTER_STATUS.SUBMITTED, REGISTER_STATUS.RETURNED].includes(record.status),
    can_reconcile: hasPermission(actor, "reconcileWorksheetRegister") && record.status === REGISTER_STATUS.APPROVED && !record.reconciliation
  };
}

function summaryView(db, record) {
  return {
    id: record.id, reference: record.reference, title: record.title, period: record.period,
    scope: record.scope, client_name: db.clients.find((c) => c.id === record.scope?.client_id)?.name || null,
    status: record.status, reconciliation_state: record.reconciliation_state,
    roster_size: (record.roster || []).length,
    totals: computeTotals(record.lines || [], record.roster || []).grand,
    exception_counts: countExceptions(record.exceptions),
    created_by_name: userName(db, record.created_by), approved_by_name: userName(db, record.approved_by),
    created_at: record.created_at, updated_at: record.updated_at, approved_at: record.approved_at || null
  };
}

function detailView(db, record, actor) {
  const grid = buildGridView(record);
  return {
    ...summaryView(db, record),
    roster: record.roster, holiday_classification: "blocked_pending_policy",
    look_around_days: record.look_around_days, exclusions: record.exclusions || [], carry_overs: record.carry_overs || [],
    grid, lines: record.lines || [], exceptions: record.exceptions || [], history: record.history || [],
    built_at: record.built_at, built_by_name: userName(db, record.built_by), lines_hash: record.lines_hash,
    submitted_by_name: userName(db, record.submitted_by), submitted_at: record.submitted_at || null,
    supervisor_comment: record.supervisor_comment || "", cancelled_reason: record.cancelled_reason || null,
    reconciliation: record.reconciliation || null,
    actions: actionsFor(db, record, actor)
  };
}

// ---- build / validation helpers ----

function resolveRoster(db, rosterInput) {
  const errors = [];
  const seenTech = new Set(); const seenName = new Set();
  const roster = [];
  for (const [i, entry] of rosterInput.entries()) {
    let displayName = String(entry.display_name || "").trim();
    let key;
    if (entry.technician_id) {
      const tech = db.users.find((u) => u.id === entry.technician_id && u.role === roles.TECHNICIAN && u.is_active);
      if (!tech) { errors.push(`Roster row ${i + 1}: technician_id must reference an active Technician.`); continue; }
      if (seenTech.has(tech.id)) { errors.push(`Roster row ${i + 1}: ${tech.name} is listed more than once.`); continue; }
      seenTech.add(tech.id);
      displayName = tech.name || displayName || tech.id;
      key = `t_${tech.id}`;
    } else {
      if (!displayName) { errors.push(`Roster row ${i + 1}: a name is required for an employee without a linked Technician account.`); continue; }
      key = `n_${slug(displayName)}`;
    }
    const norm = normaliseName(displayName);
    if (seenName.has(norm)) { errors.push(`Roster row ${i + 1}: the name "${displayName}" is listed more than once.`); continue; }
    seenName.add(norm);
    roster.push({ key, technician_id: entry.technician_id || null, display_name: displayName, group: String(entry.group || "").trim() });
  }
  return { roster, errors };
}

function validateScope(db, scope) {
  const client = db.clients.find((c) => c.id === scope.client_id);
  if (!client) return "scope.client_id must reference an existing client.";
  if (scope.quote_id) {
    const quote = db.quotes.find((q) => q.id === scope.quote_id);
    if (!quote) return "scope.quote_id must reference an existing quote.";
    if (quote.client_id !== scope.client_id) return "scope.quote_id belongs to a different client.";
  }
  if (scope.purchase_order_id) {
    const po = db.purchase_orders.find((p) => p.id === scope.purchase_order_id);
    if (!po) return "scope.purchase_order_id must reference an existing purchase order.";
    const quote = db.quotes.find((q) => q.id === po.quotation_id);
    if (quote && quote.client_id !== scope.client_id) return "scope.purchase_order_id belongs to a different client.";
  }
  return null;
}

function duplicateScopeConflict(db, record) {
  return (db.worksheet_registers || []).find((m) => m.id !== record.id && m.status !== REGISTER_STATUS.CANCELLED
    && m.period.start === record.period.start && m.period.end === record.period.end
    && m.scope.client_id === record.scope.client_id
    && normaliseName(m.scope.project_title) === normaliseName(record.scope.project_title));
}

function dedupeRefs(list) {
  const seen = new Map();
  for (const x of list || []) seen.set(`${x.source_type}:${x.record_id}#${x.row_index}`, { source_type: x.source_type, record_id: x.record_id, row_index: x.row_index, reason: x.reason });
  return [...seen.values()];
}

// Every override (exclusion / carry-over) carries who, when and why, and the
// change is written to the month's history as plain text for the reviewer.
function stampRefs(list, previous, actor, now) {
  const before = new Map((previous || []).map((x) => [`${x.source_type}:${x.record_id}#${x.row_index}`, x]));
  return dedupeRefs(list).map((x) => {
    const old = before.get(`${x.source_type}:${x.record_id}#${x.row_index}`);
    return old && old.reason === x.reason ? old : { ...x, by: actor.id, at: now };
  });
}

function describeRefChanges(kind, previous, next) {
  const k = (x) => `${x.source_type}:${x.record_id}#${x.row_index}`;
  const had = new Map((previous || []).map((x) => [k(x), x])); const has = new Map((next || []).map((x) => [k(x), x]));
  const lines = [];
  for (const [key, x] of has) if (!had.has(key) || had.get(key).reason !== x.reason) lines.push(`${kind} added: ${x.source_type} ${x.record_id} row ${x.row_index + 1}: ${x.reason}`);
  for (const [key, x] of had) if (!has.has(key)) lines.push(`${kind} removed: ${x.source_type} ${x.record_id} row ${x.row_index + 1} (was: ${x.reason})`);
  return lines;
}

// Server-authoritative rebuild. Acknowledgements survive only while the
// exception they cover is unchanged.
function rebuild(db, record, actor) {
  const fresh = consolidate(record, db);
  record.lines = fresh.lines;
  record.exceptions = mergeAcknowledgements(record.exceptions, fresh.exceptions);
  record.lines_hash = linesHash(record.lines);
  record.state_hash = stateHash(record.lines, record.exceptions);
  record.built_at = nowIso();
  record.built_by = actor.id;
  record.reconciliation_state = deriveReconciliationState(record);
}

function isStale(db, record) {
  const fresh = consolidate(record, db);
  const merged = mergeAcknowledgements(record.exceptions, fresh.exceptions);
  return stateHash(fresh.lines, merged) !== record.state_hash;
}

const STALE_MESSAGE = "This Worksheet no longer matches its source records (a Daily Time Sheet or another Worksheet changed). Rebuild it and review the result before continuing.";

// ---- handlers ----

export const listWorksheetRegisters = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "viewWorksheetRegister");
  const status = req.query?.status;
  const data = (req.db.worksheet_registers || [])
    .filter((m) => !status || m.status === status)
    .map((m) => summaryView(req.db, m))
    .sort((a, b) => String(b.period.start).localeCompare(String(a.period.start)) || String(b.created_at).localeCompare(String(a.created_at)));
  res.json({ success: true, data });
};

// Read-only: legacy records in the one Timesheet shape. Never writes.
export const listLegacyTimesheets = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "viewWorksheetRegister");
  res.json({ success: true, data: legacyTimesheetViews(req.db), read_only: true });
};

export const getWorksheetRegister = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "viewWorksheetRegister");
  const record = (req.db.worksheet_registers || []).find((m) => m.id === req.params.id);
  if (!record) return fail(res, 404, "Worksheet register not found.");
  res.json({ success: true, data: detailView(req.db, record, actor) });
};

export const getWorksheetRegisterDocument = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "viewWorksheetRegister");
  const record = (req.db.worksheet_registers || []).find((m) => m.id === req.params.id);
  if (!record) return fail(res, 404, "Worksheet register not found.");
  res.json({ success: true, data: { record: detailView(req.db, record, actor), company_profile: req.db.company_profile } });
};

// Shared by preview and create so the two can never disagree about validation or figures.
// Returns { error } (status + message, identical for both) or { record } (unsaved, no id, no reference).
function prepareNewRegister(db, body, actor, now) {
  const periodErrors = validatePeriod(body.period_start, body.period_end);
  if (periodErrors.length) return { error: { status: 400, message: periodErrors[0], extra: { errors: periodErrors } } };
  const scopeError = validateScope(db, body.scope);
  if (scopeError) return { error: { status: 400, message: scopeError } };
  const { roster, errors } = resolveRoster(db, body.roster);
  if (errors.length) return { error: { status: 400, message: errors[0], extra: { errors } } };
  const record = {
    id: null,
    reference: null,
    title: body.title,
    period: { start: body.period_start, end: body.period_end },
    scope: { client_id: body.scope.client_id, project_title: body.scope.project_title, quote_id: body.scope.quote_id || null, purchase_order_id: body.scope.purchase_order_id || null, department_section: body.scope.department_section || "" },
    roster,
    look_around_days: body.look_around_days ?? DEFAULT_LOOK_AROUND_DAYS,
    exclusions: stampRefs(body.exclusions, [], actor, now),
    carry_overs: stampRefs(body.carry_overs, [], actor, now),
    status: REGISTER_STATUS.DRAFT,
    reconciliation_state: RECONCILIATION_STATE.NOT_BUILT,
    lines: [], exceptions: [], lines_hash: null, state_hash: null, built_at: null, built_by: null,
    submitted_by: null, submitted_at: null, approved_by: null, approved_at: null, approved_lines_hash: null,
    supervisor_comment: "", cancelled_by: null, cancelled_at: null, cancelled_reason: null,
    reconciliation: null,
    history: [],
    created_by: actor.id, created_at: now, updated_at: now
  };
  return { record };
}

// Fingerprint of what a person is shown in the preview: the figures and open items (stateHash), bound to
// the period and client so a hash from one month or client can never authorise saving another.
const previewHashOf = (record) => createHash("sha256")
  .update(JSON.stringify([stateHash(record.lines, record.exceptions), record.period.start, record.period.end, record.scope.client_id, normaliseName(record.scope.project_title)]))
  .digest("hex");

const existingRegisterView = (m) => (m ? { id: m.id, reference: m.reference, title: m.title, status: m.status } : null);

// Counts only, no money: worker-days are the consolidated lines, dates are the in-period days with hours.
function rollUpSummary(record) {
  const lines = record.lines || [];
  const byKey = new Map();
  for (const l of lines) byKey.set(l.roster_key, (byKey.get(l.roster_key) || 0) + l.normal + l.ot_15 + l.ot_20);
  return {
    worker_days: lines.length,
    dates_covered: new Set(lines.filter((l) => !l.carry_over).map((l) => l.date)).size,
    workers_with_hours: [...byKey.values()].filter((h) => h > 0).length,
    workers_total: (record.roster || []).length,
    source_records: new Set(lines.flatMap((l) => (l.sources || []).map((x) => `${x.source_type}:${x.record_id ?? x.dts_id}`))).size
  };
}

// Read-only: computes the roll-up exactly as Consolidate would, and writes nothing (no register, no audit
// entry, no id). Mounted as a read-only route in persistenceMiddleware.
export const previewWorksheetRegister = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageWorksheetRegister");
  const prepared = prepareNewRegister(req.db, req.body, actor, nowIso());
  if (prepared.error) return fail(res, prepared.error.status, prepared.error.message, prepared.error.extra);
  const record = prepared.record;
  const existing = duplicateScopeConflict(req.db, record);
  const fresh = consolidate(record, req.db);
  record.lines = fresh.lines;
  record.exceptions = fresh.exceptions;
  const counts = countExceptions(record.exceptions);
  const grid = buildGridView(record);
  res.json({
    success: true,
    data: {
      persisted: false,
      period: record.period, scope: record.scope, title: record.title,
      client_name: req.db.clients.find((c) => c.id === record.scope.client_id)?.name || null,
      roster: record.roster,
      grid, lines: record.lines, totals: grid.totals.grand,
      summary: rollUpSummary(record),
      exceptions: record.exceptions, exception_counts: counts,
      ready_to_submit: counts.blocking === 0 && counts.warning_unacknowledged === 0 && record.lines.length > 0,
      existing_register: existingRegisterView(existing),
      can_consolidate: !existing,
      preview_hash: previewHashOf(record)
    }
  });
};

export const createWorksheetRegister = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageWorksheetRegister");
  const body = req.body;
  const now = nowIso();

  const prepared = prepareNewRegister(req.db, body, actor, now);
  if (prepared.error) return fail(res, prepared.error.status, prepared.error.message, prepared.error.extra);
  const record = prepared.record;
  const dup = duplicateScopeConflict(req.db, record);
  if (dup) return fail(res, 409, `Worksheet ${dup.reference} already covers this client, project and period. Open it instead of creating a second one.`);

  rebuild(req.db, record, actor);
  // Consolidate-from-preview: refuse to save figures the person has not seen. Nothing is written or audited.
  if (body.preview_hash && body.preview_hash !== previewHashOf(record)) {
    return fail(res, 409, "The approved Timesheets changed after this preview. Refresh the preview and review the new figures before consolidating.", { code: "STALE_PREVIEW" });
  }
  record.id = req.store.id("wks");
  record.reference = nextReference(req.db, body.period_start);
  record.history.push(historyEntry(req.db, actor, "Created and consolidated"));
  req.db.worksheet_registers.push(record);
  req.store.audit(req.db, actor, "worksheet_register", record.id, "REGISTER_CREATED", null, auditView(req.db, record));
  res.json({ success: true, data: detailView(req.db, record, actor) });
};

export const updateWorksheetRegister = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageWorksheetRegister");
  const record = (req.db.worksheet_registers || []).find((m) => m.id === req.params.id);
  if (!record) return fail(res, 404, "Worksheet register not found.");
  if (!EDITABLE.includes(record.status)) return fail(res, 409, `A Worksheet cannot be edited in ${record.status} status.`);

  const body = req.body;
  const before = auditView(req.db, record);
  const candidate = { ...record, period: { ...record.period }, scope: { ...record.scope } };
  if (body.title !== undefined) candidate.title = body.title;
  if (body.period_start !== undefined || body.period_end !== undefined) {
    candidate.period = { start: body.period_start ?? record.period.start, end: body.period_end ?? record.period.end };
    const periodErrors = validatePeriod(candidate.period.start, candidate.period.end);
    if (periodErrors.length) return fail(res, 400, periodErrors[0], { errors: periodErrors });
  }
  if (body.scope !== undefined) {
    const scopeError = validateScope(req.db, body.scope);
    if (scopeError) return fail(res, 400, scopeError);
    candidate.scope = { client_id: body.scope.client_id, project_title: body.scope.project_title, quote_id: body.scope.quote_id || null, purchase_order_id: body.scope.purchase_order_id || null, department_section: body.scope.department_section || "" };
  }
  if (body.roster !== undefined) {
    const { roster, errors } = resolveRoster(req.db, body.roster);
    if (errors.length) return fail(res, 400, errors[0], { errors });
    candidate.roster = roster;
  }
  if (body.look_around_days !== undefined) candidate.look_around_days = body.look_around_days;
  const now = nowIso();
  const overrideNotes = [];
  if (body.exclusions !== undefined) {
    candidate.exclusions = stampRefs(body.exclusions, record.exclusions, actor, now);
    overrideNotes.push(...describeRefChanges("Exclusion", record.exclusions, candidate.exclusions));
  }
  if (body.carry_overs !== undefined) {
    candidate.carry_overs = stampRefs(body.carry_overs, record.carry_overs, actor, now);
    overrideNotes.push(...describeRefChanges("Carry-over", record.carry_overs, candidate.carry_overs));
  }
  const dup = duplicateScopeConflict(req.db, candidate);
  if (dup) return fail(res, 409, `Worksheet ${dup.reference} already covers this client, project and period.`);

  Object.assign(record, candidate);
  rebuild(req.db, record, actor);
  record.history.push(historyEntry(req.db, actor, overrideNotes.length ? "Override recorded and re-consolidated" : "Edited and re-consolidated", overrideNotes.join(" | ")));
  record.updated_at = nowIso();
  req.store.audit(req.db, actor, "worksheet_register", record.id, overrideNotes.length ? "REGISTER_OVERRIDE_RECORDED" : "REGISTER_UPDATED", before, auditView(req.db, record));
  res.json({ success: true, data: detailView(req.db, record, actor) });
};

export const buildWorksheetRegister = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageWorksheetRegister");
  const record = (req.db.worksheet_registers || []).find((m) => m.id === req.params.id);
  if (!record) return fail(res, 404, "Worksheet register not found.");
  if (!EDITABLE.includes(record.status)) return fail(res, 409, `A Worksheet cannot be re-consolidated in ${record.status} status.`);
  const before = auditView(req.db, record);
  rebuild(req.db, record, actor);
  record.history.push(historyEntry(req.db, actor, "Re-consolidated from Daily Time Sheets"));
  record.updated_at = nowIso();
  req.store.audit(req.db, actor, "worksheet_register", record.id, "REGISTER_BUILT", before, auditView(req.db, record));
  res.json({ success: true, data: detailView(req.db, record, actor) });
};

export const acknowledgeRegisterExceptions = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageWorksheetRegister");
  const record = (req.db.worksheet_registers || []).find((m) => m.id === req.params.id);
  if (!record) return fail(res, 404, "Worksheet register not found.");
  if (!EDITABLE.includes(record.status)) return fail(res, 409, `Exceptions cannot be acknowledged in ${record.status} status.`);
  if (isStale(req.db, record)) return fail(res, 409, STALE_MESSAGE, { code: "STALE_BUILD" });

  const { keys, note } = req.body;
  const targets = [];
  for (const key of keys) {
    const exc = (record.exceptions || []).find((e) => e.key === key);
    if (!exc) return fail(res, 404, `Exception ${key} was not found on this Worksheet.`);
    if (exc.severity === SEVERITY.BLOCKING) return fail(res, 409, `Blocking exception ${exc.code} cannot be acknowledged. Fix the source record or exclude the affected row with a reason.`);
    if (exc.severity === SEVERITY.INFO) return fail(res, 409, `Information item ${exc.code} does not need acknowledgement.`);
    targets.push(exc);
  }
  const before = auditView(req.db, record);
  const at = nowIso();
  for (const exc of targets) { exc.acknowledged_by = actor.id; exc.acknowledged_at = at; exc.acknowledgement_note = note; }
  record.state_hash = stateHash(record.lines, record.exceptions);
  record.reconciliation_state = deriveReconciliationState(record);
  record.history.push(historyEntry(req.db, actor, `Acknowledged ${targets.length} warning(s)`, note));
  record.updated_at = at;
  req.store.audit(req.db, actor, "worksheet_register", record.id, "REGISTER_EXCEPTIONS_ACKNOWLEDGED", before, { ...auditView(req.db, record), acknowledged_keys: keys, note });
  res.json({ success: true, data: detailView(req.db, record, actor) });
};

export const submitWorksheetRegister = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "submitWorksheetRegister");
  const record = (req.db.worksheet_registers || []).find((m) => m.id === req.params.id);
  if (!record) return fail(res, 404, "Worksheet register not found.");
  if (!EDITABLE.includes(record.status)) return fail(res, 409, `A Worksheet cannot be submitted from ${record.status}.`);
  if (isStale(req.db, record)) return fail(res, 409, STALE_MESSAGE, { code: "STALE_BUILD" });
  const blocking = blockingExceptions(record.exceptions);
  if (blocking.length) return fail(res, 409, `${blocking.length} blocking exception(s) must be resolved before submitting.`, { code: "BLOCKING_EXCEPTIONS", exceptions: blocking.map((e) => e.key) });
  const open = unacknowledgedWarnings(record.exceptions);
  if (open.length) return fail(res, 409, `${open.length} warning(s) must be acknowledged before submitting.`, { code: "UNACKNOWLEDGED_WARNINGS", exceptions: open.map((e) => e.key) });
  if (!(record.lines || []).length) return fail(res, 409, "There are no approved Daily Time Sheet hours in this period to submit.", { code: "NO_HOURS" });

  const before = auditView(req.db, record);
  record.status = REGISTER_STATUS.SUBMITTED;
  record.submitted_by = actor.id;
  record.submitted_at = nowIso();
  record.updated_at = record.submitted_at;
  record.history.push(historyEntry(req.db, actor, "Submitted for approval"));
  req.store.audit(req.db, actor, "worksheet_register", record.id, "REGISTER_SUBMITTED", before, auditView(req.db, record));
  res.json({ success: true, data: detailView(req.db, record, actor) });
};

export const reviewWorksheetRegister = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "reviewWorksheetRegister");
  const record = (req.db.worksheet_registers || []).find((m) => m.id === req.params.id);
  if (!record) return fail(res, 404, "Worksheet register not found.");
  if (record.status !== REGISTER_STATUS.SUBMITTED) return fail(res, 409, `Worksheet review requires Submitted status, not ${record.status}.`);

  const independence = registerReviewRefusal(req.db, record, actor);
  if (independence) return fail(res, 403, independence);

  const { decision, comment } = req.body;
  const note = String(comment || "").trim();
  if (decision === "return" && !note) return fail(res, 400, "Returning a Worksheet requires a comment.");
  if (decision === "approve") {
    const block = approvalBlockReason(record, actor);
    if (block) return fail(res, 403, block);
    if (isStale(req.db, record)) return fail(res, 409, STALE_MESSAGE, { code: "STALE_BUILD" });
    if (blockingExceptions(record.exceptions).length || unacknowledgedWarnings(record.exceptions).length) {
      return fail(res, 409, "Open exceptions remain. Return this Worksheet for correction.", { code: "OPEN_EXCEPTIONS" });
    }
  }

  const before = auditView(req.db, record);
  const at = nowIso();
  if (decision === "approve") {
    record.status = REGISTER_STATUS.APPROVED;
    record.approved_by = actor.id; record.approved_at = at;
    record.approved_lines_hash = record.lines_hash;
    record.supervisor_comment = note;
  } else {
    record.status = REGISTER_STATUS.RETURNED;
    record.approved_by = null; record.approved_at = null; record.approved_lines_hash = null;
    record.supervisor_comment = note;
    record.submitted_by = null; record.submitted_at = null;
  }
  record.updated_at = at;
  record.history.push(historyEntry(req.db, actor, decision === "approve" ? "Approved" : "Returned for correction", note));
  req.store.audit(req.db, actor, "worksheet_register", record.id, decision === "approve" ? "REGISTER_APPROVED" : "REGISTER_RETURNED", before, auditView(req.db, record));
  res.json({ success: true, data: detailView(req.db, record, actor) });
};

export const cancelWorksheetRegister = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "manageWorksheetRegister");
  const record = (req.db.worksheet_registers || []).find((m) => m.id === req.params.id);
  if (!record) return fail(res, 404, "Worksheet register not found.");
  if (record.status === REGISTER_STATUS.APPROVED) return fail(res, 409, "An approved Worksheet cannot be cancelled here. Revising an approved month needs an owner-approved process.");
  if (record.status === REGISTER_STATUS.CANCELLED) return fail(res, 409, "This Worksheet is already cancelled.");
  const before = auditView(req.db, record);
  record.status = REGISTER_STATUS.CANCELLED;
  record.cancelled_by = actor.id; record.cancelled_at = nowIso(); record.cancelled_reason = req.body.reason;
  record.updated_at = record.cancelled_at;
  record.history.push(historyEntry(req.db, actor, "Cancelled", req.body.reason));
  req.store.audit(req.db, actor, "worksheet_register", record.id, "REGISTER_CANCELLED", before, auditView(req.db, record));
  res.json({ success: true, data: detailView(req.db, record, actor) });
};

// The one reconciliation path. Approved Worksheets only; idempotent;
// records hours-only evidence; never creates billable time (no rate source yet).
export const reconcileWorksheetRegister = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "reconcileWorksheetRegister");
  const record = (req.db.worksheet_registers || []).find((m) => m.id === req.params.id);
  if (!record) return fail(res, 404, "Worksheet register not found.");
  if (record.status !== REGISTER_STATUS.APPROVED) return fail(res, 409, `Only an Approved Worksheet can be reconciled, not ${record.status}.`);

  if (record.reconciliation) {
    return res.json({ success: true, already_recorded: true, data: detailView(req.db, record, actor) });
  }
  const drift = verifySourceLineage(record, req.db);
  if (drift.length) return fail(res, 409, "Source Daily Time Sheet rows no longer match what was approved. Reconciliation evidence was not recorded.", { code: "SOURCE_DRIFT", drift });

  const before = auditView(req.db, record);
  record.reconciliation = reconciliationEvidence(record, { actorId: actor.id, now: nowIso(), id: req.store.id("rec") });
  record.reconciliation_state = RECONCILIATION_STATE.EVIDENCE_RECORDED;
  record.updated_at = record.reconciliation.recorded_at;
  record.history.push(historyEntry(req.db, actor, "Non-billable reconciliation evidence recorded"));
  req.store.audit(req.db, actor, "worksheet_register", record.id, "REGISTER_RECONCILIATION_RECORDED", before, { ...auditView(req.db, record), reconciliation_id: record.reconciliation.id, billable_entries_created: 0 });
  res.json({ success: true, already_recorded: false, data: detailView(req.db, record, actor) });
};
