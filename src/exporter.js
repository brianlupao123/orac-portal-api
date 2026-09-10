function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function exportInvoicesCsv(db) {
  const headers = [
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
  for (const invoice of db.invoices) {
    const po = db.purchase_orders.find((item) => item.id === invoice.purchase_order_id);
    const quote = db.quotes.find((item) => item.id === po?.quotation_id);
    const client = db.clients.find((item) => item.id === quote?.client_id);
    const job = db.dispatch_cards.find((item) => item.id === invoice.dispatch_card_id);
    const equipment = db.equipment_tags.find((item) => item.id === job?.equipment_tag_id);
    const lines = db.invoice_lines.filter((item) => item.invoice_id === invoice.id);
    const laborHours = db.timesheets
      .filter((item) => item.dispatch_card_id === job?.id)
      .reduce((sum, item) => sum + Number(item.hours_logged || 0), 0);
    const materialCost = db.material_usage
      .filter((item) => item.dispatch_card_id === job?.id)
      .reduce((sum, item) => sum + Number(item.total_cost || 0), 0);

    for (const line of lines) {
      rows.push([
        invoice.invoice_number,
        invoice.generated_at?.slice(0, 10) || "",
        client?.id || "",
        client?.name || "",
        po?.po_reference || "",
        equipment?.tag_code || "",
        line.cost_center || "",
        line.gl_account_code || "",
        line.description || "",
        laborHours,
        materialCost,
        invoice.total_amount
      ]);
    }
  }

  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}
