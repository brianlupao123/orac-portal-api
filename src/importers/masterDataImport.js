// Bulk import of Clients and Catalog Items from CSV text.
// Every row is checked with the same schema the admin form uses and created through
// the same service function the admin form calls. Nothing here copies a create rule.
import { createHash } from "node:crypto";
import { AdminCreateClientSchema, AdminCreateCatalogItemSchema } from "../schemas.js";
import { createClientRecord, createCatalogItemRecord } from "../services/masterDataService.js";
import { parseCsvText } from "./csvText.js";

const HARD_MAX_ROWS = 1000;

// The row cap can be lowered (never raised) with IMPORT_MAX_ROWS, so operations can shrink
// one commit if PostgreSQL's statement time limit is ever reached. Invalid values are ignored.
export function resolveMaxRows(raw = process.env.IMPORT_MAX_ROWS) {
  const value = Number(raw);
  if (raw === undefined || raw === null || String(raw).trim() === "") return HARD_MAX_ROWS;
  if (!Number.isInteger(value) || value < 1 || value > HARD_MAX_ROWS) return HARD_MAX_ROWS;
  return value;
}

export const IMPORT_LIMITS = Object.freeze({ maxBytes: 512 * 1024, maxRows: resolveMaxRows(), idRetentionDays: 90 });

export const IMPORT_ENTITIES = Object.freeze({
  clients: Object.freeze({
    key: "clients",
    label: "Clients",
    permission: "manageClients",
    columns: Object.freeze([
      { name: "name", required: true },
      { name: "client_type", required: true },
      { name: "contact_person", required: false },
      { name: "email", required: false }
    ]),
    schema: AdminCreateClientSchema,
    create: createClientRecord,
    confirmation: "IMPORT_CLIENTS",
    auditAction: "IMPORT_CLIENTS_COMMITTED",
    // Repeated values are warned about, never blocked (same as the admin forms).
    duplicate: Object.freeze({ collection: "clients", field: "name", label: "client name" })
  }),
  catalog_items: Object.freeze({
    key: "catalog_items",
    label: "Catalog items",
    permission: "manageCatalog",
    columns: Object.freeze([
      { name: "item_code", required: true },
      { name: "item_name", required: true },
      { name: "unit_price", required: true },
      { name: "category", required: false },
      { name: "unit_of_measure", required: false },
      { name: "material_grade", required: false },
      { name: "dimensions", required: false }
    ]),
    schema: AdminCreateCatalogItemSchema,
    create: createCatalogItemRecord,
    confirmation: "IMPORT_CATALOG_ITEMS",
    auditAction: "IMPORT_CATALOG_ITEMS_COMMITTED",
    duplicate: Object.freeze({ collection: "catalog_items", field: "item_code", label: "item code" })
  })
});

export class ImportError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = "ImportError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const PRICE_PATTERN = /^\d+(\.\d+)?$/;
const MAX_PRICE_DIGITS = 15;
const MESSAGES = {
  FILE_EMPTY: "The file is empty.",
  FILE_TOO_LARGE: "The file is larger than 512 KB.",
  TOO_MANY_ROWS: `The file has more than ${IMPORT_LIMITS.maxRows.toLocaleString("en-US")} data rows.`,
  QUOTE_UNTERMINATED: "A quoted cell is not closed. Check for a missing closing quote.",
  QUOTED_LINE_BREAK: "A cell contains a line break inside quotes, which is not supported yet.",
  QUOTE_MALFORMED: "Text follows a closing quote in this row. Check the quotes around each cell.",
  ROW_COLUMN_COUNT: "This row has a different number of cells from the header.",
  INVALID_CHARACTER: "This cell contains a control character.",
  ENCODING_INVALID: "This cell contains an unreadable character. Save the file as CSV UTF-8 and try again.",
  DELIMITER_UNSUPPORTED: "The columns are separated by a semicolon or a tab. Save the sheet as CSV (comma separated) and try again.",
  PRICE_FORMAT: "Unit price must be a plain number such as 12.50, with no currency symbol or thousands separator.",
  WARN_SPACES: "This value has spaces at the start or end. It will be stored as typed.",
  WARN_FORMULA_LIKE: "This value starts with = + - or @. It will be stored as typed."
};

