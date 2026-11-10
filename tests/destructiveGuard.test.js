import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { evaluateGuard, parseDbHost, requireDestructiveApply } from "../scripts/lib/destructiveGuard.js";

const PHRASE = "OVERWRITE-TEST";
const okEnv = { DATABASE_URL: "postgres://u:p@db.example.com:5432/x", ORAC_CONFIRM_DESTRUCTIVE: PHRASE, ORAC_TARGET_DB_HOST: "DB.example.com", NODE_ENV: "development" };

test("without --apply: dry-run, whatever the environment says", () => {
  assert.equal(evaluateGuard({ phrase: PHRASE, argv: ["node", "s.js"], env: okEnv }).mode, "dry-run");
  assert.equal(evaluateGuard({ phrase: PHRASE, argv: [], env: {} }).mode, "dry-run");
});
test("--apply with all confirmations on a non-production host proceeds (host match is case-insensitive)", () => {
  assert.equal(evaluateGuard({ phrase: PHRASE, argv: ["--apply"], env: okEnv }).mode, "apply");
});
test("each missing or wrong confirmation refuses", () => {
  const cases = {
    noUrl: { ...okEnv, DATABASE_URL: "" },
    production: { ...okEnv, NODE_ENV: "production" },
    wrongPhrase: { ...okEnv, ORAC_CONFIRM_DESTRUCTIVE: "yes" },
    noPhrase: { ...okEnv, ORAC_CONFIRM_DESTRUCTIVE: undefined },
    hostMismatch: { ...okEnv, ORAC_TARGET_DB_HOST: "other.example.com" },
    noHost: { ...okEnv, ORAC_TARGET_DB_HOST: undefined },
    badUrl: { ...okEnv, DATABASE_URL: "not a url" }
  };
  for (const [name, env] of Object.entries(cases)) {
    const r = evaluateGuard({ phrase: PHRASE, argv: ["--apply"], env });
    assert.equal(r.mode, "refused", name);
    assert.ok(r.problems.length >= 1, name);
  }
});
test("production refusal cannot be overridden by correct confirmations", () => {
  const r = evaluateGuard({ phrase: PHRASE, argv: ["--apply"], env: { ...okEnv, NODE_ENV: "production" } });
  assert.equal(r.mode, "refused");
  assert.ok(r.problems.some((p) => /production/i.test(p)));
});
test("requireDestructiveApply exits 0 on dry-run, 1 on refusal, returns on apply; never logs the URL or password", () => {
  const logs = []; const exits = [];
  const exit = (c) => exits.push(c);
  const base = { scriptName: "t", phrase: PHRASE, effect: "does X", log: (m) => logs.push(m), exit };
  requireDestructiveApply({ ...base, argv: [], env: okEnv });
  requireDestructiveApply({ ...base, argv: ["--apply"], env: { ...okEnv, ORAC_TARGET_DB_HOST: "nope" } });
  const r = requireDestructiveApply({ ...base, argv: ["--apply"], env: okEnv });
  assert.deepEqual(exits, [0, 1]);
  assert.equal(r.mode, "apply");
  const all = logs.join("\n");
  assert.equal(all.includes("postgres://"), false);
  assert.equal(all.includes(":p@"), false);
});
test("parseDbHost", () => {
  assert.equal(parseDbHost("postgres://u:p@Host.Example.com/db"), "host.example.com");
  assert.equal(parseDbHost("garbage"), null);
});
test("every script that overwrites the store row is wired to the guard and does not connect first", () => {
  const dir = new URL("../scripts/", import.meta.url);
  const risky = readdirSync(dir).filter((f) => f.endsWith(".js")).filter((f) => {
    const s = readFileSync(new URL(f, dir), "utf8");
    return /ON CONFLICT[\s\S]{0,80}DO UPDATE SET data|UPDATE store SET data/i.test(s);
  });
  assert.ok(risky.length >= 3, `expected the legacy seed/restore scripts, found ${risky.join(", ")}`);
  for (const f of risky) {
    const s = readFileSync(new URL(f, dir), "utf8").replace(/\r/g, "");
    // seed-neon.js has its own guard (reviewed separately). reset-admin-password.js and
    // bootstrap-totp-ticket.js are scoped, transactional, audited recovery/bootstrap tools
    // (Admin account only), not whole-row overwrites.
    if (f === "seed-neon.js" || f === "reset-admin-password.js" || f === "bootstrap-totp-ticket.js") continue;
    if (f === "seed-curated-demo.js") {
      // Own, weaker guard: dry-run default, explicit confirmation, snapshot first. It has NO target-host or
      // production check (residual risk recorded in the findings report; owner decision).
      assert.match(s, /includes\("--apply"\)/);
      assert.match(s, /ORAC_DEMO_SEED_CONFIRM/);
      assert.ok(s.indexOf("INSERT INTO store_backups") < s.indexOf("UPDATE store SET data"), "snapshot must precede the overwrite");
      continue;
    }
    assert.match(s, /requireDestructiveApply|evaluateGuard/, `${f} must use the destructive guard`);
    const guardAt = Math.max(s.indexOf("requireDestructiveApply("), s.indexOf("evaluateGuard({"));
    const connectAt = s.search(/new (pg\.)?Pool\(|\.connect\(/);
    if (connectAt > -1) assert.ok(guardAt > -1 && guardAt < connectAt, `${f}: guard must run before any connection is created`);
  }
});
