import crypto from "node:crypto";

export const DEFAULT_BUSINESS_TIMEZONE = "Africa/Harare";

export function getBusinessTimezone(env = process.env) {
  const tz = env.ORAC_BUSINESS_TIMEZONE || env.BUSINESS_TIMEZONE || DEFAULT_BUSINESS_TIMEZONE;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    if (env.NODE_ENV === "production" && env.ORAC_STRICT_TIMEZONE === "true") {
      throw new Error(`Invalid ORAC_BUSINESS_TIMEZONE: "${tz}"`);
    }
    return DEFAULT_BUSINESS_TIMEZONE;
  }
}

/**
 * Format a Date or timestamp string as YYYY-MM-DD in the business timezone.
 * Calendar dates (already matching YYYY-MM-DD) are preserved directly without timezone shift.
 */
export function formatBusinessDate(dateInput, timezone = getBusinessTimezone()) {
  if (!dateInput) return "";
  if (typeof dateInput === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    return dateInput;
  }
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("sv-SE", { timeZone: timezone }).format(d);
}

/**
 * Hash exact CSV string or Buffer using SHA-256
 */
export function hashCsv(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}
