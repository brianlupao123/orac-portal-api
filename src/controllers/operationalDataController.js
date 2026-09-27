import { roles, requirePermission } from "../permissions.js";
import { getActor, scopeOperationalData } from "./coreController.js";
import { computeInvoiceReadyReport } from "../reports.js";

const analyticsRoles = [roles.ADMIN, roles.MANAGEMENT, roles.FINANCE, roles.OPERATIONS, roles.SUPERVISOR, roles.TECHNICIAN];
const leadPreviewRoles = [roles.ADMIN, roles.MANAGEMENT, roles.SALES];
const csvHeaders = ["company_name", "contact_name", "email", "service_need"];

function deny(res, message) {
  return res.status(403).json({ success: false, message });
}

function csvCell(value) {
  let text = String(value ?? "").replace(/\r?\n/g, " ");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sendCsv(res, filename, headers, rows) {
  const csv = [headers.join(","), ...rows.map((row) => headers.map((key) => csvCell(row[key])).join(","))].join("\n");
  res.header("Content-Type", "text/csv; charset=utf-8");
  res.header("Content-Disposition", `attachment; filename=${filename}`);
  res.send(csv);
}

export function getPastelReviewQuotes(req, res) {
  const actor = getActor(req);
  requirePermission(actor, "exportPastel");
  const rows = [...req.db.quotes]
    .sort((a, b) => String(a.quote_number || a.id).localeCompare(String(b.quote_number || b.id)))
    .map((quote) => ({
      quote_number: quote.quote_number || quote.id,
      client_id: quote.client_id,
      status: quote.status,
      total_amount: Number(quote.total_amount || 0).toFixed(2)
    }));
  return sendCsv(res, "orac-pastel-review-quotes.csv", ["quote_number", "client_id", "status", "total_amount"], rows);
}

export function getPastelReviewInvoiceReady(req, res) {
  const actor = getActor(req);
  requirePermission(actor, "exportPastel");
  const rows = computeInvoiceReadyReport(req.db)
    .sort((a, b) => String(a.dispatch_number || a.id).localeCompare(String(b.dispatch_number || b.id)))
    .map((item) => ({ dispatch_number: item.dispatch_number || item.id, quotation_id: item.quotation_id }));
  return sendCsv(res, "orac-pastel-review-invoice-ready.csv", ["dispatch_number", "quotation_id"], rows);
}

function parseCsvRow(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  if (quoted) return null;
  cells.push(cell.trim());
  return cells;
}

export function previewLeadImport(req, res) {
  const actor = getActor(req);
  if (!actor?.is_active || !leadPreviewRoles.includes(actor.role)) return deny(res, "Role cannot preview lead imports.");
  const csv = String(req.body?.csv_content || "");
  if (!csv || Buffer.byteLength(csv, "utf8") > 512 * 1024) {
    return res.status(400).json({ success: false, message: "csv_content is required and must be at most 512 KB." });
  }
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2 || lines.length > 501) return res.status(400).json({ success: false, message: "CSV must contain 1 to 500 data rows." });
  const headers = parseCsvRow(lines[0]);
  if (!headers || csvHeaders.some((header) => !headers.includes(header))) {
    return res.status(400).json({ success: false, message: `CSV must contain: ${csvHeaders.join(", ")}.` });
  }
  const existingEmails = new Set((req.db.leads || []).map((lead) => String(lead.email || "").toLowerCase()));
  const seen = new Set();
  const rows = lines.slice(1).map((line, rowIndex) => {
    const cells = parseCsvRow(line);
    const values = Object.fromEntries(headers.map((header, index) => [header, cells?.[index] || ""]));
    const email = values.email.toLowerCase();
    const errors = [];
    if (!cells) errors.push("Unclosed quoted value.");
    for (const header of csvHeaders) if (!values[header]) errors.push(`${header} is required.`);
    if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.push("email is invalid.");
    if (email && (existingEmails.has(email) || seen.has(email))) errors.push("email duplicates an existing or earlier CSV lead.");
    if (email) seen.add(email);
    return { row: rowIndex + 2, values, valid: errors.length === 0, errors };
  });
  return res.json({ success: true, preview_only: true, total_rows: rows.length, valid_rows: rows.filter((row) => row.valid).length, invalid_rows: rows.filter((row) => !row.valid).length, rows });
}

