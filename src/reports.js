export function computePipelineReport(db) {
  const byStatus = {};
  for (const quote of db.quotes) {
    if (!byStatus[quote.status]) byStatus[quote.status] = [];
    byStatus[quote.status].push({
      id: quote.id,
      quote_number: quote.quote_number,
      client_id: quote.client_id,
      total_amount: quote.total_amount,
      created_at: quote.created_at
    });
  }
  const counts = {};
  for (const [status, list] of Object.entries(byStatus)) counts[status] = list.length;
  return { by_status: byStatus, counts };
}

export function computePoComplianceReport(db) {
  const approvedAwaitingPo = db.quotes
    .filter((q) => q.status === "Approved_Pending_PO")
    .filter((q) => !db.purchase_orders.some((po) => po.quotation_id === q.id))
    .map((q) => ({ id: q.id, quote_number: q.quote_number, client_id: q.client_id }));

  const requiresAmendment = db.purchase_orders
    .filter((po) => po.requires_amendment)
    .map((po) => ({ id: po.id, po_reference: po.po_reference, po_amount: po.po_amount, logged_value: po.logged_value || 0 }));

  const urgentPendingVerification = db.purchase_orders
    .filter((po) => po.started_before_po && po.status !== "verified")
    .map((po) => ({ id: po.id, quotation_id: po.quotation_id }));

  return {
    approved_awaiting_po: approvedAwaitingPo,
    requires_amendment: requiresAmendment,
    urgent_pending_verification: urgentPendingVerification
  };
}

export function computeDispatchReport(db) {
  return db.dispatch_cards.map((job) => {
    const worksheets = db.field_worksheets.filter((w) => w.dispatch_card_id === job.id);
    return {
      id: job.id,
      dispatch_number: job.dispatch_number,
      status: job.status,
      started_before_po: job.started_before_po,
      scheduled_start: job.scheduled_start,
      worksheet_count: worksheets.length,
      approved_worksheet_count: worksheets.filter((w) => w.status === "Supervisor_Approved").length
    };
  });
}

export function computeWorksheetReport(db) {
  // Chat B added a Client_Acknowledged step between Submitted and
  // Supervisor_Approved. `pending_review` stays a superset (Submitted OR
  // Client_Acknowledged) for backward compatibility with existing callers;
  // the two new fields give the precise breakdown by stage.
  const awaitingClientAcknowledgement = db.field_worksheets.filter((w) => w.status === "Submitted");
  const awaitingSupervisorReview = db.field_worksheets.filter((w) => w.status === "Client_Acknowledged");
  return {
    pending_review: [...awaitingClientAcknowledgement, ...awaitingSupervisorReview]
      .map((w) => ({ id: w.id, dispatch_card_id: w.dispatch_card_id, work_date: w.work_date, hours: w.hours })),
    pending_client_acknowledgement: awaitingClientAcknowledgement
      .map((w) => ({ id: w.id, dispatch_card_id: w.dispatch_card_id, work_date: w.work_date, hours: w.hours })),
    pending_supervisor_review: awaitingSupervisorReview
      .map((w) => ({ id: w.id, dispatch_card_id: w.dispatch_card_id, work_date: w.work_date, hours: w.hours })),
    returned_for_correction: db.field_worksheets
      .filter((w) => w.status === "Returned_For_Correction")
      .map((w) => ({ id: w.id, dispatch_card_id: w.dispatch_card_id, supervisor_comment: w.supervisor_comment })),
    approved_count: db.field_worksheets.filter((w) => w.status === "Supervisor_Approved").length
  };
}

export function computeInvoiceReadyReport(db) {
  const invoicedJobIds = new Set(db.invoices.map((inv) => inv.dispatch_card_id));
  return db.dispatch_cards
    .filter((job) => !invoicedJobIds.has(job.id))
    .filter((job) => {
      const po = db.purchase_orders.find((p) => p.quotation_id === job.quotation_id);
      if (!po || po.status !== "verified" || po.requires_amendment) return false;
      return db.field_worksheets.some((w) => w.dispatch_card_id === job.id && w.status === "Supervisor_Approved");
    })
    .map((job) => ({ id: job.id, dispatch_number: job.dispatch_number, quotation_id: job.quotation_id }));
}

export function computeVarianceReport(db) {
  return db.purchase_orders
    .filter((po) => po.requires_amendment)
    .map((po) => ({
      id: po.id,
      po_reference: po.po_reference,
      po_amount: po.po_amount,
      logged_value: po.logged_value || 0,
      variance: (po.logged_value || 0) - po.po_amount
    }));
}
