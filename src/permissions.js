export const roles = {
  ADMIN: "Admin",
  MANAGEMENT: "Management",
  SALES: "Sales",
  OPERATIONS: "Operations",
  TECHNICIAN: "Technician",
  SUPERVISOR: "Supervisor",
  FINANCE: "Finance",
  CLIENT_VIEWER: "Client Viewer"
};

export const permissions = {
  createQuote: [roles.ADMIN, roles.SALES],
  sendQuote: [roles.ADMIN, roles.SALES],
  approveQuote: [roles.ADMIN, roles.MANAGEMENT, roles.SALES],
  verifyPo: [roles.ADMIN, roles.FINANCE],
  rejectPo: [roles.ADMIN, roles.FINANCE],
  recordPo: [roles.ADMIN, roles.FINANCE, roles.SALES],
  dispatch: [roles.ADMIN, roles.OPERATIONS],
  viewDispatchRoster: [roles.ADMIN, roles.OPERATIONS, roles.SUPERVISOR],
  addTimesheet: [roles.ADMIN, roles.OPERATIONS, roles.TECHNICIAN, roles.SUPERVISOR],
  submitKioskTimesheets: [roles.ADMIN, roles.OPERATIONS],
  // Task 03: kiosk entries need Supervisor review. Only a Supervisor decides;
  // Admin/Operations may read the queue to chase it (owner decision D-K1: Admin fallback).
  reviewKioskTimesheet: [roles.SUPERVISOR],
  // Assigning the Supervisor who reviews a dispatch's kiosk entries. Not a Supervisor self-service action.
  assignDispatchSupervisor: [roles.ADMIN, roles.OPERATIONS],
  viewKioskTimesheetReview: [roles.ADMIN, roles.OPERATIONS, roles.SUPERVISOR],
  viewDispatchTimesheets: [roles.ADMIN, roles.OPERATIONS, roles.SUPERVISOR, roles.TECHNICIAN, roles.SALES],
  // Read-only operational summary. Management may read every Job Card; field
  // roles remain restricted to dispatches they are assigned to.
  viewDispatchJobCard: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR, roles.TECHNICIAN, roles.SALES],
  addMaterials: [roles.ADMIN, roles.OPERATIONS, roles.TECHNICIAN, roles.SUPERVISOR],
  // Sales Desk (Phase 2): keys signed paper in under its OWN account. Sales is limited in the controllers to
  // paper entries (source paper_entry) that it created itself, on dispatches in its own portfolio.
  createWorksheet: [roles.ADMIN, roles.OPERATIONS, roles.TECHNICIAN, roles.SUPERVISOR, roles.SALES],
  submitWorksheet: [roles.ADMIN, roles.OPERATIONS, roles.TECHNICIAN, roles.SUPERVISOR, roles.SALES],
  reviewWorksheet: [roles.ADMIN, roles.OPERATIONS, roles.SUPERVISOR],
  createDailyTimesheet: [roles.ADMIN, roles.OPERATIONS, roles.SUPERVISOR, roles.TECHNICIAN, roles.SALES],
  submitDailyTimesheet: [roles.ADMIN, roles.OPERATIONS, roles.SUPERVISOR, roles.TECHNICIAN, roles.SALES],
  reviewDailyTimesheet: [roles.ADMIN, roles.OPERATIONS, roles.SUPERVISOR],
  // Dropdown source for Daily Time Sheet auto-fill (Trade, National ID). Read-only.
  viewTechnicianProfiles: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR, roles.SALES],
  createContractorLog: [roles.ADMIN, roles.OPERATIONS, roles.SUPERVISOR],
  submitContractorLog: [roles.ADMIN, roles.OPERATIONS, roles.SUPERVISOR],
  reviewContractorLog: [roles.ADMIN, roles.OPERATIONS, roles.SUPERVISOR],
  // Worksheet: consolidation of approved Daily Time Sheets (hours only, no rates).
  // Technicians and Client Viewers hold none of these: a month shows colleagues' hours.
  // Approval separation of duties (submitter / builder / roster member) is enforced in the controller.
  viewWorksheetRegister: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR, roles.SALES],
  manageWorksheetRegister: [roles.ADMIN, roles.OPERATIONS, roles.SUPERVISOR, roles.SALES],
  submitWorksheetRegister: [roles.ADMIN, roles.OPERATIONS, roles.SUPERVISOR, roles.SALES],
  reviewWorksheetRegister: [roles.ADMIN, roles.OPERATIONS, roles.SUPERVISOR],
  reconcileWorksheetRegister: [roles.ADMIN, roles.OPERATIONS],
  // Chat B — Digital Timesheets and client acknowledgement.
  // Only the client's own representative may acknowledge that client's work.
  acknowledgeWorksheet: [roles.CLIENT_VIEWER],
  viewOwnClientTimesheets: [roles.CLIENT_VIEWER],
  // A correction after acknowledgement/approval reuses the same actor set as
  // editing a draft worksheet; scoping to "own worksheet" for a Technician is
  // enforced inside the controller, same as updateWorksheet/submitWorksheet.
  reviseWorksheet: [roles.ADMIN, roles.OPERATIONS, roles.TECHNICIAN, roles.SUPERVISOR],
  downloadTimesheetPeriodPack: [roles.ADMIN, roles.OPERATIONS],
  viewTimesheetPeriodSummary: [roles.ADMIN, roles.OPERATIONS, roles.MANAGEMENT],
  approveAmendment: [roles.ADMIN, roles.FINANCE],
  invoice: [roles.ADMIN, roles.FINANCE],
  // Legacy controlled invoicing mirrors the two-person control used by the
  // separate V5 writer. Preparing a calculation never creates an invoice.
  manageLegacyInvoiceDraft: [roles.ADMIN, roles.FINANCE, roles.SALES],
  issueLegacyInvoiceDraft: [roles.ADMIN, roles.FINANCE],
  // Read-only explanation of the same evidence and PO controls used by the
  // Invoice Ready report. This does not grant invoice creation.
  viewInvoiceReadiness: [roles.ADMIN, roles.MANAGEMENT, roles.FINANCE, roles.SALES],
  exportPastel: [roles.ADMIN, roles.FINANCE],
  // Technician payroll summary: certified hours only (no rates or amounts). Export to
  // Pastel stays behind exportPastel (Admin, Finance); Management is read-only.
  viewTechnicianPayroll: [roles.ADMIN, roles.MANAGEMENT, roles.FINANCE],
  viewAudit: [roles.ADMIN, roles.MANAGEMENT, roles.FINANCE],
  manageUsers: [roles.ADMIN],
  // Who may open the access-request inbox and be notified of new requests.
  // Pilot decision: Admin only. Deciding (approve/reject/issue a setup link) stays
  // behind manageUsers whatever this list says.
  viewAccessRequests: [roles.ADMIN],
  manageClients: [roles.ADMIN, roles.MANAGEMENT],
  manageAssets: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS],
  createServiceRequest: [roles.CLIENT_VIEWER],
  viewOwnServiceRequests: [roles.CLIENT_VIEWER],
  triageServiceRequests: [roles.SALES, roles.OPERATIONS],
  convertServiceRequest: [roles.SALES, roles.OPERATIONS],
  manageCatalog: [roles.ADMIN, roles.MANAGEMENT],
  manageCompanyProfile: [roles.ADMIN, roles.MANAGEMENT],
  viewContracts: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.CLIENT_VIEWER],
  manageContracts: [roles.ADMIN, roles.MANAGEMENT],
  manageMaintenanceSchedules: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS],
  submitClientPo: [roles.CLIENT_VIEWER, roles.SALES, roles.ADMIN],
  manageInventory: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS],
  // Internal Work Requests (staff to staff). Client Viewer holds none of these.
  // These lists only gate the endpoints; which sender may send which request
  // type to which recipient role is the pairing policy in
  // internalWorkRequestRules.js (a test keeps the two in step).
  createInternalWorkRequest: [roles.MANAGEMENT, roles.SALES, roles.FINANCE, roles.OPERATIONS, roles.SUPERVISOR, roles.TECHNICIAN],
  viewInternalWorkRequestOutbox: [roles.MANAGEMENT, roles.SALES, roles.FINANCE, roles.OPERATIONS, roles.SUPERVISOR, roles.TECHNICIAN],
  viewInternalWorkRequestInbox: [roles.ADMIN, roles.MANAGEMENT, roles.SALES, roles.FINANCE, roles.OPERATIONS],
  workInternalWorkRequest: [roles.ADMIN, roles.MANAGEMENT, roles.SALES, roles.FINANCE, roles.OPERATIONS],
  // Read-only, by id. Never grants any mutation.
  auditInternalWorkRequests: [roles.ADMIN],
  manageCommercialOwnership: [roles.ADMIN, roles.MANAGEMENT]
};

