import { z } from "zod";
import { roles } from "./permissions.js";
import { SERVICE_REQUEST_URGENCIES, TRIAGE_DECISION_NAMES } from "./serviceRequestRules.js";
import {
  INTERNAL_WORK_REQUEST_LIMITS, INTERNAL_WORK_REQUEST_PRIORITIES, INTERNAL_WORK_REQUEST_TRANSITION_ACTIONS,
  INTERNAL_WORK_REQUEST_TYPE_CODES, NEW_TECHNICIAN_REGISTRATION, RELATED_ENTITY_TYPE_CODES
} from "./internalWorkRequestRules.js";
import { TECHNICIAN_TRADES } from "./trades.js";
import {
  APPROVED_UNITS_OF_MEASURE,
  COST_TYPES,
  ITEM_TYPES,
  TAX_STATUSES
} from "./quoteCalculation.js";

export const QuoteLineSchema = z.object({
  catalog_item_id: z.string().nullable().optional(),
  description: z.string().min(1, "Description is required"),
  quantity: z.number().positive("Quantity must be positive"),
  unit_price: z.number().min(0, "Unit price cannot be negative"),
  work_package_id: z.string().trim().min(1).optional(),
  cost_type: z.enum(COST_TYPES).optional(),
  resource_role: z.string().trim().max(80).nullable().optional(),
  unit_of_measure: z.enum(APPROVED_UNITS_OF_MEASURE).optional(),
  item_type: z.enum(ITEM_TYPES).optional(),
  is_provisional: z.boolean().optional()
});

export const WorkPackageSchema = z.object({
  id: z.string().min(1),
  code: z.string().optional(),
  title: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  sequence: z.number().int().min(1).optional(),
  description: z.string().max(2000).optional()
}).refine((wp) => Boolean(wp.title || wp.name), {
  message: "Work package title is required",
  path: ["title"]
}).transform((wp) => ({
  ...wp,
  title: wp.title || wp.name,
  name: wp.name || wp.title
}));

export const CreateQuoteSchema = z.object({
  client_id: z.string().min(1, "Client is required"),
  equipment_tag_id: z.string().nullable().optional(),
  source_lead_id: z.string().trim().max(128).nullable().optional(),
  lines: z.array(QuoteLineSchema).min(1, "At least one quote line is required"),
  currency: z.literal("USD").optional(),
  tax_status: z.enum(TAX_STATUSES).optional(),
  applied_tax_rate: z.number().min(0).max(1).nullable().optional(),
  discount_percent: z.number().min(0).max(100).optional(),
  validity_days: z.number().int().optional(),
  scope_summary: z.string().max(2000).nullable().optional(),
  assumptions: z.string().max(2000).nullable().optional(),
  work_packages: z.array(WorkPackageSchema).optional()
});

export const UpdateQuoteSchema = z.object({
  description: z.string().optional(),
  equipment_tag_id: z.string().nullable().optional(),
  lines: z.array(QuoteLineSchema).min(1, "At least one quote line is required").optional(),
  tax_status: z.enum(TAX_STATUSES).optional(),
  applied_tax_rate: z.number().min(0).max(1).nullable().optional(),
  discount_percent: z.number().min(0).max(100).optional(),
  validity_days: z.number().int().optional(),
  scope_summary: z.string().max(2000).nullable().optional(),
  assumptions: z.string().max(2000).nullable().optional(),
  work_packages: z.array(WorkPackageSchema).optional()
});

const V5QuoteLineSchema = z.object({
  catalog_item_id: z.string().nullable().optional(),
  description: z.string().min(1, "Description is required"),
  quantity: z.number().positive("Quantity must be positive"),
  unit_price: z.number().min(0, "Unit price cannot be negative"),
  pricing_basis: z.enum(["hourly", "minimum_hours", "fixed"]),
  planned_hours: z.number().positive("Planned hours must be positive").max(24 * 366).nullable().optional(),
  materials_included: z.boolean().optional()
});

export const CreateQuoteRevisionSchema = z.object({
  reason: z.string().trim().min(3, "A revision reason is required").max(1000),
  lines: z.array(V5QuoteLineSchema).min(1, "At least one quote line is required"),
  tax_rate: z.number().min(0).max(100).nullable().optional(),
  client_po_reference: z.string().trim().min(1).max(120).nullable().optional(),
  client_po_date: z.string().date().nullable().optional()
});

