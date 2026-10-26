import { roles } from "../permissions.js";
import { CLIENT_VISIBLE_QUOTE_STATUSES } from "./coreController.js";
import { fromCents, PROVISIONAL_VAT_NOTICE, TAX_STATUSES } from "../quoteCalculation.js";
import { isEligibleForDb } from "../timesheetEligibility.js";
import { generateControlledPdf, humanizeTimestamp, formatCurrency } from "../pdfGenerator.js";

function getActor(req) {
  return req.user?.id ? req.db.users.find((u) => u.id === req.user.id) : null;
}

function deny(res, message) {
  return res.status(403).json({ success: false, message });
}

function roleAllowed(actor, allowedRoles) {
  return Boolean(actor?.is_active) && allowedRoles.includes(actor.role);
}

function assertDocumentRole(req, res, allowedRoles, message) {
  const actor = getActor(req);
  if (!roleAllowed(actor, allowedRoles)) {
    deny(res, message);
    return false;
  }
  if (actor.role === roles.CLIENT_VIEWER && !actor.client_id) {
    deny(res, "Client Viewer is not linked to a client account.");
    return false;
  }
  return true;
}

function assertClientAccess(req, res, client) {
  const actor = getActor(req);
  if (actor?.role === roles.CLIENT_VIEWER) {
    if (!actor.client_id || !client || client.id !== actor.client_id) {
      deny(res, "Client Viewer cannot access another client's documents.");
      return false;
    }
  }
  return true;
}

// Supervisor scope. Mirrors dispatchController.isAssignedToDispatch and
// coreController.scopeOperationalData: a Supervisor is in scope only when named on the
// dispatch or on a linked worksheet. Ownership that cannot be established fails closed.
function supervisorInScope(db, actor, job, worksheet) {
  if (worksheet?.supervisor_id === actor.id) return true;
  if (!job) return false;
  return job.assigned_supervisor_id === actor.id ||
    job.supervisor_id === actor.id ||
    (db.field_worksheets || []).some((item) => item.dispatch_card_id === job.id && item.supervisor_id === actor.id);
}

function assertQuoteAccess(req, res, doc) {
  const actor = getActor(req);
  const allowed = [roles.ADMIN, roles.MANAGEMENT, roles.SALES, roles.FINANCE, roles.OPERATIONS, roles.CLIENT_VIEWER];
  if (!roleAllowed(actor, allowed)) {
    deny(res, `Role ${actor?.role || "Unknown"} cannot view quote documents.`);
    return false;
  }
  // Client Viewers can only see quotes in visible statuses (Sent or later)
  if (actor.role === roles.CLIENT_VIEWER && !CLIENT_VISIBLE_QUOTE_STATUSES.includes(doc.quote.status)) {
    deny(res, "This quotation is not yet available for client viewing.");
    return false;
  }
  return assertClientAccess(req, res, doc.client);
}

function assertDispatchAccess(req, res, doc) {
  const actor = getActor(req);
  const allowed = [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR, roles.FINANCE, roles.TECHNICIAN];
  if (!roleAllowed(actor, allowed)) {
    deny(res, `Role ${actor?.role || "Unknown"} cannot view job card documents.`);
    return false;
  }
  if (!assertClientAccess(req, res, doc.client)) return false;
  if (actor.role === roles.SUPERVISOR && !supervisorInScope(req.db, actor, doc.job, null)) {
    deny(res, "Supervisor can only view assigned job cards.");
    return false;
  }
  if (actor.role === roles.TECHNICIAN) {
    const assignedWorksheet = req.db.field_worksheets.some((worksheet) => worksheet.dispatch_card_id === doc.job.id && worksheet.technician_id === actor.id);
    const onRoster = (doc.job.assigned_technician_ids || []).includes(actor.id);
    if (!assignedWorksheet && !onRoster && doc.job.assigned_technician_id !== actor.id) {
      deny(res, "Technician can only view assigned job cards.");
      return false;
    }
  }
  return true;
}

function assertWorksheetAccess(req, res, doc) {
  const actor = getActor(req);
  const allowed = [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR, roles.TECHNICIAN, roles.CLIENT_VIEWER];
  if (!roleAllowed(actor, allowed)) {
    deny(res, `Role ${actor?.role || "Unknown"} cannot view worksheet documents.`);
    return false;
  }
  if (!assertClientAccess(req, res, doc.client)) return false;
  if (actor.role === roles.SUPERVISOR && !supervisorInScope(req.db, actor, doc.job, doc.worksheet)) {
    deny(res, "Supervisor can only view worksheets for assigned jobs.");
    return false;
  }
  if (actor.role === roles.TECHNICIAN && doc.worksheet.technician_id !== actor.id) {
    deny(res, "Technician can only view assigned worksheets.");
    return false;
  }
  return true;
}

