import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import apiRouter from "../src/router.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { createStore } from "../src/store.js";
import { generateToken } from "../src/middleware/auth.js";

// Full HTTP-level integration test: a real Express app, the real router, the
// real mutex-locking persistence middleware and a real JSON file store on
// disk (a temp file per test run - never the developer's data/db.json).
// This is the layer the unit and real-store tests above cannot exercise:
// authentication, route order, generic-collection exposure and a genuine
// concurrent-request race on the file-backed mutex.

function buildApp(store) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", persistenceMiddleware(store));
  app.use("/api", apiRouter);
  app.use("/api", (req, res) => res.status(404).json({ success: false, message: "API route not found." }));
  app.use((err, req, res, _next) => {
    res.status(err.status || 500).json({ success: false, message: err.message || "Internal server error." });
  });
  return app;
}

async function withServer(app, run) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}/api`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Fresh temp store file per test, seeded by createStore(), with a SECOND
// Operations user appended so the concurrent-acknowledge test has two
// distinct eligible recipients (the seed data ships only one).
function makeTempStore() {
  const dir = mkdtempSync(join(tmpdir(), "orac-iwr-http-"));
  const file = join(dir, "db.json");
  const store = createStore(file); // creates+seeds the file synchronously
  const db = JSON.parse(readFileSync(file, "utf8"));
  db.users.push({ id: "u_ops2", name: "Operations User Two", email: "ops2@orac.co.zw", role: "Operations", is_active: true, password_hash: db.users[0].password_hash });
  writeFileSync(file, JSON.stringify(db, null, 2));
  return { store, file };
}

const token = (user) => generateToken(user);
const authed = (url, user, init = {}) => fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token(user)}` } });

const SALES = { id: "u_sales", email: "sales@orac.co.zw", role: "Sales", is_active: true };
const OPS = { id: "u_ops", email: "ops@orac.co.zw", role: "Operations", is_active: true };
const OPS2 = { id: "u_ops2", email: "ops2@orac.co.zw", role: "Operations", is_active: true };
const CLIENT = { id: "u_client", email: "client@orac.co.zw", role: "Client Viewer", is_active: true };

test("every internal-work-request route requires a bearer token (401 with none)", async () => {
  const { store } = makeTempStore();
  await withServer(buildApp(store), async (base) => {
    const routes = [
      ["GET", "/internal-work-requests/options"],
      ["GET", "/internal-work-requests/outbox"],
      ["GET", "/internal-work-requests/inbox"],
      ["GET", "/internal-work-requests/iwr_missing"],
      ["POST", "/internal-work-requests"],
      ["POST", "/internal-work-requests/iwr_missing/acknowledge"],
      ["POST", "/internal-work-requests/iwr_missing/transition"]
    ];
    for (const [method, path] of routes) {
      const response = await fetch(`${base}${path}`, { method });
      assert.equal(response.status, 401, `${method} ${path} must require auth`);
    }
  });
});

test("Client Viewer receives 403 on every internal-work-request route (no client-facing access)", async () => {
  const { store } = makeTempStore();
  await withServer(buildApp(store), async (base) => {
    const create = await authed(`${base}/internal-work-requests`, CLIENT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_type: "STOCK_AVAILABILITY", subject: "x", description: "y" })
    });
    assert.equal(create.status, 403);

    const outbox = await authed(`${base}/internal-work-requests/outbox`, CLIENT);
    assert.equal(outbox.status, 403);

    const inbox = await authed(`${base}/internal-work-requests/inbox`, CLIENT);
    assert.equal(inbox.status, 403);

    const options = await authed(`${base}/internal-work-requests/options`, CLIENT);
    assert.equal(options.status, 403);

    const ack = await authed(`${base}/internal-work-requests/iwr_missing/acknowledge`, CLIENT, { method: "POST" });
    assert.equal(ack.status, 403);
  });
});

test("route order: fixed paths (options/outbox/inbox) are never captured by /:id", async () => {
  const { store } = makeTempStore();
  await withServer(buildApp(store), async (base) => {
    const options = await authed(`${base}/internal-work-requests/options`, SALES);
    assert.equal(options.status, 200);
    const body = await options.json();
    assert.ok(Array.isArray(body.data.types));

    const outbox = await authed(`${base}/internal-work-requests/outbox`, SALES);
    assert.equal(outbox.status, 200);
    const outboxBody = await outbox.json();
    assert.deepEqual(outboxBody.data, []);
  });
});

test("the generic collection route never exposes internal_work_requests (404, not the collection endpoint)", async () => {
  const { store } = makeTempStore();
  await withServer(buildApp(store), async (base) => {
    const response = await authed(`${base}/internal_work_requests`, SALES);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.message, "API route not found.");
  });
});