export const RecordAmendedPoEvidenceSchema = z.object({
  evidence_reference: z.string().trim().min(3, "Client acceptance evidence is required").max(500),
  evidence_channel: z.enum(["amended_po", "written_acceptance"]),
  accepted_on: z.string().date(),
  notes: z.string().trim().max(1000).optional()
});

export const TransitionQuoteSchema = z.object({
  target_state: z.string().min(1, "Target state is required"),
  started_before_po: z.boolean().optional(),
  urgent_reason: z.string().optional(),
  // Used only for the documented Admin fallback when the Admin approving the
  // quote is also its sender.  All other server-owned transition fields stay
  // excluded by this schema.
  approval_exception_reason: z.string().trim().min(10, "Admin fallback approval reason must be at least 10 characters").max(500).optional()
});

export const DocumentReferenceSchema = z.string().trim()
  .min(3, "Document reference must be at least 3 characters")
  .max(100, "Document reference cannot exceed 100 characters")
  .regex(/^[A-Za-z0-9._:-]+$/, "Document reference must contain only letters, numbers, dots, underscores, colons, or hyphens");

export const VerifyPoSchema = z.object({
  po_reference: z.string().trim().min(1, "PO reference is required").max(100),
  po_amount: z.number().positive("PO amount must be greater than zero"),
  currency: z.literal("USD").optional(),
  started_before_po: z.boolean().optional(),
  date_received: z.string().optional(),
  po_issue_date: z.string().optional(),
  document_reference: DocumentReferenceSchema.optional(),
  verification_notes: z.string().trim().max(1000).optional()
});

export const AddTimesheetSchema = z.object({
  hours_logged: z.number().positive("Hours logged must be positive"),
  hourly_rate: z.number().min(0, "Hourly rate cannot be negative"),
  work_date: z.string().optional(),
  notes: z.string().optional(),
  // Required when a Technician logs their own billable time — see the
  // addTimesheet controller comment on why. Optional at the schema level so
  // a non-Technician actor's own request is not rejected before the
  // controller can apply the narrower, role-specific rule.
  source_worksheet_id: z.string().optional()
});

export const KioskTimesheetBatchSchema = z.object({
  work_date: z.string().min(1, "Work date is required"),
  // Client-generated reference for one submission, so a retry after a dropped
  // connection is recognised instead of creating duplicate entries.
  batch_key: z.string().min(8, "Submission reference is too short").max(100, "Submission reference is too long").optional(),
  entries: z.array(z.object({
    technician_id: z.string().min(1, "Technician is required"),
    hours_logged: z.number().positive("Hours logged must be positive").max(24, "Hours logged cannot exceed 24"),
    hourly_rate: z.number().min(0, "Hourly rate cannot be negative"),
    // Evidence only: what the crew reported. Not a rate and not read by billing.
    hours_breakdown: z.object({
      normal: z.number().min(0).max(24),
      ot_1_5: z.number().min(0).max(24),
      ot_2_0: z.number().min(0).max(24)
    }).optional(),
    shift: z.string().max(40, "Shift label cannot exceed 40 characters").optional(),
    notes: z.string().max(500, "Notes cannot exceed 500 characters").optional()
  })).min(1, "At least one time entry is required").max(50, "A kiosk batch cannot exceed 50 entries")
});

// Kiosk Timesheet review. The "reject requires a comment" rule is enforced in
// the controller so its message always reaches the user.
export const ReviewKioskTimesheetSchema = z.object({
  decision: z.enum(["approve", "reject"], { errorMap: () => ({ message: "Decision must be approve or reject" }) }),
  comment: z.string().max(500, "Comment cannot exceed 500 characters").optional()
});

export const AssignDispatchSupervisorSchema = z.object({
  supervisor_id: z.string().min(1, "Supervisor is required")
});

export const AssignRosterSchema = z.object({
  technician_id: z.string().min(1, "technician_id is required")
});

export const AddMaterialSchema = z.object({
  catalog_item_id: z.string().nullable().optional(),
  description: z.string().min(1, "Description is required"),
  quantity_used: z.number().positive("Quantity must be positive"),
  unit_cost: z.number().min(0, "Unit cost cannot be negative"),
  // Optional. When given for a tracked stock item it must equal the item's own
  // unit; quantities are never converted.
  unit_of_measure: z.string().min(1).optional(),
  // Optional duplicate-submission key (also accepted as the Idempotency-Key header).
  idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/, "Idempotency key must be 8-128 characters: letters, digits, . _ : -").optional()
});

