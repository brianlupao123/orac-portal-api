// Governed workflow knowledge for the providerless, deterministic, read-only
// ORAC assistant (Task 04).
//
// WHAT THIS IS
//   A static, versioned catalog of workflow guidance. Every statement below is
//   derived from an ENFORCING source file named in the article's `sources`
//   list (permissions.js, stateMachine.js, controllers). It contains no live
//   data: counts and statuses always come from the caller's role-scoped
//   summary (buildScopedSummary) at request time.
//
// WHAT THIS IS NOT
//   * It is not owner-approved policy. The Markdown articles under
//     knowledge-base/ are still Draft, so the assistant labels this catalog
//     "code-derived, owner approval pending" on every answer.
//   * It is not an authorization source. Route/controller checks stay
//     authoritative; a role appearing in `roleParts` only decides which
//     guidance is shown, never whether an action is allowed.
//   * It contains no business policy that the code does not enforce (no
//     thresholds, tax, currency, warehouse or approval limits).
//
// Maintenance rule: when the enforcing source changes, bump the article
// `version` and CATALOG_VERSION in the same commit. A test checks that every
// role named here still exists and that destinations mirror the permissions.

import { hasPermission, permissions, roles } from "../permissions.js";

export const CATALOG_VERSION = "1.0.1";
export const CATALOG_SOURCE_BASELINE = "orac-portal-api@855620dfd95374aac3eb00248acd37450bd1cc49";
export const APPROVAL_STATE = "Code-derived from enforcing source; owner approval pending";

const R = roles;
const ALL_ROLES = Object.freeze(Object.values(R));

// Screens the assistant may link to. `path` must equal a frontend route in
// src/accessPolicy.js ROUTE_ACCESS; `roles` mirrors that table exactly and
// `requires` (where one permission maps exactly) is re-checked on the server.
export const DESTINATIONS = Object.freeze({
  dashboard: { path: "/", label: "Dashboard", roles: ALL_ROLES },
  portal: { path: "/portal", label: "Client Portal", roles: [R.CLIENT_VIEWER], requires: "createServiceRequest" },
  serviceRequests: { path: "/service-requests", label: "Service Requests", roles: [R.SALES, R.OPERATIONS], requires: "triageServiceRequests" },
  quotations: { path: "/quotations", label: "Quotations", roles: [R.ADMIN, R.SALES], requires: "createQuote" },
  finance: { path: "/finance", label: "PO & Invoicing", roles: [R.ADMIN, R.FINANCE], requires: "invoice" },
  internalRequests: { path: "/internal-requests", label: "Internal Requests", roles: [R.ADMIN, R.MANAGEMENT, R.SALES, R.FINANCE, R.OPERATIONS, R.SUPERVISOR, R.TECHNICIAN] },
  worksheets: { path: "/worksheets", label: "Timesheets", roles: [R.ADMIN, R.MANAGEMENT, R.OPERATIONS, R.SUPERVISOR, R.TECHNICIAN] },
  kiosk: { path: "/kiosk", label: "Kiosk Mode", roles: [R.ADMIN, R.MANAGEMENT, R.OPERATIONS, R.SUPERVISOR] },
  inventory: { path: "/inventory", label: "Inventory", roles: [R.ADMIN, R.MANAGEMENT, R.OPERATIONS], requires: "manageInventory" },
  reports: { path: "/reports", label: "Reports", roles: [R.ADMIN, R.MANAGEMENT, R.OPERATIONS, R.SUPERVISOR, R.SALES, R.FINANCE] },
  jobCards: { path: "/job-cards", label: "Job Cards", roles: [R.ADMIN, R.MANAGEMENT, R.OPERATIONS, R.SUPERVISOR, R.TECHNICIAN], requires: "viewDispatchJobCard" },
  operationalData: { path: "/operational-data", label: "Operational Data", roles: [R.ADMIN, R.MANAGEMENT, R.OPERATIONS, R.SUPERVISOR, R.TECHNICIAN, R.SALES, R.FINANCE] },
  documents: { path: "/documents", label: "Documents", roles: ALL_ROLES },
  contracts: { path: "/contracts", label: "Contracts", roles: [R.ADMIN, R.MANAGEMENT, R.OPERATIONS, R.CLIENT_VIEWER], requires: "viewContracts" },
  admin: { path: "/admin", label: "Administration", roles: [R.ADMIN, R.MANAGEMENT, R.OPERATIONS] }
});

