import { pool } from "./pool.js";
import { createStore as createJsonStore } from "./store.js";

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
    id: helpers.id,
    audit: helpers.audit,
    recalculateVariance: helpers.recalculateVariance,
    async read() {
      const release = await acquire();
      try {
        const result = await databasePool.query("SELECT data FROM store WHERE id = 'main'");
        if (result.rowCount !== 1) {
          throw Object.assign(new Error("Database is not initialized. Run npm run seed:neon first."), { status: 503 });
        }
        return { db: result.rows[0].data, release };
      } catch (error) {
        release();
        throw error;
      }
    },
    async write(db, release) {
      try {
        const result = await databasePool.query("UPDATE store SET data = $1 WHERE id = 'main'", [db]);
        if (result.rowCount !== 1) throw new Error("Database state was not saved.");
      } finally {
        release?.();
      }
    },
    release(release) {
      release?.();
    }
  };
}
