import assert from "node:assert/strict";
import test from "node:test";
import { parseCsvText } from "../src/importers/csvText.js";
import {
  IMPORT_ENTITIES, analyseCsv, contentFingerprint, existingDuplicateKeys, resolveMaxRows, sha256Text
} from "../src/importers/masterDataImport.js";
import {
  commitMasterDataImport, getImportJob, listImportJobs, manageableEntities, previewMasterDataImport
} from "../src/controllers/importController.js";
import { normalizeDb, SCHEMA_COLLECTIONS } from "../src/store.js";

// Synthetic data only. No server, no files: plain objects in memory, controllers called directly.

function fixture() {
  const db = normalizeDb({ users: [], clients: [], catalog_items: [] }, { seedDemoRecords: false });
  for (const [id, role] of [["u_admin", "Admin"], ["u_mgmt", "Management"], ["u_sales", "Sales"], ["u_fin", "Finance"]]) {
    db.users.push({ id, role, is_active: true, name: `Test ${role}`, email: `${id}@example.test` });
  }
  let n = 0;
  const store = {
    id: (prefix) => `${prefix}_${++n}`,
    audit: (d, actor, type, id, action, oldV, newV) => { d.audit_logs.push({ entity_type: type, entity_id: id, action, actor_id: actor.id, new_values: newV }); }
  };
  return { db, store };
}

function call(handler, { db, store }, userId, { body = {}, params = {} } = {}) {
  const out = { status: 200, body: null };
  const res = { status(code) { out.status = code; return res; }, json(payload) { out.body = payload; return res; } };
  try {
    handler({ db, store, user: { id: userId }, body, params, nowMs: Date.UTC(2026, 10, 1) }, res);
  } catch (error) {
    out.status = error.status || 500;
    out.body = { success: false, message: error.message };
  }
  return out;
}

const CLIENT_HEADER = "name,client_type,contact_person,email\n";
const commitBody = (csv, entity = "clients", rows) => ({
  csv_content: csv,
  file_sha256: sha256Text(csv),
  confirmation: IMPORT_ENTITIES[entity].confirmation,
  expected_row_count: rows ?? parseCsvText(csv).records.length - 1
});

// ---------- parser ----------
test("text after a closing quote is flagged, never merged silently", () => {
  const r = parseCsvText('a,"abc"def,c\n').records[0];
  assert.equal(r.malformedQuote, true);
  assert.equal(parseCsvText('a,"abc" ,c\n').records[0].malformedQuote, true);
  assert.equal(parseCsvText('a,"x""y",c\n').records[0].malformedQuote, false);
  assert.equal(parseCsvText('a,ab"c,d\n').records[0].malformedQuote, false);
});

test("a malformed-quote row is a row error that blocks the commit", () => {
  const csv = `${CLIENT_HEADER}Acme,"Mine"x,Pat Example,pat@example.test\n`;
  const analysis = analyseCsv(IMPORT_ENTITIES.clients, csv);
  assert.equal(analysis.rows[0].status, "error");
  assert.equal(analysis.rows[0].errors[0].code, "QUOTE_MALFORMED");
  const f = fixture();
  const res = call(commitMasterDataImport("clients"), f, "u_admin", { body: commitBody(csv) });
  assert.equal(res.status, 400);
  assert.equal(f.db.clients.length, 0);
});

// ---------- delimiter, encoding ----------
test("semicolon- and tab-separated files get one clear message", () => {
  for (const sep of [";", "\t"]) {
    const csv = ["name", "client_type"].join(sep) + "\nAcme" + sep + "Mine\n";
    const analysis = analyseCsv(IMPORT_ENTITIES.clients, csv);
    assert.deepEqual(analysis.fileErrors.map((e) => e.code), ["DELIMITER_UNSUPPORTED"]);
  }
});

