import jwt from "jsonwebtoken";
import { config } from "../config.js";

// In-memory, per-process rate limiting for the unauthenticated API surface.
//
// WHY THIS RUNS BEFORE persistenceMiddleware (see server.js): that middleware
// takes the store write lock (and, on PostgreSQL, opens a transaction with
// SELECT ... FOR UPDATE) for every non-GET request. A limiter placed inside the
// router would only run after the lock is held, so a flood would still queue
// on the lock. This limiter therefore answers 429 before any store access.
//
// LIMITS OF THIS DESIGN (owner decisions - see OWNER_DECISION_LOG in the packet):
//  * State is per process. With N running instances the effective limit is N x.
//  * req.ip is the proxy address unless TRUST_PROXY_HOPS is configured, in which
//    case the per-IP keys below degrade to one shared bucket. That is safe (it
//    only ever limits more) but coarse until the proxy topology is confirmed.
//  * The default numbers are PROVISIONAL and overridable by environment
//    variables. They are not an approved lockout policy.
//  * Login throttling counts FAILED attempts per email. An attacker can
//    therefore temporarily block a named user from signing in; that trade-off
//    needs an owner decision.

const MAX_KEYS = 10000;

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function readLimitConfig(env = process.env) {
  return {
    disabled: env.RATE_LIMIT_DISABLED === "true",
    windowMs: positiveInt(env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    apiWritesPerIp: positiveInt(env.RATE_LIMIT_API_WRITE_MAX, 300),
    loginFailuresPerEmail: positiveInt(env.RATE_LIMIT_LOGIN_FAILURES_MAX, 10),
    loginAttemptsPerIp: positiveInt(env.RATE_LIMIT_LOGIN_ATTEMPTS_MAX, 300),
    publicWritesPerIp: positiveInt(env.RATE_LIMIT_PUBLIC_WRITE_MAX, 30),
    publicWritesPerEmail: positiveInt(env.RATE_LIMIT_PUBLIC_EMAIL_MAX, 5)
  };
}

// Fixed-window counter with bounded memory.
export class WindowCounter {
  constructor({ windowMs, now = Date.now }) {
    this.windowMs = windowMs;
    this.now = now;
    this.entries = new Map();
  }

  prune() {
    const t = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= t) this.entries.delete(key);
    }
  }

  slot(key) {
    const t = this.now();
    let entry = this.entries.get(key);
    if (entry && entry.resetAt <= t) {
      this.entries.delete(key);
      entry = undefined;
    }
    if (!entry) {
      if (this.entries.size >= MAX_KEYS) {
        this.prune();
        // Still full: share one overflow bucket so memory stays bounded and
        // the limiter fails closed (more limiting), never open.
        if (this.entries.size >= MAX_KEYS) key = "__overflow__";
        entry = this.entries.get(key);
      }
      if (!entry) {
        entry = { count: 0, resetAt: t + this.windowMs };
        this.entries.set(key, entry);
      }
    }
    return entry;
  }

  hit(key) {
    const entry = this.slot(key);
    entry.count += 1;
    return entry;
  }

  peek(key) {
    // Once saturated, unseen keys are charged to the shared overflow bucket.
    // Looking up only their original key would make per-email limits fail open.
    const entry = this.entries.get(key) || (this.entries.size >= MAX_KEYS ? this.entries.get("__overflow__") : undefined);
    if (!entry || entry.resetAt <= this.now()) return { count: 0, resetAt: 0 };
    return entry;
  }

  clear(key) {
    this.entries.delete(key);
  }
}

function tooMany(res, resetAt, now) {
  const seconds = Math.max(1, Math.ceil((resetAt - now()) / 1000));
  res.setHeader("Retry-After", String(seconds));
  return res.status(429).json({ success: false, message: "Too many requests. Please try again later." });
}

export function normalizedEmail(req) {
  const raw = req.body && typeof req.body === "object" ? req.body.email : "";
  return typeof raw === "string" ? raw.trim().toLowerCase().slice(0, 254) : "";
}