export const sha256Text = (text) => createHash("sha256").update(String(text), "utf8").digest("hex");

// Whitespace-proof fingerprint used only to recognise the same file saved again: BOM,
// line-ending style and trailing blank lines do not change it. Cell values do.
export function contentFingerprint(text) {
  let src = String(text);
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  return sha256Text(src.replace(/\r\n|\r/g, "\n").replace(/\s+$/, ""));
}

function convertPrice(cell) {
  if (!PRICE_PATTERN.test(cell)) return null;
  if (cell.replace(".", "").length > MAX_PRICE_DIGITS) return null;
  const value = Number(cell);
  return Number.isFinite(value) ? value : null;
}

const duplicateKey = (value) => String(value ?? "").trim().toLowerCase();

// Keys of records that already exist, for the "already exists" warning. Read only.
export function existingDuplicateKeys(entity, db) {
  const { collection, field } = entity.duplicate;
  return new Set((db?.[collection] || []).map((record) => duplicateKey(record[field])).filter(Boolean));
}

// Pure analysis of one file. No store access: existing keys are passed in.
// Returns file-level errors and one result per data row.
export function analyseCsv(entity, csvContent, { existingKeys = new Set() } = {}) {
  const fileErrors = [];
  const text = typeof csvContent === "string" ? csvContent : "";
  if (Buffer.byteLength(text, "utf8") > IMPORT_LIMITS.maxBytes) {
    return { fileErrors: [{ code: "FILE_TOO_LARGE", message: MESSAGES.FILE_TOO_LARGE }], rows: [], rowCount: 0 };
  }
  if (!text.trim()) {
    return { fileErrors: [{ code: "FILE_EMPTY", message: MESSAGES.FILE_EMPTY }], rows: [], rowCount: 0 };
  }
  const { records, unterminated } = parseCsvText(text);
  if (unterminated) fileErrors.push({ code: "QUOTE_UNTERMINATED", message: MESSAGES.QUOTE_UNTERMINATED });
  if (records.length === 0) {
    fileErrors.push({ code: "FILE_EMPTY", message: MESSAGES.FILE_EMPTY });
    return { fileErrors, rows: [], rowCount: 0 };
  }

  // A header that did not split at all but contains ; or a tab is a differently separated file.
  // One clear message is more useful than "unknown column" plus a list of missing columns.
  if (records[0].cells.length === 1 && /[;\t]/.test(records[0].cells[0])) {
    fileErrors.push({ code: "DELIMITER_UNSUPPORTED", message: MESSAGES.DELIMITER_UNSUPPORTED });
    return { fileErrors, rows: [], rowCount: Math.max(records.length - 1, 0) };
  }

  const headerCells = records[0].cells.map((cell) => cell.trim().toLowerCase());
  const known = new Map(entity.columns.map((column) => [column.name, column]));
  const seen = new Set();
  for (const name of headerCells) {
    if (!known.has(name)) fileErrors.push({ code: "HEADER_UNKNOWN", message: `Unknown column: ${name || "(blank)"}.` });
    else if (seen.has(name)) fileErrors.push({ code: "HEADER_REPEATED", message: `Column appears more than once: ${name}.` });
    seen.add(name);
  }
  for (const column of entity.columns) {
    if (column.required && !seen.has(column.name)) {
      fileErrors.push({ code: "HEADER_MISSING", message: `A required column is missing: ${column.name}.` });
    }
  }

  const dataRecords = records.slice(1);
  if (dataRecords.length > IMPORT_LIMITS.maxRows) {
    fileErrors.push({ code: "TOO_MANY_ROWS", message: MESSAGES.TOO_MANY_ROWS });
  }
  if (fileErrors.length > 0) return { fileErrors, rows: [], rowCount: dataRecords.length };

  const firstRowByKey = new Map();
  const rows = dataRecords.map((record, index) => {
    const errors = [];
    const warnings = [];
    const values = {};
    const input = {};
    headerCells.forEach((name, position) => { values[name] = record.cells[position] ?? ""; });
    if (record.quotedBreak) errors.push({ field: "", code: "QUOTED_LINE_BREAK", message: MESSAGES.QUOTED_LINE_BREAK });
    if (record.malformedQuote) errors.push({ field: "", code: "QUOTE_MALFORMED", message: MESSAGES.QUOTE_MALFORMED });
    if (record.cells.length !== headerCells.length) {
      errors.push({ field: "", code: "ROW_COLUMN_COUNT", message: MESSAGES.ROW_COLUMN_COUNT });
    }
    if (errors.length === 0) {
      headerCells.forEach((name, position) => {
        const cell = record.cells[position];
        if (CONTROL_CHARS.test(cell)) errors.push({ field: name, code: "INVALID_CHARACTER", message: MESSAGES.INVALID_CHARACTER });
        if (cell.includes("\uFFFD")) errors.push({ field: name, code: "ENCODING_INVALID", message: MESSAGES.ENCODING_INVALID });
        if (cell !== cell.trim()) warnings.push({ field: name, code: "WARN_SPACES", message: MESSAGES.WARN_SPACES });
        if (name !== "unit_price" && /^[=+\-@]/.test(cell)) {
          warnings.push({ field: name, code: "WARN_FORMULA_LIKE", message: MESSAGES.WARN_FORMULA_LIKE });
        }
        input[name] = cell;
      });
    }
    let parsed = null;
    if (errors.length === 0) {
      if (entity.key === "catalog_items") {
        const price = convertPrice(input.unit_price);
        if (price === null) errors.push({ field: "unit_price", code: "PRICE_FORMAT", message: MESSAGES.PRICE_FORMAT });
        else input.unit_price = price;
      }
      if (errors.length === 0) {
        const result = entity.schema.safeParse(input);
        if (result.success) parsed = result.data;
        else {
          for (const issue of result.error.issues) {
            errors.push({ field: String(issue.path[0] ?? ""), code: "FIELD_INVALID", message: issue.message });
          }
        }
      }
    }
    // Repeated values are reported, never blocked: the admin forms accept them too.
    if (errors.length === 0 && parsed) {
      const { field, label } = entity.duplicate;
      const key = duplicateKey(parsed[field]);
      if (key) {
        if (firstRowByKey.has(key)) {
          warnings.push({ field, code: "WARN_DUPLICATE_IN_FILE", message: `This ${label} is also in row ${firstRowByKey.get(key)} of this file.` });
        } else {
          firstRowByKey.set(key, index + 1);
          if (existingKeys.has(key)) {
            warnings.push({ field, code: "WARN_DUPLICATE_EXISTING", message: `A record with this ${label} already exists. Importing it creates a second one.` });
          }
        }
      }
    }
    return { row: index + 1, line: record.line, status: errors.length ? "error" : "ok", values, errors, warnings, parsed };
  });
  return { fileErrors, rows, rowCount: rows.length };
}

