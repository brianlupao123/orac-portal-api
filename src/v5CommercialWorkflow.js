import { createHash } from "node:crypto";
import { isEligibleForDb } from "./timesheetEligibility.js";

// V5 remains dark until every dependent adapter is ready. Its master flag is
// intentionally independent from the earlier TIMESHEET_* experiment flags.
export const V5_MASTER_FLAG = "ORAC_V5_COMMERCIAL_WORKFLOW";
export const v5Enabled = () => process.env[V5_MASTER_FLAG] === "enabled";

export const CLIENT_SIGNATURE_METHODS = Object.freeze(["paper_attested", "electronic_otp"]);
export const V5_POLICY_DEFAULTS = Object.freeze({
  invoice_self_approval: "allowed_if_clean",
  client_signature_methods: [],
  unbilled_age_days: 30,
  variance_warning_percent: 80,
  currency: "USD",
  tax_rate: null,
  tax_status: "unconfigured"
});

export function getV5Policy(db) {
  const configured = db?.company_profile?.v5_commercial_policy;
  return { ...V5_POLICY_DEFAULTS, ...(configured && typeof configured === "object" ? configured : {}) };
}

export function validateV5PolicyPatch(patch) {
  const errors = [];
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in V5_POLICY_DEFAULTS)) errors.push(`Unknown V5 policy key: ${key}`);
    else if (key === "invoice_self_approval" && value !== "allowed_if_clean") errors.push("invoice_self_approval must be allowed_if_clean.");
    else if (key === "client_signature_methods" && (!Array.isArray(value) || value.some((method) => !CLIENT_SIGNATURE_METHODS.includes(method)))) errors.push("client_signature_methods contains an unsupported method.");
    else if (key === "unbilled_age_days" && (!Number.isInteger(value) || value < 1 || value > 365)) errors.push("unbilled_age_days must be an integer from 1 to 365.");
    else if (key === "variance_warning_percent" && (typeof value !== "number" || value < 0 || value > 100)) errors.push("variance_warning_percent must be from 0 to 100.");
    else if (key === "currency" && value !== "USD") errors.push("currency must be USD for the V5 pilot.");
    else if (key === "tax_rate" && value !== null) errors.push("tax_rate must remain null until tax is configured.");
    else if (key === "tax_status" && value !== "unconfigured") errors.push("tax_status must remain unconfigured until tax is configured.");
  }
  return errors;
}

export function hoursToHundredths(value) {
  const numeric = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 24) throw new Error("Hours must be greater than 0 and not exceed 24.");
  const hundredths = Math.round(numeric * 100);
  if (Math.abs(numeric * 100 - hundredths) > 1e-7) throw new Error("Hours may use at most two decimal places.");
  return hundredths;
}

export const hundredthsToHours = (hundredths) => Number((Number(hundredths) / 100).toFixed(2));

export function signatureHash({ sheet_id, dispatch_card_id, worker_id, work_date, hours_hundredths, buckets }) {
  const payload = JSON.stringify({ sheet_id, dispatch_card_id, worker_id, work_date, hours_hundredths, buckets: buckets || {} });
  return createHash("sha256").update(payload).digest("hex");
}

export function signatureRefusal(db, method, currentHash, signature) {
  if (!v5Enabled()) return "The V5 commercial workflow is not enabled.";
  if (!CLIENT_SIGNATURE_METHODS.includes(method)) return "Unsupported signature method.";
  if (!getV5Policy(db).client_signature_methods.includes(method)) return "This signature method is not enabled for the pilot.";
  if (!signature || signature.hours_hash !== currentHash) return "The signature does not match the current hours.";
  if (!signature.signer_ref || !signature.evidence_ref || !signature.custodian_user_id) return "The signature evidence is incomplete.";
  return null;
}

export function sheetIsVerified(db, sheet) {
  const currentHash = signatureHash(sheet);
  const orac = sheet?.signatures?.orac;
  const client = sheet?.signatures?.client;
  return !signatureRefusal(db, "paper_attested", currentHash, orac) &&
    !signatureRefusal(db, sheet?.client_signature_method, currentHash, client);
}

// Rate-free input to a future V5 invoice calculation. The mapping is explicit
// so one verified Timesheet cannot be silently priced against an unrelated
// quotation line. Unmapped records are reported rather than discarded.
export function canonicalHoursByQuoteLine(db, dispatchId) {
  const byQuoteLine = {};
  const unmapped = { hours: 0, source_ids: [] };
  for (const sheet of db?.field_worksheets || []) {
    if (sheet.dispatch_card_id !== dispatchId || !isEligibleForDb(db, sheet)) continue;
    const hours = Number(sheet.hours || 0);
    if (!sheet.quote_line_id) {
      unmapped.hours = Number((unmapped.hours + hours).toFixed(2));
      unmapped.source_ids.push(sheet.id);
      continue;
    }
    const current = byQuoteLine[sheet.quote_line_id] || { hours: 0, source_ids: [] };
    current.hours = Number((current.hours + hours).toFixed(2));
    current.source_ids.push(sheet.id);
    byQuoteLine[sheet.quote_line_id] = current;
  }
  return { by_quote_line: byQuoteLine, unmapped };
}

// Material usage is operational evidence, not a client price. A separate,
// append-only allocation links one recorded usage to one accepted V5 material
// line. Unallocated usage remains visible as an exception rather than being
// guessed into a future invoice.
export function allocatedMaterialsByQuoteLine(db, dispatchId) {
  const allocations = db?.v5_material_allocations || [];
  const by_quote_line = {};
  const unallocated = [];
  for (const usage of db?.material_usage || []) {
    if (usage.dispatch_card_id !== dispatchId) continue;
    const allocation = allocations.find((item) => item.material_usage_id === usage.id);
    if (!allocation) {
      unallocated.push({
        material_usage_id: usage.id,
        catalog_item_id: usage.catalog_item_id || null,
        description: usage.description,
        quantity_used: usage.quantity_used,
        unit_of_measure: usage.unit_of_measure || null
      });
      continue;
    }
    const current = by_quote_line[allocation.quote_line_id] || { quantity: 0, source_material_usage_ids: [] };
    current.quantity = Number((current.quantity + Number(allocation.quantity_used || 0)).toFixed(6));
    current.source_material_usage_ids.push(usage.id);
    by_quote_line[allocation.quote_line_id] = current;
  }
  return { by_quote_line, unallocated };
}