// Routes on the unauthenticated surface that WRITE (they take the store lock).
// A regression test compares this table with the public section of router.js.
export const PUBLIC_WRITE_ROUTES = [
  "POST /leads",
  "POST /auth/request-password-reset",
  "POST /auth/reset-password",
  "POST /auth/totp/verify",
  "POST /auth/totp/enrollment/start",
  "POST /auth/totp/enrollment/confirm",
  "POST /access-requests"
];
const PER_EMAIL_ROUTES = new Set([
  "POST /auth/request-password-reset",
  "POST /auth/reset-password",
  "POST /auth/totp/enrollment/start",
  "POST /auth/totp/enrollment/confirm",
  "POST /access-requests"
]);

// Mount with app.use("/api", ...) AFTER express.json() and BEFORE persistenceMiddleware.
export function createPublicEndpointLimits({ env = process.env, now = Date.now } = {}) {
  const cfg = readLimitConfig(env);
  const ipWrites = new WindowCounter({ windowMs: cfg.windowMs, now });
  const emailWrites = new WindowCounter({ windowMs: cfg.windowMs, now });
  const loginAttemptsByIp = new WindowCounter({ windowMs: cfg.windowMs, now });
  const loginFailuresByEmail = new WindowCounter({ windowMs: cfg.windowMs, now });
  const apiWritesByIp = new WindowCounter({ windowMs: cfg.windowMs, now });

  const middleware = (req, res, next) => {
    const route = `${req.method} ${req.path}`;
    const ip = req.ip || "unknown-ip";
    const isWrite = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    const isPublicWrite = route === "POST /auth/login" || PUBLIC_WRITE_ROUTES.includes(route);

    // Reject unknown/protected writes before persistenceMiddleware acquires the
    // global store lock. Verify the signature here; authMiddleware still checks
    // that the account is active and applies role and record-scope permissions.
    if (isWrite && !isPublicWrite) {
      if (!cfg.disabled) {
        const attempt = apiWritesByIp.hit(ip);
        if (attempt.count > cfg.apiWritesPerIp) return tooMany(res, attempt.resetAt, now);
      }
      const match = /^Bearer ([^\s]+)$/.exec(req.headers?.authorization || "");
      if (!match) return res.status(401).json({ success: false, message: "Unauthorized. Token missing or invalid." });
      try {
        jwt.verify(match[1], config.jwtSecret, { algorithms: ["HS256"] });
      } catch {
        return res.status(401).json({ success: false, message: "Unauthorized. Token missing or invalid." });
      }
      return next();
    }

    if (cfg.disabled) return next();

    if (route === "POST /auth/login") {
      const attempts = loginAttemptsByIp.hit(ip);
      if (attempts.count > cfg.loginAttemptsPerIp) return tooMany(res, attempts.resetAt, now);
      const email = normalizedEmail(req);
      if (email && loginFailuresByEmail.peek(email).count >= cfg.loginFailuresPerEmail) {
        return tooMany(res, loginFailuresByEmail.peek(email).resetAt, now);
      }
      // Observe the outcome: failed sign-ins count against the email, a
      // successful one clears it. Only 401 counts (not validation errors).
      const originalJson = res.json.bind(res);
      res.json = (...args) => {
        if (email) {
          if (res.statusCode === 401) loginFailuresByEmail.hit(email);
          else if (res.statusCode >= 200 && res.statusCode < 300) loginFailuresByEmail.clear(email);
        }
        return originalJson(...args);
      };
      return next();
    }

    if (PUBLIC_WRITE_ROUTES.includes(route)) {
      const perIp = ipWrites.hit(ip);
      if (perIp.count > cfg.publicWritesPerIp) return tooMany(res, perIp.resetAt, now);
      if (PER_EMAIL_ROUTES.has(route)) {
        const email = normalizedEmail(req);
        if (email) {
          const perEmail = emailWrites.hit(`${route}|${email}`);
          if (perEmail.count > cfg.publicWritesPerEmail) return tooMany(res, perEmail.resetAt, now);
        }
      }
    }
    return next();
  };
  middleware.config = cfg;
  return middleware;
}
