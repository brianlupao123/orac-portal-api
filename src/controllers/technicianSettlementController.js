import { requirePermission } from "../permissions.js";
import { isTechnicianRecord } from "../technicianProfiles.js";
import { decryptPaymentDetails, PAYMENT_FIELDS } from "../paymentDetails.js";

// POST /api/technicians/:id/settlement-details/access
// Finance and Admin only. Returns a contractor's decrypted payment details and records who opened
// them. POST (not GET) so the access event goes through the persisting write path; GET requests
// never persist. The audit record names the fields, never the values.
export const accessTechnicianSettlementDetails = (req, res) => {
  const actor = req.db.users.find((u) => u.id === req.user.id);
  requirePermission(actor, "viewTechnicianSettlementDetails");
  const target = req.db.users.find((u) => u.id === req.params.id);
  if (!target || !isTechnicianRecord(target)) return res.status(404).json({ success: false, message: "Technician not found." });

  const details = decryptPaymentDetails(target.payment_details);
  req.store.audit(req.db, actor, "user", target.id, "TECHNICIAN_SETTLEMENT_DETAILS_VIEWED", null, {
    fields_returned: PAYMENT_FIELDS.filter((f) => details[f] !== undefined),
    employee_code_returned: Boolean(target.employee_code)
  });
  res.json({
    success: true,
    data: {
      technician_id: target.id,
      employee_code: target.employee_code ?? null,
      payment_method: details.payment_method ?? null,
      ecocash_number: details.ecocash_number ?? null,
      bank_name: details.bank_name ?? null,
      bank_account: details.bank_account ?? null,
      bank_branch: details.bank_branch ?? null
    }
  });
};
