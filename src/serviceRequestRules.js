// Client Service Requests - pure domain rules (no I/O, no Express, no store).
// Workflow: Client Viewer request -> Sales/Operations triage -> one explicit lead.

export const SERVICE_REQUEST_STATUS = Object.freeze({
  SUBMITTED: "Submitted",
  ACKNOWLEDGED: "Acknowledged",
  ACCEPTED: "Accepted",
  DECLINED: "Declined",
  CONVERTED: "Converted_To_Lead"
});

export const SERVICE_REQUEST_STATUSES = Object.freeze(Object.values(SERVICE_REQUEST_STATUS));

// Same vocabulary as the public request form (frontend LandingPage.jsx).
export const SERVICE_REQUEST_URGENCIES = Object.freeze(["standard", "planned_shutdown", "urgent_downtime"]);

export const SERVICE_REQUEST_LIMITS = Object.freeze({ title: 160, serviceNeed: 2000, note: 1000 });

// The only status changes a triage decision may make. Conversion is separate.
export const TRIAGE_DECISIONS = Object.freeze({
  acknowledge: Object.freeze({
    from: [SERVICE_REQUEST_STATUS.SUBMITTED],
    to: SERVICE_REQUEST_STATUS.ACKNOWLEDGED,
    action: "SERVICE_REQUEST_ACKNOWLEDGED"
  }),
  accept: Object.freeze({
    from: [SERVICE_REQUEST_STATUS.ACKNOWLEDGED],
    to: SERVICE_REQUEST_STATUS.ACCEPTED,
    action: "SERVICE_REQUEST_ACCEPTED"
  }),
  decline: Object.freeze({
    from: [SERVICE_REQUEST_STATUS.SUBMITTED, SERVICE_REQUEST_STATUS.ACKNOWLEDGED],
    to: SERVICE_REQUEST_STATUS.DECLINED,
    action: "SERVICE_REQUEST_DECLINED"
  })
});

export const TRIAGE_DECISION_NAMES = Object.freeze(Object.keys(TRIAGE_DECISIONS));

export function findTriageDecision(name) {
  // Own-property lookup: "constructor", "__proto__" etc. are never decisions.
  return typeof name === "string" && Object.hasOwn(TRIAGE_DECISIONS, name) ? TRIAGE_DECISIONS[name] : null;
}

const isActive = (item) => item?.is_active !== false;

/**
 * Resolves the optional mine site / equipment tag against the caller's own
 * client. Missing, archived and other-client records all give the same
 * answer so a caller cannot probe for another client's records.
 */
export function resolveOwnedReferences(db, clientId, { mine_site_id: mineSiteId, equipment_tag_id: equipmentTagId } = {}) {
  let mineSite = null;
  let equipment = null;

  if (mineSiteId) {
    mineSite = (db.mine_sites || []).find((item) => item.id === mineSiteId) || null;
    if (!mineSite || mineSite.client_id !== clientId || !isActive(mineSite)) {
      return { ok: false, message: "The selected mine site is not available for your account." };
    }
  }

  if (equipmentTagId) {
    equipment = (db.equipment_tags || []).find((item) => item.id === equipmentTagId) || null;
    const section = equipment && (db.plant_sections || []).find((item) => item.id === equipment.plant_section_id);
    const plant = section && (db.plants || []).find((item) => item.id === section.plant_id);
    const site = plant && (db.mine_sites || []).find((item) => item.id === plant.mine_site_id);
    const chainActive = [equipment, section, plant, site].every((item) => item && isActive(item));
    if (!chainActive || site.client_id !== clientId || (mineSite && mineSite.id !== site.id)) {
      return { ok: false, message: "The selected equipment tag is not available for your account." };
    }
  }

  return { ok: true, mineSite, equipment };
}

export function isRealCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const lookup = (list, id) => (id ? (list || []).find((item) => item.id === id) || null : null);

// What a Client Viewer may see about their own request. Internal identities,
// the triage note and lead linkage are deliberately not included.
export function toClientView(record, db) {
  const mineSite = lookup(db.mine_sites, record.mine_site_id);
  const equipment = lookup(db.equipment_tags, record.equipment_tag_id);
  return {
    id: record.id,
    title: record.title,
    service_need: record.service_need,
    urgency: record.urgency,
    mine_site_id: record.mine_site_id,
    mine_site_name: mineSite && mineSite.client_id === record.client_id ? mineSite.name : null,
    equipment_tag_id: record.equipment_tag_id,
    equipment_tag_code: equipment ? equipment.tag_code : null,
    requested_date: record.requested_date,
    status: record.status,
    triaged_at: record.triaged_at,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

// Full record plus display names (derived at read time, never stored).
export function toTriageView(record, db) {
  return {
    ...record,
    client_name: lookup(db.clients, record.client_id)?.name || null,
    mine_site_name: lookup(db.mine_sites, record.mine_site_id)?.name || null,
    equipment_tag_code: lookup(db.equipment_tags, record.equipment_tag_id)?.tag_code || null,
    created_by_name: lookup(db.users, record.created_by_user_id)?.name || null,
    triaged_by_name: lookup(db.users, record.triaged_by_user_id)?.name || null
  };
}

/**
 * Builds the ORAC lead for an accepted request, following the existing
 * createLead shape (coreController.js) plus traceability fields. Only data
 * ORAC already holds is used; nothing is invented.
 */
export function buildLeadFromRequest(record, db, leadId, timestamp) {
  const client = lookup(db.clients, record.client_id);
  const requester = lookup(db.users, record.created_by_user_id);
  const mineSite = lookup(db.mine_sites, record.mine_site_id);
  return {
    id: leadId,
    company_name: client?.name || "",
    contact_name: String(requester?.name || client?.contact_person || "").trim(),
    email: String(requester?.email || client?.email || "").trim(),
    phone: "",
    mine_site: mineSite && mineSite.client_id === record.client_id ? String(mineSite.name || "").trim() : "",
    service_need: record.service_need,
    urgency: record.urgency,
    status: "New",
    created_at: timestamp,
    service_request_id: record.id,
    client_id: record.client_id,
    mine_site_id: record.mine_site_id,
    equipment_tag_id: record.equipment_tag_id,
    requested_date: record.requested_date
  };
}
