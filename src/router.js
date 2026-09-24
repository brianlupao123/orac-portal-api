import express from "express";
import { authMiddleware } from "./middleware/auth.js";
import { validate } from "./middleware/validate.js";
import {
  LoginSchema, CreateQuoteSchema, UpdateQuoteSchema, TransitionQuoteSchema, VerifyPoSchema,
  AddTimesheetSchema, KioskTimesheetBatchSchema, AddMaterialSchema, CreateWorksheetSchema,
  ReviewWorksheetSchema, ApproveAmendmentSchema, CreateLeadSchema, UpdateWorksheetSchema,
  AdminCreateUserSchema, AdminUpdateUserSchema, AdminCreateClientSchema, AdminUpdateClientSchema,
  AdminCreateMineSiteSchema, AdminUpdateMineSiteSchema, AdminCreatePlantSchema, AdminUpdatePlantSchema,
  AdminCreatePlantSectionSchema, AdminUpdatePlantSectionSchema, AdminCreateEquipmentTagSchema, AdminUpdateEquipmentTagSchema,
  AdminCreateCatalogItemSchema, AdminUpdateCatalogItemSchema, AdminCompanyProfileSchema,
  ClientSubmitPoSchema,
  CreateSupplierSchema, UpdateSupplierSchema,
  CreateStockItemSchema, UpdateStockItemSchema,
  StockMovementSchema,
  CreateServiceRequestSchema, TriageServiceRequestSchema,
  CreateInternalWorkRequestSchema, TransitionInternalWorkRequestSchema
} from "./schemas.js";

import { loginDemoUser, getMe, requestPasswordReset, resetPassword } from "./controllers/authController.js";
import { createAccessRequest, approveAccessRequest, rejectAccessRequest } from "./controllers/accessRequestsController.js";
import { createQuote, transition, capturePo, submitClientPo, updateQuote, cancelQuote } from "./controllers/quoteController.js";
import {
  addTimesheet, addMaterialUsage, createWorksheet,
  submitWorksheet, reviewWorksheet, approveAmendment, updateWorksheet
} from "./controllers/dispatchController.js";
import { getKioskRoster, submitKioskTimesheets } from "./controllers/kioskController.js";
import { getSummary, exportPastel, createLead, getCollection, reactivateEntity, deactivateEntity, voidInvoice } from "./controllers/coreController.js";
import { getQuoteDocument, getDispatchDocument, getWorksheetDocument, getInvoiceDocument, getPoDocument, getQuotePdf, getJobCardPdf, getWorksheetPdf, getInvoicePdf, getPoDocumentPdf } from "./controllers/documentController.js";
import { getPipelineReport, getPoComplianceReport, getDispatchReport, getWorksheetReport, getInvoiceReadyReport, getVarianceReport } from "./controllers/reportsController.js";
import { createUser, updateUser, createClient, updateClient, createMineSite, updateMineSite, createPlant, updatePlant, createPlantSection, updatePlantSection, createEquipmentTag, updateEquipmentTag, createCatalogItem, updateCatalogItem, getCompanyProfile, updateCompanyProfile } from "./controllers/adminController.js";
import { getSuppliers, createSupplier, updateSupplier, getStockItems, createStockItem, updateStockItem, recordStockMovement, getLowStockReport } from "./controllers/inventoryController.js";
import { getNotifications, markAllRead, markRead } from "./controllers/notificationController.js";
import { getAiHealth, getBriefing, getAttentionItems, getMetricExplanation, getChatResponse, flagAiResponse } from "./controllers/aiController.js";
import { getPastelReviewQuotes, getPastelReviewInvoiceReady, previewLeadImport, commitLeadImport, getOperationalAnalytics } from "./controllers/operationalDataController.js";
import { getDailyTaskReport, getInvoiceReadySummary, getClientCompletionRecord } from "./controllers/operationalDocumentsController.js";
import {
  createServiceRequest, listOwnServiceRequests, listServiceRequestTriageQueue,
  triageServiceRequest, convertServiceRequestToLead
} from "./controllers/serviceRequestsController.js";
import {
  getInternalWorkRequestOptions, createInternalWorkRequest, listInternalWorkRequestOutbox,
  listInternalWorkRequestInbox, getInternalWorkRequest, acknowledgeInternalWorkRequest,
  transitionInternalWorkRequest
} from "./controllers/internalWorkRequestsController.js";
import {
  listContracts, createContract, updateContract,
  listMaintenanceSchedules, createMaintenanceSchedule, updateMaintenanceSchedule
} from "./controllers/contractsController.js";

const router = express.Router();

// Public routes
router.post("/auth/login", validate(LoginSchema), loginDemoUser);
router.post("/leads", validate(CreateLeadSchema), createLead);

// NEW — Phase 6: forgot/reset password (public; token proves identity).
// Not run through the `validate()` middleware — schemas.js's exact export
// conventions weren't available when this was written. Both functions do
// their own inline validation. Add proper zod schemas here once schemas.js
// is available, for consistency with the rest of the router.
router.post("/auth/request-password-reset", requestPasswordReset);
router.post("/auth/reset-password", resetPassword);