function assertInvoiceAccess(req, res, doc) {
  const actor = getActor(req);
  const allowed = [roles.ADMIN, roles.MANAGEMENT, roles.FINANCE, roles.CLIENT_VIEWER];
  if (!roleAllowed(actor, allowed)) {
    deny(res, `Role ${actor?.role || "Unknown"} cannot view invoice documents.`);
    return false;
  }
  return assertClientAccess(req, res, doc.client);
}

function assertPoAccess(req, res, doc) {
  const actor = getActor(req);
  const allowed = [roles.ADMIN, roles.MANAGEMENT, roles.FINANCE, roles.OPERATIONS, roles.CLIENT_VIEWER];
  if (!roleAllowed(actor, allowed)) {
    deny(res, `Role ${actor?.role || "Unknown"} cannot view PO documents.`);
    return false;
  }
  return assertClientAccess(req, res, doc.client);
}

function hierarchyForEquipment(db, equipment) {
  const section = equipment ? db.plant_sections.find((item) => item.id === equipment.plant_section_id) : null;
  const plant = section ? db.plants.find((item) => item.id === section.plant_id) : null;
  const mine_site = plant ? db.mine_sites.find((item) => item.id === plant.mine_site_id) : null;
  return { mine_site, plant, section };
}

function findUser(db, id) {
  return id ? db.users.find((user) => user.id === id) || null : null;
}

function findQuoteDoc(db, id) {
  const quote = db.quotes.find((q) => q.id === id);
  if (!quote) return null;
  const client = db.clients.find((c) => c.id === quote.client_id);
  const lines = db.quote_lines.filter((l) => l.quotation_id === quote.id);
  const equipment = db.equipment_tags.find((e) => e.id === quote.equipment_tag_id);
  return { quote, client, lines, equipment, hierarchy: hierarchyForEquipment(db, equipment), company_profile: db.company_profile };
}

function findDispatchDoc(db, id) {
  const job = db.dispatch_cards.find((d) => d.id === id);
  if (!job) return null;
  const quote = db.quotes.find((q) => q.id === job.quotation_id);
  const client = db.clients.find((c) => c.id === quote?.client_id);
  const equipment = db.equipment_tags.find((e) => e.id === job.equipment_tag_id);
  const po = db.purchase_orders.find((p) => p.quotation_id === job.quotation_id);
  const worksheets = db.field_worksheets.filter((worksheet) => worksheet.dispatch_card_id === job.id);
  return {
    job,
    quote,
    client,
    equipment,
    po,
    worksheets,
    hierarchy: hierarchyForEquipment(db, equipment),
    supervisor: findUser(db, job.assigned_supervisor_id),
    company_profile: db.company_profile
  };
}

function findWorksheetDoc(db, id) {
  const worksheet = db.field_worksheets.find((w) => w.id === id);
  if (!worksheet) return null;
  const job = db.dispatch_cards.find((d) => d.id === worksheet.dispatch_card_id);
  const quote = job ? db.quotes.find((q) => q.id === job.quotation_id) : null;
  const client = quote ? db.clients.find((c) => c.id === quote.client_id) : null;
  const equipment = job ? db.equipment_tags.find((e) => e.id === job.equipment_tag_id) : null;
  return {
    worksheet,
    job,
    quote,
    client,
    equipment,
    hierarchy: hierarchyForEquipment(db, equipment),
    technician: findUser(db, worksheet.technician_id),
    approved_by_user: findUser(db, worksheet.approved_by),
    company_profile: db.company_profile
  };
}

