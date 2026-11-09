import assert from "node:assert/strict";
import test from "node:test";
import { IMPORT_ENTITIES, IMPORT_LIMITS, analyseCsv, sha256Text } from "../src/importers/masterDataImport.js";
import { downloadImportTemplate, commitMasterDataImport, listImportJobs, previewMasterDataImport } from "../src/controllers/importController.js";
import { normalizeDb } from "../src/store.js";
import { roles } from "../src/permissions.js";

// The V0 candidate's refusal table (REFUSAL_TEST_TABLE.md), ported to controller level so it runs without a web
// server. Where the V0 test checked an HTTP status, this checks the status and code the controller returns, and
// that nothing was created. Request-level rollback and body-size limits stay HTTP-level concerns (see the notes).

const H = "name,client_type,contact_person,email\n";
function fixture() {
  const db = normalizeDb({ users: [], clients: [], catalog_items: [] }, { seedDemoRecords: false });
  for (const role of Object.values(roles)) db.users.push({ id: `u_${role}`, role, is_active: true, name: `Test ${role}`, email: `${role}@example.test` });
  db.users.push({ id: "u_inactive", role: roles.MANAGEMENT, is_active: false, name: "Inactive", email: "inactive@example.test" });
  let n = 0;
  const store = { id: (p) => `${p}_${++n}`, audit: (d, a, t, id, action) => { d.audit_logs.push({ entity_type: t, entity_id: id, action }); } };
  return { db, store };
}
function call(handler, f, userId, { body = {}, params = {}, claimedRole } = {}) {
  const out = { status: 200, body: null };
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
  try { handler({ db: f.db, store: f.store, user: { id: userId, role: claimedRole }, body, params, nowMs: Date.UTC(2026, 10, 1) }, res); }
  catch (e) { out.status = e.status || 500; out.body = { success: false, message: e.message }; }
  return out;
}
const commitBody = (csv, over = {}) => ({ csv_content: csv, file_sha256: sha256Text(csv), confirmation: "IMPORT_CLIENTS", expected_row_count: csv.trim().split("\n").length - 1, ...over });
const created = (f) => f.db.clients.length + f.db.catalog_items.length + (f.db.import_jobs || []).length + f.db.audit_logs.length;
const GOOD = `${H}Refusal Co,Mine,Pat Example,pat@example.test\nSecond Co,Mine,,\n`;

test("every role except Admin and Management is refused (403) on every route, and nothing is created", () => {
  const f = fixture();
  const refused = Object.values(roles).filter((r) => r !== roles.ADMIN && r !== roles.MANAGEMENT);
  assert.equal(refused.length, 6);
  for (const role of refused) {
    for (const entity of ["clients", "catalog_items"]) {
      assert.equal(call(previewMasterDataImport(entity), f, `u_${role}`, { body: { csv_content: GOOD } }).status, 403, `${role} preview ${entity}`);
      assert.equal(call(commitMasterDataImport(entity), f, `u_${role}`, { body: commitBody(GOOD) }).status, 403, `${role} commit ${entity}`);
      assert.equal(call(downloadImportTemplate(entity), f, `u_${role}`).status, 403, `${role} template ${entity}`);
    }
    assert.equal(call(listImportJobs, f, `u_${role}`).status, 403, `${role} history`);
  }
  assert.equal(created(f), 0);
});

test("Admin and Management are allowed", () => {
  const f = fixture();
  for (const who of [roles.ADMIN, roles.MANAGEMENT]) {
    assert.equal(call(downloadImportTemplate("clients"), f, `u_${who}`).status, 200, who);
    assert.equal(call(previewMasterDataImport("clients"), f, `u_${who}`, { body: { csv_content: GOOD } }).status, 200, who);
  }
});

test("the database role wins over a role claimed in the token; inactive and unknown accounts are refused", () => {
  const f = fixture();
  assert.equal(call(commitMasterDataImport("clients"), f, `u_${roles.SALES}`, { body: commitBody(GOOD), claimedRole: roles.ADMIN }).status, 403);
  assert.equal(call(previewMasterDataImport("clients"), f, "u_inactive", { body: { csv_content: GOOD } }).status, 403);
  assert.equal(call(previewMasterDataImport("clients"), f, "u_does_not_exist", { body: { csv_content: GOOD } }).status, 403);
  assert.equal(created(f), 0);
});

