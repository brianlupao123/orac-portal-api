export function persistenceMiddleware(store) {
  return async (req, res, next) => {
    let context;
    let released = false;
    let writeStarted = false;
    let sendingResponse = false;

    const isReadOnly = ["GET", "HEAD", "OPTIONS"].includes(req.method)
      || (req.method === "POST" && req.path === "/auth/login");

    const safeRelease = async () => {
      if (writeStarted || released) return;
      released = true;
      if (context) await store.release(context);
    };

    try {
      const { db, release } = await store.read({ lock: !isReadOnly });
      context = release;
      req.db = db;
      req.store = store;
      req.releaseDb = release;
      const originalJson = res.json.bind(res);
      const originalSend = res.send.bind(res);
      const originalEnd = res.end.bind(res);

      const respond = (send, args) => {
        if (sendingResponse) return send(...args);
        if (isReadOnly || res.statusCode < 200 || res.statusCode >= 300) {
          Promise.resolve(safeRelease()).then(() => {
            if (!res.destroyed) {
              sendingResponse = true;
              send(...args);
              sendingResponse = false;
            }
          }).catch(next);
          return res;
        }
        if (writeStarted) return res;
        writeStarted = true;
        Promise.resolve(store.write(db, context)).then(() => {
          released = true;
          if (!res.destroyed) {
            sendingResponse = true;
            send(...args);
            sendingResponse = false;
          }
        }).catch((error) => Promise.resolve(safeRelease()).then(() => next(error), next));
        return res;
      };

      res.json = (...args) => respond(originalJson, args);
      res.send = (...args) => respond(originalSend, args);
      res.end = (...args) => respond(originalEnd, args);
      res.once("finish", () => { void safeRelease(); });
      res.once("close", () => { void safeRelease(); });
      next();
    } catch (error) {
      Promise.resolve(safeRelease()).then(() => next(error), next);
    }
  };
}