function findInvoiceDoc(db, id) {
  const invoice = db.invoices.find((i) => i.id === id);
  if (!invoice) return null;
  const po = db.purchase_orders.find((p) => p.id === invoice.purchase_order_id);
  const job = db.dispatch_cards.find((d) => d.id === invoice.dispatch_card_id);
  const quote = job ? db.quotes.find((q) => q.id === job.quotation_id) : null;
  const client = quote ? db.clients.find((c) => c.id === quote.client_id) : null;
  const equipment = job ? db.equipment_tags.find((e) => e.id === job.equipment_tag_id) : null;
  const lines = db.invoice_lines.filter((l) => l.invoice_id === invoice.id);
  const worksheets = job ? db.field_worksheets.filter((worksheet) => worksheet.dispatch_card_id === job.id && isEligibleForDb(db, worksheet)) : [];
  return {
    invoice,
    po,
    job,
    quote,
    client,
    equipment,
    lines,
    worksheets,
    hierarchy: hierarchyForEquipment(db, equipment),
    generated_by_user: findUser(db, invoice.generated_by),
    company_profile: db.company_profile
  };
}

function findPoDoc(db, id) {
  const po = db.purchase_orders.find((p) => p.id === id);
  if (!po) return null;
  const quote = db.quotes.find((q) => q.id === po.quotation_id);
  const client = quote ? db.clients.find((c) => c.id === quote.client_id) : null;
  return { po, quote, client, company_profile: db.company_profile };
}

export const getQuoteDocument = (req, res) => {
  if (!assertDocumentRole(req, res, [roles.ADMIN, roles.MANAGEMENT, roles.SALES, roles.FINANCE, roles.OPERATIONS, roles.CLIENT_VIEWER], "Role cannot view quote documents.")) return;
  const doc = findQuoteDoc(req.db, req.params.id);
  if (!doc) return res.status(404).json({ success: false, message: "Quote not found." });
  if (!assertQuoteAccess(req, res, doc)) return;
  res.json({ success: true, data: doc });
};

export const getDispatchDocument = (req, res) => {
  if (!assertDocumentRole(req, res, [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR, roles.FINANCE, roles.TECHNICIAN], "Role cannot view job card documents.")) return;
  const doc = findDispatchDoc(req.db, req.params.id);
  if (!doc) return res.status(404).json({ success: false, message: "Dispatch card not found." });
  if (!assertDispatchAccess(req, res, doc)) return;
  res.json({ success: true, data: doc });
};

export const getWorksheetDocument = (req, res) => {
  if (!assertDocumentRole(req, res, [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR, roles.TECHNICIAN, roles.CLIENT_VIEWER], "Role cannot view worksheet documents.")) return;
  const doc = findWorksheetDoc(req.db, req.params.id);
  if (!doc) return res.status(404).json({ success: false, message: "Timesheet not found." });
  if (!assertWorksheetAccess(req, res, doc)) return;
  if (getActor(req).role === roles.CLIENT_VIEWER && !isEligibleForDb(req.db, doc.worksheet)) {
    return res.status(409).json({ success: false, message: "Client completion document requires a supervisor-approved worksheet." });
  }
  res.json({ success: true, data: doc });
};

export const getInvoiceDocument = (req, res) => {
  if (!assertDocumentRole(req, res, [roles.ADMIN, roles.MANAGEMENT, roles.FINANCE, roles.CLIENT_VIEWER], "Role cannot view invoice documents.")) return;
  const doc = findInvoiceDoc(req.db, req.params.id);
  if (!doc) return res.status(404).json({ success: false, message: "Invoice not found." });
  if (!assertInvoiceAccess(req, res, doc)) return;
  if (!doc.po || doc.po.status !== "verified" || !String(doc.po.po_reference || "").trim()) {
    return res.status(409).json({ success: false, message: "Invoice document blocked: no verified PO reference on file." });
  }
  if (doc.po.requires_amendment) {
    return res.status(409).json({ success: false, message: "Invoice document blocked: PO amendment is required." });
  }
  if (doc.worksheets.length === 0) {
    return res.status(409).json({ success: false, message: "Invoice document blocked: supervisor-approved timesheet is required." });
  }
  res.json({ success: true, data: doc });
};

export const getPoDocument = (req, res) => {
  if (!assertDocumentRole(req, res, [roles.ADMIN, roles.MANAGEMENT, roles.FINANCE, roles.OPERATIONS, roles.CLIENT_VIEWER], "Role cannot view PO documents.")) return;
  const doc = findPoDoc(req.db, req.params.id);
  if (!doc) return res.status(404).json({ success: false, message: "Purchase order not found." });
  if (!assertPoAccess(req, res, doc)) return;
  res.json({ success: true, data: doc });
};

