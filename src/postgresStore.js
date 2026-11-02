import { pool } from "./pool.js";
import { createStore as createJsonStore, normalizeDb } from "./store.js";

// The pilot uses one JSONB aggregate. It is deliberately initialized only by
// scripts/seed-neon.js, never by a failed request or server startup.
export function createStore(_filePath, databasePool = pool) {
  const helpers = createJsonStore(":memory:");
  let lock = Promise.resolve();

  async function acquire() {
    let unlock;
    const previous = lock;
    lock = new Promise((resolve) => { unlock = resolve; });
    await previous;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        unlock();
      }
    };
  }

  return {
    driver: "postgres",
    id: helpers.id,
    audit: helpers.audit,
    recalculateVariance: helpers.recalculateVariance,
    async read(options = { lock: true }) {
      if (!options.lock) {
        const client = await databasePool.connect();
        try {
          const result = await client.query("SELECT data FROM store WHERE id = 'main'");
          if (result.rowCount !== 1) {
            throw Object.assign(new Error("Database is not initialized. Run npm run seed:neon first."), { status: 503 });
          }
          return { db: normalizeDb(result.rows[0].data, { seedDemoRecords: false }), release: null };
        } finally {
          client.release();
        }
      }

      const releaseLock = await acquire();
      const client = await databasePool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '10s'");
        const result = await client.query("SELECT data FROM store WHERE id = 'main' FOR UPDATE");
        if (result.rowCount !== 1) {
          throw Object.assign(new Error("Database is not initialized. Run npm run seed:neon first."), { status: 503 });
        }
        const db = normalizeDb(result.rows[0].data, { seedDemoRecords: false });
        return { db, release: { client, releaseLock } };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
        releaseLock();
        throw error;
      }
    },
    async write(db, context) {
      if (!context?.client || context.released) return;
      const { client } = context;
      try {
        const result = await client.query("UPDATE store SET data = $1 WHERE id = 'main'", [db]);
        if (result.rowCount !== 1) throw new Error("Database state was not saved.");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        context.released = true;
        client.release();
        context.releaseLock();
      }
    },
    async release(context) {
      if (context?.client && !context.released) {
        context.released = true;
        try {
          await context.client.query("ROLLBACK");
        } finally {
          context.client.release();
          context.releaseLock();
        }
      }
    }
  };
}