export const CreateWorksheetSchema = z.object({
  activity: z.string().min(1, "Activity is required"),
  hours: z.number().positive("Hours must be greater than zero"),
  technician_id: z.string().optional(),
  work_date: z.string().optional(),
  tools_used: z.string().optional(),
  materials_used: z.array(z.any()).optional(),
  outcomes: z.string().optional(),
  challenges: z.string().optional(),
  evidence_files: z.array(z.string()).optional(),
  submit: z.boolean().optional()
});

export const UpdateWorksheetSchema = z.object({
  activity: z.string().min(1, "Activity is required").optional(),
  hours: z.number().positive("Hours must be greater than zero").optional(),
  tools_used: z.string().optional(),
  outcomes: z.string().optional(),
  challenges: z.string().optional()
});

export const ReviewWorksheetSchema = z.object({
  decision: z.enum(["approve", "return"], { errorMap: () => ({ message: "Decision must be approve or return" }) }),
  comment: z.string().optional()
});

// Chat B — client acknowledgement. Phone/tablet touch input is acceptable;
// what makes this evidence (not just a canvas doodle) is that it is stored
// server-side with a signer identity, an explicit acknowledgement, a
// timestamp and an immutable reference, all set only by this endpoint.
export const ClientAcknowledgeWorksheetSchema = z.object({
  signer_name: z.string().trim().min(1, "Signer name is required"),
  signer_role: z.string().trim().min(1, "Signer declared role is required"),
  acknowledgement: z.literal(true, { errorMap: () => ({ message: "Explicit acknowledgement is required" }) })
});

// Client return-with-reason (Implementation Contract step 1). A reason is mandatory.
export const ClientReturnWorksheetSchema = z.object({
  reason: z.string().trim().min(3, "A reason of at least 3 characters is required to return a Timesheet").max(1000)
});

// Chat B — corrections after client acknowledgement or supervisor approval
// must go through a new, reasoned, linked revision rather than editing
// signed data in place.
export const ReviseWorksheetSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required to revise an acknowledged or approved worksheet")
});

const DailyTimesheetEntrySchema = z.object({
  kind: z.enum(["entry", "separator"]).optional(),
  date: z.string().optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  normal_hours: z.union([z.number(), z.null()]).optional(),
  ot_15: z.union([z.number(), z.literal("X"), z.literal("x"), z.null()]).optional(),
  ot_20: z.union([z.number(), z.literal("X"), z.literal("x"), z.null()]).optional(),
  description: z.string().max(500, "Description cannot exceed 500 characters").optional()
});

const SignatureSchema = z.object({
  name: z.string().optional(),
  date: z.string().optional()
});

export const CreateDailyTimesheetSchema = z.object({
  technician_id: z.string().optional(),
  name_on_form: z.string().min(1, "Name is required"),
  category: z.string().optional(),
  department_section: z.string().optional(),
  cell_number: z.string().optional(),
  entries: z.array(DailyTimesheetEntrySchema).max(60, "A daily time sheet cannot exceed 60 rows").optional(),
  signatures: z.object({
    employee: SignatureSchema.optional(),
    site_foreman: SignatureSchema.optional(),
    customer_representative: SignatureSchema.optional()
  }).optional(),
  signed_copy_image: z.string().optional(),
  submit: z.boolean().optional(),
  // Sales Desk paper entry (capture_method and entered_by are server-stamped, never accepted from the client).
  source: z.literal("paper_entry").optional(),
  client_paper_reference: z.string().max(200).optional(),
  signatory_name_on_paper: z.string().max(120).optional(),
  scan_reference: z.string().max(500).optional(),
  scan_hash: z.string().max(200).optional()
});

export const UpdateDailyTimesheetSchema = CreateDailyTimesheetSchema.partial();
export const ReviewDailyTimesheetSchema = z.object({
  decision: z.enum(["approve", "return"], { errorMap: () => ({ message: "Decision must be approve or return" }) }),
  comment: z.string().optional()
});

const ContractorLogRowSchema = z.object({
  worker_name: z.string().optional(),
  grade: z.enum(["Artisan", "Assistant"]).optional(),
  normal: z.union([z.number(), z.null()]).optional(),
  ot_15: z.union([z.number(), z.null()]).optional(),
  ot_20: z.union([z.number(), z.null()]).optional(),
  comments: z.string().max(500, "Comments cannot exceed 500 characters").optional()
});