test("an unreadable character (a non-UTF-8 file read as UTF-8) is a row error", () => {
  const csv = `${CLIENT_HEADER}Caf\uFFFD Mine,Mine,Pat Example,pat@example.test\n`;
  const row = analyseCsv(IMPORT_ENTITIES.clients, csv).rows[0];
  assert.equal(row.status, "error");
  assert.equal(row.errors[0].code, "ENCODING_INVALID");
  assert.match(row.errors[0].message, /UTF-8/);
});

// ---------- duplicates (warned, never blocked) ----------
test("repeated names inside one file are warned about, with the first row number", () => {
  const csv = `${CLIENT_HEADER}Acme Mining,Mine,,\n  acme mining ,Mine,,\nOther Co,Mine,,\n`;
  const rows = analyseCsv(IMPORT_ENTITIES.clients, csv).rows;
  assert.equal(rows[0].warnings.some((w) => w.code === "WARN_DUPLICATE_IN_FILE"), false);
  const dup = rows[1].warnings.find((w) => w.code === "WARN_DUPLICATE_IN_FILE");
  assert.ok(dup);
  assert.match(dup.message, /row 1/);
  assert.equal(rows[2].warnings.length, 0);
  assert.equal(rows.every((r) => r.status === "ok"), true, "duplicates never block");
});

test("a name or item code that already exists is warned about, ignoring case and spaces", () => {
  const f = fixture();
  f.db.clients.push({ id: "c_old", name: "Great Dyke Concentrator", client_type: "Mine", is_active: false });
  f.db.catalog_items.push({ id: "cat_old", item_code: "PL-100", item_name: "Plate", unit_price: 5 });
  const c = analyseCsv(IMPORT_ENTITIES.clients, `${CLIENT_HEADER}great dyke concentrator ,Mine,,\n`, { existingKeys: existingDuplicateKeys(IMPORT_ENTITIES.clients, f.db) });
  assert.equal(c.rows[0].warnings.some((w) => w.code === "WARN_DUPLICATE_EXISTING"), true, "inactive clients still count");
  const k = analyseCsv(IMPORT_ENTITIES.catalog_items, "item_code,item_name,unit_price\npl-100,Plate again,6.50\n", { existingKeys: existingDuplicateKeys(IMPORT_ENTITIES.catalog_items, f.db) });
  assert.equal(k.rows[0].warnings.some((w) => w.code === "WARN_DUPLICATE_EXISTING"), true);
});

test("preview reports duplicate_count and still allows the commit; both records are created", () => {
  const f = fixture();
  const csv = `${CLIENT_HEADER}Repeat Co,Mine,,\nRepeat Co,Mine,,\n`;
  const preview = call(previewMasterDataImport("clients"), f, "u_admin", { body: { csv_content: csv } });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.data.duplicate_count, 1);
  assert.equal(preview.body.data.can_commit, true);
  const commit = call(commitMasterDataImport("clients"), f, "u_admin", { body: commitBody(csv) });
  assert.equal(commit.status, 201);
  assert.equal(f.db.clients.length, 2);
  assert.equal(f.db.import_jobs[0].duplicate_warnings_count, 1);
});

// ---------- same file saved again ----------
test("the same file saved with other line endings, a BOM or extra blank lines is still caught", () => {
  const base = `${CLIENT_HEADER}Fresh Co,Mine,Pat Example,pat@example.test\n`;
  const same = [base.replace(/\n/g, "\r\n"), `\uFEFF${base}`, `${base}\n\n`, base.trimEnd()];
  for (const variant of same) assert.equal(contentFingerprint(variant), contentFingerprint(base));
  assert.notEqual(contentFingerprint(base.replace("Fresh Co", "Fresh Co 2")), contentFingerprint(base));

  const f = fixture();
  assert.equal(call(commitMasterDataImport("clients"), f, "u_admin", { body: commitBody(base) }).status, 201);
  for (const variant of same) {
    const preview = call(previewMasterDataImport("clients"), f, "u_admin", { body: { csv_content: variant } });
    assert.equal(preview.body.data.already_imported, true);
    assert.equal(preview.body.data.can_commit, false);
    const again = call(commitMasterDataImport("clients"), f, "u_admin", { body: commitBody(variant, "clients", 1) });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, "DUPLICATE_FILE");
  }
  assert.equal(f.db.clients.length, 1, "nothing was created by the repeats");
});

