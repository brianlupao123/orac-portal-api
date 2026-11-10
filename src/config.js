import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateTotpRuntime } from "./totpPolicy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const envPath = join(projectRoot, ".env");

function loadDotEnvFile() {
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnvFile();

const DEV_JWT_SECRET = "orac-local-development-secret-change-before-production";

export const config = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 5050),
  jwtSecret: process.env.JWT_SECRET || DEV_JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "8h",
  storeDriver: process.env.STORE_DRIVER || "json",
  jsonDbPath: process.env.JSON_DB_PATH || "./data/db.json",
  isProduction: (process.env.NODE_ENV || "development") === "production",
  // Production always requires a password. Set ORAC_REQUIRE_PASSWORD=true on any
  // other deployment that holds real or shared data (UAT, staging) so it does
  // not inherit the local-development shortcut of signing in without one.
  requirePassword:
    (process.env.NODE_ENV || "development") === "production" || process.env.ORAC_REQUIRE_PASSWORD === "true"
};

export function validateRuntimeConfig() {
  validateTotpRuntime();
  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    throw new Error("Invalid PORT. Expected a number between 1 and 65535.");
  }

  if (process.env.TRUST_PROXY_HOPS !== undefined) {
    const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS);
    if (!Number.isSafeInteger(trustProxyHops) || trustProxyHops < 0) {
      throw new Error("Invalid TRUST_PROXY_HOPS. Expected a non-negative integer matching the deployed proxy chain.");
    }
  }

  const isProd = config.isProduction || process.env.NODE_ENV === "production";
  if (isProd) {
    if (process.env.TIMESHEET_SALES_ACCESS === "enabled") {
      throw new Error("Production safety violation: TIMESHEET_SALES_ACCESS cannot be enabled in production environments (maker-checker separation violation).");
    }
    if (config.storeDriver !== "postgres") {
      throw new Error("Production requires STORE_DRIVER=postgres.");
    }
    if (!process.env.JWT_SECRET || config.jwtSecret === DEV_JWT_SECRET || config.jwtSecret.length < 32) {
      throw new Error("Production JWT_SECRET must be set to a strong value of at least 32 characters.");
    }
    if (process.env.RATE_LIMIT_DISABLED === "true") {
      throw new Error("RATE_LIMIT_DISABLED=true is not permitted in production.");
    }
  }

  if (config.storeDriver !== "json" && config.storeDriver !== "postgres") {
    throw new Error("STORE_DRIVER must be 'json' or 'postgres'.");
  }

  if (config.storeDriver === "postgres" && !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required when STORE_DRIVER=postgres");
  }
}

export { DEV_JWT_SECRET };
