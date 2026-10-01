// Minimal request/response doubles shared by the Task 05 tests (no Express needed).
export function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    sendStatus(c) { this.statusCode = c; return this; }
  };
}
export function makeReq({ method = "POST", path = "/", body = {}, ip = "1.1.1.1", headers = {}, db, store, user, params = {} } = {}) {
  return { method, path, body, ip, headers, db, store, user, params };
}
// Runs a middleware; returns { res, passed } where passed is true when next() was called.
export function run(mw, req, res = makeRes()) {
  let passed = false;
  mw(req, res, () => { passed = true; });
  return { res, passed };
}
