import { roles } from "../permissions.js";
import { generatePdfBuffer } from "../pdfGenerator.js";

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

// --- Printable PDF (HTML Fallback) Endpoints ---

const BRAND_NAME = "Orac Systems";
const BRAND_LEGAL = "Handon Enterprises (Pvt) Ltd";
const BRAND_PRIMARY = "#6EC1E4";
const BRAND_SLATE = "#54595F";

function esc(str) { return String(str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function currency(n) { return "$" + Number(n || 0).toFixed(2); }
function hierarchyText(h) { return [h?.mine_site?.name, h?.plant?.name, h?.section?.name].filter(Boolean).map(esc).join(" &rarr; ") || "N/A"; }

function sendPdf(res, title, content) {
  res.type("application/pdf").send(generatePdfBuffer(title, BRAND_NAME, BRAND_LEGAL, content));
}

export const getQuotePdf = (req, res) => {
  if (!assertDocumentRole(req, res, [roles.ADMIN, roles.MANAGEMENT, roles.SALES, roles.FINANCE, roles.OPERATIONS, roles.CLIENT_VIEWER], "Role cannot view quote documents.")) return;
  const doc = findQuoteDoc(req.db, req.params.id);
  if (!doc) return res.status(404).json({ success: false, message: "Quote not found." });
  if (!assertQuoteAccess(req, res, doc)) return;

  const content = `
    <div class="details-grid">
      <div><span class="detail-label">Quote Number:</span> ${esc(doc.quote.quote_number)}</div>
      <div><span class="detail-label">Status:</span> ${esc(doc.quote.status)}</div>
      <div><span class="detail-label">Prepared Date:</span> ${esc(doc.quote.created_at)}</div>
      <div><span class="detail-label">Client:</span> ${esc(doc.client?.name)}</div>
      <div><span class="detail-label">Equipment Tag:</span> ${esc(doc.equipment?.tag_code)}</div>
      <div><span class="detail-label">Location:</span> ${hierarchyText(doc.hierarchy)}</div>
    </div>
    <table>
      <thead>
        <tr>
          <th>Description</th>
          <th>Qty</th>
          <th>Unit Price</th>
          <th>Line Total</th>
        </tr>
      </thead>
      <tbody>
        ${doc.lines.map(l => `
          <tr>
            <td>${esc(l.description)}</td>
            <td>${esc(l.quantity)}</td>
            <td>${currency(l.unit_price)}</td>
            <td>${currency(l.quantity * l.unit_price)}</td>
          </tr>
        `).join("")}
        <tr class="total-row">
          <td colspan="3" style="text-align: right">Total</td>
          <td>${currency(doc.quote.total_amount)}</td>
        </tr>
      </tbody>
    </table>
  `;
  sendPdf(res, "Quotation " + esc(doc.quote.quote_number), content);
};

export const getJobCardPdf = (req, res) => {
  if (!assertDocumentRole(req, res, [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR, roles.FINANCE, roles.TECHNICIAN], "Role cannot view job card documents.")) return;
  const doc = findDispatchDoc(req.db, req.params.id);
  if (!doc) return res.status(404).json({ success: false, message: "Job Card not found." });
  if (!assertDispatchAccess(req, res, doc)) return;

  const dispatchReference = doc.job.dispatch_reference || doc.job.dispatch_number || doc.job.id;
  const content = `
    <div class="details-grid">
      <div><span class="detail-label">Dispatch Reference:</span> ${esc(dispatchReference)}</div>
      <div><span class="detail-label">Status:</span> ${esc(doc.job.status)}</div>
      <div><span class="detail-label">Urgency:</span> ${doc.job.started_before_po ? "URGENT" : "Normal"}</div>
      <div><span class="detail-label">Client:</span> ${esc(doc.client?.name)}</div>
      <div><span class="detail-label">Location:</span> ${hierarchyText(doc.hierarchy)}</div>
      <div><span class="detail-label">Equipment:</span> ${esc(doc.equipment?.tag_code)}</div>
      <div><span class="detail-label">Supervisor:</span> ${esc(doc.supervisor?.name || "Pending")}</div>
      <div><span class="detail-label">PO Reference:</span> ${esc(doc.po?.po_reference || "Pending")}</div>
    </div>
    <div style="margin-bottom: 20px;">
      <div class="detail-label">Scope of Work:</div>
      <p>${esc(doc.job.notes)}</p>
    </div>
    <div style="margin-bottom: 20px; border: 1px solid #ccc; padding: 10px; min-height: 100px;">
      <div class="detail-label" style="color: #ccc;">Safety / Field Notes</div>
    </div>
    <div class="signoff-area">
      <div class="sign-box">
        <div class="sign-line"></div>
        <div>Technician Signoff</div>
      </div>
      <div class="sign-box">
        <div class="sign-line"></div>
        <div>Supervisor Signoff</div>
      </div>
    </div>
  `;
  sendPdf(res, "Job Card " + esc(dispatchReference), content);
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
  const content = `
    <div class="details-grid">
      <div><span class="detail-label">Worksheet Ref:</span> ${esc(worksheetReference)}</div>
      <div><span class="detail-label">Job Card Ref:</span> ${esc(doc.job?.dispatch_reference)}</div>
      <div><span class="detail-label">Technician:</span> ${esc(doc.technician?.name)}</div>
      <div><span class="detail-label">Date:</span> ${esc(workDate)}</div>
      <div><span class="detail-label">Status:</span> ${esc(doc.worksheet.status)}</div>
      <div><span class="detail-label">Client:</span> ${esc(doc.client?.name)}</div>
    </div>
    <div style="margin-bottom: 20px;">
      <div class="detail-label">Work Completed:</div>
      <p>${esc(activity)}</p>
    </div>
    <div class="details-grid">
      <div><span class="detail-label">Hours Logged:</span> ${esc(hours)}</div>
      <div><span class="detail-label">Approved By:</span> ${esc(doc.approved_by_user?.name || "Pending")}</div>
    </div>
    <div class="signoff-area">
      <div class="sign-box">
        <div class="sign-line"></div>
        <div>Technician Signature</div>
      </div>
      <div class="sign-box">
        <div class="sign-line"></div>
        <div>Client / Supervisor Signature</div>
      </div>
    </div>
  `;
  sendPdf(res, "Field Worksheet " + esc(worksheetReference), content);
};

export const getInvoicePdf = (req, res) => {
  if (!assertDocumentRole(req, res, [roles.ADMIN, roles.MANAGEMENT, roles.FINANCE, roles.CLIENT_VIEWER], "Role cannot view invoice documents.")) return;
  const doc = findInvoiceDoc(req.db, req.params.id);
  if (!doc) return res.status(404).json({ success: false, message: "Invoice not found." });
  if (!assertInvoiceAccess(req, res, doc)) return;

  // Invoice guards
  if (!doc.po || doc.po.status !== "verified" || !String(doc.po.po_reference || "").trim()) {
    return res.status(409).json({ success: false, message: "Invoice document blocked: no verified PO reference on file." });
  }
  if (doc.po.requires_amendment) {
    return res.status(409).json({ success: false, message: "Invoice document blocked: PO amendment is required." });
  }
  if (doc.worksheets.length === 0) {
    return res.status(409).json({ success: false, message: "Invoice document blocked: supervisor-approved worksheet is required." });
  }

  const content = `
    <div class="details-grid">
      <div><span class="detail-label">Invoice Number:</span> ${esc(doc.invoice.invoice_number)}</div>
      <div><span class="detail-label">Invoice Date:</span> ${esc(doc.invoice.created_at || doc.invoice.generated_at)}</div>
      <div><span class="detail-label">Client:</span> ${esc(doc.client?.name)}</div>
      <div><span class="detail-label">PO Reference:</span> ${esc(doc.po.po_reference)}</div>
      <div><span class="detail-label">Job Reference:</span> ${esc(doc.job?.dispatch_reference || doc.job?.dispatch_number || doc.job?.id)}</div>
    </div>
    <table>
      <thead>
        <tr>
          <th>Description</th>
          <th>Qty</th>
          <th>Unit Price</th>
          <th>Line Total</th>
        </tr>
      </thead>
      <tbody>
        ${doc.lines.map(l => `
          <tr>
            <td>${esc(l.description)}</td>
            <td>${esc(l.quantity)}</td>
            <td>${currency(l.unit_price)}</td>
            <td>${currency(l.quantity * l.unit_price)}</td>
          </tr>
        `).join("")}
        <tr class="total-row">
          <td colspan="3" style="text-align: right">Total Due</td>
          <td>${currency(doc.invoice.total_amount)}</td>
        </tr>
      </tbody>
    </table>
    <div style="margin-top: 20px; font-size: 14px;">
      <strong>Payment Terms:</strong> Strictly 30 days from invoice date.
    </div>
    ${String(doc.invoice.status || "").toLowerCase() === "voided" ? '<div style="margin-top: 16px; font-weight: bold; color: #b42318;">VOIDED</div>' : ""}
  `;
  sendPdf(res, "Invoice " + esc(doc.invoice.invoice_number), content);
};

export const getPoDocumentPdf = (req, res) => {
  if (!assertDocumentRole(req, res, [roles.ADMIN, roles.MANAGEMENT, roles.FINANCE, roles.OPERATIONS, roles.CLIENT_VIEWER], "Role cannot view PO documents.")) return;
  const doc = findPoDoc(req.db, req.params.id);
  if (!doc) return res.status(404).json({ success: false, message: "Purchase order not found." });
  if (!assertPoAccess(req, res, doc)) return;

  const content = `
    <div class="details-grid">
      <div><span class="detail-label">PO Reference:</span> ${esc(doc.po.po_reference)}</div>
      <div><span class="detail-label">Status:</span> ${esc(doc.po.status)}</div>
      <div><span class="detail-label">Quote Number:</span> ${esc(doc.quote?.quote_number)}</div>
      <div><span class="detail-label">Client:</span> ${esc(doc.client?.name)}</div>
      <div><span class="detail-label">PO Amount:</span> ${currency(doc.po.po_amount)}</div>
      <div><span class="detail-label">Amendment Required:</span> ${doc.po.requires_amendment ? "YES" : "No"}</div>
    </div>
  `;
  sendPdf(res, "Purchase Order " + esc(doc.po.po_reference), content);
};
