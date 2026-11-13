import { requirePermission } from "../permissions.js";
import { isTechnicianRecord } from "../technicianProfiles.js";

export function getTechnicianSettlementDetails(req, res) {
  const actor = (req.db.users || []).find((user) => user.id === req.user?.id);
  requirePermission(actor, "viewTechnicianSettlementDetails");
  const technician = (req.db.users || []).find((user) => user.id === req.params.id && user.is_active && isTechnicianRecord(user));
  if (!technician) return res.status(404).json({ success: false, message: "Technician not found." });
  const data = {
    technician_id: technician.id,
    payment_method: technician.payment_method || null,
    ecocash_number: technician.ecocash_number || technician.phone_number || null,
    bank_name: technician.bank_name || null,
    bank_account: technician.bank_account || null,
    bank_branch: technician.bank_branch || null,
    employee_code: technician.employee_code || null
  };
  req.store.audit(req.db, actor, "technician_settlement_details", technician.id, "TECHNICIAN_SETTLEMENT_DETAILS_VIEWED", null, {
    fields: Object.keys(data).filter((key) => key !== "technician_id" && data[key] !== null)
  });
  return res.json({ success: true, data });
}
