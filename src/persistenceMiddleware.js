// A few GET requests must leave a persisted audit row (who opened a Daily Time Sheet or the review
// queue). Ordinary GETs never write, so these exact paths opt in to the write path.
const AUDITED_READS = [/^\/document-data\/daily_timesheets\/[^/]+$/, /^\/daily-timesheet-review-queue$/];
const isAuditedRead = (req) => req.method === "GET" && AUDITED_READS.some((re) => re.test(req.path));

export function persistenceMiddleware(store) {
  return async (req, res, next) => {
    let context;
    let released = false;
    let writeStarted = false;
    let sendingResponse = false;

    // Read-only by exact match: login, and the Worksheet roll-up preview (it computes and returns,
    // so it must never take the write lock or rewrite the store). Look-alike paths still persist.
    const isReadOnly = (["GET", "HEAD", "OPTIONS"].includes(req.method) && !isAuditedRead(req))
      || (req.method === "POST" && ((req.path === "/auth/login" && !process.env.ORAC_TOTP_PROTECTED_ROLES)
        || req.path === "/worksheet_registers/preview"));

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
        if (isReadOnly || ((res.statusCode < 200 || res.statusCode >= 300) && !req.persistOnFailure)) {
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
