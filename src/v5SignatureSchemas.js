import { z } from "zod";

// Evidence-only inputs. Every schema is strict: an account, role, password, OTP,
// rate or any other unknown key is rejected rather than silently dropped.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[a-fA-F0-9]{64}$/;

export const V5ClientSupervisorContactSchema = z.object({
  name: z.string().trim().min(2, "The client Supervisor's name is required").max(120),
  title: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().email("Enter a valid email address").max(200).optional(),
  source_reference: z.string().trim().min(3, "State how the client named this person (PO, email, minutes)").max(200),
  dispatch_scoped: z.boolean().optional()
}).strict();

export const V5PaperSignatureSchema = z.object({
  client_supervisor_contact_id: z.string().trim().min(1, "Select the named client Supervisor contact"),
  worker_name_on_paper: z.string().trim().min(2).max(120),
  client_supervisor_name_on_paper: z.string().trim().min(2).max(120),
  worker_signed_on_paper: z.literal(true, { message: "The worker's paper signature must be present" }),
  client_supervisor_signed_on_paper: z.literal(true, { message: "The client Supervisor's paper signature must be present" }),
  paper_attestation: z.literal(true, { message: "Explicit paper attestation is required" }),
  evidence_reference: z.string().trim().min(3).max(200),
  source_channel: z.string().trim().min(2).max(60),
  custodian_user_id: z.string().trim().min(1),
  received_date: z.string().regex(ISO_DATE, "received_date must be YYYY-MM-DD"),
  scan_hash: z.string().regex(SHA256, "scan_hash must be a SHA-256 hex digest"),
  replacement_reason: z.string().trim().min(5).max(300).optional()
}).strict();

export const V5SupervisorConfirmationSchema = z.object({
  evidence_id: z.string().trim().min(1),
  hours_hash: z.string().regex(SHA256, "hours_hash must be a SHA-256 hex digest"),
  attest: z.literal(true, { message: "Explicit confirmation is required" })
}).strict();