// --- Printable PDF endpoints ---
//
// Every helper below builds a plain "model" object (see pdfGenerator.js for
// the shape) out of real, already-authorized record data only. A field that
// the current record genuinely does not have is passed through as an
// explicit `{ value: "...", placeholder: true }` entry rather than being
// invented or silently dropped - the renderer then draws it in italic with
// a distinct color so a reader can tell "recorded as blank/pending" apart
// from "this renderer lost the data". No commercial figure, legal wording,
// tax treatment, or payment term is asserted here unless it comes directly
// from a real field on the record.

const FALLBACK_COMPANY = { name: "Orac Systems", legalName: "Handon Enterprises (Pvt) Ltd" };

// Exported so other controllers producing controlled PDFs (e.g. the
// Chat B Timesheet period pack) can reuse the same company header instead
// of duplicating the fallback logic.
export function companyFromProfile(company_profile) {
  return {
    name: company_profile?.company_name || FALLBACK_COMPANY.name,
    legalName: company_profile?.legal_name || FALLBACK_COMPANY.legalName,
    brandPrimary: company_profile?.brand_primary
  };
}

function hierarchyValue(hierarchy) {
  const parts = [hierarchy?.mine_site?.name, hierarchy?.plant?.name, hierarchy?.section?.name].filter(Boolean);
  return parts.length ? { value: parts.join(" > ") } : { value: "Not recorded", placeholder: true };
}

function clientValue(client) {
  return client?.name ? { value: client.name } : { value: "Not recorded", placeholder: true };
}

function refValue(value, label) {
  return value ? { value: String(value) } : { value: `${label || "Not"} assigned`, placeholder: true };
}

function nameOrPending(user, pendingLabel = "Pending") {
  return user?.name ? { value: user.name } : { value: pendingLabel, placeholder: true };
}

const CONTROLLED_NOTE = "Controlled record generated by Orac-IOS. Not valid if altered outside the system.";

function quoteLineRows(lines) {
  return (lines || []).map((l) => [
    l.description || "",
    String(l.quantity ?? ""),
    formatCurrency(l.unit_price),
    formatCurrency(l.line_total ?? (Number(l.quantity) || 0) * (Number(l.unit_price) || 0))
  ]);
}

const LINE_ITEM_COLUMNS = [
  { label: "Description", weight: 4 },
  { label: "Qty", weight: 1, align: "right" },
  { label: "Unit Price", weight: 1.4, align: "right" },
  { label: "Line Total", weight: 1.4, align: "right" }
];

function sendControlledPdf(res, model) {
  res.type("application/pdf").send(generateControlledPdf(model));
}

