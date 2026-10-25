import { buildQuoteTrail, recordTrailEnabled } from "../recordTrail.js";

export const getQuoteTrail = (req, res) => {
  if (!recordTrailEnabled()) {
    return res.status(404).json({ success: false, code: "TRAIL_DISABLED", message: "Not found." });
  }
  const actor = (req.db.users || []).find((user) => user.id === req.user?.id);
  if (!actor || actor.is_active === false) {
    return res.status(401).json({ success: false, message: "Authentication required." });
  }
  const eventCursor = typeof req.query?.event_cursor === "string" ? req.query.event_cursor : undefined;
  const result = buildQuoteTrail(req.db, req.params.id, actor, { eventCursor });
  if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });
  return res.json({ success: true, data: result.data });
};
