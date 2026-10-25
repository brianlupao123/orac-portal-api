// Persistent Idempotency-Key support for POST /api/leads (F01 / TB-13).
//
// Purpose: a public enquiry that was SAVED but whose HTTP response was lost
// (timeout, dropped connection, closed tab) can be retried with the same key and
// returns the ORIGINAL response instead of creating a second lead.
//
// Where state lives: one array, `idempotency_keys`, inside the existing store
// aggregate (JSON file or the Postgres JSONB row). It is written in the SAME
// store.write() as the lead and its LEAD_CREATED audit entry, so the three are
// committed together or not at all. It is deliberately NOT listed in the
// generic collection routes in router.js, so no GET/deactivate route can reach it.
//
// Honest limits (also in FRONTEND_CONTRACT.md):
//  * 24h retention, measured from the successful first creation. Retries never
//    extend it. After expiry a reused key is a NEW submission.
//  * Each record holds one copy of the original response (the lead as returned)
//    for at most 24h so a replay is byte-for-byte the original. That is a second
//    copy of the lead's personal data inside the same store; it is pruned with
//    the record.
//  * The JSON store serialises requests with an in-process mutex only. Two
//    Node processes sharing one JSON file are NOT protected (pre-existing
//    limit). PostgreSQL serialises across processes through SELECT ... FOR UPDATE.
import { createHash } from "node:crypto";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_REPLAY_HEADER = "Idempotency-Replayed";
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const LEAD_CREATE_SCOPE = "POST /api/leads";
export const IDEMPOTENCY_COLLECTION = "idempotency_keys";

// Exactly what crypto.randomUUID() emits (RFC 4122 version 4), 36 characters.
// Upper-case input is accepted and normalised to lower case.
const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function reject(res, message) {
  return res.status(400).json({ success: false, code: "IDEMPOTENCY_KEY_INVALID", message });
}

function headerOccurrences(req) {
  if (!Array.isArray(req.rawHeaders)) return null;
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (String(req.rawHeaders[i]).toLowerCase() === "idempotency-key") count += 1;
  }
  return count;
}

// Runs BEFORE body validation and before any mutation. Absent header: legacy
// behaviour (req.idempotencyKey stays undefined). Present but malformed,
// empty, or repeated: 400 and nothing is reserved.
export function idempotencyKeyMiddleware(req, res, next) {
  const raw = req.headers?.["idempotency-key"];
  if (raw === undefined) return next();
  const occurrences = headerOccurrences(req);
  if (occurrences !== null && occurrences > 1) {
    return reject(res, "Send exactly one Idempotency-Key header.");
  }
  if (typeof raw !== "string" || raw.length !== 36 || !KEY_PATTERN.test(raw.toLowerCase())) {
    return reject(res, "Idempotency-Key must be a UUID version 4 as produced by crypto.randomUUID().");
  }
  req.idempotencyKey = raw.toLowerCase();
  return next();
}

// The clock is injectable per request ONLY by server-side code (tests set
// req.nowMs). Nothing a client sends can influence it.
export function requestNowMs(req) {
  return typeof req.nowMs === "function" ? Number(req.nowMs()) : Date.now();
}

// Schema output -> the fields a lead is built from, with explicit defaults:
// absent/blank phone and mine_site are "", absent/blank urgency is "standard".
// Raw JSON key order, unknown properties (stripped by the schema) and absent vs
// default-valued optionals therefore cannot change the result.
export function canonicalLeadFields(body) {
  return {
    company_name: body.company_name,
    contact_name: body.contact_name,
    email: body.email,
    phone: String(body.phone || "").trim(),
    mine_site: String(body.mine_site || "").trim(),
    service_need: body.service_need,
    urgency: String(body.urgency || "standard").trim()
  };
}

// SHA-256 over a fixed-position JSON array: injective for strings, independent of
// property order. No case-folding or trimming beyond canonicalLeadFields, and no
// business-duplicate inference (email/company/description never match across keys).
export function leadRequestHash(fields) {
  const positional = [
    "lead.create.v1",
    fields.company_name, fields.contact_name, fields.email, fields.phone,
    fields.mine_site, fields.service_need, fields.urgency
  ];
  return createHash("sha256").update(JSON.stringify(positional)).digest("hex");
}

// Half-open window: a record is valid for  created <= now < expires_at.
// At exactly created + 24h it is expired. An unparseable expiry counts as expired.
export function isExpired(record, nowMs) {
  return !(Date.parse(record.expires_at) > nowMs);
}

// Removes ONLY expired idempotency records. Never touches leads and never evicts
// an unexpired record, however many exist.
export function pruneExpiredKeys(db, nowMs) {
  if (!Array.isArray(db[IDEMPOTENCY_COLLECTION])) db[IDEMPOTENCY_COLLECTION] = [];
  const before = db[IDEMPOTENCY_COLLECTION].length;
  db[IDEMPOTENCY_COLLECTION] = db[IDEMPOTENCY_COLLECTION].filter((record) => !isExpired(record, nowMs));
  return before - db[IDEMPOTENCY_COLLECTION].length;
}

export function findActiveKey(db, scope, key, nowMs) {
  const records = Array.isArray(db[IDEMPOTENCY_COLLECTION]) ? db[IDEMPOTENCY_COLLECTION] : [];
  return records.find((record) => record.scope === scope && record.key === key && !isExpired(record, nowMs)) || null;
}

export function buildKeyRecord({ scope, key, requestHash, leadId, statusCode, response, nowMs }) {
  return {
    scope,
    key,
    request_hash: requestHash,
    lead_id: leadId,
    status_code: statusCode,
    response: structuredClone(response),
    created_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + IDEMPOTENCY_TTL_MS).toISOString()
  };
}
