import assert from "node:assert";
import test from "node:test";
import { createStore } from "../src/postgresStore.js";

function createPool(data = { users: [], audit_logs: [] }) {
  const queries = [];
  let released = 0;
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.startsWith("SELECT data")) return { rowCount: 1, rows: [{ data }] };
      if (sql.startsWith("UPDATE store")) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release() { released += 1; }
  };
  return { connect: async () => client, queries, get released() { return released; } };
}

test("write reads use a database transaction and row lock", async () => {
  const pool = createPool();
  const store = createStore(":memory:", pool);
  const { db, release } = await store.read();

  assert.deepEqual(pool.queries.slice(0, 4), [
    "BEGIN",
    "SET LOCAL lock_timeout = '5s'",
    "SET LOCAL statement_timeout = '10s'",
    "SELECT data FROM store WHERE id = 'main' FOR UPDATE"
  ]);

  await store.write(db, release);
  assert.ok(pool.queries.includes("COMMIT"));
  assert.equal(pool.released, 1);
});

test("read-only loads skip the transaction and row lock", async () => {
  const pool = createPool();
  const store = createStore(":memory:", pool);
  const { release } = await store.read({ lock: false });

  assert.equal(release, null);
  assert.deepEqual(pool.queries, ["SELECT data FROM store WHERE id = 'main'"]);
  assert.equal(pool.released, 1);
});
