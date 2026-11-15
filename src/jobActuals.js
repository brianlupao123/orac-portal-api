import { evaluateForDb } from "./timesheetEligibility.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const CLASSES = ["normal", "ot_15", "ot_20"];

/**
 * Single-source calculator for job actual hours.
 * Enforces that:
 * 1. Only field worksheets matching the dispatch_card_id are considered.
 * 2. Superseded revisions (ws.superseded_by truthy) are strictly ignored.
 * 3. The worksheet must evaluate as eligible (Supervisor_Approved under legacy or cutover rules).
 * 4. Daily timesheets and worksheet registers are never summed (zero double-counting).
 */
export function jobActuals(db, dispatchId) {
  const out = { total: 0, normal: 0, ot_15: 0, ot_20: 0, ids: [] };
  if (!db || !dispatchId) return out;

  for (const ws of db.field_worksheets || []) {
    if (ws.dispatch_card_id !== dispatchId) continue;
    if (ws.superseded_by) continue;

    const evalResult = evaluateForDb(db, ws);
    if (!evalResult || !evalResult.eligible) continue;

    out.ids.push(ws.id);
    out.total = r2(out.total + r2(ws.hours || 0));
    for (const c of CLASSES) {
      out[c] = r2(out[c] + r2(ws.hours_breakdown?.[c] || 0));
    }
  }

  return out;
}