test("a file with one changed cell is a different file", () => {
  const f = fixture();
  const a = `${CLIENT_HEADER}Fresh Co,Mine,,\n`;
  const b = `${CLIENT_HEADER}Fresh Co,Mine,Pat Example,\n`;
  assert.equal(call(commitMasterDataImport("clients"), f, "u_admin", { body: commitBody(a) }).status, 201);
  assert.equal(call(previewMasterDataImport("clients"), f, "u_admin", { body: { csv_content: b } }).body.data.already_imported, false);
});

test("a job recorded before this change (no content_sha256) is still matched by its exact hash", () => {
  const f = fixture();
  const csv = `${CLIENT_HEADER}Old Co,Mine,,\n`;
  f.db.import_jobs = [{ id: "imp_old", entity: "clients", file_sha256: sha256Text(csv), row_count: 1, created_count: 1, created_ids: [], created_at: "2026-10-01T00:00:00.000Z" }];
  assert.equal(call(previewMasterDataImport("clients"), f, "u_admin", { body: { csv_content: csv } }).body.data.already_imported, true);
});

// ---------- row cap ----------
test("IMPORT_MAX_ROWS can lower the cap, never raise it, and bad values are ignored", () => {
  assert.equal(resolveMaxRows(undefined), 1000);
  assert.equal(resolveMaxRows(""), 1000);
  assert.equal(resolveMaxRows("300"), 300);
  assert.equal(resolveMaxRows("1000"), 1000);
  for (const bad of ["5000", "0", "-5", "abc", "12.5", "1e3"]) assert.equal(resolveMaxRows(bad), 1000, bad);
});

// ---------- history access ----------
test("import history: Admin and Management can read it, Sales and Finance cannot; unknown id is 404", () => {
  const f = fixture();
  const csv = `${CLIENT_HEADER}History Co,Mine,,\n`;
  assert.equal(call(commitMasterDataImport("clients"), f, "u_mgmt", { body: commitBody(csv) }).status, 201);
  const jobId = f.db.import_jobs[0].id;
  assert.equal(call(listImportJobs, f, "u_admin").body.data.length, 1);
  assert.equal(call(listImportJobs, f, "u_mgmt").body.data.length, 1);
  for (const who of ["u_sales", "u_fin"]) {
    assert.equal(call(listImportJobs, f, who).status, 403, who);
    assert.equal(call(getImportJob, f, who, { params: { id: jobId } }).status, 403, who);
  }
  assert.equal(call(getImportJob, f, "u_admin", { params: { id: jobId } }).body.data.id, jobId);
  assert.equal(call(getImportJob, f, "u_admin", { params: { id: "imp_nope" } }).status, 404);
  const list = call(listImportJobs, f, "u_admin").body.data[0];
  assert.equal("created_ids" in list, false, "the list never carries record ids");
  assert.equal(list.ids_available, true);
});

test("history is limited per kind of data: someone who may manage only clients never sees catalog jobs", () => {
  const onlyClients = (_actor, permission) => permission === "manageClients";
  const onlyCatalog = (_actor, permission) => permission === "manageCatalog";
  assert.deepEqual(manageableEntities({}, onlyClients), ["clients"]);
  assert.deepEqual(manageableEntities({}, onlyCatalog), ["catalog_items"]);
  assert.deepEqual(manageableEntities({}, () => false), []);
  assert.deepEqual(manageableEntities({ role: "Admin", is_active: true }).sort(), ["catalog_items", "clients"]);
});

// ---------- store registration ----------
test("import_jobs is a registered collection, so a production database always has it", () => {
  assert.equal(SCHEMA_COLLECTIONS.includes("import_jobs"), true);
  const db = normalizeDb({}, { seedDemoRecords: false });
  assert.deepEqual(db.import_jobs, []);
});