const countBy = (rows, fn) => rows.filter(fn).length;
const publicRow = ({ parsed, ...rest }) => rest;
const countDuplicateWarnings = (rows) =>
  rows.reduce((total, r) => total + r.warnings.filter((w) => w.code === "WARN_DUPLICATE_IN_FILE" || w.code === "WARN_DUPLICATE_EXISTING").length, 0);

// The same file saved again (even with different line endings or trailing blank lines) is recognised.
function sameFileAlreadyImported(entity, db, hash, fingerprint) {
  return (db.import_jobs || []).some((job) =>
    job.entity === entity.key && (job.file_sha256 === hash || (job.content_sha256 && job.content_sha256 === fingerprint)));
}

export function previewImport(entity, csvContent, db) {
  if (typeof csvContent !== "string") throw new ImportError(400, "CSV_CONTENT_REQUIRED", "csv_content is required.");
  const analysis = analyseCsv(entity, csvContent, { existingKeys: existingDuplicateKeys(entity, db) });
  const hash = sha256Text(csvContent);
  const errorCount = countBy(analysis.rows, (r) => r.status === "error") + analysis.fileErrors.length;
  const alreadyImported = sameFileAlreadyImported(entity, db, hash, contentFingerprint(csvContent));
  return {
    entity: entity.key,
    file_sha256: hash,
    file_errors: analysis.fileErrors,
    row_count: analysis.rowCount,
    ok_count: countBy(analysis.rows, (r) => r.status === "ok"),
    error_count: errorCount,
    warning_count: analysis.rows.reduce((total, r) => total + r.warnings.length, 0),
    duplicate_count: countDuplicateWarnings(analysis.rows),
    confirmation_phrase: entity.confirmation,
    already_imported: alreadyImported,
    can_commit: errorCount === 0 && analysis.rowCount > 0 && !alreadyImported,
    rows: analysis.rows.map(publicRow)
  };
}