const ContractorLogSignOffSchema = z.object({
  name: z.string().optional(),
  signature: z.string().optional(),
  date: z.string().optional()
});

export const CreateContractorLogSchema = z.object({
  contractor_name: z.string().min(1, "Name of Contractor is required"),
  department_section: z.string().optional(),
  section: z.string().optional(),
  order_no: z.string().optional(),
  log_date: z.string().optional(),
  work_description: z.string().max(1000, "Work description cannot exceed 1000 characters").optional(),
  rows: z.array(ContractorLogRowSchema).max(40, "A contractor log cannot exceed 40 rows").optional(),
  signatures: z.object({
    supervisor: ContractorLogSignOffSchema.optional(),
    foreman: ContractorLogSignOffSchema.optional()
  }).optional(),
  submit: z.boolean().optional()
});

export const UpdateContractorLogSchema = CreateContractorLogSchema.partial();
export const ReviewContractorLogSchema = z.object({
  decision: z.enum(["approve", "return"], { errorMap: () => ({ message: "Decision must be approve or return" }) }),
  comment: z.string().optional()
});

export const ApproveAmendmentSchema = z.object({
  new_amount: z.number().positive("New amount must be positive"),
  reason: z.string().optional()
});

export const ApproveV5AmendmentSchema = z.object({
  approval_note: z.string().optional()
});

export const CreateLeadSchema = z.object({
  company_name: z.string().min(1, "Company name is required"),
  contact_name: z.string().min(1, "Contact name is required"),
  email: z.string().email("A valid email is required"),
  service_need: z.string().min(1, "Service need is required"),
  phone: z.string().optional(),
  mine_site: z.string().optional(),
  urgency: z.string().optional()
});

export const LoginSchema = z.object({
  email: z.string().email("Valid email required"),
  password: z.string().min(1).max(72).optional()
});

export const AdminCreateUserSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Valid email required"),
  password: z.string().min(10, "Password must be at least 10 characters").max(72),
  role: z.enum(Object.values(roles), { errorMap: () => ({ message: "Invalid role" }) }),
  is_active: z.boolean().optional(),
  client_id: z.string().optional(),
  trade: z.enum(TECHNICIAN_TRADES).nullable().optional(),
  national_id: z.string().trim().max(32).nullable().optional(),
  employee_code: z.string().trim().max(32).nullable().optional()
}).refine(
  (data) => data.role !== roles.CLIENT_VIEWER || Boolean(data.client_id),
  { message: "client_id is required when role is Client Viewer.", path: ["client_id"] }
);

export const AdminUpdateUserSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  password: z.string().min(10, "Password must be at least 10 characters").max(72).optional(),
  role: z.enum(Object.values(roles)).optional(),
  is_active: z.boolean().optional(),
  client_id: z.string().optional(),
  trade: z.enum(TECHNICIAN_TRADES).nullable().optional(),
  national_id: z.string().trim().max(32).nullable().optional(),
  employee_code: z.string().trim().max(32).nullable().optional()
});
// NOTE (Chat E gap fix): the equivalent "Client Viewer requires client_id"
// rule for updates is enforced in adminController.updateUser instead of
// here, because this is a partial-update schema — at schema-validation time
// we cannot see the user's pre-existing role/client_id, only whichever
// fields this particular request happens to touch. The controller checks
// the combined *final* state (existing + incoming changes) before writing.

export const AdminCreateClientSchema = z.object({
  name: z.string().min(1, "Name is required"),
  client_type: z.string().min(1, "Client type is required"),
  contact_person: z.string().optional(),
  email: z.union([z.string().email(), z.literal("")]).optional()
});

export const AdminUpdateClientSchema = z.object({
  name: z.string().min(1).optional(),
  client_type: z.string().optional(),
  contact_person: z.string().optional(),
  email: z.union([z.string().email(), z.literal("")]).optional()
});

export const AdminCreateMineSiteSchema = z.object({
  client_id: z.string().min(1, "Client is required"),
  name: z.string().min(1, "Name is required"),
  location: z.string().optional()
});

export const AdminUpdateMineSiteSchema = z.object({
  client_id: z.string().optional(),
  name: z.string().min(1).optional(),
  location: z.string().optional()
});

export const AdminCreatePlantSchema = z.object({
  mine_site_id: z.string().min(1, "Mine site is required"),
  name: z.string().min(1, "Name is required"),
  plant_code: z.string().min(1, "Plant code is required")
});

