export function persistenceMiddleware(store) {
  return async (req, res, next) => {
    try {
      const { db, release } = await store.read();
      req.db = db;
      req.store = store;
      req.releaseDb = release;
      const originalJson = res.json.bind(res);
      let writeStarted = false;
      let released = false;
      const releaseRead = () => {
        if (!released) {
          released = true;
          store.release(release);
        }
      };

      res.json = (body) => {
        if (req.method === "GET" || res.statusCode < 200 || res.statusCode >= 300) {
          releaseRead();
          return originalJson(body);
        }
        if (writeStarted) return res;
        writeStarted = true;
        Promise.resolve(store.write(db, release)).then(() => {
          released = true;
          if (!res.destroyed) originalJson(body);
        }).catch(next);
        return res;
      };
      res.once("close", () => {
        if (!writeStarted) releaseRead();
      });
      next();
    } catch (error) {
      next(error);
    }
  };
}
