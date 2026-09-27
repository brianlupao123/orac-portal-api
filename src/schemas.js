import { z } from "zod";
import { roles } from "./permissions.js";
import { SERVICE_REQUEST_URGENCIES, TRIAGE_DECISION_NAMES } from "./serviceRequestRules.js";
import {
  INTERNAL_WORK_REQUEST_LIMITS, INTERNAL_WORK_REQUEST_PRIORITIES, INTERNAL_WORK_REQUEST_TRANSITION_ACTIONS,
  INTERNAL_WORK_REQUEST_TYPE_CODES, RELATED_ENTITY_TYPE_CODES
} from "./internalWorkRequestRules.js";
import { TECHNICIAN_TRADES } from "./trades.js";

export const QuoteLineSchema = z.object({
  catalog_item_id: z.string().nullable().optional(),
  description: z.string().min(1, "Description is required"),
  quantity: z.number().positive("Quantity must be positive"),
  unit_price: z.number().min(0, "Unit price cannot be negative")
});

export const CreateQuoteSchema = z.object({
  client_id: z.string().min(1, "Client is required"),
  equipment_tag_id: z.string().nullable().optional(),
  lines: z.array(QuoteLineSchema).min(1, "At least one quote line is required")
});

export const UpdateQuoteSchema = z.object({
  description: z.string().optional(),
  equipment_tag_id: z.string().nullable().optional(),
  lines: z.array(QuoteLineSchema).min(1, "At least one quote line is required").optional()
});

export const TransitionQuoteSchema = z.object({
  target_state: z.string().min(1, "Target state is required"),
  started_before_po: z.boolean().optional(),
  urgent_reason: z.string().optional()
});

export const VerifyPoSchema = z.object({
  po_reference: z.string().min(1, "PO reference is required"),
  po_amount: z.number().positive("PO amount must be greater than zero"),
  started_before_po: z.boolean().optional(),
  date_received: z.string().optional()
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
  entries: z.array(z.object({
    technician_id: z.string().min(1, "Technician is required"),
    hours_logged: z.number().positive("Hours logged must be positive").max(24, "Hours logged cannot exceed 24"),
    hourly_rate: z.number().min(0, "Hourly rate cannot be negative"),
    notes: z.string().max(500, "Notes cannot exceed 500 characters").optional()
  })).min(1, "At least one time entry is required").max(50, "A kiosk batch cannot exceed 50 entries")
});

export const AssignRosterSchema = z.object({
  technician_id: z.string().min(1, "technician_id is required")
});

export const AddMaterialSchema = z.object({
  catalog_item_id: z.string().nullable().optional(),
  description: z.string().min(1, "Description is required"),
  quantity_used: z.number().positive("Quantity must be positive"),
  unit_cost: z.number().min(0, "Unit cost cannot be negative")
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

// Chat B — corrections after client acknowledgement or supervisor approval
// must go through a new, reasoned, linked revision rather than editing
// signed data in place.
export const ReviseWorksheetSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required to revise an acknowledged or approved worksheet")
});

export const ApproveAmendmentSchema = z.object({
  new_amount: z.number().positive("New amount must be positive"),
  reason: z.string().optional()
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
  trade: z.enum(TECHNICIAN_TRADES).nullable().optional()
});

export const AdminUpdateUserSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  password: z.string().min(10, "Password must be at least 10 characters").max(72).optional(),
  role: z.enum(Object.values(roles)).optional(),
  is_active: z.boolean().optional(),
  client_id: z.string().optional(),
  trade: z.enum(TECHNICIAN_TRADES).nullable().optional()
});

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
  brand_slate: z.string().optional()
});

export const ClientSubmitPoSchema = z.object({
  po_reference: z.string().min(1, "PO reference is required"),
  po_amount: z.number().positive("PO amount must be greater than zero"),
  date_received: z.string().optional()
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

export const CreateInternalWorkRequestSchema = z.strictObject({
  request_type: z.enum(INTERNAL_WORK_REQUEST_TYPE_CODES, { message: "Request type is not recognised" }),
  subject: z.string().trim().min(1, "Subject is required").max(INTERNAL_WORK_REQUEST_LIMITS.subject, "Subject is too long"),
  description: z.string().trim().min(1, "Description is required").max(INTERNAL_WORK_REQUEST_LIMITS.description, "Description is too long"),
  priority: z.enum(INTERNAL_WORK_REQUEST_PRIORITIES, { message: "Priority is not recognised" }).optional(),
  recipient_role: z.enum(Object.values(roles), { message: "Recipient role is not recognised" }).optional(),
  related_entity_type: z.enum(RELATED_ENTITY_TYPE_CODES, { message: "Related record type is not recognised" }).nullable().optional(),
  related_entity_id: z.string().trim().min(1).max(INTERNAL_WORK_REQUEST_LIMITS.relatedId).nullable().optional()
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