export const AdminUpdatePlantSchema = z.object({
  mine_site_id: z.string().optional(),
  name: z.string().min(1).optional(),
  plant_code: z.string().min(1).optional()
});

export const AdminCreatePlantSectionSchema = z.object({
  plant_id: z.string().min(1, "Plant is required"),
  name: z.string().min(1, "Name is required"),
  section_code: z.string().min(1, "Section code is required")
});

export const AdminUpdatePlantSectionSchema = z.object({
  plant_id: z.string().optional(),
  name: z.string().min(1).optional(),
  section_code: z.string().min(1).optional()
});

export const AdminCreateEquipmentTagSchema = z.object({
  plant_section_id: z.string().min(1, "Plant section is required"),
  tag_code: z.string().min(1, "Tag code is required"),
  equipment_name: z.string().min(1, "Equipment name is required"),
  criticality: z.string().optional(),
  status: z.string().optional()
});

export const AdminUpdateEquipmentTagSchema = z.object({
  plant_section_id: z.string().optional(),
  tag_code: z.string().min(1).optional(),
  equipment_name: z.string().min(1).optional(),
  criticality: z.string().optional(),
  status: z.string().optional()
});

export const AdminCreateCatalogItemSchema = z.object({
  item_code: z.string().min(1, "Item code is required"),
  item_name: z.string().min(1, "Item name is required"),
  category: z.string().optional(),
  unit_of_measure: z.string().optional(),
  unit_price: z.number().min(0, "Unit price cannot be negative"),
  material_grade: z.string().optional(),
  dimensions: z.string().optional()
});

export const AdminUpdateCatalogItemSchema = z.object({
  item_code: z.string().min(1).optional(),
  item_name: z.string().min(1).optional(),
  category: z.string().optional(),
  unit_of_measure: z.string().optional(),
  unit_price: z.number().min(0, "Unit price cannot be negative").optional(),
  material_grade: z.string().optional(),
  dimensions: z.string().optional()
});

export const AdminCompanyProfileSchema = z.object({
  company_name: z.string().min(1).optional(),
  legal_name: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  brand_primary: z.string().optional(),
  brand_slate: z.string().optional(),
  // This is the only production authority for quotation tax.  A Sales quote
  // request must never be able to declare itself taxable or approved.
  quotation_tax_configuration: z.object({
    tax_status: z.enum(["taxable", "zero-rated", "exempt"]),
    applied_tax_rate: z.number().min(0).max(1).nullable(),
    approved: z.boolean(),
    approval_reference: z.string().trim().min(1).max(256).optional()
  }).superRefine((configuration, context) => {
    if (configuration.tax_status === "taxable" && !(configuration.applied_tax_rate > 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["applied_tax_rate"],
        message: "A taxable quotation tax configuration requires a positive applied tax rate."
      });
    }
    if (configuration.tax_status !== "taxable" && configuration.applied_tax_rate !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["applied_tax_rate"],
        message: "Zero-rated and exempt quotation tax configurations require a 0 tax rate."
      });
    }
    if (configuration.approved && !configuration.approval_reference) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approval_reference"],
        message: "An approved quotation tax configuration requires an accountant approval reference."
      });
    }
  }).optional()
});

export const ClientSubmitPoSchema = z.object({
  po_reference: z.string().trim().min(1, "PO reference is required").max(100),
  po_amount: z.number().positive("PO amount must be greater than zero"),
  currency: z.literal("USD").optional(),
  date_received: z.string().optional(),
  po_issue_date: z.string().optional(),
  document_reference: DocumentReferenceSchema.optional(),
  idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/).optional()
});

export const RejectPoSchema = z.object({
  reason: z.string().trim().min(3, "Rejection reason must be at least 3 characters").max(1000)
});

// ── Inventory & Procurement (Phase 07) ─────────────────────────────────────

export const CreateSupplierSchema = z.object({
  name: z.string().min(1, "Supplier name is required"),
  contact_person: z.string().optional(),
  email: z.union([z.string().email(), z.literal("")]).optional(),
  phone: z.string().optional(),
  lead_time_days: z.number().int().min(0).optional()
});

export const UpdateSupplierSchema = z.object({
  name: z.string().min(1).optional(),
  contact_person: z.string().optional(),
  email: z.union([z.string().email(), z.literal("")]).optional(),
  phone: z.string().optional(),
  lead_time_days: z.number().int().min(0).optional()
});

