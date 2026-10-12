import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the JSON store uses the configured JSON_DB_PATH at server startup", () => {
  const source = readFileSync(new URL("../server.js", import.meta.url), "utf8");

  assert.match(source, /createJsonStore\(resolve\(__dirname, config\.jsonDbPath\)\)/);
  assert.doesNotMatch(source, /createJsonStore\(join\(__dirname, "data", "db\.json"\)\)/);
});