// NEW — Phase 6: "Request Access" replaces open self-signup. Public
// submission only; approval requires auth + manageUsers (below).
router.post("/access-requests", createAccessRequest);

// Protected routes
router.use(authMiddleware);

router.get("/auth/me", getMe);
router.get("/summary", getSummary);
router.get("/exports/pastel.csv", exportPastel);
router.get("/exports/pastel-review/quotes.csv", getPastelReviewQuotes);
router.get("/exports/pastel-review/invoice-ready.csv", getPastelReviewInvoiceReady);
router.post("/imports/leads/preview", previewLeadImport);
router.post("/imports/leads/commit", commitLeadImport);
router.get("/analytics/operational", getOperationalAnalytics);

// Phase 0.5 is deterministic and providerless. These routes have no model,
// provider, free-text, or business-record mutation capability.
router.get("/ai/health", getAiHealth);
router.post("/ai/briefing", getBriefing);
router.post("/ai/attention", getAttentionItems);
router.post("/ai/explain", getMetricExplanation);
router.post("/ai/chat", getChatResponse);
router.post("/ai/feedback", flagAiResponse);

// Printable/document-data endpoints (Phase 03)
router.get("/document-data/quotes/:id", getQuoteDocument);
router.get("/document-data/dispatch_cards/:id", getDispatchDocument);
router.get("/document-data/field_worksheets/:id", getWorksheetDocument);
router.get("/document-data/invoices/:id", getInvoiceDocument);
router.get("/document-data/purchase_orders/:id", getPoDocument);
router.get("/document-data/daily-task-report", getDailyTaskReport);
router.get("/document-data/invoice-ready-summary", getInvoiceReadySummary);
router.get("/document-data/client-completion/:id", getClientCompletionRecord);

// Printable document endpoints (Phase 09)
router.get("/documents/quotes/:id.pdf", getQuotePdf);
router.get("/documents/job-cards/:id.pdf", getJobCardPdf);
router.get("/documents/worksheets/:id.pdf", getWorksheetPdf);
router.get("/documents/invoices/:id.pdf", getInvoicePdf);
router.post("/invoices/:id/void", voidInvoice);
router.get("/documents/purchase-orders/:id.pdf", getPoDocumentPdf);

// Reports (Phase 04)
router.get("/reports/pipeline", getPipelineReport);
router.get("/reports/po-compliance", getPoComplianceReport);
router.get("/reports/dispatch", getDispatchReport);
router.get("/reports/worksheets", getWorksheetReport);
router.get("/reports/invoice-ready", getInvoiceReadyReport);
router.get("/reports/variance", getVarianceReport);
// Admin Settings (Phase 05)
router.post("/admin/users", validate(AdminCreateUserSchema), createUser);
router.patch("/admin/users/:id", validate(AdminUpdateUserSchema), updateUser);
router.post("/admin/clients", validate(AdminCreateClientSchema), createClient);
router.patch("/admin/clients/:id", validate(AdminUpdateClientSchema), updateClient);
router.post("/admin/mine_sites", validate(AdminCreateMineSiteSchema), createMineSite);
router.patch("/admin/mine_sites/:id", validate(AdminUpdateMineSiteSchema), updateMineSite);
router.post("/admin/plants", validate(AdminCreatePlantSchema), createPlant);
router.patch("/admin/plants/:id", validate(AdminUpdatePlantSchema), updatePlant);
router.post("/admin/plant_sections", validate(AdminCreatePlantSectionSchema), createPlantSection);
router.patch("/admin/plant_sections/:id", validate(AdminUpdatePlantSectionSchema), updatePlantSection);
router.post("/admin/equipment_tags", validate(AdminCreateEquipmentTagSchema), createEquipmentTag);
router.patch("/admin/equipment_tags/:id", validate(AdminUpdateEquipmentTagSchema), updateEquipmentTag);
router.post("/admin/catalog_items", validate(AdminCreateCatalogItemSchema), createCatalogItem);
router.patch("/admin/catalog_items/:id", validate(AdminUpdateCatalogItemSchema), updateCatalogItem);
router.get("/admin/company_profile", getCompanyProfile);
router.patch("/admin/company_profile", validate(AdminCompanyProfileSchema), updateCompanyProfile);

// NEW — Phase 6: Access request review (Admin only, enforced inside the
// controller via requirePermission(actor, "manageUsers")).
router.post("/access-requests/:id/approve", approveAccessRequest);
router.post("/access-requests/:id/reject", rejectAccessRequest);

// Quotes
router.post("/quotes", validate(CreateQuoteSchema), createQuote);
router.patch("/quotes/:id", validate(UpdateQuoteSchema), updateQuote);
router.post("/quotes/:id/cancel", cancelQuote);
router.post("/quotes/:id/transition", validate(TransitionQuoteSchema), transition);
router.post("/quotes/:id/po", validate(VerifyPoSchema), capturePo);
router.post("/quotes/:id/client-po", validate(ClientSubmitPoSchema), submitClientPo);

