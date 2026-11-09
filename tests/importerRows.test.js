import assert from "node:assert/strict";
import test from "node:test";
import { AdminCreateClientSchema, AdminCreateCatalogItemSchema } from "../src/schemas.js";
import { IMPORT_ENTITIES, IMPORT_LIMITS, analyseCsv, sha256Text } from "../src/importers/masterDataImport.js";

// Synthetic data only.
const clients = IMPORT_ENTITIES.clients;
const catalog = IMPORT_ENTITIES.catalog_items;
const codes = (list) => list.map((e) => e.code);

test("template columns equal the fields of the form schemas (add a field and this fails)", () => {
  assert.deepEqual(clients.columns.map((c) => c.name).sort(), Object.keys(AdminCreateClientSchema.shape).sort());
  assert.deepEqual(catalog.columns.map((c) => c.name).sort(), Object.keys(AdminCreateCatalogItemSchema.shape).sort());
});

test("a valid clients file has no errors; blank optional cells are allowed", () => {
  const a = analyseCsv(clients, "name,client_type,contact_person,email\nTest Co,Mine,,\nSecond Co,Plant,Pat Example,pat@example.test\n");
  assert.deepEqual(a.fileErrors, []);
  assert.equal(a.rowCount, 2);
  assert.deepEqual(a.rows.map((r) => r.status), ["ok", "ok"]);
  assert.equal(a.rows[0].parsed.name, "Test Co");
});

test("header matching ignores case and surrounding spaces; unknown, repeated and missing headers reject the whole file", () => {
  assert.deepEqual(analyseCsv(clients, " NAME , Client_Type \nA,B\n").fileErrors, []);
  assert.deepEqual(codes(analyseCsv(clients, "name,client_type,colour\nA,B,red\n").fileErrors), ["HEADER_UNKNOWN"]);
  assert.deepEqual(codes(analyseCsv(clients, "name,name,client_type\nA,B,C\n").fileErrors), ["HEADER_REPEATED"]);
  assert.deepEqual(codes(analyseCsv(clients, "name\nA\n").fileErrors), ["HEADER_MISSING"]);
});

test("form rules apply per row: required fields and email format", () => {
  const a = analyseCsv(clients, "name,client_type,email\n,Mine,\nOK Co,Mine,not-an-email\n");
  assert.equal(a.rows[0].status, "error");
  assert.ok(a.rows[0].errors.some((e) => e.field === "name" && e.code === "FIELD_INVALID"));
  assert.equal(a.rows[1].status, "error");
  assert.ok(a.rows[1].errors.some((e) => e.field === "email"));
});

test("price must be a plain number: symbols, separators, comma decimals, negatives, 16 digits and blanks are rejected", () => {
  const bad = ["$12.50", "R 12", "1,200", "12,5", "-5", "1e3", "1.2.3", "1234567890123456", "", " 12"];
  for (const price of bad) {
    const a = analyseCsv(catalog, `item_code,item_name,unit_price\nA1,Bolt,"${price}"\n`);
    assert.equal(a.rows[0].status, "error", `price [${price}] should be rejected`);
    assert.deepEqual(codes(a.rows[0].errors), ["PRICE_FORMAT"], `price [${price}]`);
  }
  for (const price of ["0", "12", "12.50", "007", "123456789012345"]) {
    const a = analyseCsv(catalog, `item_code,item_name,unit_price\nA1,Bolt,${price}\n`);
    assert.equal(a.rows[0].status, "ok", `price [${price}] should pass`);
    assert.equal(a.rows[0].parsed.unit_price, Number(price));
  }
});

test("no value is changed: spaces and formula-like text give warnings and are kept as typed", () => {
  const a = analyseCsv(clients, "name,client_type,contact_person\n  Padded Co ,Mine,=HYPERLINK(1)\n");
  assert.equal(a.rows[0].status, "ok");
  assert.equal(a.rows[0].parsed.name, "  Padded Co ");
  assert.equal(a.rows[0].parsed.contact_person, "=HYPERLINK(1)");
  assert.deepEqual(codes(a.rows[0].warnings).sort(), ["WARN_FORMULA_LIKE", "WARN_SPACES"]);
});

test("row structure errors: wrong cell count, control characters, quoted line breaks", () => {
  const a = analyseCsv(clients, 'name,client_type\nOne,Mine,extra\nTwo\nBell\u0007Co,Mine\n"Multi\nline",Mine\n');
  assert.deepEqual(a.rows.map((r) => codes(r.errors)[0]), ["ROW_COLUMN_COUNT", "ROW_COLUMN_COUNT", "INVALID_CHARACTER", "QUOTED_LINE_BREAK"]);
});

test("limits: empty file, more than 1,000 rows and more than 512 KB", () => {
  assert.deepEqual(codes(analyseCsv(clients, "   \n").fileErrors), ["FILE_EMPTY"]);
  const header = "name,client_type\n";
  const rows = (n) => Array.from({ length: n }, (_, i) => `C${i},Mine`).join("\n");
  assert.deepEqual(analyseCsv(clients, header + rows(IMPORT_LIMITS.maxRows)).fileErrors, []);
  assert.deepEqual(codes(analyseCsv(clients, header + rows(IMPORT_LIMITS.maxRows + 1)).fileErrors), ["TOO_MANY_ROWS"]);
  assert.deepEqual(codes(analyseCsv(clients, `name,client_type\n${"x".repeat(IMPORT_LIMITS.maxBytes)},Mine\n`).fileErrors), ["FILE_TOO_LARGE"]);
});

test("leading zeros in codes are kept as text", () => {
  const a = analyseCsv(catalog, "item_code,item_name,unit_price\n007,Bolt,1\n");
  assert.equal(a.rows[0].parsed.item_code, "007");
});

test("file hash is the SHA-256 of the exact text", () => {
  assert.equal(sha256Text("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("zod 4 errors have no .errors list, which is why the importer reads .issues (existing validate.js reads .errors)", () => {
  const result = AdminCreateClientSchema.safeParse({ name: "", client_type: "x" });
  assert.equal(result.success, false);
  assert.equal(result.error.errors, undefined);
  assert.ok(Array.isArray(result.error.issues) && result.error.issues.length > 0);
});