test("wrong confirmation phrase, wrong or non-integer count, and a changed hash are refused with the right code", () => {
  const f = fixture(); const as = `u_${roles.ADMIN}`;
  const run = (over) => call(commitMasterDataImport("clients"), f, as, { body: commitBody(GOOD, over) });
  for (const phrase of ["import_clients", "IMPORT_CLIENT", "", undefined]) { const r = run({ confirmation: phrase }); assert.equal(r.status, 400); assert.equal(r.body.code, "CONFIRMATION_WRONG", String(phrase)); }
  for (const count of [1, 3, 2.5, "2", null, undefined]) { const r = run({ expected_row_count: count }); assert.equal(r.status, 400); assert.equal(r.body.code, "COUNT_WRONG", String(count)); }
  const r = run({ file_sha256: sha256Text(`${GOOD} `) }); assert.equal(r.body.code, "HASH_MISMATCH");
  const edited = run({ csv_content: `${GOOD}Third Co,Mine,,\n` }); // text edited after the preview: hash no longer matches
  assert.equal(edited.body.code, "HASH_MISMATCH");
  assert.equal(created(f), 0);
});

test("any row error refuses the whole file (ROW_ERRORS) and nothing is created", () => {
  const f = fixture();
  const csv = `${H}Good Co,Mine,,\n,Mine,,\nBad Email Co,Mine,Pat,not-an-email\n`;
  const r = call(commitMasterDataImport("clients"), f, `u_${roles.ADMIN}`, { body: commitBody(csv) });
  assert.equal(r.status, 400); assert.equal(r.body.code, "ROW_ERRORS"); assert.equal(r.body.error_count, 2);
  assert.equal(created(f), 0);
});

test("header problems: unknown, repeated and missing columns reject the whole file", () => {
  const f = fixture();
  const cases = [["name,client_type,wages\nA,Mine,5\n", "HEADER_UNKNOWN"], ["name,name,client_type\nA,A,Mine\n", "HEADER_REPEATED"], ["name,contact_person\nA,Pat\n", "HEADER_MISSING"]];
  for (const [csv, code] of cases) {
    const preview = call(previewMasterDataImport("clients"), f, `u_${roles.ADMIN}`, { body: { csv_content: csv } }).body.data;
    assert.ok(preview.file_errors.some((e) => e.code === code), code);
    assert.equal(preview.can_commit, false);
    const r = call(commitMasterDataImport("clients"), f, `u_${roles.ADMIN}`, { body: commitBody(csv, { expected_row_count: 1 }) });
    assert.equal(r.status, 400); assert.ok(r.body.file_errors.some((e) => e.code === code), code);
  }
  assert.equal(created(f), 0);
});

test("empty file and missing csv_content", () => {
  const f = fixture();
  assert.equal(call(commitMasterDataImport("clients"), f, `u_${roles.ADMIN}`, { body: { csv_content: "", file_sha256: sha256Text(""), confirmation: "IMPORT_CLIENTS", expected_row_count: 0 } }).body.code, "FILE_EMPTY");
  const none = call(commitMasterDataImport("clients"), f, `u_${roles.ADMIN}`, { body: {} });
  assert.equal(none.status, 400); assert.equal(none.body.code, "CSV_CONTENT_REQUIRED");
  assert.equal(call(previewMasterDataImport("clients"), f, `u_${roles.ADMIN}`, { body: {} }).body.code, "CSV_CONTENT_REQUIRED");
});

test("one row over the row cap, and a file over 512 KB, are refused", () => {
  const f = fixture();
  const many = H + Array.from({ length: IMPORT_LIMITS.maxRows + 1 }, (_, i) => `Cap Co ${i},Mine,,`).join("\n") + "\n";
  assert.equal(analyseCsv(IMPORT_ENTITIES.clients, many).fileErrors[0].code, "TOO_MANY_ROWS");
  assert.equal(call(commitMasterDataImport("clients"), f, `u_${roles.ADMIN}`, { body: commitBody(many) }).body.code, "TOO_MANY_ROWS");
  const big = H + `Big Co,Mine,${"x".repeat(IMPORT_LIMITS.maxBytes)},\n`;
  const preview = call(previewMasterDataImport("clients"), f, `u_${roles.ADMIN}`, { body: { csv_content: big } }).body.data;
  assert.equal(preview.file_errors[0].code, "FILE_TOO_LARGE"); assert.equal(preview.can_commit, false);
  assert.equal(call(commitMasterDataImport("clients"), f, `u_${roles.ADMIN}`, { body: commitBody(big) }).body.code, "FILE_TOO_LARGE");
  assert.equal(created(f), 0);
});