export const CreateStockItemSchema = z.object({
  catalog_item_id: z.string().optional(),
  item_code: z.string().min(1, "Item code is required"),
  item_name: z.string().min(1, "Item name is required"),
  unit_of_measure: z.string().min(1, "Unit of measure is required"),
  quantity_on_hand: z.number().min(0, "Quantity cannot be negative").optional(),
  reorder_level: z.number().min(0, "Reorder level cannot be negative").optional(),
  unit_cost: z.number().min(0, "Unit cost cannot be negative").optional(),
  supplier_id: z.string().optional(),
  location: z.string().optional()
});

export const UpdateStockItemSchema = z.object({
  item_code: z.string().min(1).optional(),
  item_name: z.string().min(1).optional(),
  unit_of_measure: z.string().optional(),
  reorder_level: z.number().min(0).optional(),
  unit_cost: z.number().min(0).optional(),
  supplier_id: z.string().optional(),
  location: z.string().optional()
});

export const StockMovementSchema = z.object({
  stock_item_id: z.string().min(1, "Stock item is required"),
  movement_type: z.enum(["in", "out", "adjustment"], {
    errorMap: () => ({ message: "Movement type must be in, out, or adjustment" })
  }),
  quantity: z.number().refine((v) => v !== 0, "Quantity cannot be zero"),
  reason: z.string().min(1, "Reason is required"),
  reference_id: z.string().optional(),
  // Optional and additive: identifies what kind of record reference_id points
  // at so the ledger can resolve a readable label (see inventoryLedger.js).
  // Omitting it is still valid — older callers and manual entries with no
  // linked record are unaffected. "direct_sale" is reserved for the
  // dedicated /inventory/movements/direct-sale endpoint, not this one.
  reference_type: z.enum(["dispatch_card", "purchase_order", "supplier", "material_usage", "return", "scrap"]).optional(),
  // Only meaningful for a "return" reference today; stored either way so a
  // future reference_type can use it without a schema change.
  client_id: z.string().optional(),
  override_negative: z.boolean().optional(),
  // Evidence for a supplier receipt: delivery note or supplier invoice number.
  source_document_ref: z.string().trim().max(120).optional(),
  // Optional duplicate-submission key (also accepted as the Idempotency-Key header).
  idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/, "Idempotency key must be 8-128 characters: letters, digits, . _ : -").optional()
});

// Chat C's authorised direct-sale stock issue contract. See
// CHAT_C_DIRECT_SALE_STOCK_ISSUE_CONTRACT.md for the full description of who
// calls this and when. This schema deliberately has no price/tax/invoice
// fields — this endpoint issues stock, it does not record a sale.
export const DirectSaleStockIssueSchema = z.object({
  stock_item_id: z.string().min(1, "Stock item is required"),
  quantity: z.number().positive("Quantity must be a positive number"),
  reason: z.string().min(1, "Reason is required"),
  client_id: z.string().min(1, "Client is required for a direct-sale issue"),
  // The id of whatever record Chat C's commercial flow uses to represent the
  // approved direct sale (an order, invoice, or receipt id). This ledger
  // does not validate that record exists — it only stores and displays it.
  sale_reference_id: z.string().min(1, "A sale reference id is required"),
  override_negative: z.boolean().optional()
});

// ── Client Service Requests ────────────────────────────────────────────────
// Strict: identity, tenant, status, triage and lead fields are never accepted
// from the caller (client_id, created_by_user_id, status, triaged_*, converted_*).

export const CreateServiceRequestSchema = z.strictObject({
  title: z.string().trim().min(1, "Title is required").max(160, "Title cannot exceed 160 characters"),
  service_need: z.string().trim().min(1, "Service need is required").max(2000, "Service need cannot exceed 2000 characters"),
  urgency: z.enum(SERVICE_REQUEST_URGENCIES, { message: "Urgency must be standard, planned_shutdown or urgent_downtime" }).optional(),
  mine_site_id: z.string().min(1).nullable().optional(),
  equipment_tag_id: z.string().min(1).nullable().optional(),
  requested_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Requested date must be YYYY-MM-DD").nullable().optional()
});

export const TriageServiceRequestSchema = z.strictObject({
  decision: z.enum(TRIAGE_DECISION_NAMES, { message: "Decision must be acknowledge, accept or decline" }),
  note: z.string().trim().max(1000, "Note cannot exceed 1000 characters").optional()
});

// ── Internal Work Requests ─────────────────────────────────────────────────
// Strict: sender, role, client, status, assignee, history and timestamps are
// never accepted from the caller. Pairing and related-record checks need the
// session and the database, so the controller performs them.

