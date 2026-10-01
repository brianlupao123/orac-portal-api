import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";

const tmp = () => mkdtempSync(join(tmpdir(), "orac-store-"));

test("a corrupt data file is NOT overwritten with seed data: 503, file byte-identical, mutex released", async () => {
  const dir = tmp(); const file = join(dir, "db.json");
  const store = createStore(file);
  writeFileSync(file, "{ this is not json");
  await assert.rejects(store.read(), (e) => e.status === 503 && /not been modified/.test(e.message));
  assert.equal(readFileSync(file, "utf8"), "{ this is not json");
  // The mutex must be free: a repaired file can be read immediately (would hang forever otherwise).
  writeFileSync(file, JSON.stringify({ users: [] }));
  const { db, release } = await Promise.race([store.read(), new Promise((_, rej) => setTimeout(() => rej(new Error("mutex still held")), 2000))]);
  assert.ok(Array.isArray(db.users));
  release();
  rmSync(dir, { recursive: true, force: true });
});

test("an empty (zero byte) file is treated as corrupt, not as 'nothing to lose'", async () => {
  const dir = tmp(); const file = join(dir, "db.json");
  const store = createStore(file);
  writeFileSync(file, "");
  await assert.rejects(store.read(), (e) => e.status === 503);
  assert.equal(readFileSync(file, "utf8"), "");
  rmSync(dir, { recursive: true, force: true });
});

test("a file removed after startup (ENOENT) is re-seeded", async () => {
  const dir = tmp(); const file = join(dir, "db.json");
  const store = createStore(file);
  rmSync(file);
  const { db, release } = await store.read();
  assert.ok(db.users.length > 0);
  assert.ok(existsSync(file));
  release();
  rmSync(dir, { recursive: true, force: true });
});

test("writes are atomic: content replaced, no temp files left behind, mutex released", async () => {
  const dir = tmp(); const file = join(dir, "db.json");
  const store = createStore(file);
  const { db, release } = await store.read();
  db.marker = "written";
  store.write(db, release);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).marker, "written");
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
  const again = await Promise.race([store.read(), new Promise((_, rej) => setTimeout(() => rej(new Error("mutex still held")), 2000))]);
  assert.equal(again.db.marker, "written");
  again.release();
  rmSync(dir, { recursive: true, force: true });
});

test("concurrent readers are serialised by the mutex", async () => {
  const dir = tmp(); const file = join(dir, "db.json");
  const store = createStore(file);
  const order = [];
  const job = async (name) => { const { db, release } = await store.read(); order.push(`${name}:start`); await new Promise((r) => setTimeout(r, 20)); order.push(`${name}:end`); store.write(db, release); };
  await Promise.all([job("a"), job("b")]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
  rmSync(dir, { recursive: true, force: true });
});