// Dispatches & Worksheets
router.post("/dispatch_cards/:id/timesheets", validate(AddTimesheetSchema), addTimesheet);
router.get("/kiosk/dispatch_cards/:id/roster", getKioskRoster);
router.post("/kiosk/dispatch_cards/:id/timesheets", validate(KioskTimesheetBatchSchema), submitKioskTimesheets);
router.post("/dispatch_cards/:id/materials", validate(AddMaterialSchema), addMaterialUsage);
router.post("/dispatch_cards/:id/worksheets", validate(CreateWorksheetSchema), createWorksheet);
router.post("/field_worksheets/:id/submit", submitWorksheet);
router.patch("/field_worksheets/:id", validate(UpdateWorksheetSchema), updateWorksheet);
router.post("/field_worksheets/:id/review", validate(ReviewWorksheetSchema), reviewWorksheet);

// Purchase Orders
router.post("/purchase_orders/:id/amendments", validate(ApproveAmendmentSchema), approveAmendment);

// Inventory & Procurement (Phase 07)
router.get("/inventory/suppliers", getSuppliers);
router.post("/inventory/suppliers", validate(CreateSupplierSchema), createSupplier);
router.patch("/inventory/suppliers/:id", validate(UpdateSupplierSchema), updateSupplier);
router.get("/inventory/stock_items", getStockItems);
router.post("/inventory/stock_items", validate(CreateStockItemSchema), createStockItem);
router.patch("/inventory/stock_items/:id", validate(UpdateStockItemSchema), updateStockItem);
router.post("/inventory/movements", validate(StockMovementSchema), recordStockMovement);
router.get("/inventory/reports/low-stock", getLowStockReport);

// Notifications (Phase 08)
router.get("/notifications", getNotifications);
router.post("/notifications/read-all", markAllRead);
router.post("/notifications/:id/read", markRead);

// Client Service Requests: Client Viewer request -> Sales/Operations triage ->
// one explicit lead. Role and client scoping are enforced inside the controller.
// Deliberately NOT a generic collection route (see collectionGuards).
router.post("/service-requests", validate(CreateServiceRequestSchema), createServiceRequest);
router.get("/service-requests/mine", listOwnServiceRequests);
router.get("/service-requests/triage", listServiceRequestTriageQueue);
router.post("/service-requests/:id/triage", validate(TriageServiceRequestSchema), triageServiceRequest);
router.post("/service-requests/:id/convert-lead", convertServiceRequestToLead);

// Internal Work Requests: controlled staff-to-staff requests. Explicit routes
// only; NOT in the generic `collections` list below, so the generic GET/deactivate
// routes can never expose or archive them. Scope (own outbox, role inbox,
// participant-only detail) is enforced inside the controller from the session.
// Fixed paths are registered before `/:id` so they are never read as an id.
router.get("/internal-work-requests/options", getInternalWorkRequestOptions);
router.get("/internal-work-requests/outbox", listInternalWorkRequestOutbox);
router.get("/internal-work-requests/inbox", listInternalWorkRequestInbox);
router.get("/internal-work-requests/:id", getInternalWorkRequest);
router.post("/internal-work-requests", validate(CreateInternalWorkRequestSchema), createInternalWorkRequest);
router.post("/internal-work-requests/:id/acknowledge", acknowledgeInternalWorkRequest);
router.post("/internal-work-requests/:id/transition", validate(TransitionInternalWorkRequestSchema), transitionInternalWorkRequest);

// Contracts & preventative maintenance (pilot). Explicit routes only. These
// records are deliberately NOT in the generic `collections` list below, so the
// generic GET/deactivate routes can never expose or archive them. The controller
// checks the role, validates the body, and scopes Client Viewer reads itself.
router.get("/contracts", listContracts);
router.post("/contracts", createContract);
router.patch("/contracts/:id", updateContract);
router.get("/maintenance-schedules", listMaintenanceSchedules);
router.post("/maintenance-schedules", createMaintenanceSchedule);
router.patch("/maintenance-schedules/:id", updateMaintenanceSchedule);

// Generic GET endpoints for collections
const collections = [
  "users", "clients", "leads", "quotes", "quote_lines",
  "purchase_orders", "dispatch_cards", "field_worksheets",
  "invoices", "equipment_tags", "catalog_items", "audit_logs",
  "mine_sites", "plants", "plant_sections",
  "suppliers", "stock_items", "stock_movements",
  "access_requests"
];

collections.forEach((collection) => {
  router.get(`/${collection}`, getCollection(collection));
  router.post(`/admin/${collection}/:id/deactivate`, deactivateEntity(collection));
  router.post(`/admin/${collection}/:id/reactivate`, reactivateEntity(collection));
});

export default router;