test("end to end over HTTP: create, list in both boxes, acknowledge, complete, and the file on disk reflects it", async () => {
  const { store, file } = makeTempStore();
  await withServer(buildApp(store), async (base) => {
    const created = await authed(`${base}/internal-work-requests`, SALES, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_type: "STOCK_AVAILABILITY",
        subject: "Confirm availability",
        description: "10 m2 of rubber lining for a pending quote.",
        recipient_role: "Operations"
      })
    });
    assert.equal(created.status, 201);
    const record = (await created.json()).data;
    assert.match(record.id, /^iwr_/);

    // Server-owned fields cannot be supplied by the caller at all: the schema
    // is a strict object, so a body naming any of them is rejected outright
    // rather than the extra fields being silently accepted and ignored.
    const spoofed = await authed(`${base}/internal-work-requests`, SALES, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_type: "STOCK_AVAILABILITY", subject: "x", description: "y", recipient_role: "Operations",
        created_by_user_id: "u_ops", status: "Completed", client_id: "c_other", assigned_to_user_id: "u_ops"
      })
    });
    assert.equal(spoofed.status, 400, "a strict schema rejects a body naming server-owned fields instead of silently dropping them");

    // The legitimately-created record above proves the server-owned fields on
    // a normal request: status starts Submitted, creator is the session user.
    assert.equal(record.status, "Submitted");
    assert.equal(record.created_by_user_id, "u_sales");

    const inbox = await authed(`${base}/internal-work-requests/inbox`, OPS);
    assert.equal(inbox.status, 200);
    assert.ok((await inbox.json()).data.some((item) => item.id === record.id));

    const salesOutbox = await authed(`${base}/internal-work-requests/outbox`, SALES);
    assert.equal((await salesOutbox.json()).data.length, 1, "the rejected spoof attempt created no record");

    const ack = await authed(`${base}/internal-work-requests/${record.id}/acknowledge`, OPS, { method: "POST" });
    assert.equal(ack.status, 200);

    const complete = await authed(`${base}/internal-work-requests/${record.id}/transition`, OPS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "complete", note: "48 m2 on hand, reserved." })
    });
    assert.equal(complete.status, 200);
    assert.equal((await complete.json()).data.status, "Completed");
  });

  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  const persisted = onDisk.internal_work_requests.find((item) => item.status === "Completed");
  assert.ok(persisted, "the completed request is actually persisted to the file store, not only held in memory");
  assert.equal(persisted.resolution_note, "48 m2 on hand, reserved.");
});

test("a rejected create (validation failure) writes nothing to the file", async () => {
  const { store, file } = makeTempStore();
  const before = readFileSync(file, "utf8");
  await withServer(buildApp(store), async (base) => {
    const response = await authed(`${base}/internal-work-requests`, SALES, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_type: "NOT_A_TYPE", subject: "x", description: "y" })
    });
    assert.equal(response.status, 400);
  });
  assert.equal(readFileSync(file, "utf8"), before, "a 4xx response must never persist a partial write");
});

test("two concurrent acknowledge attempts by different eligible recipients: exactly one 200, the other a truthful 409", async () => {
  const { store, file } = makeTempStore();
  await withServer(buildApp(store), async (base) => {
    const created = await authed(`${base}/internal-work-requests`, SALES, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_type: "STOCK_AVAILABILITY", subject: "Race condition check", description: "Two Operations users claim at once.", recipient_role: "Operations"
      })
    });
    const id = (await created.json()).data.id;

    const [first, second] = await Promise.all([
      authed(`${base}/internal-work-requests/${id}/acknowledge`, OPS, { method: "POST" }),
      authed(`${base}/internal-work-requests/${id}/acknowledge`, OPS2, { method: "POST" })
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409], "the store's write mutex must serialise the two claims, not corrupt or double-assign the request");
  });

  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  const record = onDisk.internal_work_requests.find((item) => item.request_type === "STOCK_AVAILABILITY" && item.subject === "Race condition check");
  assert.ok(record.assigned_to_user_id === "u_ops" || record.assigned_to_user_id === "u_ops2", "exactly one of the two claimants ends up assigned");
  assert.equal(record.status, "Acknowledged");
});

test("Operations cannot acknowledge its own Operations-to-Operations request, even over HTTP", async () => {
  const { store } = makeTempStore();
  await withServer(buildApp(store), async (base) => {
    const created = await authed(`${base}/internal-work-requests`, OPS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_type: "STOCK_FULFILMENT", subject: "Reserve rubber lining", description: "Operations to Operations fulfilment.",
        recipient_role: "Operations", related_entity_type: "stock_item", related_entity_id: "si_rubber_lining"
      })
    });
    assert.equal(created.status, 201);
    const id = (await created.json()).data.id;

    // The requester holds the recipient role too, but must not acknowledge its own request.
    const selfAck = await authed(`${base}/internal-work-requests/${id}/acknowledge`, OPS, { method: "POST" });
    assert.equal(selfAck.status, 403);

    // A different Operations account is the eligible recipient and can.
    const otherAck = await authed(`${base}/internal-work-requests/${id}/acknowledge`, OPS2, { method: "POST" });
    assert.equal(otherAck.status, 200);
  });
});