test("the same file twice: 409 DUPLICATE_FILE, preview says already_imported, exactly one job", () => {
  const f = fixture(); const as = `u_${roles.ADMIN}`;
  assert.equal(call(commitMasterDataImport("clients"), f, as, { body: commitBody(GOOD) }).status, 201);
  const again = call(commitMasterDataImport("clients"), f, as, { body: commitBody(GOOD) });
  assert.equal(again.status, 409); assert.equal(again.body.code, "DUPLICATE_FILE");
  assert.equal(call(previewMasterDataImport("clients"), f, as, { body: { csv_content: GOOD } }).body.data.already_imported, true);
  assert.equal(f.db.import_jobs.length, 1); assert.equal(f.db.clients.length, 2);
});

test("a failure part-way through the commit creates no job and is not swallowed (rollback of the request copy is the caller's job)", () => {
  const f = fixture(); const csv = `${H}A Co,Mine,,\nB Co,Mine,,\nC Co,Mine,,\nD Co,Mine,,\n`;
  let calls = 0; const real = f.store.audit;
  f.store.audit = (...args) => { calls += 1; if (calls === 3) throw new Error("injected failure at record 3"); return real(...args); };
  const r = call(commitMasterDataImport("clients"), f, `u_${roles.ADMIN}`, { body: commitBody(csv) });
  assert.equal(r.status, 500); assert.match(r.body.message, /injected failure/);
  assert.equal((f.db.import_jobs || []).length, 0, "no job record is written for a failed commit");
  assert.equal(f.db.audit_logs.some((a) => a.entity_type === "import_job"), false, "no job-level audit entry");
});

test("job record ids older than 90 days are cleared at the next commit; a database without import_jobs still works", () => {
  const f = fixture(); const as = `u_${roles.ADMIN}`;
  delete f.db.import_jobs; // an older store file
  assert.equal(call(listImportJobs, f, as).body.data.length, 0);
  f.db.import_jobs = [{ id: "imp_old", entity: "clients", file_sha256: "x", row_count: 1, created_count: 1, created_ids: ["c_old"], created_at: new Date(Date.UTC(2026, 10, 1) - 100 * 86400000).toISOString() }];
  assert.equal(call(commitMasterDataImport("clients"), f, as, { body: commitBody(GOOD) }).status, 201);
  const old = f.db.import_jobs.find((j) => j.id === "imp_old");
  assert.deepEqual(old.created_ids, []); assert.ok(old.ids_pruned_at);
  const fresh = f.db.import_jobs.find((j) => j.id !== "imp_old"); assert.equal(fresh.created_ids.length, 2);
});

test("prices must be plain numbers: symbol, separator, comma decimal, sign, exponent, 16 digits and blank are all PRICE_FORMAT", () => {
  for (const price of ["$12.50", "1,200.00", "12,50", "-5", "+5", "1e3", "1234567890123456", ""]) {
    const csv = `item_code,item_name,unit_price\nPR-1,Price test,"${price}"\n`;
    const row = analyseCsv(IMPORT_ENTITIES.catalog_items, csv).rows[0];
    assert.equal(row.status, "error", price);
    assert.ok(row.errors.some((e) => e.code === "PRICE_FORMAT" || e.code === "FIELD_INVALID"), `${JSON.stringify(price)} -> ${row.errors.map((e) => e.code)}`);
  }
  assert.equal(analyseCsv(IMPORT_ENTITIES.catalog_items, "item_code,item_name,unit_price\nPR-2,Plain,12.50\n").rows[0].status, "ok");
});

test("row structure errors: quoted line break, wrong cell count, control character", () => {
  const rows = analyseCsv(IMPORT_ENTITIES.clients, `${H}"Line\nBreak Co",Mine,,\nShort Co,Mine\nCtrl\u0007 Co,Mine,,\n`).rows;
  assert.deepEqual(rows.map((r) => r.status), ["error", "error", "error"]);
  assert.equal(rows[0].errors[0].code, "QUOTED_LINE_BREAK"); assert.equal(rows[1].errors[0].code, "ROW_COLUMN_COUNT"); assert.equal(rows[2].errors[0].code, "INVALID_CHARACTER");
});

test("the template is the header row, as JSON, for Admin and Management", () => {
  const f = fixture();
  const t = call(downloadImportTemplate("catalog_items"), f, `u_${roles.MANAGEMENT}`);
  assert.equal(t.status, 200); assert.equal(t.body.data.csv_content.trim(), IMPORT_ENTITIES.catalog_items.columns.map((c) => c.name).join(","));
});
