import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("application pool requires PostgreSQL certificate validation", () => {
  const source = readFileSync(new URL("../src/pool.js", import.meta.url), "utf8");

  assert.match(source, /ssl:\s*\{\s*rejectUnauthorized:\s*true\s*\}/);
});
