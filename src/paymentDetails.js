import crypto from "node:crypto";

// Contractor payment details (EcoCash / bank). Stored encrypted at rest in a dedicated
// `payment_details` envelope on the user record. The envelope is never part of the public
// user shape (accountTokens.toPublicUser) and never appears in an audit payload.
//
// Fail closed: with no valid ORAC_PAYMENT_ENCRYPTION_KEY nothing can be stored or read, so real
// bank or EcoCash numbers can never land in the store as plain text.

export const PAYMENT_FIELDS = Object.freeze(["payment_method", "ecocash_number", "bank_name", "bank_account", "bank_branch"]);
export const PAYMENT_METHODS = Object.freeze(["ecocash", "bank"]);

function key(env = process.env) {
  const input = env.ORAC_PAYMENT_ENCRYPTION_KEY;
  if (!input || !/^[A-Za-z0-9+/]{43}=$/.test(input)) return null;
  const buf = Buffer.from(input, "base64");
  return buf.length === 32 ? buf : null;
}

export const paymentEncryptionConfigured = (env = process.env) => key(env) !== null;

export function encryptPaymentDetails(details, env = process.env) {
  const k = key(env);
  if (!k) throw Object.assign(new Error("Payment details storage is not enabled: ORAC_PAYMENT_ENCRYPTION_KEY is not set."), { status: 503 });
  const clean = Object.fromEntries(PAYMENT_FIELDS.filter((f) => details[f] !== undefined && details[f] !== null && details[f] !== "").map((f) => [f, String(details[f])]));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(clean), "utf8"), cipher.final()]);
  return { v: 1, data: [iv, cipher.getAuthTag(), ct].map((p) => p.toString("base64url")).join("."), fields: Object.keys(clean) };
}

export function decryptPaymentDetails(envelope, env = process.env) {
  if (!envelope?.data) return {};
  const k = key(env);
  if (!k) throw Object.assign(new Error("Payment details storage is not enabled: ORAC_PAYMENT_ENCRYPTION_KEY is not set."), { status: 503 });
  const [iv, tag, ct] = String(envelope.data).split(".").map((p) => Buffer.from(p, "base64url"));
  if (!iv || !tag || !ct || iv.length !== 12 || tag.length !== 16) throw Object.assign(new Error("Stored payment details are unreadable."), { status: 500 });
  const d = crypto.createDecipheriv("aes-256-gcm", k, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
}

/** Names of the payment fields present in a request body (values never leave this module's callers). */
export const paymentFieldsIn = (body) => PAYMENT_FIELDS.filter((f) => body && body[f] !== undefined);
