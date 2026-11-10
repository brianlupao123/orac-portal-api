import { roles } from "./permissions.js";
import { validateTotpEncryptionKey } from "./totp.js";

const VALID_ROLES = new Set(Object.values(roles));

export function protectedTotpRoles(env = process.env) {
  const value = env.ORAC_TOTP_PROTECTED_ROLES;
  if (!value) return new Set();
  const list = value.split(",").map((item) => item.trim());
  if (list.some((item) => !VALID_ROLES.has(item)) || new Set(list).size !== list.length) {
    throw new Error("ORAC_TOTP_PROTECTED_ROLES contains an invalid or duplicate role.");
  }
  return new Set(list);
}

export function totpRequiredFor(user, env = process.env) {
  return protectedTotpRoles(env).has(user?.role);
}

export function totpEnrollmentEnabled(env = process.env) {
  return env.ORAC_TOTP_ENROLLMENT_ENABLED === "true";
}

export function validateTotpRuntime(env = process.env) {
  if (protectedTotpRoles(env).size > 0 || totpEnrollmentEnabled(env)) {
    validateTotpEncryptionKey(env);
    if (env.NODE_ENV !== "production" && env.ORAC_REQUIRE_PASSWORD !== "true") {
      throw new Error("ORAC_REQUIRE_PASSWORD=true is required when TOTP is enabled.");
    }
  }
}
