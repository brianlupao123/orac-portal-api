/**
 * Client Viewer Allowlist Registry (Lane 7 Specification: Construct, Never Strip)
 *
 * External mining and industrial clients (Client Viewer role) must never receive raw database
 * records or internal business data. Responses for Client Viewers are constructed strictly by
 * selecting explicitly approved customer-facing keys into a new projection object.
 *
 * Forbidden content (strictly blocked):
 * - Worker identity, technician national IDs, artisan hourly pay rates
 * - Internal company costs, markups, margins, or labour buy rates
 * - Internal staff comments, void reasons, or staff-only queues
 * - Internal bank credentials or GL cost-center codes
 */

export function shapeQuoteForClient(doc) {
  if (!doc) return null;
  const { quote, client, lines, equipment, company_profile } = doc;
  return {
    quote: quote ? {
      id: quote.id,
      quote_number: quote.quote_number,
      client_id: quote.client_id,
      status: quote.status,
      created_at: quote.created_at,
      sent_at: quote.sent_at || null,
      valid_until: quote.valid_until || null,
      total_amount: quote.total_amount,
      currency: "USD",
      scope_of_work: quote.scope_of_work || null
    } : null,
    client: client ? {
      id: client.id,
      name: client.name,
      contact_person: client.contact_person || null,
      email: client.email || null
    } : null,
    lines: (lines || []).map((l) => ({
      item_code: l.item_code || null,
      description: l.description,
      quantity: l.quantity,
      unit_of_measure: l.unit_of_measure || null,
      total_price: l.total_price || l.amount || null
    })),
    equipment: equipment ? {
      tag: equipment.tag || null,
      description: equipment.description || null
    } : null,
    company_profile: company_profile ? {
      company_name: company_profile.company_name,
      physical_address: company_profile.physical_address || null,
      email: company_profile.email || null,
      phone: company_profile.phone || null
    } : null
  };
}

export function shapeWorksheetForClient(doc) {
  if (!doc) return null;
  const { worksheet, client, job, company_profile } = doc;
  return {
    worksheet: worksheet ? {
      id: worksheet.id,
      dispatch_card_id: worksheet.dispatch_card_id,
      work_date: worksheet.work_date,
      status: worksheet.status,
      hours: worksheet.hours,
      work_description: worksheet.work_description || null
    } : null,
    client: client ? {
      id: client.id,
      name: client.name
    } : null,
    dispatch: job ? {
      id: job.id,
      dispatch_number: job.dispatch_number,
      scheduled_start: job.scheduled_start || null,
      scheduled_end: job.scheduled_end || null
    } : null,
    company_profile: company_profile ? {
      company_name: company_profile.company_name
    } : null
  };
}

export function shapeInvoiceForClient(doc) {
  if (!doc) return null;
  const { invoice, quote, client, po, company_profile } = doc;
  return {
    invoice: invoice ? {
      id: invoice.id,
      invoice_number: invoice.invoice_number,
      quotation_id: invoice.quotation_id,
      dispatch_card_id: invoice.dispatch_card_id,
      status: invoice.status,
      invoice_date: invoice.invoice_date || invoice.created_at,
      total_amount: invoice.total_amount,
      currency: "USD"
    } : null,
    quote: quote ? {
      id: quote.id,
      quote_number: quote.quote_number
    } : null,
    client: client ? {
      id: client.id,
      name: client.name
    } : null,
    po: po ? {
      id: po.id,
      po_reference: po.po_reference
    } : null,
    company_profile: company_profile ? {
      company_name: company_profile.company_name,
      physical_address: company_profile.physical_address || null
    } : null
  };
}

export function shapePoForClient(doc) {
  if (!doc) return null;
  const { po, quote, client, company_profile } = doc;
  return {
    po: po ? {
      id: po.id,
      po_reference: po.po_reference,
      quotation_id: po.quotation_id,
      status: po.status,
      po_amount: po.po_amount,
      verified_at: po.verified_at || null
    } : null,
    quote: quote ? {
      id: quote.id,
      quote_number: quote.quote_number
    } : null,
    client: client ? {
      id: client.id,
      name: client.name
    } : null,
    company_profile: company_profile ? {
      company_name: company_profile.company_name
    } : null
  };
}

export function shapeDocumentForClient(type, doc) {
  switch (type) {
    case "quote":
      return shapeQuoteForClient(doc);
    case "worksheet":
      return shapeWorksheetForClient(doc);
    case "invoice":
      return shapeInvoiceForClient(doc);
    case "po":
      return shapePoForClient(doc);
    default:
      return null;
  }
}
