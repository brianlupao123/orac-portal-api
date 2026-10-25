import assert from "node:assert/strict";
import test from "node:test";
import { restoreStoreBackup } from "../scripts/lib/restoreStoreBackup.js";

function fakeClient({ current = { records: ["current"] }, backup = { records: ["restored"] }, failUpdate = false } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith("SELECT data FROM store WHERE")) return current ? { rowCount: 1, rows: [{ data: current }] } : { rowCount: 0, rows: [] };
      if (sql.startsWith("SELECT data FROM store_backups")) return backup ? { rowCount: 1, rows: [{ data: backup }] } : { rowCount: 0, rows: [] };
      if (sql.startsWith("INSERT INTO store_backups")) return { rowCount: 1, rows: [{ id: 73 }] };
      if (sql.startsWith("UPDATE store SET") && failUpdate) throw new Error("synthetic update failure");
      return { rowCount: 1, rows: [] };
    }
  };
  return { client, calls };
}

test("restore snapshots current store and replaces it in one committed transaction", async () => {
  const { client, calls } = fakeClient();
  const safetyId = await restoreStoreBackup(client, 12);
  assert.equal(safetyId, 73);
  assert.equal(calls[0].sql, "BEGIN");
  assert.match(calls.find((call) => call.sql.startsWith("SELECT data FROM store WHERE")).sql, /FOR UPDATE/);
  assert.deepEqual(calls.find((call) => call.sql.startsWith("INSERT INTO store_backups")).params, ["before-restore-of-12", { records: ["current"] }]);
  assert.deepEqual(calls.find((call) => call.sql.startsWith("UPDATE store SET")).params, [{ records: ["restored"] }]);
  assert.equal(calls.at(-1).sql, "COMMIT");
  assert.equal(calls.some((call) => call.sql === "ROLLBACK"), false);
});

test("restore refuses an absent current store and rolls back", async () => {
  const { client, calls } = fakeClient({ current: null });
  await assert.rejects(restoreStoreBackup(client, 12), /main store does not exist/);
  assert.equal(calls.at(-1).sql, "ROLLBACK");
  assert.equal(calls.some((call) => call.sql.startsWith("UPDATE store SET")), false);
});

test("restore refuses a missing backup and rolls back before snapshot or update", async () => {
  const { client, calls } = fakeClient({ backup: null });
  await assert.rejects(restoreStoreBackup(client, 12), /Backup was not found/);
  assert.equal(calls.at(-1).sql, "ROLLBACK");
  assert.equal(calls.some((call) => call.sql.startsWith("INSERT INTO store_backups")), false);
  assert.equal(calls.some((call) => call.sql.startsWith("UPDATE store SET")), false);
});

test("restore rolls back if replacing the store fails", async () => {
  const { client, calls } = fakeClient({ failUpdate: true });
  await assert.rejects(restoreStoreBackup(client, 12), /synthetic update failure/);
  assert.equal(calls.at(-1).sql, "ROLLBACK");
  assert.equal(calls.some((call) => call.sql === "COMMIT"), false);
});
