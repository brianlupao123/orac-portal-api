import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { validate } from "../src/middleware/validate.js";

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test("Zod 4 field validation message reaches the HTTP 400 response", () => {
  const req = { body: { email: "invalid" } };
  const res = response();
  let nextCalled = false;
  const schema = z.object({ email: z.email("Email address is invalid") });

  validate(schema)(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { success: false, message: "Email address is invalid" });
});

test("unexpected parser errors retain the generic HTTP 400 response", () => {
  const res = response();
  validate({ parse() { throw new Error("internal detail"); } })({ body: {} }, res, () => {
    assert.fail("next must not run");
  });

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { success: false, message: "Invalid request payload." });
});