export const getQuotePdf = (req, res) => {
  if (!assertDocumentRole(req, res, [roles.ADMIN, roles.MANAGEMENT, roles.SALES, roles.FINANCE, roles.OPERATIONS, roles.CLIENT_VIEWER], "Role cannot view quote documents.")) return;
  const doc = findQuoteDoc(req.db, req.params.id);
  if (!doc) return res.status(404).json({ success: false, message: "Quote not found." });
  if (!assertQuoteAccess(req, res, doc)) return;

  const q = doc.quote;

  // --- Build work-package-grouped line items ---
  const workPackages = q.work_packages || [];
  const wpMap = new Map(workPackages.map((wp) => [wp.id, wp.title || wp.name || wp.id]));

  // Group lines by work_package_id
  const linesByWp = new Map();
  for (const line of doc.lines) {
    const wpId = line.work_package_id || "wp_01";
    if (!linesByWp.has(wpId)) linesByWp.set(wpId, []);
    linesByWp.get(wpId).push(line);
  }

  // Build sections array
  const sections = [];

  // Site Reference
  sections.push({
    type: "keyvalue",
    heading: "Site Reference",
    items: [{ label: "Location", ...hierarchyValue(doc.hierarchy) }]
  });

  // Scope Summary (if present)
  if (q.scope_summary) {
    sections.push({
      type: "paragraph",
      heading: "Scope of Work",
      text: q.scope_summary
    });
  }

  // Assumptions (if present)
  if (q.assumptions) {
    sections.push({
      type: "paragraph",
      heading: "Assumptions & Exclusions",
      text: q.assumptions
    });
  }

  // Line item columns — 7-column controlled quotation layout
  const QUOTE_LINE_COLUMNS = [
    { label: "Type", weight: 1 },
    { label: "Role / Resource", weight: 1.5 },
    { label: "Description", weight: 3 },
    { label: "Qty", weight: 0.7, align: "right" },
    { label: "UoM", weight: 0.8 },
    { label: "Rate (USD)", weight: 1.2, align: "right" },
    { label: "Total (USD)", weight: 1.2, align: "right" }
  ];

  // Emit a table per work package
  for (const [wpId, wpLines] of linesByWp) {
    const wpName = wpMap.get(wpId) || wpId;
    const rows = wpLines.map((l) => {
      const unitPrice = Number.isInteger(l.unit_price_cents) ? fromCents(l.unit_price_cents) : Number(l.unit_price || 0);
      const lineTotal = Number.isInteger(l.line_total_cents) ? fromCents(l.line_total_cents) : Number(l.line_total ?? (Number(l.quantity) || 0) * unitPrice);
      return [
        l.cost_type || "material",
        l.resource_role || "-",
        l.description || "",
        String(l.quantity ?? ""),
        l.unit_of_measure || "each",
        formatCurrency(unitPrice),
        formatCurrency(lineTotal)
      ];
    });

    const wpSubtotalCents = wpLines.reduce((sum, l) => {
      if (Number.isInteger(l.line_total_cents)) return sum + l.line_total_cents;
      const unitPrice = Number.isInteger(l.unit_price_cents) ? fromCents(l.unit_price_cents) : Number(l.unit_price || 0);
      const lineTotal = Number(l.line_total ?? (Number(l.quantity) || 0) * unitPrice);
      return sum + Math.round(lineTotal * 100);
    }, 0);

    sections.push({
      type: "table",
      heading: linesByWp.size > 1 ? `Work Package: ${wpName}` : "Line Items",
      columns: QUOTE_LINE_COLUMNS,
      rows: rows,
      emptyMessage: "No line items in this work package.",
      totalsRow: rows.length ? [null, null, null, null, null, "Subtotal", formatCurrency(wpSubtotalCents / 100)] : null
    });
  }

  // If no lines at all, show empty table
  if (linesByWp.size === 0) {
    sections.push({
      type: "table",
      heading: "Line Items",
      columns: QUOTE_LINE_COLUMNS,
      rows: [],
      emptyMessage: "No line items recorded for this quotation."
    });
  }

  // --- Commercial Summary ---
  const preTaxCents = Number.isInteger(q.pre_tax_total_cents) ? q.pre_tax_total_cents : Math.round(Number(q.total_amount || 0) * 100);
  const discountPercent = Number(q.discount_percent || 0);
  const discountCents = Number.isInteger(q.discount_cents) ? q.discount_cents : Math.round(preTaxCents * (discountPercent / 100));
  const netSubtotalCents = Number.isInteger(q.net_subtotal_cents) ? q.net_subtotal_cents : Math.max(0, preTaxCents - discountCents);
  const taxTotalCents = Number.isInteger(q.tax_total_cents) ? q.tax_total_cents : 0;
  const grandTotalCents = Number.isInteger(q.grand_total_cents) ? q.grand_total_cents : (netSubtotalCents + taxTotalCents);
  const taxStatus = q.tax_status || "unconfigured";
  const appliedTaxRate = q.applied_tax_rate;

  const summaryItems = [
    { label: "Subtotal (excl. VAT)", value: formatCurrency(preTaxCents / 100) },
  ];

  if (discountPercent > 0) {
    summaryItems.push({ label: `Discount (${discountPercent}%)`, value: `-${formatCurrency(discountCents / 100)}` });
    summaryItems.push({ label: "Net Subtotal", value: formatCurrency(netSubtotalCents / 100) });
  }

  // Tax line
  if (taxStatus === "taxable" || taxStatus === "provisional") {
    const rateLabel = appliedTaxRate != null ? `${Number((appliedTaxRate * 100).toFixed(6))}%` : "TBD";
    summaryItems.push({ label: `VAT @ ${rateLabel}`, value: formatCurrency(taxTotalCents / 100) });
  } else if (taxStatus === "zero-rated") {
    summaryItems.push({ label: "VAT (Zero-Rated)", value: formatCurrency(0) });
  } else if (taxStatus === "exempt") {
    summaryItems.push({ label: "VAT (Exempt)", value: formatCurrency(0) });
  } else {
    summaryItems.push({ label: "VAT", value: "Not configured", placeholder: true });
  }

  summaryItems.push({ label: "Grand Total (USD)", value: formatCurrency(grandTotalCents / 100) });

  sections.push({
    type: "keyvalue",
    heading: "Commercial Summary",
    items: summaryItems
  });

  // --- Tax Treatment Notice ---
  if (taxStatus === "provisional") {
    sections.push({
      type: "notice",
      tone: "warning",
      text: PROVISIONAL_VAT_NOTICE
    });
  } else if (taxStatus === "unconfigured") {
    sections.push({
      type: "notice",
      tone: "warning",
      text: "Tax treatment has not been configured for this quotation."
    });
  }

  // --- Commercial Terms & Conditions ---
  const validityDays = q.validity_days || 30;
  const termsText = [
    `This quotation is valid for ${validityDays} calendar days from the date of issue.`,
    "All prices are quoted in United States Dollars (USD).",
    "Payment terms are as per the governing purchase order or contract.",
    "Scope changes after acceptance may result in a revised quotation.",
    "This quotation is subject to the standard terms and conditions of Orac Systems."
  ].join(" ");

  sections.push({
    type: "paragraph",
    heading: "Commercial Terms & Conditions",
    text: termsText
  });

  // --- Dual Signoff ---
  sections.push({
    type: "signoff",
    boxes: [
      { label: "Orac Systems — Authorised Signatory" },
      { label: "Client Acceptance — Authorised Signatory" }
    ]
  });

  // --- Build header meta ---
  const taxStatusLabel = taxStatus === "provisional" ? "Provisional"
    : taxStatus === "taxable" ? "Taxable"
    : taxStatus === "zero-rated" ? "Zero-Rated"
    : taxStatus === "exempt" ? "Exempt"
    : "Not Configured";

  const headerMeta = [
    { label: "Prepared", ...(humanizeTimestamp(q.created_at) ? { value: humanizeTimestamp(q.created_at) } : { value: "Not recorded", placeholder: true }) },
    { label: "Client", ...clientValue(doc.client) },
    { label: "Equipment Tag", ...refValue(doc.equipment?.tag_code, "No tag") },
    { label: "Validity", value: `${validityDays} days from issue` },
    { label: "Currency", value: "USD" },
    { label: "Tax Treatment", value: taxStatusLabel }
  ];

  const model = {
    documentType: "QUOTATION",
    documentTypeLabel: "Controlled Quotation",
    documentNumber: q.quote_number || null,
    status: q.status || "Draft",
    company: companyFromProfile(doc.company_profile),
    generatedAtLabel: "Generated",
    generatedAt: humanizeTimestamp(new Date().toISOString()),
    controlledNote: CONTROLLED_NOTE,
    headerMeta,
    sections
  };
  sendControlledPdf(res, model);
};

