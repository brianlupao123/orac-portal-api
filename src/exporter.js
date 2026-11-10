import { countedTimesheets } from "./timesheetReview.js";
import { formatBusinessDate } from "./businessTimezone.js";

function csvEscape(value) {
  let text = String(value ?? "");
  // Neutralise spreadsheet formulas in text cells (client names, PO references
  // and descriptions are user-entered). Real numbers are left untouched.
  if (typeof value !== "number" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function exportInvoicesCsv(db, { timezone } = {}) {
  const headers = [
    "transaction_type",
    "transaction_id",
    "date",
    "client_id",
    "client_name",
    "po_reference",
    "asset_tag_id",
    "cost_center",
    "gl_account_code",
    "description",
    "labor_hours",
    "material_cost",
    "total_invoiced_amount"
  ];

  const rows = [headers];
  for (const invoice of db.invoices || []) {
    // Exclude voided invoices from current billable review output
    if (invoice.status === "voided") continue;

    const po = (db.purchase_orders || []).find((item) => item.id === invoice.purchase_order_id);
    const quote = (db.quotes || []).find((item) => item.id === po?.quotation_id);
    const client = (db.clients || []).find((item) => item.id === quote?.client_id);
    const job = (db.dispatch_cards || []).find((item) => item.id === invoice.dispatch_card_id);
    const equipment = (db.equipment_tags || []).find((item) => item.id === job?.equipment_tag_id);
    const lines = (db.invoice_lines || []).filter((item) => item.invoice_id === invoice.id);
    const laborHours = countedTimesheets(db, job?.id)
      .reduce((sum, item) => sum + Number(item.hours_logged || 0), 0);
    const materialCost = (db.material_usage || [])
      .filter((item) => item.dispatch_card_id === job?.id)
      .reduce((sum, item) => sum + Number(item.total_cost || 0), 0);

    const invDate = formatBusinessDate(invoice.generated_at || invoice.created_at, timezone);

    if (lines.length === 0) {
      rows.push([
        "invoice",
        invoice.invoice_number,
        invDate,
        client?.id || "",
        client?.name || "",
        po?.po_reference || "",
        equipment?.tag_code || "",
        "",
        "",
        "Field service invoice",
        laborHours,
        materialCost,
        invoice.total_amount
      ]);
    } else if (lines.length === 1) {
      const line = lines[0];
      rows.push([
        "invoice",
        invoice.invoice_number,
        invDate,
        client?.id || "",
        client?.name || "",
        po?.po_reference || "",
        equipment?.tag_code || "",
        line.cost_center || "",
        line.gl_account_code || "",
        line.description || "",
        laborHours,
        materialCost,
        Number(line.line_total ?? invoice.total_amount)
      ]);
    } else {
      // Multiple lines: allocate hours and material costs to respective lines to avoid
      // multiplying totals and costs when summed across the export
      for (const line of lines) {
        const isLabour = line.gl_account_code === "SALES-SERVICE" || /labou?r/i.test(line.description || "");
        const isMaterial = line.gl_account_code === "SALES-MATERIALS" || /material/i.test(line.description || "");
        const lineHours = isLabour ? (Number(line.quantity) || laborHours) : 0;
        const lineMatCost = isMaterial ? Number(line.line_total || materialCost) : 0;
        const lineAmount = Number(line.line_total ?? line.amount ?? 0);

        rows.push([
          "invoice",
          invoice.invoice_number,
          invDate,
          client?.id || "",
          client?.name || "",
          po?.po_reference || "",
          equipment?.tag_code || "",
          line.cost_center || "",
          line.gl_account_code || "",
          line.description || "",
          lineHours,
          lineMatCost,
          lineAmount
        ]);
      }
    }

    for (const creditNote of (db.invoice_credit_notes || []).filter((item) => item.invoice_id === invoice.id && item.status === "issued")) {
      rows.push([
        "credit_note",
        creditNote.id,
        formatBusinessDate(creditNote.issued_at || creditNote.prepared_at, timezone),
        client?.id || "",
        client?.name || "",
        po?.po_reference || "",
        equipment?.tag_code || "",
        "",
        "",
        `Credit note: ${creditNote.reason}`,
        0,
        0,
        -Math.abs(Number(creditNote.amount || 0))
      ]);
    }
  }

  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}
