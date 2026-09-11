import express from "express";
import { authMiddleware } from "./middleware/auth.js";
import { validate } from "./middleware/validate.js";
import {
  LoginSchema, CreateQuoteSchema, TransitionQuoteSchema, VerifyPoSchema,
  AddTimesheetSchema, AddMaterialSchema, CreateWorksheetSchema,
  ReviewWorksheetSchema, ApproveAmendmentSchema, CreateLeadSchema,
  AdminCreateUserSchema, AdminUpdateUserSchema, AdminCreateClientSchema, AdminUpdateClientSchema,
  AdminCreateMineSiteSchema, AdminUpdateMineSiteSchema, AdminCreatePlantSchema, AdminUpdatePlantSchema,
  AdminCreatePlantSectionSchema, AdminUpdatePlantSectionSchema, AdminCreateEquipmentTagSchema, AdminUpdateEquipmentTagSchema,
  AdminCreateCatalogItemSchema, AdminUpdateCatalogItemSchema, AdminCompanyProfileSchema,
  ClientSubmitPoSchema,
  CreateSupplierSchema, UpdateSupplierSchema,
  CreateStockItemSchema, UpdateStockItemSchema,
  StockMovementSchema
} from "./schemas.js";

import { loginDemoUser, getMe, requestPasswordReset, resetPassword } from "./controllers/authController.js";
import { createAccessRequest, approveAccessRequest, rejectAccessRequest } from "./controllers/accessRequestsController.js";
import { createQuote, transition, capturePo, submitClientPo, updateQuote, cancelQuote } from "./controllers/quoteController.js";
import {
  addTimesheet, addMaterialUsage, createWorksheet,
  submitWorksheet, reviewWorksheet, approveAmendment, updateWorksheet
} from "./controllers/dispatchController.js";
import { getSummary, exportPastel, createLead, getCollection, reactivateEntity, deactivateEntity } from "./controllers/coreController.js";
import { getQuoteDocument, getDispatchDocument, getWorksheetDocument, getInvoiceDocument, getPoDocument, getQuotePdf, getJobCardPdf, getWorksheetPdf, getInvoicePdf, getPoDocumentPdf } from "./controllers/documentController.js";
import { getPipelineReport, getPoComplianceReport, getDispatchReport, getWorksheetReport, getInvoiceReadyReport, getVarianceReport } from "./controllers/reportsController.js";
import { createUser, updateUser, createClient, updateClient, createMineSite, updateMineSite, createPlant, updatePlant, createPlantSection, updatePlantSection, createEquipmentTag, updateEquipmentTag, createCatalogItem, updateCatalogItem, getCompanyProfile, updateCompanyProfile } from "./controllers/adminController.js";
import { getSuppliers, createSupplier, updateSupplier, getStockItems, createStockItem, updateStockItem, recordStockMovement, getLowStockReport } from "./controllers/inventoryController.js";
import { getNotifications, markAllRead, markRead } from "./controllers/notificationController.js";

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

// Printable/document-data endpoints (Phase 03)
router.get("/document-data/quotes/:id", getQuoteDocument);
router.get("/document-data/dispatch_cards/:id", getDispatchDocument);
router.get("/document-data/field_worksheets/:id", getWorksheetDocument);
router.get("/document-data/invoices/:id", getInvoiceDocument);
router.get("/document-data/purchase_orders/:id", getPoDocument);

// Printable document endpoints (Phase 09)
router.get("/documents/quotes/:id.pdf", getQuotePdf);
router.get("/documents/job-cards/:id.pdf", getJobCardPdf);
router.get("/documents/worksheets/:id.pdf", getWorksheetPdf);
router.get("/documents/invoices/:id.pdf", getInvoicePdf);
router.post("/invoices/:id/void", deactivateEntity("invoices"));
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
router.patch("/quotes/:id", updateQuote);
router.post("/quotes/:id/cancel", cancelQuote);
router.post("/quotes/:id/transition", validate(TransitionQuoteSchema), transition);
router.post("/quotes/:id/po", validate(VerifyPoSchema), capturePo);
router.post("/quotes/:id/client-po", validate(ClientSubmitPoSchema), submitClientPo);

// Dispatches & Worksheets
router.post("/dispatch_cards/:id/timesheets", validate(AddTimesheetSchema), addTimesheet);
router.post("/dispatch_cards/:id/materials", validate(AddMaterialSchema), addMaterialUsage);
router.post("/dispatch_cards/:id/worksheets", validate(CreateWorksheetSchema), createWorksheet);
router.post("/field_worksheets/:id/submit", submitWorksheet);
router.patch("/field_worksheets/:id", updateWorksheet);
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
