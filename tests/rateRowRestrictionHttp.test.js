import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import apiRouter from "../src/router.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { createStore } from "../src/store.js";
import { generateToken } from "../src/middleware/auth.js";

const dispatchId = "dispatch-rate-row-http";

async function post(base, user, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${generateToken(user)}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test("rate-row restriction is enforced by both real timesheet write routes only when enabled", async () => {
  const flagName = "TIMESHEET_RATE_ROW_RESTRICT";
  const priorFlag = process.env[flagName];
  const dir = mkdtempSync(join(tmpdir(), "orac-rate-row-http-"));
  const store = createStore(join(dir, "db.json"));
  let server;

  try {
    delete process.env[flagName];
    const { db, release } = await store.read();
    db.dispatch_cards = [{
      id: dispatchId,
      dispatch_number: "DC-RATE-TEST",
      status: "In_Progress",
      assigned_technician_id: "u_tech",
      assigned_supervisor_id: "u_supervisor"
    }];
    db.field_worksheets = [];
    db.timesheets = [];
    db.audit_logs = [];
    await store.write(db, release);

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/api", persistenceMiddleware(store));
    app.use("/api", apiRouter);
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
    server = await new Promise((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const actors = {
      admin: db.users.find((user) => user.id === "u_admin"),
      finance: db.users.find((user) => user.id === "u_finance"),
      operations: db.users.find((user) => user.id === "u_ops")
    };
    const directPath = `/dispatch_cards/${dispatchId}/timesheets`;
    const kioskPath = `/kiosk/dispatch_cards/${dispatchId}/timesheets`;
    const directBody = { hours_logged: 2, hourly_rate: 45, work_date: "2026-10-01" };
    const kioskBody = {
      work_date: "2026-10-02",
      batch_key: "rate-row-test-001",
      entries: [{ technician_id: "u_tech", hours_logged: 2, hourly_rate: 45, notes: "Synthetic test" }]
    };

    // With the opt-in flag absent, existing Operations write access is preserved.
    assert.equal((await post(base, actors.operations, directPath, directBody)).status, 200);
    assert.equal((await post(base, actors.operations, kioskPath, kioskBody)).status, 200);

    process.env[flagName] = "enabled";
    const directDenied = await post(base, actors.operations, directPath, { ...directBody, work_date: "2026-10-03" });
    const kioskDenied = await post(base, actors.operations, kioskPath, {
      ...kioskBody,
      work_date: "2026-10-04",
      batch_key: "rate-row-test-002"
    });
    assert.equal(directDenied.status, 403);
    assert.equal(kioskDenied.status, 403);
    assert.equal(
      (await post(base, actors.finance, directPath, { ...directBody, work_date: "2026-10-04" })).status,
      403,
      "Finance passes the role overlay but is still denied by direct-dispatch assignment scope"
    );

    // Admin remains authorized through both endpoints; Finance can use the
    // kiosk route, which does not require the submitting actor's dispatch assignment.
    assert.equal((await post(base, actors.admin, directPath, { ...directBody, work_date: "2026-10-05" })).status, 200);
    const adminKiosk = await post(base, actors.admin, kioskPath, {
      ...kioskBody,
      work_date: "2026-10-06",
      batch_key: "rate-row-test-003"
    });
    assert.equal(adminKiosk.status, 200);
    const financeKiosk = await post(base, actors.finance, kioskPath, {
      ...kioskBody,
      work_date: "2026-10-07",
      batch_key: "rate-row-test-004"
    });
    assert.equal(financeKiosk.status, 200);

    const persisted = JSON.parse(readFileSync(join(dir, "db.json"), "utf8"));
    assert.equal(persisted.timesheets.length, 5, "refused requests must not persist rate-bearing rows");
    assert.equal(
      persisted.audit_logs.filter((entry) => ["TIMESHEET_ADDED", "KIOSK_TIMESHEET_ADDED"].includes(entry.action)).length,
      5,
      "refused requests must not create timesheet audit events"
    );
  } finally {
    if (priorFlag === undefined) delete process.env[flagName];
    else process.env[flagName] = priorFlag;
    server?.closeAllConnections?.();
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