// Authorize a destination for an ACTOR (server-side). Returns a link object or
// null. The frontend independently re-checks canAccessRoute before rendering.
export function authorizeDestination(actor, destinationId) {
  // Own-property check: ids such as "__proto__" or "constructor" must not resolve.
  const destination = typeof destinationId === "string" && Object.hasOwn(DESTINATIONS, destinationId) ? DESTINATIONS[destinationId] : null;
  if (!destination || !actor?.is_active) return null;
  if (!destination.roles.includes(actor.role)) return null;
  if (destination.requires && !hasPermission(actor, destination.requires)) return null;
  return { id: destinationId, path: destination.path, label: destination.label };
}

// Live-evidence metrics that may back a workflow answer, per role. Sales and
// Finance are deliberately absent for worksheet metrics: their scoped summary
// zeroes those keys, and a zero that means "hidden" must never read as "none".
const WORKSHEET_METRICS = ["pending_client_acknowledgement", "pending_supervisor_review", "returned_for_correction"];

export const METRIC_LABELS_EXTRA = Object.freeze({
  pending_client_acknowledgement: "Timesheets awaiting client acknowledgement",
  pending_supervisor_review: "Timesheets awaiting Supervisor review"
});

export const ARTICLES = Object.freeze([
  {
    id: "timesheet-lifecycle",
    version: "1.0",
    title: "Timesheets (field worksheets): submission, client acknowledgement and review",
    keywords: ["timesheet", "timesheets", "time sheet", "worksheet", "worksheets", "work sheet", "hours", "submit", "submitted", "submission", "client_acknowledged", "supervisor_approved", "returned_for_correction", "acknowledge", "acknowledgement", "acknowledgment", "return", "returned", "correction", "resubmit", "approve", "review", "revise", "revision"],
    destination: "worksheets",
    sources: ["src/controllers/dispatchController.js (reviewWorksheet)", "src/controllers/timesheetAcknowledgementController.js", "src/permissions.js"],
    summary: "A Timesheet is a field worksheet. It moves Draft, then Submitted, then Client_Acknowledged, then either Supervisor_Approved or Returned_For_Correction.",
    statuses: [
      ["Draft", "Being prepared; not yet submitted."],
      ["Submitted", "Handed in by the field team. It is waiting for the client representative to acknowledge it. It is not yet eligible for Supervisor review."],
      ["Client_Acknowledged", "The client representative has acknowledged the work. It is now waiting for an independent reviewer."],
      ["Supervisor_Approved", "Approved by an independent reviewer. Only this status counts as approved evidence for invoicing and client completion documents."],
      ["Returned_For_Correction", "Sent back with a reviewer comment. The owner corrects and resubmits it."]
    ],
    evidence: [
      "Approval needs the entry to be Client_Acknowledged.",
      "Returning an entry needs a reviewer comment.",
      "The person who submitted an entry cannot approve it, and the person who verified the PO cannot approve its worksheet."
    ],
    roleParts: {
      [R.TECHNICIAN]: { do: "Create and submit Timesheets for the dispatches assigned to you. If one is returned, read the reviewer comment, correct it and resubmit. After acknowledgement or approval, changes are made as a new revision, not by editing the signed entry.", next: "Open Timesheets and check for returned entries first.", link: "worksheets" },
      [R.SUPERVISOR]: { do: "Review Timesheets on dispatches assigned to you once they show Client_Acknowledged. Approve, or return with a comment. You cannot approve an entry you submitted yourself.", next: "Open Timesheets and work the entries that are Client_Acknowledged.", link: "worksheets" },
      [R.OPERATIONS]: { do: "Review Timesheets once they show Client_Acknowledged: approve, or return with a comment. You cannot approve an entry you submitted, or one on a PO you verified.", next: "Open Timesheets and work the entries that are Client_Acknowledged.", link: "worksheets" },
      [R.ADMIN]: { do: "Admin holds the same review permission as Operations. Independence rules still apply: you cannot approve an entry you submitted or one on a PO you verified.", next: "Open Timesheets to see entries and their status.", link: "worksheets" },
      [R.MANAGEMENT]: { do: "Management can see Timesheet status and period summaries but does not hold the review permission, so it cannot approve or return an entry.", next: "Use Timesheets for status and Reports for summaries; ask a Supervisor or Operations for a decision.", link: "worksheets" },
      [R.CLIENT_VIEWER]: { do: "Your organisation's representative acknowledges Submitted entries for your own organisation only. After a Supervisor approves an entry, its completion document becomes available to you.", next: "Open Documents for approved completion records.", link: "documents" }
    },
    knownLimits: [
      "Client confirmation is done by the client's named authoriser or delegate in the Client portal. If the client has no active authoriser the Timesheet shows Awaiting Client Authority and ORAC Sales and Admin are told. A client can also return a Timesheet with a reason when that option is enabled. Ask Admin which clients have reached their confirmation cutover.",
      "The Timesheets page tile labelled Awaiting Review counts Submitted entries. The server only lets reviewers act on Client_Acknowledged entries."
    ],
    metrics: {
      [R.ADMIN]: WORKSHEET_METRICS, [R.MANAGEMENT]: WORKSHEET_METRICS, [R.OPERATIONS]: WORKSHEET_METRICS,
      [R.SUPERVISOR]: WORKSHEET_METRICS, [R.TECHNICIAN]: WORKSHEET_METRICS,
      [R.CLIENT_VIEWER]: ["pending_client_acknowledgement"]
    }
  },
  {
    id: "kiosk-timesheets",
    version: "1.1",
    title: "Kiosk time entries",
    keywords: ["kiosk", "roster", "batch", "crew hours", "bulk hours"],
    destination: "kiosk",
    sources: ["src/controllers/kioskController.js", "src/controllers/timesheetReviewController.js", "src/timesheetReview.js", "src/permissions.js (submitKioskTimesheets, viewKioskTimesheetReview, reviewKioskTimesheet)"],
    summary: "Kiosk mode records hours for technicians on one dispatch's roster in a single batch.",
    statuses: [],
    evidence: [
      "Every entry must belong to a technician assigned to that dispatch, and a technician may appear only once per batch.",
      "A new kiosk entry waits for review by a Supervisor assigned to the dispatch. Admin and Operations can see the review queue but cannot approve or reject entries.",
      "Pending and rejected kiosk entries do not count as approved hours. A Supervisor cannot review an entry they recorded or their own time.",
      "Each entry and each batch is written to the audit log with who recorded it."
    ],
    roleParts: {
      [R.ADMIN]: { do: "Admin can submit a kiosk batch and view the review queue, but cannot approve or reject entries.", next: "Open Kiosk Mode, enter the roster hours, then follow the queue until an assigned Supervisor reviews them.", link: "kiosk" },
      [R.OPERATIONS]: { do: "Operations can submit a kiosk batch and view the review queue, but cannot approve or reject entries.", next: "Open Kiosk Mode, enter the roster hours, then follow the queue until an assigned Supervisor reviews them.", link: "kiosk" },
      [R.SUPERVISOR]: { do: "Supervisor can review pending kiosk entries only for dispatches assigned to them; they cannot submit kiosk batches or review their own or recorded entries.", next: "Open the kiosk review queue for an assigned dispatch and approve accurate evidence or reject it with a correction comment.", link: "kiosk" },
      [R.MANAGEMENT]: { do: "Management does not have permission to submit, list, or review kiosk timesheets.", next: "Ask Operations or Admin for the current queue status; an assigned Supervisor makes the review decision.", link: "dashboard" }
    },
    knownLimits: [
      "A kiosk entry remains pending until an assigned Supervisor approves or rejects it. Pending and rejected entries are excluded from approved hours and invoice/variance calculations. If no active Supervisor is assigned, the entry stays pending until one is assigned."
    ],
    metrics: {}
  },
  {
    id: "quote-lifecycle",
    version: "1.0",
    title: "Quotes: from draft to invoiced",
    keywords: ["quote", "quotation", "quoting", "pipeline", "send quote", "draft quote", "approve quote", "cancel quote", "quote status", "quote stage"],
    destination: "quotations",
    sources: ["src/stateMachine.js", "src/permissions.js", "src/controllers/quoteController.js"],
    summary: "A quote moves Draft, Sent, Approved_Pending_PO, PO_Verified, Field_Dispatch, then Invoiced. Only those forward steps are allowed.",
    statuses: [
      ["Draft", "Being prepared. Only Draft quotes can be edited or cancelled."],
      ["Sent", "Issued to the client. Needs a client and at least one line."],
      ["Approved_Pending_PO", "Approved and waiting for purchase order evidence."],
      ["PO_Verified", "A purchase order with a reference and an amount has been verified."],
      ["Field_Dispatch", "Released for field work."],
      ["Invoiced", "An invoice exists for the work."]
    ],
    evidence: [
      "Sales cannot approve a quote they personally sent. A different Sales colleague, Operations or Admin must approve it."
    ],
    roleParts: {
      [R.SALES]: { do: "Create, edit, send and cancel Draft quotes. Someone else must approve a quote you sent.", next: "Open Quotations and follow up quotes that are Sent or waiting for a PO.", link: "quotations" },
      [R.ADMIN]: { do: "Create, send and approve quotes.", next: "Open Quotations to see status by quote.", link: "quotations" },
      [R.OPERATIONS]: { do: "Operations may approve a sent quote. It cannot create, send or cancel one.", next: "The Quotations screen is limited to Admin and Sales in this release, so approval cannot be done from a screen you can open. Ask Admin or Sales.", link: "dashboard" },
      [R.MANAGEMENT]: { do: "Management monitors the quote pipeline and cannot create, send or approve quotes.", next: "Use the Dashboard and Reports for pipeline status.", link: "reports" },
      [R.FINANCE]: { do: "Finance sees quotes waiting for a purchase order and acts on the PO and invoice steps, not on quote creation.", next: "Open PO & Invoicing.", link: "finance" },
      [R.CLIENT_VIEWER]: { do: "You see your own organisation's quotes. You can submit your purchase order reference for a quote of your organisation.", next: "Open the Client Portal.", link: "portal" }
    },
    knownLimits: [],
    metrics: {
      [R.SALES]: ["quotes"], [R.ADMIN]: ["quotes", "pending_po"], [R.MANAGEMENT]: ["quotes"], [R.FINANCE]: ["pending_po"],
      [R.CLIENT_VIEWER]: ["quotes"]
    }
  },
  {
    id: "po-and-amendments",
    version: "1.0",
    title: "Purchase orders and PO amendments",
    keywords: ["purchase order", "po", "pos", "po reference", "po amount", "amendment", "amendments", "verify po", "awaiting po", "pending po", "blocked"],
    destination: "finance",
    sources: ["src/stateMachine.js", "src/controllers/quoteController.js", "src/permissions.js (verifyPo, approveAmendment, submitClientPo)"],
    summary: "A purchase order needs a reference and an amount to be verified. A verified PO amount can only change through an approved amendment.",
    statuses: [
      ["Awaiting PO", "The quote is approved and no verified PO evidence exists yet."],
      ["Verified", "A PO with a reference and an amount above zero has been verified."],
      ["Requires amendment", "Logged work exceeds the PO amount. Invoicing stays blocked until an amendment is approved."]
    ],
    evidence: [
      "Verification needs a PO reference and an amount above zero.",
      "Dispatch requires PO evidence unless an urgent pre-PO dispatch is explicitly authorised with a reason.",
      "Amendment approval is limited to Admin and Finance and is subject to separation-of-duties controls."
    ],
    roleParts: {
      [R.FINANCE]: { do: "Verify a PO and approve amendments.", next: "Open PO & Invoicing and clear amendments before invoice work.", link: "finance" },
      [R.ADMIN]: { do: "Verify a PO and approve amendments.", next: "Open PO & Invoicing.", link: "finance" },
      [R.OPERATIONS]: { do: "Operations may verify a PO. It cannot approve amendments.", next: "The PO & Invoicing screen is limited to Admin and Finance in this release. Ask Finance or Admin to action it.", link: "dashboard" },
      [R.MANAGEMENT]: { do: "Management monitors PO exposure and cannot verify a PO or approve an amendment.", next: "Use the Dashboard and Reports.", link: "reports" },
      [R.CLIENT_VIEWER]: { do: "Submit the purchase order reference and amount for a quote of your organisation.", next: "Open the Client Portal.", link: "portal" }
    },
    knownLimits: [],
    metrics: { [R.FINANCE]: ["pending_po", "blocked_amendments"], [R.ADMIN]: ["pending_po", "blocked_amendments"], [R.MANAGEMENT]: ["pending_po"] }
  },
  {
    id: "invoicing",
    version: "1.0",
    title: "Invoices and invoice readiness",
    keywords: ["invoice", "invoices", "invoicing", "billing", "invoice ready", "invoice blocked", "void", "pastel", "export invoice", "payment"],
    destination: "finance",
    sources: ["src/stateMachine.js (Invoiced)", "src/permissions.js (invoice, exportPastel)", "src/controllers/coreController.js"],
    summary: "An invoice can only be raised when the dispatch, the verified PO and an approved Timesheet all exist and no amendment is outstanding.",
    statuses: [],
    evidence: [
      "A dispatch card must exist.",
      "A verified PO with a reference is required.",
      "At least one Supervisor_Approved Timesheet is required.",
      "An unresolved PO amendment blocks invoicing.",
      "Voiding an invoice requires a reason."
    ],
    roleParts: {
      [R.FINANCE]: { do: "Raise invoices when all four conditions are met, void with a reason, and export for Pastel.", next: "Open PO & Invoicing and check the blocking condition named on the quote.", link: "finance" },
      [R.ADMIN]: { do: "Admin holds the same invoice and export permissions as Finance.", next: "Open PO & Invoicing.", link: "finance" },
      [R.MANAGEMENT]: { do: "Management sees invoice counts for visibility and cannot raise, void or export invoices.", next: "Use the Dashboard and Reports.", link: "reports" },
      [R.CLIENT_VIEWER]: { do: "You see invoices for your own organisation only.", next: "Open Documents for your invoice documents.", link: "documents" }
    },
    knownLimits: [],
    metrics: { [R.FINANCE]: ["invoices", "blocked_amendments"], [R.ADMIN]: ["invoices"], [R.MANAGEMENT]: ["invoices"], [R.CLIENT_VIEWER]: ["invoices"] }
  },
  {
    id: "dispatch-and-field-work",
    version: "1.0",
    title: "Dispatch and field work",
    keywords: ["dispatch", "dispatches", "job", "jobs", "assigned", "assignment", "field", "material", "materials", "roster", "site"],
    destination: "worksheets",
    sources: ["src/permissions.js (dispatch, addTimesheet, addMaterials)", "src/controllers/dispatchController.js", "src/controllers/coreController.js (buildScopedSummary)"],
    summary: "Operations and Admin release dispatches. Technicians and Supervisors see and work only the dispatches assigned to them.",
    statuses: [],
    evidence: [
      "Dispatch needs PO evidence unless an urgent pre-PO dispatch is authorised with a reason.",
      "A dispatch that already has an active invoice is frozen.",
      "Materials recorded against a dispatch are deducted from stock by the server."
    ],
    roleParts: {
      [R.OPERATIONS]: { do: "Release dispatches, assign the roster, and follow field evidence through to review.", next: "Open Timesheets to follow dispatch evidence.", link: "worksheets" },
      [R.ADMIN]: { do: "Release dispatches and oversee field evidence.", next: "Open Timesheets.", link: "worksheets" },
      [R.SUPERVISOR]: { do: "Release dispatches inside your assignment and review the evidence they produce.", next: "Open Timesheets.", link: "worksheets" },
      [R.TECHNICIAN]: { do: "Record hours, materials and worksheet evidence on dispatches assigned to you.", next: "Open Timesheets.", link: "worksheets" },
      [R.MANAGEMENT]: { do: "Management sees dispatch counts and status for oversight and does not assign or release work.", next: "Use the Dashboard and Reports.", link: "reports" },
      [R.CLIENT_VIEWER]: { do: "You see dispatch progress for your own organisation only.", next: "Use the Dashboard for progress.", link: "dashboard" }
    },
    knownLimits: [],
    metrics: {
      [R.OPERATIONS]: ["dispatches"], [R.ADMIN]: ["dispatches"], [R.SUPERVISOR]: ["dispatches"], [R.TECHNICIAN]: ["dispatches"],
      [R.MANAGEMENT]: ["dispatches"], [R.CLIENT_VIEWER]: ["dispatches"]
    }
  },
  {
    id: "service-requests",
    version: "1.0",
    title: "Client service requests",
    keywords: ["service request", "service requests", "request service", "triage", "convert", "lead", "leads"],
    destination: "serviceRequests",
    sources: ["src/serviceRequestRules.js", "src/permissions.js (createServiceRequest, triageServiceRequests, convertServiceRequest)"],
    summary: "A client submits a service request. Sales or Operations triage it: Submitted, then Acknowledged, then Accepted or Declined. Conversion to a lead is a separate step.",
    statuses: [
      ["Submitted", "Received from the client."],
      ["Acknowledged", "Seen by Sales or Operations."],
      ["Accepted", "Accepted for follow-up."],
      ["Declined", "Declined. Can be declined from Submitted or Acknowledged."],
      ["Converted_To_Lead", "Converted to a lead."]
    ],
    evidence: [],
    roleParts: {
      [R.CLIENT_VIEWER]: { do: "Submit a request for your own organisation and follow its status.", next: "Open the Client Portal.", link: "portal" },
      [R.SALES]: { do: "Acknowledge, accept or decline requests. Conversion to a lead is a separate step.", next: "Open Service Requests.", link: "serviceRequests" },
      [R.OPERATIONS]: { do: "Acknowledge, accept or decline requests. Conversion to a lead is a separate step.", next: "Open Service Requests.", link: "serviceRequests" }
    },
    knownLimits: [
      "A requested date is only the client's preference. This system has no capacity-controlled appointment booking, availability calendar, assigned booking slot, or confirmed appointment date. 'Accepted' means accepted for follow-up, not booked. Do not tell a client that a visit is scheduled; Sales or Operations must confirm it outside this workflow."
    ],
    metrics: {}
  },
  {
    id: "inventory-and-stock",
    version: "1.0",
    title: "Inventory and stock movements",
    keywords: ["stock", "inventory", "movement", "movements", "reorder", "on hand", "issue stock", "receipt", "negative stock", "scrap", "return stock"],
    destination: "inventory",
    sources: ["src/inventoryLedger.js", "src/controllers/inventoryController.js", "src/permissions.js (manageInventory)"],
    summary: "Every stock change is a recorded movement with the actor, reason and reference. Stock cannot go negative unless the explicit authorised override is used.",
    statuses: [],
    evidence: [
      "Each movement records quantity before and after, who made it and why.",
      "Insufficient stock is refused by the server.",
      "No walk-in or cash sales are part of this pilot."
    ],
    roleParts: {
      [R.OPERATIONS]: { do: "Record and review stock movements and reorder levels.", next: "Open Inventory and read the movement history for the item.", link: "inventory" },
      [R.ADMIN]: { do: "Record and review stock movements and reorder levels.", next: "Open Inventory.", link: "inventory" },
      [R.MANAGEMENT]: { do: "Manage inventory records and review movements.", next: "Open Inventory.", link: "inventory" },
      [R.TECHNICIAN]: { do: "Record materials used on your assigned dispatch. The server deducts the stock; you do not adjust stock directly.", next: "Open Timesheets.", link: "worksheets" },
      [R.SUPERVISOR]: { do: "Record materials used on an assigned dispatch. The server deducts the stock.", next: "Open Timesheets.", link: "worksheets" }
    },
    knownLimits: [],
    metrics: {}
  },
  {
    id: "internal-requests",
    version: "1.0",
    title: "Internal work requests (staff to staff)",
    keywords: ["internal request", "internal requests", "team request", "ask another team", "raise a request", "inbox", "outbox"],
    destination: "internalRequests",
    sources: ["src/internalWorkRequestRules.js", "src/permissions.js (createInternalWorkRequest, viewInternalWorkRequestInbox)"],
    summary: "Staff raise requests to another role. The lifecycle is Submitted, Acknowledged, In Progress, then Completed, Rejected or Cancelled.",
    statuses: [
      ["Submitted", "Sent and waiting for the recipient role."],
      ["Acknowledged", "Seen by the recipient."],
      ["In Progress", "Being worked."],
      ["Completed", "Finished."],
      ["Rejected", "Declined by the recipient."],
      ["Cancelled", "Withdrawn."]
    ],
    evidence: ["Which sender may send which request type to which role is set by the pairing policy in internalWorkRequestRules.js."],
    roleParts: {
      [R.MANAGEMENT]: { do: "Raise requests and work requests addressed to you.", next: "Open Internal Requests.", link: "internalRequests" },
      [R.SALES]: { do: "Raise requests and work requests addressed to you.", next: "Open Internal Requests.", link: "internalRequests" },
      [R.FINANCE]: { do: "Raise requests and work requests addressed to you.", next: "Open Internal Requests.", link: "internalRequests" },
      [R.OPERATIONS]: { do: "Raise requests and work requests addressed to you.", next: "Open Internal Requests.", link: "internalRequests" },
      [R.SUPERVISOR]: { do: "Raise requests and track the ones you sent.", next: "Open Internal Requests.", link: "internalRequests" },
      [R.TECHNICIAN]: { do: "Raise requests and track the ones you sent.", next: "Open Internal Requests.", link: "internalRequests" },
      [R.ADMIN]: { do: "Receive and work requests. Admin does not raise them.", next: "Open Internal Requests.", link: "internalRequests" }
    },
    knownLimits: [],
    metrics: {}
  },
  {
    id: "access-and-accounts",
    version: "1.0",
    title: "Access requests, accounts and roles",
    keywords: ["access request", "access requests", "new user", "create user", "role change", "change role", "make me admin", "password", "reset password", "permissions"],
    destination: "admin",
    sources: ["src/controllers/accessRequestsController.js", "src/controllers/adminController.js", "src/permissions.js (manageUsers)"],
    summary: "Only an Admin approves an access request and assigns the final role. Nobody can request or self-assign the Admin role.",
    statuses: [],
    evidence: ["The Admin sets the actual role at approval; the requested role is not binding."],
    roleParts: {
      [R.ADMIN]: { do: "Review access requests, approve or reject them, and set the final role.", next: "Open Administration and review the access requests.", link: "admin" },
      [R.MANAGEMENT]: { do: "You cannot approve access or change roles. Ask an Admin.", next: "Ask an Admin.", link: "dashboard" },
      [R.OPERATIONS]: { do: "You cannot approve access or change roles. Ask an Admin.", next: "Ask an Admin.", link: "dashboard" },
      [R.SALES]: { do: "You cannot approve access or change roles. Ask an Admin.", next: "Ask an Admin.", link: "dashboard" },
      [R.FINANCE]: { do: "You cannot approve access or change roles. Ask an Admin.", next: "Ask an Admin.", link: "dashboard" },
      [R.SUPERVISOR]: { do: "You cannot approve access or change roles. Ask an Admin.", next: "Ask an Admin.", link: "dashboard" },
      [R.TECHNICIAN]: { do: "You cannot approve access or change roles. Ask an Admin.", next: "Ask an Admin.", link: "dashboard" },
      [R.CLIENT_VIEWER]: { do: "You cannot approve access or change roles. Ask your ORAC contact to raise it with an Admin.", next: "Contact your ORAC representative.", link: "dashboard" }
    },
    knownLimits: [],
    metrics: {}
  },
  {
    id: "contracts-and-maintenance",
    version: "1.0",
    title: "Contracts and preventative maintenance",
    keywords: ["contract", "contracts", "maintenance", "schedule", "schedules", "preventative", "preventive", "renewal", "expire", "expiry"],
    destination: "contracts",
    sources: ["src/controllers/contractsController.js", "src/permissions.js (viewContracts, manageContracts, manageMaintenanceSchedules)"],
    summary: "Contracts are Draft, Active, Expired or Cancelled. Schedules can only be added to Draft or Active contracts.",
    statuses: [
      ["Draft", "Being prepared."],
      ["Active", "In force."],
      ["Expired", "Past its term."],
      ["Cancelled", "Cancelled."]
    ],
    evidence: [],
    roleParts: {
      [R.ADMIN]: { do: "Manage contracts and maintenance schedules.", next: "Open Contracts.", link: "contracts" },
      [R.MANAGEMENT]: { do: "Manage contracts and maintenance schedules.", next: "Open Contracts.", link: "contracts" },
      [R.OPERATIONS]: { do: "View contracts and manage maintenance schedules. You cannot create or change contracts.", next: "Open Contracts.", link: "contracts" },
      [R.CLIENT_VIEWER]: { do: "View your own organisation's contracts.", next: "Open Contracts.", link: "contracts" }
    },
    knownLimits: [],
    metrics: {}
  },
  {
    id: "documents-and-reports",
    version: "1.0",
    title: "Documents, reports and downloads",
    keywords: ["document", "documents", "pdf", "download", "report", "reports", "completion record", "period pack", "export", "csv"],
    destination: "documents",
    sources: ["src/controllers/documentController.js", "src/reports.js", "src/permissions.js (downloadTimesheetPeriodPack, viewTimesheetPeriodSummary)"],
    summary: "Documents and reports are generated by the server for the records your role may see.",
    statuses: [],
    evidence: [
      "A client's completion document is only available once its Timesheet is Supervisor_Approved.",
      "Timesheet period packs are limited to Admin and Operations; period summaries to Admin, Operations and Management."
    ],
    roleParts: {
      [R.ADMIN]: { do: "Download documents and reports and the Timesheet period pack.", next: "Open Documents or Reports.", link: "documents" },
      [R.MANAGEMENT]: { do: "View reports and Timesheet period summaries.", next: "Open Reports.", link: "reports" },
      [R.OPERATIONS]: { do: "Download documents and the Timesheet period pack.", next: "Open Documents.", link: "documents" },
      [R.SUPERVISOR]: { do: "View documents and reports for your assigned work.", next: "Open Documents.", link: "documents" },
      [R.TECHNICIAN]: { do: "View documents for your assigned work.", next: "Open Documents.", link: "documents" },
      [R.SALES]: { do: "View documents and reports within your role's scope.", next: "Open Documents.", link: "documents" },
      [R.FINANCE]: { do: "View documents and reports within your role's scope.", next: "Open Documents.", link: "documents" },
      [R.CLIENT_VIEWER]: { do: "Download documents for your own organisation.", next: "Open Documents.", link: "documents" }
    },
    knownLimits: [
      "At this release the web app has no screen for the Timesheet period pack, so it cannot be downloaded from the Documents or Reports pages."
    ],
    metrics: {}
  }
]);

export const ARTICLES_BY_ID = Object.freeze(Object.fromEntries(ARTICLES.map((article) => [article.id, article])));

export function articlesForRole(role) {
  return ARTICLES.filter((article) => Object.hasOwn(article.roleParts, role));
}

// Sanity helper used by tests: every permission name referenced by a
// destination must exist in permissions.js.
export function destinationPermissionNames() {
  return Object.values(DESTINATIONS).map((destination) => destination.requires).filter(Boolean)
    .filter((name) => !Object.hasOwn(permissions, name));
}
