import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../src/postgresStore.js";

function fakePool(initial) {
  let persisted = structuredClone(initial);
  const state = { released: false, updates: 0, commits: 0 };
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          if (sql === "BEGIN" || sql.startsWith("SET LOCAL")) return { rowCount: 0, rows: [] };
          if (sql.startsWith("SELECT data FROM store")) {
            return { rowCount: 1, rows: [{ data: structuredClone(persisted) }] };
          }
          if (sql.startsWith("UPDATE store SET")) {
            persisted = structuredClone(params[0]);
            state.updates += 1;
            return { rowCount: 1, rows: [] };
          }
          if (sql === "COMMIT") {
            state.commits += 1;
            return { rowCount: 0, rows: [] };
          }
          if (sql === "ROLLBACK") return { rowCount: 0, rows: [] };
          throw new Error(`Unexpected SQL: ${sql}`);
        },
        release() { state.released = true; }
      };
    }
  };
  return { pool, state, persisted: () => structuredClone(persisted) };
}

const emptyDatabase = () => ({ users: [], suppliers: [], stock_items: [] });

test("PostgreSQL unlocked read normalizes only its in-memory result and does not persist", async () => {
  const fake = fakePool(emptyDatabase());
  const store = createStore(":memory:", fake.pool);
  const { db, release } = await store.read({ lock: false });
  assert.deepEqual(db.users, []);
  assert.deepEqual(db.suppliers, []);
  assert.deepEqual(db.stock_items, []);
  assert.equal(release, null);
  assert.equal(fake.state.updates, 0);
  assert.equal(fake.state.released, true);
  assert.deepEqual(fake.persisted(), emptyDatabase());
});

test("PostgreSQL locked read followed by a write still does not recreate demo records", async () => {
  const fake = fakePool(emptyDatabase());
  const store = createStore(":memory:", fake.pool);
  const { db, release } = await store.read();
  assert.deepEqual(db.users, []);
  assert.deepEqual(db.suppliers, []);
  assert.deepEqual(db.stock_items, []);
  await store.write(db, release);
  assert.equal(fake.state.updates, 1);
  assert.equal(fake.state.commits, 1);
  assert.deepEqual(fake.persisted().users, []);
  assert.deepEqual(fake.persisted().suppliers, []);
  assert.deepEqual(fake.persisted().stock_items, []);
});