export const getJobCardPdf = (req, res) => {
  if (!assertDocumentRole(req, res, [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR, roles.FINANCE, roles.TECHNICIAN], "Role cannot view job card documents.")) return;
  const doc = findDispatchDoc(req.db, req.params.id);
  if (!doc) return res.status(404).json({ success: false, message: "Job Card not found." });
  if (!assertDispatchAccess(req, res, doc)) return;

  const dispatchReference = doc.job.dispatch_number || doc.job.id;
  const quoteLines = doc.quote ? req.db.quote_lines.filter((l) => l.quotation_id === doc.quote.id) : [];
  const scopeText = quoteLines.length
    ? quoteLines.map((l) => `${l.description} (qty ${l.quantity})`).join("; ")
    : "";

  const model = {
    documentType: "JOB_CARD",
    documentTypeLabel: "Job Card",
    documentNumber: dispatchReference,
    status: doc.job.status || "Unknown",
    company: companyFromProfile(doc.company_profile),
    generatedAtLabel: "Generated",
    generatedAt: humanizeTimestamp(new Date().toISOString()),
    controlledNote: CONTROLLED_NOTE,
    headerMeta: [
      { label: "Client", ...clientValue(doc.client) },
      { label: "Equipment Tag", ...refValue(doc.equipment?.tag_code, "No tag") },
      { label: "Urgency", value: doc.job.started_before_po ? "URGENT" : "Normal" }
    ],
    sections: [
      {
        type: "keyvalue",
        heading: "Dispatch Details",
        items: [
          { label: "Location", ...hierarchyValue(doc.hierarchy) },
          { label: "Site Contact", ...refValue(doc.job.site_contact, "Not") },
          { label: "Supervisor", ...nameOrPending(doc.supervisor) },
          { label: "PO Reference", ...refValue(doc.po?.po_reference, "Pending") },
          { label: "Scheduled Start", value: humanizeTimestamp(doc.job.scheduled_start) || "Not recorded", placeholder: !doc.job.scheduled_start }
        ]
      },
      doc.job.started_before_po
        ? { type: "paragraph", heading: "Urgent Dispatch Reason", text: doc.job.urgent_reason, placeholder: !doc.job.urgent_reason }
        : null,
      {
        type: "paragraph",
        heading: "Scope of Work",
        text: scopeText,
        placeholder: !scopeText
      },
      { type: "signoff", boxes: [{ label: "Technician Signoff" }, { label: "Supervisor Signoff" }] }
    ].filter(Boolean)
  };
  sendControlledPdf(res, model);
};

