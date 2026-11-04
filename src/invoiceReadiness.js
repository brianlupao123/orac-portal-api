import { isEligibleForDb } from "./timesheetEligibility.js";
import { invoiceVarianceGate } from "./timesheetWorkflow.js";
import { poScopeGate } from "./poVariance.js";
import { countedTimesheets, pendingKioskTimesheets, reviewBlockedReason } from "./timesheetReview.js";

function linkedTimesheetEvidenceBlock(db, job) {
  const linkedHours = new Map();
  for (const entry of countedTimesheets(db, job.id)) {
    if (!Number.isFinite(Number(entry.hours_logged)) || Number(entry.hours_logged) < 0 ||
        !Number.isFinite(Number(entry.hourly_rate)) || Number(entry.hourly_rate) < 0) {
      return {
        code: "INVALID_INVOICE_TIMESHEET_VALUE",
        message: `Invoice blocked: Timesheet ${entry.id || "(unknown)"} has invalid hours or rate data.`,
        status: 409
      };
    }
    if (!entry.source_worksheet_id) continue;

    const worksheet = (db.field_worksheets || []).find((item) => item.id === entry.source_worksheet_id);
    if (!worksheet || worksheet.dispatch_card_id !== job.id ||
        !entry.user_id || worksheet.technician_id !== entry.user_id || !isEligibleForDb(db, worksheet)) {
      return {
        code: "INVOICE_TIMESHEET_EVIDENCE_MISMATCH",
        message: `Invoice blocked: Timesheet ${entry.id || "(unknown)"} does not match an eligible source Timesheet for this dispatch and worker.`,
        status: 409
      };
    }
    linkedHours.set(worksheet.id, (linkedHours.get(worksheet.id) || 0) + Number(entry.hours_logged));
  }

  for (const [worksheetId, hours] of linkedHours) {
    const worksheet = db.field_worksheets.find((item) => item.id === worksheetId);
    if (!Number.isFinite(Number(worksheet.hours)) || hours > Number(worksheet.hours)) {
      return {
        code: "INVOICE_TIMESHEET_HOURS_EXCEEDED",
        message: `Invoice blocked: billable Timesheet hours exceed the approved source record ${worksheetId}.`,
        status: 409
      };
    }
  }
  return null;
}

export function invoiceReadinessBlock(db, job) {
  const quote = db.quotes.find((item) => item.id === job.quotation_id);
  if (!quote || quote.status !== "Field_Dispatch") {
    return { code: "QUOTE_NOT_READY_FOR_INVOICE", message: "Invoice blocked: quote must be in Field_Dispatch status.", status: 400 };
  }

  if (quote.v5_commercial_workflow) {
    return {
      code: "V5_INVOICE_CALCULATION_UNAVAILABLE",
      message: "Invoice blocked: V5 Timesheets are ready for pricing review only; V5 invoice calculation is not implemented.",
      status: 409
    };
  }

  const po = (db.purchase_orders || []).find((item) => item.quotation_id === job.quotation_id && item.status !== "rejected" && item.status !== "cancelled") || (db.purchase_orders || []).find((item) => item.quotation_id === job.quotation_id);
  if (!po || po.status !== "verified" || !String(po.po_reference || "").trim()) {
    return { code: "VERIFIED_PO_REQUIRED", message: "Invoice blocked: verified PO reference is required.", status: 400 };
  }
  if (!Number.isFinite(Number(po.po_amount)) || Number(po.po_amount) <= 0) {
    return { code: "VERIFIED_PO_AMOUNT_INVALID", message: "Invoice blocked: the verified PO must have a positive numeric amount.", status: 409 };
  }

  if (!db.field_worksheets.some((item) => item.dispatch_card_id === job.id && isEligibleForDb(db, item))) {
    return { code: "APPROVED_WORKSHEET_REQUIRED", message: "Invoice blocked: at least one supervisor-approved worksheet is required.", status: 400 };
  }

  const evidenceBlock = linkedTimesheetEvidenceBlock(db, job);
  if (evidenceBlock) return evidenceBlock;

  const dispatchMaterials = (db.material_usage || []).filter((item) => item.dispatch_card_id === job.id);
  if (dispatchMaterials.some((item) => !Number.isFinite(Number(item.total_cost)) || Number(item.total_cost) < 0)) {
    return { code: "INVALID_INVOICE_MATERIAL_VALUE", message: "Invoice blocked: a material usage record has an invalid amount.", status: 409 };
  }

  const pendingKiosk = pendingKioskTimesheets(db, job.id);
  if (pendingKiosk.length > 0) {
    const detail = pendingKiosk.length === 1 ? "entry is" : "entries are";
    const reason = reviewBlockedReason(db, job);
    return {
      code: "KIOSK_REVIEW_PENDING",
      message: `Invoice blocked: ${pendingKiosk.length} kiosk timesheet ${detail} awaiting Supervisor review.${reason ? ` ${reason}` : ""}`,
      status: 400
    };
  }

  if (po.requires_amendment) {
    return { code: "PO_AMENDMENT_REQUIRED", message: "Invoice blocked: logged work exceeds PO amount and requires an approved PO amendment.", status: 400 };
  }

  const amounts = calculateLegacyInvoiceAmounts(db, job, quote);
  if (![amounts.laborTotal, amounts.materialTotal, amounts.total].every(Number.isFinite) ||
      amounts.laborTotal < 0 || amounts.materialTotal < 0 || amounts.total <= 0) {
    return { code: "INVOICE_AMOUNT_INVALID", message: "Invoice blocked: the calculated invoice amount is invalid or unavailable.", status: 409 };
  }
  const previouslyInvoiced = (db.invoices || [])
    .filter((item) => item.purchase_order_id === po.id && String(item.status || "").toLowerCase() !== "voided")
    .reduce((sum, item) => sum + Number(item.total_amount), 0);
  if (!Number.isFinite(previouslyInvoiced) || previouslyInvoiced < 0) {
    return { code: "INVOICE_HISTORY_AMOUNT_INVALID", message: "Invoice blocked: an existing invoice against this PO has an invalid amount.", status: 409 };
  }
  if (previouslyInvoiced + amounts.total > Number(po.po_amount) + 0.005) {
    return {
      code: "INVOICE_EXCEEDS_PO_REMAINING",
      message: "Invoice blocked: the calculated invoice exceeds the remaining verified PO amount. Obtain and verify an approved PO amendment first.",
      status: 409
    };
  }

  const variance = invoiceVarianceGate(db, job.id);
  if (!variance.allow) {
    return { code: "INVOICE_VARIANCE_BLOCK", message: variance.reason, status: 409 };
  }

  // Certified hours vs quoted/PO hours (dark under the same flag). Cleared only by Sales evidence for this exact overrun.
  const scope = poScopeGate(db, job);
  if (!scope.allow) {
    return { code: "PO_SCOPE_OVERRUN_UNRESOLVED", message: scope.reason, status: 409 };
  }

  return null;
}