// `payload` is the structured detail of a technician registration. Here it is
// shape-only and strict (no extra keys); the allow-lists, limits and patterns
// are enforced by parseTechnicianPayload, which the controller always runs.
// Subject and description are required for every other type and generated by
// the server for a registration (parseCreateBody enforces both rules).
export const CreateInternalWorkRequestSchema = z.strictObject({
  request_type: z.enum(INTERNAL_WORK_REQUEST_TYPE_CODES, { message: "Request type is not recognised" }),
  subject: z.string().trim().max(INTERNAL_WORK_REQUEST_LIMITS.subject, "Subject is too long").optional(),
  description: z.string().trim().max(INTERNAL_WORK_REQUEST_LIMITS.description, "Description is too long").optional(),
  payload: z.strictObject({
    first_name: z.string(),
    last_name: z.string(),
    national_id: z.string(),
    trade: z.string(),
    worker_type: z.string(),
    phone_number: z.string()
  }).optional(),
  priority: z.enum(INTERNAL_WORK_REQUEST_PRIORITIES, { message: "Priority is not recognised" }).optional(),
  recipient_role: z.enum(Object.values(roles), { message: "Recipient role is not recognised" }).optional(),
  related_entity_type: z.enum(RELATED_ENTITY_TYPE_CODES, { message: "Related record type is not recognised" }).nullable().optional(),
  related_entity_id: z.string().trim().min(1).max(INTERNAL_WORK_REQUEST_LIMITS.relatedId).nullable().optional()
}).superRefine((data, ctx) => {
  if (data.request_type === NEW_TECHNICIAN_REGISTRATION) return;
  if (!data.subject) ctx.addIssue({ code: "custom", path: ["subject"], message: "Subject is required" });
  if (!data.description) ctx.addIssue({ code: "custom", path: ["description"], message: "Description is required" });
});

export const TransitionInternalWorkRequestSchema = z.strictObject({
  action: z.enum(INTERNAL_WORK_REQUEST_TRANSITION_ACTIONS, { message: "Action must be start, complete, reject or cancel" }),
  note: z.string().trim().max(INTERNAL_WORK_REQUEST_LIMITS.note, "Note is too long").optional()
});

// Contracts and preventative maintenance (pilot)
//
// Every object is strict: a caller may not send id, contract_number,
// created_by_user_id, created_at or updated_at, and gets a 400 naming the
// unknown key instead of having it silently dropped.

export function isRealIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

const IsoDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date format YYYY-MM-DD")
  .refine(isRealIsoDate, "Enter a real calendar date");

const ContractTitleSchema = z.string().trim().min(1, "Contract title is required").max(160, "Contract title cannot exceed 160 characters");
const ContractValueSchema = z.number().min(0, "Contract value cannot be negative").max(1_000_000_000_000, "Contract value is too large").nullable();
const MaintenanceNotesSchema = z.string().trim().max(500, "Notes cannot exceed 500 characters");

export const CONTRACT_STATUSES = ["Draft", "Active", "Expired", "Cancelled"];
export const MAINTENANCE_FREQUENCIES = ["Weekly", "Monthly", "Quarterly", "Biannual", "Annual"];

// A new contract starts as Draft or Active. Expired and Cancelled are reached
// only by updating an existing contract.
export const CreateContractSchema = z.object({
  client_id: z.string().trim().min(1, "Client is required"),
  title: ContractTitleSchema,
  start_date: IsoDateSchema,
  end_date: IsoDateSchema,
  total_value: ContractValueSchema.optional(),
  status: z.enum(["Draft", "Active"]).optional()
}).strict();