// Timesheet workflow packet (contract steps 3-9). Every overlay is DARK: with its
// environment flag unset, effectivePermissionRoles() returns the base list unchanged.
const S = roles.SALES, F = roles.FINANCE, A = roles.ADMIN, M = roles.MANAGEMENT, O = roles.OPERATIONS, V = roles.SUPERVISOR, T = roles.TECHNICIAN;
const NEW_PERMISSIONS = {
  // Always-defined but only reachable through flag-guarded endpoints.
  viewTimesheetsRateFree: [A, M, S, O, V, F],
  viewV5BillingReadiness: [A, M, S, F],
  // Read-only commercial calculation preview. It cannot create an invoice.
  viewV5InvoicePreview: [A, M, S, F],
  manageV5MaterialAllocation: [A, S],
  approveV5Amendment: [A, F],
  manageV5AmendmentLink: [A, S],
  manageV5AmendmentCoverage: [A, S],
  // The V5 writer is a separate, dark capability. Finance/Admin prepare
  // commercial drafts and a different Finance/Admin user issues them.
  manageV5InvoiceDraft: [A, F],
  issueV5Invoice: [A, F],
  viewV5Invoice: [A, F, M],
  recordV5LineCompletion: [V],
  manageV5AmendmentSupersession: [A, F],
  manageV5AllocationRemap: [A, F],
  // V5 paper-signature evidence (dark). The client-site Supervisor has NO role; only the assigned ORAC Supervisor confirms.
  manageV5ClientSupervisorContacts: [A, S],
  recordV5PaperSignature: [A, S],
  confirmV5Timesheet: [V],
  viewV5SignatureEvidence: [A, M, S, V, F],
  manageTimesheetAuthority: [A],
  captureTimesheetPaper: [A, S],
  logPaperCustody: [A, S, O],
  viewInvoiceVariance: [A, F],
  overrideInvoiceVariance: [A, F],
  // Phase 3: certified hours vs quoted/PO hours. Everyone who reviews or invoices may see the hours position;
  // money figures are stripped server-side unless the viewer also holds viewInvoiceVariance (Sales stays rate-free).
  viewPoVariance: [A, M, S, F],
  attachPoScopeEvidence: [A, S],
  resolvePostInvoiceRevision: [A, F],
  viewPaperSampling: [A, F],
  runTimesheetReminders: [A, S]
};
const OVERLAYS = [
  { flag: "TIMESHEET_SALES_ACCESS",
    add: { viewWorksheetRegister: [S, F], manageWorksheetRegister: [S], submitWorksheetRegister: [S], reviewWorksheetRegister: [S], reconcileWorksheetRegister: [F], reviseWorksheet: [S] } },
  { flag: "TIMESHEET_RATE_ROW_RESTRICT",
    replace: { addTimesheet: [A, F], submitKioskTimesheets: [A, F] } },
  { flag: "TIMESHEET_OPS_RESTRICT",
    remove: { viewWorksheetRegister: [O, V], manageWorksheetRegister: [O, V], submitWorksheetRegister: [O, V], reviewWorksheetRegister: [O, V], reconcileWorksheetRegister: [O] } }
];
export function effectivePermissionRoles(permission) {
  if (process.env.NODE_ENV === "production" && process.env.TIMESHEET_SALES_ACCESS === "enabled") {
    throw new Error("TIMESHEET_SALES_ACCESS flag cannot be enabled in production environments (maker-checker separation violation).");
  }
  let list = permissions[permission] || NEW_PERMISSIONS[permission] || [];
  for (const o of OVERLAYS) {
    if (process.env[o.flag] !== "enabled") continue;
    if (o.replace?.[permission]) list = o.replace[permission];
    if (o.add?.[permission]) {
      const addRoles = (process.env.NODE_ENV === "production" && permission === "reviewWorksheetRegister")
        ? o.add[permission].filter((r) => r !== roles.SALES)
        : o.add[permission];
      list = [...new Set([...list, ...addRoles])];
    }
    if (o.remove?.[permission]) list = list.filter((r) => !o.remove[permission].includes(r));
  }
  return list;
}

export function hasPermission(actor, permission) {
  return Boolean(actor?.is_active) && effectivePermissionRoles(permission).includes(actor.role);
}

export function requirePermission(actor, permission) {
  if (!hasPermission(actor, permission)) {
    throw Object.assign(new Error(`Role ${actor?.role || "Unknown"} cannot perform ${permission}.`), { status: 403 });
  }
}