export const getWorksheetPdf = (req, res) => {
  if (!assertDocumentRole(req, res, [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR, roles.TECHNICIAN, roles.CLIENT_VIEWER], "Role cannot view worksheet documents.")) return;
  const doc = findWorksheetDoc(req.db, req.params.id);
  if (!doc) return res.status(404).json({ success: false, message: "Timesheet not found." });
  if (!assertWorksheetAccess(req, res, doc)) return;
  if (getActor(req).role === roles.CLIENT_VIEWER && !isEligibleForDb(req.db, doc.worksheet)) {
    return res.status(409).json({ success: false, message: "Client completion document requires a supervisor-approved worksheet." });
  }

  const worksheetReference = doc.worksheet.worksheet_reference || doc.worksheet.id;
  const activity = doc.worksheet.activity_description || doc.worksheet.activity;
  const hours = doc.worksheet.hours_logged ?? doc.worksheet.hours;
  const workDate = doc.worksheet.date_logged || doc.worksheet.work_date;
  const jobReference = doc.job?.dispatch_number || doc.job?.id;

  const model = {
    documentType: "FIELD_WORKSHEET",
    documentTypeLabel: "Field Worksheet",
    documentNumber: worksheetReference,
    status: doc.worksheet.status || "Unknown",
    company: companyFromProfile(doc.company_profile),
    generatedAtLabel: "Generated",
    generatedAt: humanizeTimestamp(new Date().toISOString()),
    controlledNote: CONTROLLED_NOTE,
    headerMeta: [
      { label: "Client", ...clientValue(doc.client) },
      { label: "Job Card Ref", ...refValue(jobReference, "Not") },
      { label: "Date", value: humanizeTimestamp(workDate) || "Not recorded", placeholder: !workDate }
    ],
    sections: [
      {
        type: "keyvalue",
        heading: "Worksheet Details",
        items: [
          { label: "Technician", ...nameOrPending(doc.technician) },
          { label: "Hours Logged", value: hours !== undefined && hours !== null ? String(hours) : "Not recorded", placeholder: hours === undefined || hours === null },
          { label: "Approved By", ...nameOrPending(doc.approved_by_user) },
          { label: "Location", ...hierarchyValue(doc.hierarchy) }
        ]
      },
      { type: "paragraph", heading: "Work Completed", text: activity, placeholder: !activity },
      doc.worksheet.supervisor_comment
        ? { type: "paragraph", heading: "Supervisor Comment", text: doc.worksheet.supervisor_comment }
        : null,
      // Digital client acknowledgement recorded by the system (authenticated
      // Client Viewer, typed name and role, timestamp, evidence reference). It is
      // printed as evidence and never replaces the ink signature boxes below.
      doc.worksheet.client_acknowledgement
        ? {
            type: "keyvalue",
            heading: "Client Acknowledgement (recorded digitally)",
            items: [
              { label: "Signed By", ...refValue(doc.worksheet.client_acknowledgement.signer_name, "Not") },
              { label: "Signer Role", ...refValue(doc.worksheet.client_acknowledgement.signer_role, "Not") },
              { label: "Acknowledged At", value: humanizeTimestamp(doc.worksheet.client_acknowledgement.acknowledged_at) || "Not recorded", placeholder: !doc.worksheet.client_acknowledgement.acknowledged_at },
              { label: "Evidence Reference", ...refValue(doc.worksheet.client_acknowledgement.evidence_reference, "Not") }
            ]
          }
        : null,
      { type: "signoff", boxes: [{ label: "Technician Signature" }, { label: "Client / Supervisor Signature" }] }
    ].filter(Boolean)
  };
  sendControlledPdf(res, model);
};