// client_id is intentionally absent: a contract cannot be moved to another client.
export const UpdateContractSchema = z.object({
  title: ContractTitleSchema.optional(),
  start_date: IsoDateSchema.optional(),
  end_date: IsoDateSchema.optional(),
  total_value: ContractValueSchema.optional(),
  status: z.enum(CONTRACT_STATUSES).optional()
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one contract field is required"
);

export const CreateMaintenanceScheduleSchema = z.object({
  contract_id: z.string().trim().min(1, "Contract is required"),
  equipment_tag_id: z.string().trim().min(1, "Equipment tag cannot be empty").nullable().optional(),
  frequency: z.enum(MAINTENANCE_FREQUENCIES),
  next_due_date: IsoDateSchema,
  notes: MaintenanceNotesSchema.optional()
}).strict();

// contract_id is intentionally absent: a schedule cannot move to another contract.
export const UpdateMaintenanceScheduleSchema = z.object({
  equipment_tag_id: z.string().trim().min(1, "Equipment tag cannot be empty").nullable().optional(),
  frequency: z.enum(MAINTENANCE_FREQUENCIES).optional(),
  next_due_date: IsoDateSchema.optional(),
  notes: MaintenanceNotesSchema.optional()
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one schedule field is required"
);

export const V5MaterialAllocationSchema = z.object({
  material_usage_id: z.string().min(1),
  quote_line_id: z.string().min(1)
});

export const V5AmendmentDispatchLinkSchema = z.object({
  amendment_quote_id: z.string().min(1)
});

export const V5AmendmentEvidenceAllocationSchema = z.object({
  amendment_quote_id: z.string().min(1),
  amendment_quote_line_id: z.string().min(1),
  source_type: z.enum(["field_worksheet", "material_usage"]),
  source_id: z.string().min(1),
  quantity: z.number().positive(),
  reason: z.string().min(3)
});

export const CreateV5InvoiceDraftSchema = z.object({
  idempotency_key: z.string().min(1),
  lines: z.array(z.object({
    quote_line_id: z.string().min(1),
    sources: z.array(z.object({
      source_type: z.enum(["field_worksheet", "material_usage"]),
      source_id: z.string().min(1),
      quantity: z.number().positive().refine((v) => Math.abs(v * 1000000 - Math.round(v * 1000000)) < 1e-7, "Invalid decimal precision")
    })).optional()
  })).min(1)
}).strict();

export const IssueV5InvoiceDraftSchema = z.object({
  idempotency_key: z.string().min(1)
}).strict();

// The legacy commercial path uses a separate draft/issue lifecycle. These
// payloads intentionally carry no money: the server recalculates from
// approved field evidence at preparation and again at issue.
export const CreateLegacyInvoiceDraftSchema = z.object({
  idempotency_key: z.string().min(1)
}).strict();

export const IssueLegacyInvoiceDraftSchema = z.object({
  idempotency_key: z.string().min(1)
}).strict();

export const V5LineCompletionSchema = z.object({
  quote_line_id: z.string().min(1),
  reason: z.string().min(1),
  idempotency_key: z.string().min(1)
}).strict();

export const V5AmendmentSupersessionSchema = z.object({
  superseded_amendment_quote_id: z.string().min(1),
  replacement_amendment_quote_id: z.string().min(1),
  reason: z.string().min(1),
  idempotency_key: z.string().min(1)
}).strict().refine((data) => data.superseded_amendment_quote_id !== data.replacement_amendment_quote_id, {
  message: "Cannot supersede an amendment with itself"
});

export const V5AllocationRemapSchema = z.object({
  allocation_id: z.string().min(1),
  replacement_amendment_quote_line_id: z.string().min(1),
  reason: z.string().min(1),
  idempotency_key: z.string().min(1)
}).strict();

export const RecordInvoicePaymentSchema = z.object({
  amount: z.number().positive(),
  payment_method: z.string().min(1),
  reference: z.string().min(1),
  received_on: z.string().min(1),
  notes: z.string().nullable().optional()
});

export const VoidInvoicePaymentSchema = z.object({
  reason: z.string().min(1)
});

export const CreateInvoiceCreditNoteSchema = z.object({
  amount: z.number().positive(),
  reason: z.string().min(1)
});

const COMMERCIAL_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export const AssignCommercialOwnershipSchema = z.object({
  target_entity: z.enum(["client", "quote"]),
  target_id: z.string().regex(COMMERCIAL_ID_REGEX, "Invalid target_id format"),
  owner_id: z.string().regex(COMMERCIAL_ID_REGEX, "Invalid owner_id format"),
  account_team_user_ids: z.array(z.string().regex(COMMERCIAL_ID_REGEX, "Invalid account_team_user_id format"))
    .default([])
    .transform((ids) => [...new Set(ids)]),
  reason: z.string().trim().min(10, "A valid business reason (at least 10 characters) is required for ownership assignment.")
}).refine((data) => !data.account_team_user_ids.includes(data.owner_id), {
  message: "Primary owner cannot also appear in account_team_user_ids",
  path: ["account_team_user_ids"]
});

export const IssueInvoiceCreditNoteSchema = z.object({
  idempotency_key: z.string().min(1)
});
