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
  approveQuote: [roles.ADMIN, roles.SALES, roles.OPERATIONS],
  verifyPo: [roles.ADMIN, roles.FINANCE, roles.OPERATIONS],
  dispatch: [roles.ADMIN, roles.OPERATIONS, roles.SUPERVISOR],
  addTimesheet: [roles.ADMIN, roles.OPERATIONS, roles.TECHNICIAN, roles.SUPERVISOR],
  submitKioskTimesheets: [roles.ADMIN, roles.OPERATIONS],
  addMaterials: [roles.ADMIN, roles.OPERATIONS, roles.TECHNICIAN, roles.SUPERVISOR],
  createWorksheet: [roles.ADMIN, roles.OPERATIONS, roles.TECHNICIAN, roles.SUPERVISOR],
  submitWorksheet: [roles.ADMIN, roles.OPERATIONS, roles.TECHNICIAN, roles.SUPERVISOR],
  reviewWorksheet: [roles.ADMIN, roles.OPERATIONS, roles.SUPERVISOR],
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
  exportPastel: [roles.ADMIN, roles.FINANCE],
  viewAudit: [roles.ADMIN, roles.MANAGEMENT, roles.FINANCE],
  manageUsers: [roles.ADMIN],
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
  submitClientPo: [roles.CLIENT_VIEWER],
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
  auditInternalWorkRequests: [roles.ADMIN]
};

export function hasPermission(actor, permission) {
  return Boolean(actor?.is_active) && (permissions[permission] || []).includes(actor.role);
}

export function requirePermission(actor, permission) {
  if (!hasPermission(actor, permission)) {
    throw Object.assign(new Error(`Role ${actor?.role || "Unknown"} cannot perform ${permission}.`), { status: 403 });
  }
}
