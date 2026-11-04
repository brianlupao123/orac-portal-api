// Technician Profile Registry (ORAC Roadmap Phase 1).
//
// Field artisans (boilermakers, electricians, fitters, welders ...) usually have
// no company email, smartphone or login. They live in `db.users` as STAFF
// PROFILES: a record with a `worker_type` and no email/password_hash. A profile
// can never sign in (login matches on email), but staff can select it when
// filing a Daily Time Sheet. A normal registered Technician user is also an
// assignable technician; the two are handled by the same helpers.

import { roles } from "./permissions.js";

export const WORKER_TYPES = Object.freeze(["permanent", "contractor"]);

/** Artisan staff profile: a Technician-or-roleless record carrying a valid worker_type. */
export function isArtisanProfile(user) {
  if (!user || !WORKER_TYPES.includes(user.worker_type)) return false;
  return user.role === undefined || user.role === null || user.role === roles.TECHNICIAN;
}

/** Anyone who may appear as a technician on a timesheet: a Technician user or an artisan profile. */
export function isTechnicianRecord(user) {
  return Boolean(user) && (user.role === roles.TECHNICIAN || isArtisanProfile(user));
}

export function technicianDisplayName(user) {
  const first = String(user?.first_name || "").trim();
  const last = String(user?.last_name || "").trim();
  const full = `${first} ${last}`.trim();
  return full || String(user?.name || "").trim();
}

/** Shape returned for dropdown auto-fill. Never includes credentials or contact secrets. */
export function toTechnicianProfile(user) {
  return {
    id: user.id,
    first_name: user.first_name ?? null,
    last_name: user.last_name ?? null,
    name: technicianDisplayName(user),
    trade: user.trade ?? null,
    national_id: user.national_id ?? null,
    worker_type: user.worker_type ?? null,
    has_login: Boolean(user.password_hash)
  };
}