export const getInvoicePdf = (req, res) => {
  if (!assertDocumentRole(req, res, [roles.ADMIN, roles.MANAGEMENT, roles.FINANCE, roles.CLIENT_VIEWER], "Role cannot view invoice documents.")) return;
  const doc = findInvoiceDoc(req.db, req.params.id);
  if (!doc) return res.status(404).json({ success: false, message: "Invoice not found." });
  if (!assertInvoiceAccess(req, res, doc)) return;

  // Invoice guards - unchanged from the original controller.
  if (!doc.po || doc.po.status !== "verified" || !String(doc.po.po_reference || "").trim()) {
    return res.status(409).json({ success: false, message: "Invoice document blocked: no verified PO reference on file." });
  }
  if (doc.po.requires_amendment) {
    return res.status(409).json({ success: false, message: "Invoice document blocked: PO amendment is required." });
  }
  if (doc.worksheets.length === 0) {
    return res.status(409).json({ success: false, message: "Invoice document blocked: supervisor-approved timesheet is required." });
  }

  const jobReference = doc.job?.dispatch_number || doc.job?.id;
  const isVoided = String(doc.invoice.status || "").toLowerCase() === "voided";
  const lineRows = quoteLineRows(doc.lines);

  const model = {
    documentType: "INVOICE",
    documentTypeLabel: "Invoice",
    documentNumber: doc.invoice.invoice_number || null,
    status: doc.invoice.status || "Unknown",
    company: companyFromProfile(doc.company_profile),
    generatedAtLabel: "Generated",
    generatedAt: humanizeTimestamp(new Date().toISOString()),
    controlledNote: CONTROLLED_NOTE,
    headerMeta: [
      {
        label: "Invoice Date",
        value: humanizeTimestamp(doc.invoice.created_at || doc.invoice.generated_at) || "Not recorded",
        placeholder: !(doc.invoice.created_at || doc.invoice.generated_at)
      },
      { label: "Client", ...clientValue(doc.client) },
      { label: "PO Reference", value: doc.po.po_reference }
    ],
    sections: [
      { type: "keyvalue", heading: "References", items: [{ label: "Job Reference", ...refValue(jobReference, "Not") }] },
      {
        type: "table",
        heading: "Line Items",
        columns: LINE_ITEM_COLUMNS,
        rows: lineRows,
        emptyMessage: "No invoice lines recorded.",
        totalsRow: [null, null, "Total Due", formatCurrency(doc.invoice.total_amount)]
      },
      // No payment-terms figure is asserted here: the data model has no
      // payment-terms field on invoices (confirmed against schemas.js /
      // stateMachine.js), so the original renderer's fixed "Strictly 30
      // days from invoice date" line was a fabricated commercial claim,
      // not real data. This placeholder makes that gap visible instead.
      {
        type: "paragraph",
        heading: "Payment Terms",
        text: "Not recorded in this system. Refer to the governing purchase order or contract.",
        placeholder: true
      },
      isVoided ? { type: "notice", tone: "danger", text: "VOIDED" } : null
    ].filter(Boolean)
  };
  sendControlledPdf(res, model);
};

export const getPoDocumentPdf = (req, res) => {
  if (!assertDocumentRole(req, res, [roles.ADMIN, roles.MANAGEMENT, roles.FINANCE, roles.OPERATIONS, roles.CLIENT_VIEWER], "Role cannot view PO documents.")) return;
  const doc = findPoDoc(req.db, req.params.id);
  if (!doc) return res.status(404).json({ success: false, message: "Purchase order not found." });
  if (!assertPoAccess(req, res, doc)) return;

  const model = {
    documentType: "PURCHASE_ORDER",
    documentTypeLabel: "Purchase Order",
    documentNumber: doc.po.po_reference || null,
    status: doc.po.status || "Unknown",
    company: companyFromProfile(doc.company_profile),
    generatedAtLabel: "Generated",
    generatedAt: humanizeTimestamp(new Date().toISOString()),
    controlledNote: CONTROLLED_NOTE,
    headerMeta: [
      { label: "Quote Number", ...refValue(doc.quote?.quote_number, "Not linked") },
      { label: "Client", ...clientValue(doc.client) },
      { label: "PO Amount", value: formatCurrency(doc.po.po_amount) }
    ],
    sections: [
      {
        type: "keyvalue",
        heading: "Amendment Status",
        items: [{ label: "Amendment Required", value: doc.po.requires_amendment ? "YES" : "No" }]
      }
    ]
  };
  sendControlledPdf(res, model);
};
