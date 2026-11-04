import { z } from "zod";

// Worksheet request schemas. Kept in their own module so schemas.js is
// not touched. Every object is STRICT: an unknown key is rejected, not silently
// dropped. That is how "technicians never enter their hourly rate" is enforced
// at the API edge: a body carrying hourly_rate / rate / amount is a 400.

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be YYYY-MM-DD");

const RosterEntrySchema = z.object({
  technician_id: z.string().min(1).nullable().optional(),
  display_name: z.string().trim().min(1, "Employee name is required").max(120).optional(),
  group: z.string().trim().max(80).optional()
}).strict();

const RowRefSchema = z.object({
  source_type: z.enum(["timesheet", "daily_timesheet", "contractor_log"], { message: "source_type must be timesheet, daily_timesheet or contractor_log" }),
  record_id: z.string().min(1),
  row_index: z.number().int().min(0).max(59),
  reason: z.string().trim().min(3, "A reason of at least 3 characters is required").max(300)
}).strict();

const ScopeSchema = z.object({
  client_id: z.string().min(1, "Client is required"),
  project_title: z.string().trim().min(1, "Project title is required").max(160),
  quote_id: z.string().min(1).nullable().optional(),
  purchase_order_id: z.string().min(1).nullable().optional(),
  department_section: z.string().trim().max(120).optional()
}).strict();

const base = {
  title: z.string().trim().min(1, "Title is required").max(160),
  period_start: IsoDate,
  period_end: IsoDate,
  scope: ScopeSchema,
  roster: z.array(RosterEntrySchema).min(1, "At least one employee is required").max(150, "A roster cannot exceed 150 employees"),
  // BLOCKED: public-holiday classification waits for the company policy (OD-05).
  // An empty list is tolerated; any date is refused with this message.
  public_holiday_dates: z.array(z.any()).max(0, "Public-holiday classification is blocked until the company policy is decided.").optional(),
  look_around_days: z.number().int().min(0).max(62).optional(),
  exclusions: z.array(RowRefSchema).max(200).optional(),
  carry_overs: z.array(RowRefSchema).max(200).optional()
};

// Preview: the same body as create, minus preview_hash. It is read-only and never saves.
export const PreviewWorksheetRegisterSchema = z.object(base).strict();
// Create: optional preview_hash (SHA-256 of the figures the person was shown). When present, the save
// is refused with STALE_PREVIEW if the approved Timesheets changed since that preview.
export const CreateWorksheetRegisterSchema = z.object({
  ...base,
  preview_hash: z.string().regex(/^[0-9a-f]{64}$/, "preview_hash must be a lowercase SHA-256 hex string").optional()
}).strict();
export const UpdateWorksheetRegisterSchema = z.object(base).partial().strict();

export const AcknowledgeRegisterExceptionsSchema = z.object({
  keys: z.array(z.string().min(1)).min(1).max(100),
  note: z.string().trim().min(3, "An acknowledgement note of at least 3 characters is required").max(300)
}).strict();

export const ReviewWorksheetRegisterSchema = z.object({
  decision: z.enum(["approve", "return"], { message: "Decision must be approve or return" }),
  comment: z.string().max(1000).optional()
}).strict();

export const CancelWorksheetRegisterSchema = z.object({
  reason: z.string().trim().min(3, "A cancellation reason of at least 3 characters is required").max(300)
}).strict();

export const ReconcileWorksheetRegisterSchema = z.object({
  confirm: z.literal(true, { message: "Explicit confirmation is required" })
}).strict();
