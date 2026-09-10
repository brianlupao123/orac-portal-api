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
  addMaterials: [roles.ADMIN, roles.OPERATIONS, roles.TECHNICIAN, roles.SUPERVISOR],
  createWorksheet: [roles.ADMIN, roles.OPERATIONS, roles.TECHNICIAN, roles.SUPERVISOR],
  submitWorksheet: [roles.ADMIN, roles.OPERATIONS, roles.TECHNICIAN, roles.SUPERVISOR],
  reviewWorksheet: [roles.ADMIN, roles.OPERATIONS, roles.SUPERVISOR],
  approveAmendment: [roles.ADMIN, roles.FINANCE],
  invoice: [roles.ADMIN, roles.FINANCE],
  exportPastel: [roles.ADMIN, roles.FINANCE],
  viewAudit: [roles.ADMIN, roles.MANAGEMENT, roles.FINANCE],
  manageUsers: [roles.ADMIN],
  manageClients: [roles.ADMIN, roles.MANAGEMENT],
  manageAssets: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS],
  manageCatalog: [roles.ADMIN, roles.MANAGEMENT],
  manageCompanyProfile: [roles.ADMIN, roles.MANAGEMENT],
  submitClientPo: [roles.CLIENT_VIEWER],
  manageInventory: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS]
};

export function hasPermission(actor, permission) {
  return Boolean(actor?.is_active) && (permissions[permission] || []).includes(actor.role);
}

export function requirePermission(actor, permission) {
  if (!hasPermission(actor, permission)) {
    throw Object.assign(new Error(`Role ${actor?.role || "Unknown"} cannot perform ${permission}.`), { status: 403 });
  }
}
