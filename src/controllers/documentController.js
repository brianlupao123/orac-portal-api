import { roles } from "../permissions.js";
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
    if (!assignedWorksheet && doc.job.assigned_technician_id !== actor.id) {
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
  const worksheets = job ? db.field_worksheets.filter((worksheet) => worksheet.dispatch_card_id === job.id && worksheet.status === "Supervisor_Approved") : [];
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
  if (!doc) return res.status(404).json({ success: false, message: "Worksheet not found." });
  if (!assertWorksheetAccess(req, res, doc)) return;
  if (getActor(req).role === roles.CLIENT_VIEWER && doc.worksheet.status !== "Supervisor_Approved") {
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
    return res.status(409).json({ success: false, message: "Invoice document blocked: supervisor-approved worksheet is required." });
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

function companyFromProfile(company_profile) {
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

  const lineRows = quoteLineRows(doc.lines);
  const model = {
    documentType: "QUOTATION",
    documentTypeLabel: "Quotation",
    documentNumber: doc.quote.quote_number || null,
    status: doc.quote.status || "Draft",
    company: companyFromProfile(doc.company_profile),
    generatedAtLabel: "Generated",
    generatedAt: humanizeTimestamp(new Date().toISOString()),
    controlledNote: CONTROLLED_NOTE,
    headerMeta: [
      { label: "Prepared", ...(humanizeTimestamp(doc.quote.created_at) ? { value: humanizeTimestamp(doc.quote.created_at) } : { value: "Not recorded", placeholder: true }) },
      { label: "Client", ...clientValue(doc.client) },
      { label: "Equipment Tag", ...refValue(doc.equipment?.tag_code, "No tag") }
    ],
    sections: [
      { type: "keyvalue", heading: "Site Reference", items: [{ label: "Location", ...hierarchyValue(doc.hierarchy) }] },
      {
        type: "table",
        heading: "Line Items",
        columns: LINE_ITEM_COLUMNS,
        rows: lineRows,
        emptyMessage: "No line items recorded for this quotation.",
        totalsRow: lineRows.length ? [null, null, "Total", formatCurrency(doc.quote.total_amount)] : null
      }
    ]
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
  if (!doc) return res.status(404).json({ success: false, message: "Worksheet not found." });
  if (!assertWorksheetAccess(req, res, doc)) return;
  if (getActor(req).role === roles.CLIENT_VIEWER && doc.worksheet.status !== "Supervisor_Approved") {
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
    return res.status(409).json({ success: false, message: "Invoice document blocked: supervisor-approved worksheet is required." });
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
