import assert from "node:assert";
import test from "node:test";
import express from "express";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";

async function withServer(app, run) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("read-only requests bypass the write transaction", async () => {
  const calls = { read: [], release: 0, write: 0 };
  const store = {
    read: async (options) => { calls.read.push(options); return { db: {}, release: null }; },
    release: async () => { calls.release += 1; },
    write: async () => { calls.write += 1; }
  };
  const app = express();
  app.use(persistenceMiddleware(store));
  app.get("/health", (_req, res) => res.json({ ok: true }));

  await withServer(app, async (url) => {
    const response = await fetch(`${url}/health`);
    assert.equal(response.status, 200);
  });
  assert.deepEqual(calls.read, [{ lock: false }]);
  assert.equal(calls.write, 0);
});

test("login bypasses the write transaction even when credentials are rejected", async () => {
  const calls = { read: [], release: 0, write: 0 };
  const store = {
    read: async (options) => { calls.read.push(options); return { db: {}, release: null }; },
    release: async () => { calls.release += 1; },
    write: async () => { calls.write += 1; }
  };
  const app = express();
  app.use(persistenceMiddleware(store));
  app.post("/auth/login", (_req, res) => res.status(401).json({ message: "Invalid credentials." }));

  await withServer(app, async (url) => {
    const response = await fetch(`${url}/auth/login`, { method: "POST" });
    assert.equal(response.status, 401);
  });
  assert.deepEqual(calls.read, [{ lock: false }]);
  assert.equal(calls.write, 0);
});

test("a rejected mutation releases its transaction without writing", async () => {
  const calls = { read: [], release: 0, write: 0 };
  const context = {};
  const store = {
    read: async (options) => { calls.read.push(options); return { db: {}, release: context }; },
    release: async (value) => { assert.strictEqual(value, context); calls.release += 1; },
    write: async () => { calls.write += 1; }
  };
  const app = express();
  app.use(persistenceMiddleware(store));
  app.post("/invalid", (_req, res) => res.status(400).json({ message: "Validation failed." }));

  await withServer(app, async (url) => {
    const response = await fetch(`${url}/invalid`, { method: "POST" });
    assert.equal(response.status, 400);
  });
  assert.deepEqual(calls.read, [{ lock: true }]);
  assert.equal(calls.release, 1);
  assert.equal(calls.write, 0);
});
