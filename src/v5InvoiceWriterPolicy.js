import { v5Enabled } from "./v5CommercialWorkflow.js";

export const V5_INVOICE_WRITER_FLAG = "ORAC_V5_INVOICE_WRITER";
export const V5_INVOICE_JSON_ACKNOWLEDGEMENT = "ORAC_V5_INVOICE_JSON_SINGLE_PROCESS";

// The writer is deliberately more restrictive than the wider V5 workflow.
// JSON can be used only by a single acknowledged process; production uses
// PostgreSQL locking through the existing persistence middleware.
export function v5InvoiceWriterRefusal({ storeDriver = process.env.STORE_DRIVER || "json" } = {}) {
  if (!v5Enabled() || process.env[V5_INVOICE_WRITER_FLAG] !== "enabled") {
    return { code: "FEATURE_DISABLED", message: "V5 invoice writing is not enabled." };
  }
  if (storeDriver === "postgres") return null;
  if (storeDriver === "json") {
    if (process.env[V5_INVOICE_JSON_ACKNOWLEDGEMENT] === "acknowledged") return null;
    return { code: "V5_INVOICE_JSON_STORE_UNSUPPORTED", message: "V5 invoice writing requires PostgreSQL or an explicit single-process JSON acknowledgement." };
  }
  return { code: "V5_INVOICE_STORE_UNSUPPORTED", message: "V5 invoice writing requires a supported store driver." };
}
