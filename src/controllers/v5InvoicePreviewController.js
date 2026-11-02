import { requirePermission } from "../permissions.js";
import { v5Enabled } from "../v5CommercialWorkflow.js";
import { buildV5InvoicePreview } from "../v5InvoicePreview.js";

export function getV5InvoicePreview(req, res) {
  const actor = (req.db.users || []).find((user) => user.id === req.user?.id);
  requirePermission(actor, "viewV5InvoicePreview");
  if (!v5Enabled()) return res.status(409).json({ success: false, code: "FEATURE_DISABLED", message: "V5 invoice preview is not enabled yet." });
  const result = buildV5InvoicePreview(req.db, req.params.id);
  if (result.error) return res.status(result.error.status).json({ success: false, ...result.error });
  return res.json({ success: true, data: result.data });
}
