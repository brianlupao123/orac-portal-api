import { z } from "zod";
import { roles } from "./permissions.js";

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
  notes: z.string().optional()
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

export const ReviewWorksheetSchema = z.object({
  decision: z.enum(["approve", "return"], { errorMap: () => ({ message: "Decision must be approve or return" }) }),
  comment: z.string().optional()
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
  role: z.enum(Object.values(roles), { errorMap: () => ({ message: "Invalid role" }) }),
  is_active: z.boolean().optional(),
  client_id: z.string().optional()
});

export const AdminUpdateUserSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  role: z.enum(Object.values(roles)).optional(),
  is_active: z.boolean().optional(),
  client_id: z.string().optional()
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
