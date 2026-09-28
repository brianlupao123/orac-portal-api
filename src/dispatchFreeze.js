// Chat E (audit trail / billable-evidence integrity): once an invoice has been
// generated from a dispatch's logged work, that work may not silently change.
// A voided invoice no longer freezes the dispatch (what happens next is owner
// decision D-E5: no reissue flow exists yet).
export function dispatchHasActiveInvoice(db, dispatch) {
  return (db.invoices || []).some((invoice) =>
    invoice.dispatch_card_id === dispatch.id &&
    String(invoice.status || "").toLowerCase() !== "voided"
  );
}

export const INVOICED_DISPATCH_MESSAGE =
  "This dispatch has already been invoiced. Logged work cannot be added or changed after invoicing.";
