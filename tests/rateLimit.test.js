import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicEndpointLimits, PUBLIC_WRITE_ROUTES, WindowCounter, readLimitConfig, normalizedEmail } from "../src/middleware/rateLimit.js";
import { makeReq, makeRes, run } from "./_http.js";

function limiter(env = {}, clock = { t: 1_000_000 }) {
  const mw = createPublicEndpointLimits({ env, now: () => clock.t });
  return { mw, clock };
}
const post = (path, body = {}, ip = "9.9.9.9") => makeReq({ method: "POST", path, body, ip });

test("public writes: per-IP window returns 429 with Retry-After, then recovers after the window", () => {
  const { mw, clock } = limiter({ RATE_LIMIT_PUBLIC_WRITE_MAX: "3", RATE_LIMIT_WINDOW_MS: "60000" });
  for (let i = 0; i < 3; i++) assert.equal(run(mw, post("/leads")).passed, true);
  const blocked = run(mw, post("/leads"));
  assert.equal(blocked.passed, false);
  assert.equal(blocked.res.statusCode, 429);
  assert.equal(Number(blocked.res.headers["retry-after"]) >= 1, true);
  assert.equal(blocked.res.body.success, false);
  assert.equal(run(mw, post("/leads", {}, "8.8.8.8")).passed, true, "another IP is unaffected");
  clock.t += 60_001;
  assert.equal(run(mw, post("/leads")).passed, true, "window reset");
});

test("per-email limit applies to reset/access routes and is case/space-insensitive", () => {
  const { mw } = limiter({ RATE_LIMIT_PUBLIC_EMAIL_MAX: "2", RATE_LIMIT_PUBLIC_WRITE_MAX: "1000" });
  const r = (email, ip) => run(mw, post("/auth/request-password-reset", { email }, ip));
  assert.equal(r("A@x.co", "1.1.1.1").passed, true);
  assert.equal(r(" a@X.CO ", "2.2.2.2").passed, true);
  assert.equal(r("a@x.co", "3.3.3.3").res.statusCode, 429);
  assert.equal(r("other@x.co", "3.3.3.3").passed, true);
});

test("login: only 401 outcomes count against the email; success clears; other statuses ignored", () => {
  const { mw } = limiter({ RATE_LIMIT_LOGIN_FAILURES_MAX: "3", RATE_LIMIT_LOGIN_ATTEMPTS_MAX: "1000" });
  const attempt = (status) => {
    const req = post("/auth/login", { email: "Victim@x.co", password: "p" });
    const { res, passed } = run(mw, req);
    if (passed) res.status(status).json({});
    return res;
  };
  attempt(400); attempt(400); attempt(400); attempt(400);
  assert.notEqual(attempt(401).statusCode, 429);
  attempt(401);
  attempt(200); // success clears the counter
  attempt(401); attempt(401);
  assert.notEqual(attempt(401).statusCode, 429, "counter was cleared by the success, third failure still allowed to run");
  const locked = run(mw, post("/auth/login", { email: "victim@x.co", password: "p" }));
  assert.equal(locked.res.statusCode, 429);
  assert.ok(locked.res.headers["retry-after"]);
});

test("login: per-IP attempt ceiling is enforced regardless of email", () => {
  const { mw } = limiter({ RATE_LIMIT_LOGIN_ATTEMPTS_MAX: "2" });
  assert.equal(run(mw, post("/auth/login", { email: "a@x.co" })).passed, true);
  assert.equal(run(mw, post("/auth/login", { email: "b@x.co" })).passed, true);
  assert.equal(run(mw, post("/auth/login", { email: "c@x.co" })).res.statusCode, 429);
});

test("routes outside the public-write table and GETs are never limited", () => {
  const { mw } = limiter({ RATE_LIMIT_PUBLIC_WRITE_MAX: "1", RATE_LIMIT_LOGIN_ATTEMPTS_MAX: "1" });
  for (let i = 0; i < 5; i++) {
    assert.equal(run(mw, makeReq({ method: "GET", path: "/leads" })).passed, true);
    assert.equal(run(mw, post("/quotes")).passed, true);
  }
});

test("RATE_LIMIT_DISABLED=true turns the limiter off (explicit opt-out only)", () => {
  const { mw } = limiter({ RATE_LIMIT_DISABLED: "true", RATE_LIMIT_PUBLIC_WRITE_MAX: "1" });
  for (let i = 0; i < 5; i++) assert.equal(run(mw, post("/leads")).passed, true);
  assert.equal(readLimitConfig({}).disabled, false);
  assert.equal(readLimitConfig({ RATE_LIMIT_DISABLED: "1" }).disabled, false, "only the literal string 'true' disables");
});

test("config: invalid or non-positive env values fall back to defaults", () => {
  const cfg = readLimitConfig({ RATE_LIMIT_PUBLIC_WRITE_MAX: "-4", RATE_LIMIT_WINDOW_MS: "abc", RATE_LIMIT_LOGIN_FAILURES_MAX: "0" });
  assert.equal(cfg.publicWritesPerIp, 30);
  assert.equal(cfg.windowMs, 15 * 60 * 1000);
  assert.equal(cfg.loginFailuresPerEmail, 10);
});

test("WindowCounter stays bounded and fails closed when full", () => {
  let t = 0;
  const c = new WindowCounter({ windowMs: 1000, now: () => t });
  for (let i = 0; i < 10050; i++) c.hit(`k${i}`);
  assert.ok(c.entries.size <= 10001, `entries ${c.entries.size}`);
  assert.ok(c.entries.get("__overflow__").count >= 50);
  t = 2000; c.hit("fresh");
  assert.equal(c.peek("k1").count, 0, "expired entries read as zero");
});

test("normalizedEmail tolerates missing/odd bodies", () => {
  assert.equal(normalizedEmail({ body: undefined }), "");
  assert.equal(normalizedEmail({ body: { email: 42 } }), "");
  assert.equal(normalizedEmail({ body: { email: "  A@B.co " } }), "a@b.co");
});

test("the limiter's route table equals the public write routes declared in router.js", () => {
  const src = readFileSync(new URL("../src/router.js", import.meta.url), "utf8").replace(/\r/g, "");
  const publicSection = src.slice(0, src.indexOf("router.use(authMiddleware)"));
  const found = [...publicSection.matchAll(/^router\.(post|put|patch|delete)\("([^"]+)"/gm)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  const expected = PUBLIC_WRITE_ROUTES.concat("POST /auth/login").sort();
  assert.deepEqual(found.sort(), expected, "a new unauthenticated write route must be added to PUBLIC_WRITE_ROUTES");
});

test("server.js mounts the limiter before persistenceMiddleware", () => {
  const src = readFileSync(new URL("../server.js", import.meta.url), "utf8").replace(/\r/g, "");
  const limit = src.indexOf("createPublicEndpointLimits()");
  const persist = src.indexOf("persistenceMiddleware(store)");
  const json = src.indexOf("express.json(");
  assert.ok(json > -1 && limit > json, "limiter must run after body parsing (it reads the email)");
  assert.ok(persist > limit, "limiter must run before the store lock is taken");
});