export function commitImport({ entity, body, db, store, actor, nowMs }) {
  const csvContent = body?.csv_content;
  if (typeof csvContent !== "string") throw new ImportError(400, "CSV_CONTENT_REQUIRED", "csv_content is required.");
  const analysis = analyseCsv(entity, csvContent, { existingKeys: existingDuplicateKeys(entity, db) });
  if (analysis.fileErrors.length > 0) {
    throw new ImportError(400, analysis.fileErrors[0].code, analysis.fileErrors[0].message, { file_errors: analysis.fileErrors });
  }
  const errorRows = analysis.rows.filter((r) => r.status === "error");
  if (errorRows.length > 0) {
    throw new ImportError(400, "ROW_ERRORS", `The file has ${errorRows.length} row(s) with errors. Nothing was created.`, { error_count: errorRows.length });
  }
  if (analysis.rowCount === 0) throw new ImportError(400, "FILE_EMPTY", MESSAGES.FILE_EMPTY);
  const hash = sha256Text(csvContent);
  const fingerprint = contentFingerprint(csvContent);
  if (body.file_sha256 !== hash) throw new ImportError(400, "HASH_MISMATCH", "The file changed after the preview. Preview it again.");
  if (body.confirmation !== entity.confirmation) throw new ImportError(400, "CONFIRMATION_WRONG", `Type exactly ${entity.confirmation}.`);
  if (!Number.isInteger(body.expected_row_count) || body.expected_row_count !== analysis.rowCount) {
    throw new ImportError(400, "COUNT_WRONG", "The row count you typed does not match the file.");
  }
  db.import_jobs = db.import_jobs || [];
  if (sameFileAlreadyImported(entity, db, hash, fingerprint)) {
    throw new ImportError(409, "DUPLICATE_FILE", "This exact file has already been imported.");
  }

  const createdIds = analysis.rows.map((row) => entity.create({ db, store, actor, input: row.parsed }).id);
  const warningsCount = analysis.rows.reduce((total, r) => total + r.warnings.length, 0);
  const duplicateWarnings = countDuplicateWarnings(analysis.rows);

  const nowIso = new Date(nowMs).toISOString();
  const cutoff = nowMs - IMPORT_LIMITS.idRetentionDays * 24 * 60 * 60 * 1000;
  for (const old of db.import_jobs) {
    if (old.created_ids.length > 0 && Date.parse(old.created_at) < cutoff) {
      old.created_ids = [];
      old.ids_pruned_at = nowIso;
    }
  }
  const job = {
    id: store.id("imp"),
    entity: entity.key,
    file_sha256: hash,
    content_sha256: fingerprint,
    row_count: analysis.rowCount,
    created_count: createdIds.length,
    created_ids: createdIds,
    warnings_count: warningsCount,
    duplicate_warnings_count: duplicateWarnings,
    created_by: actor.id,
    created_at: nowIso,
    ids_pruned_at: null
  };
  db.import_jobs.push(job);
  // Job-level audit entry: ids and counts only, never cell values.
  store.audit(db, actor, "import_job", job.id, entity.auditAction, null, {
    entity: entity.key, file_sha256: hash, row_count: job.row_count, created_count: job.created_count,
    warnings_count: warningsCount, duplicate_warnings_count: duplicateWarnings
  });
  return job;
}

export const jobSummary = ({ created_ids: ids, ...rest }) => ({ ...rest, ids_available: ids.length > 0 });
