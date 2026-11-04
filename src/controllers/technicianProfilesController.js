import { requirePermission } from "../permissions.js";
import { isTechnicianRecord, toTechnicianProfile } from "../technicianProfiles.js";

// GET /api/technician-profiles
// Active technicians (registered users and password-less artisan profiles) with
// Trade and National ID, so the timesheet form can auto-fill from one dropdown.
export const listTechnicianProfiles = (req, res) => {
  const actor = req.db.users.find((u) => u.id === req.user.id);
  requirePermission(actor, "viewTechnicianProfiles");

  const data = req.db.users
    .filter((user) => user.is_active && isTechnicianRecord(user))
    .map(toTechnicianProfile)
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({ success: true, data });
};