export function commitLeadImport(req, res) {
  const actor = getActor(req);
  if (!actor?.is_active || !leadPreviewRoles.includes(actor.role)) return deny(res, "Role cannot commit lead imports.");
  if (req.body?.confirmation !== "IMPORT_LEADS") return res.status(400).json({ success: false, message: "Enter the exact confirmation IMPORT_LEADS before committing." });
  const csv = String(req.body?.csv_content || "");
  if (!csv || Buffer.byteLength(csv, "utf8") > 512 * 1024) return res.status(400).json({ success: false, message: "csv_content is required and must be at most 512 KB." });
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  const headers = parseCsvRow(lines[0] || "");
  if (!headers || lines.length < 2 || lines.length > 501 || csvHeaders.some((header) => !headers.includes(header))) {
    return res.status(400).json({ success: false, message: "CSV must contain 1 to 500 rows and required lead headers." });
  }
  const emails = new Set((req.db.leads || []).map((lead) => String(lead.email || "").toLowerCase()));
  const candidates = [];
  for (const [index, line] of lines.slice(1).entries()) {
    const cells = parseCsvRow(line);
    const values = Object.fromEntries(headers.map((header, cellIndex) => [header, cells?.[cellIndex] || ""]));
    const email = values.email.toLowerCase();
    if (!cells || csvHeaders.some((header) => !values[header]) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email) || emails.has(email)) {
      return res.status(400).json({ success: false, message: `Import stopped: row ${index + 2} is invalid or duplicates an existing lead.` });
    }
    emails.add(email);
    candidates.push(values);
  }
  const batchId = req.store.id("lead_import");
  const imported = candidates.map((values) => ({ id: req.store.id("lead"), ...values, phone: values.phone || "", mine_site: values.mine_site || "", urgency: values.urgency || "standard", status: "New", import_batch_id: batchId, created_at: new Date().toISOString() }));
  req.db.leads.push(...imported);
  req.store.audit(req.db, actor, "lead_import", batchId, "LEAD_IMPORT_COMMITTED", null, { imported_count: imported.length, source: "csv_confirmed" });
  for (const lead of imported) req.store.audit(req.db, actor, "lead", lead.id, "LEAD_IMPORTED", null, { id: lead.id, email: lead.email, import_batch_id: batchId });
  return res.status(201).json({ success: true, data: { batch_id: batchId, imported_count: imported.length, leads: imported.map((lead) => ({ id: lead.id, email: lead.email, company_name: lead.company_name })) } });
}

function parseRange(query) {
  const from = String(query?.from || "");
  const to = String(query?.to || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T23:59:59.999Z`);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || end < start || end - start > 366 * 24 * 60 * 60 * 1000) return null;
  return { start, end };
}

function inRange(value, range) {
  if (!value) return true;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) || (date >= range.start && date <= range.end);
}

export function getOperationalAnalytics(req, res) {
  const actor = getActor(req);
  if (!actor?.is_active || !analyticsRoles.includes(actor.role)) return deny(res, "Role cannot view operational analytics.");
  const range = parseRange(req.query);
  if (!range) return res.status(400).json({ success: false, message: "Use valid from and to dates, with a maximum 366-day range." });
  const dispatches = scopeOperationalData(req.db.dispatch_cards, "dispatch_cards", actor, req.db).filter((item) => inRange(item.created_at || item.scheduled_start, range));
  const worksheets = scopeOperationalData(req.db.field_worksheets, "field_worksheets", actor, req.db).filter((item) => inRange(item.work_date || item.created_at, range));
  const data = {
    range: { from: req.query.from, to: req.query.to },
    dispatches: { total: dispatches.length, by_status: Object.groupBy(dispatches, (item) => item.status || "Unknown") },
    worksheets: {
      total: worksheets.length,
      approved: worksheets.filter((item) => item.status === "Supervisor_Approved").length,
      // Superset for backward compatibility; Chat B split this into two stages.
      pending_review: worksheets.filter((item) => ["Submitted", "Client_Acknowledged"].includes(item.status)).length,
      pending_client_acknowledgement: worksheets.filter((item) => item.status === "Submitted").length,
      pending_supervisor_review: worksheets.filter((item) => item.status === "Client_Acknowledged").length
    }
  };
  if ([roles.ADMIN, roles.MANAGEMENT, roles.FINANCE].includes(actor.role)) data.invoice_ready = computeInvoiceReadyReport(req.db).length;
  return res.json({ success: true, data });
}
