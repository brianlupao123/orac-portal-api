import { z } from "zod";

// Timesheet (v2) create/update schemas. They EXTEND the legacy worksheet body
// (activity, hours, materials_used, outcomes ...) so older callers still work.
// A v2 body supplies hours_breakdown; `hours` is then derived by the server and
// a supplied `hours` that disagrees is refused. There is deliberately no rate,
// amount or cost field anywhere: unknown keys are rejected, not dropped.

const Hour = z.union([z.number(), z.literal("X"), z.literal("x"), z.null()]);
const Breakdown = z.object({ normal: Hour.optional(), ot_15: Hour.optional(), ot_20: Hour.optional() }).strict();
const Material = z.object({
  description: z.string().trim().min(1, "Material description is required").max(200),
  quantity: z.number().positive("Material quantity must be greater than zero").max(100000),
  unit: z.string().trim().max(30).optional()
}).strict();
const EmployeeSignoff = z.object({
  name: z.string().trim().max(120).optional(),
  date: z.string().max(10).optional(),
  method: z.enum(["on_device", "paper_scan"]).optional(),
  attest: z.boolean().optional()
}).strict();

// Sales Desk paper entry. capture_method and who entered it are server-stamped, so they are NOT accepted here.
const PaperEntryFields = {
  source: z.literal("paper_entry").optional(),
  client_paper_reference: z.string().trim().max(200).optional(),
  signatory_name_on_paper: z.string().trim().max(120).optional(),
  scan_reference: z.string().trim().max(500).optional(),
  scan_hash: z.string().trim().max(200).optional()
};
const PAPER_KEYS = ["client_paper_reference", "signatory_name_on_paper", "scan_reference", "scan_hash"];

const shared = {
  activity: z.string().trim().min(1, "Work description is required").max(2000),
  hours_breakdown: Breakdown.optional(),
  hours: z.number().positive("Hours must be greater than zero").optional(),
  start_time: z.string().max(5).optional(),
  end_time: z.string().max(5).optional(),
  technician_id: z.string().optional(),
  quote_line_id: z.string().optional(),
  work_date: z.string().optional(),
  worker_type: z.enum(["technician", "contractor"]).optional(),
  worker_name: z.string().trim().max(120).optional(),
  worker_category: z.string().trim().max(80).optional(),
  tools_used: z.string().max(1000).optional(),
  materials_used: z.array(Material).max(40, "A Timesheet cannot list more than 40 materials").optional(),
  outcomes: z.string().max(2000).optional(),
  challenges: z.string().max(2000).optional(),
  evidence_files: z.array(z.string()).optional(),
  signatures: z.object({ employee: EmployeeSignoff.optional() }).strict().optional(),
  signed_copy_image: z.string().optional(),
  client_request_id: z.string().min(8, "Submission reference is too short").max(100, "Submission reference is too long").optional(),
  captured_offline_at: z.string().max(40).optional(),
  submit: z.boolean().optional(),
  ...PaperEntryFields
};

const needHours = (v) => v.hours_breakdown !== undefined || v.hours !== undefined;
const paperConsistent = (v) => (v.source === "paper_entry"
  ? Boolean(v.client_paper_reference) && Boolean(v.signatory_name_on_paper)
  : PAPER_KEYS.every((k) => !v[k]));
export const CreateTimesheetSchemaV2 = z.object(shared).strict()
  .refine(needHours, { message: "Normal, 1.5 and 2.0 hours are required.", path: ["hours_breakdown"] })
  .refine(paperConsistent, { message: "A paper entry needs source paper_entry with client_paper_reference and signatory_name_on_paper; paper details cannot be sent without it.", path: ["source"] });
export const UpdateTimesheetSchemaV2 = z.object(shared).partial().strict();