export function calculateLegacyInvoiceAmounts(db, job, quote) {
  const timesheets = countedTimesheets(db, job.id);
  const materials = (db.material_usage || []).filter((item) => item.dispatch_card_id === job.id);
  const laborTotal = timesheets.reduce((sum, item) => sum + Number(item.hours_logged) * Number(item.hourly_rate), 0);
  const laborHours = timesheets.reduce((sum, item) => sum + Number(item.hours_logged), 0);
  const materialTotal = materials.reduce((sum, item) => sum + Number(item.total_cost), 0);
  return { timesheets, materials, laborTotal, laborHours, materialTotal, total: laborTotal + materialTotal || Number(quote.total_amount) };
}

function finiteAmount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

// Read-only explanation for commercial reviewers. It deliberately derives its
// outcome from invoiceReadinessBlock so this view cannot drift from the actual
// server gate. V5 values stay unavailable until the dedicated V5 writer exists.
export function invoiceReadinessSummary(db, job) {
  const quote = (db.quotes || []).find((item) => item.id === job.quotation_id) || null;
  const po = (db.purchase_orders || []).find((item) => item.id === job.purchase_order_id) ||
    (db.purchase_orders || []).find((item) => item.quotation_id === job.quotation_id) || null;
  const worksheets = (db.field_worksheets || []).filter((item) => item.dispatch_card_id === job.id && !item.superseded_by);
  const approvedWorksheets = worksheets.filter((item) => isEligibleForDb(db, item));
  const billableTimesheets = countedTimesheets(db, job.id);
  const materials = (db.material_usage || []).filter((item) => item.dispatch_card_id === job.id);
  const pendingKiosk = pendingKioskTimesheets(db, job.id);
  const invoiceHistory = (db.invoices || []).filter((item) => item.dispatch_card_id === job.id);
  const activePoInvoices = po ? (db.invoices || []).filter((item) => item.purchase_order_id === po.id && String(item.status || "").toLowerCase() !== "voided") : [];
  const previouslyInvoiced = activePoInvoices.reduce((sum, item) => sum + Number(item.total_amount), 0);
  const poAmount = finiteAmount(po?.po_amount);
  const historyAmount = Number.isFinite(previouslyInvoiced) ? previouslyInvoiced : null;
  const v5 = Boolean(quote?.v5_commercial_workflow);
  const calculated = !v5 && quote ? calculateLegacyInvoiceAmounts(db, job, quote) : null;
  const gateBlock = invoiceReadinessBlock(db, job);
  // The report excludes every dispatch with invoice history, including voided
  // records. Surface that fact rather than silently presenting it as ready.
  const reportBlock = !gateBlock && invoiceHistory.length > 0 ? {
    code: "DISPATCH_INVOICE_HISTORY_PRESENT",
    message: "Invoice review blocked: this dispatch already has invoice history and is not included in the Invoice Ready report.",
    status: 409
  } : gateBlock;

  return {
    dispatch: { id: job.id, dispatch_number: job.dispatch_number || null, status: job.status || null },
    workflow: {
      quotation: quote ? { id: quote.id, quote_number: quote.quote_number || null, status: quote.status || null, v5_commercial_workflow: v5 } : null,
      purchase_order: po ? { id: po.id, po_reference: po.po_reference || null, status: po.status || null, requires_amendment: Boolean(po.requires_amendment) } : null
    },
    evidence: {
      worksheets: { total: worksheets.length, approved: approvedWorksheets.length },
      billable_time: {
        entry_count: billableTimesheets.length,
        hours: billableTimesheets.reduce((sum, item) => sum + (finiteAmount(item.hours_logged) || 0), 0)
      },
      material_usage_count: materials.length,
      kiosk_review_pending_count: pendingKiosk.length
    },
    commercial: {
      currency: "USD",
      po_amount: poAmount,
      previously_invoiced_amount: historyAmount,
      remaining_po_amount: poAmount !== null && historyAmount !== null ? Math.max(0, poAmount - historyAmount) : null,
      calculated_invoice: calculated && [calculated.laborTotal, calculated.materialTotal, calculated.total].every(Number.isFinite) ? {
        labor_amount: calculated.laborTotal,
        material_amount: calculated.materialTotal,
        total_amount: calculated.total
      } : null,
      calculation_available: Boolean(calculated)
    },
    readiness: {
      ready_for_invoice_review: !reportBlock,
      blocker: reportBlock ? { code: reportBlock.code, message: reportBlock.message } : null
    }
  };
}
