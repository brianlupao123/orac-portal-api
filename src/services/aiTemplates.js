const ROLE_METRICS = {
  Operations: ["dispatches", "worksheets", "pending_review", "returned_for_correction"],
  Finance: ["blocked_amendments", "pending_po", "invoices"]
};

const METRIC_LABELS = {
  dispatches: "Dispatch records",
  worksheets: "Field worksheets",
  pending_review: "Worksheets awaiting review",
  returned_for_correction: "Worksheets returned for correction",
  blocked_amendments: "POs requiring amendment",
  pending_po: "Quotes awaiting a purchase order",
  invoices: "Invoices"
};

const EVIDENCE_TARGETS = {
  clients: { targetId: "evidence-kpi-clients", type: "kpi" },
  quotes: { targetId: "evidence-kpi-quotes", type: "kpi" },
  dispatches: { targetId: "evidence-kpi-dispatches", type: "kpi" },
  invoices: { targetId: "evidence-kpi-invoices", type: "kpi" },
  worksheets: { targetId: "evidence-kpi-worksheets", type: "kpi" },
  pending_review: { targetId: "evidence-kpi-worksheets-review", type: "kpi" },
  returned_for_correction: { targetId: "evidence-kpi-returned-for-correction", type: "kpi" },
  pending_po: { targetId: "evidence-pipeline-approved-pending-po", type: "pipeline" },
  blocked_amendments: { targetId: "evidence-kpi-blocked-amendments", type: "kpi" }
};

function assertMetric(payload, metric) {
  if (!Object.hasOwn(payload, metric)) {
    throw new Error(`Metric ${metric} is unavailable for this summary.`);
  }
  return payload[metric];
}

function evidenceReference(payload, metric) {
  const value = assertMetric(payload, metric);
  const target = EVIDENCE_TARGETS[metric];
  if (!target) return null;
  return {
    metric,
    label: METRIC_LABELS[metric] || metric,
    value,
    ...target
  };
}

function claim(payload, metric, sentence) {
  const reference = evidenceReference(payload, metric);
  return {
    metric,
    value: assertMetric(payload, metric),
    sentence,
    evidenceRefs: reference ? [reference] : []
  };
}

export function metricsForRole(role) {
  return (ROLE_METRICS[role] || []).map((key) => ({ key, label: METRIC_LABELS[key] }));
}

export function buildBriefing(payload, role) {
  if (role === "Operations") {
    return [
      claim(payload, "dispatches", `Your dashboard currently includes ${assertMetric(payload, "dispatches")} dispatch record(s).`),
      claim(payload, "pending_review", `${assertMetric(payload, "pending_review")} worksheet(s) are awaiting review.`),
      claim(payload, "returned_for_correction", `${assertMetric(payload, "returned_for_correction")} worksheet(s) are returned for correction.`)
    ];
  }
  if (role === "Finance") {
    return [
      claim(payload, "blocked_amendments", `${assertMetric(payload, "blocked_amendments")} PO(s) are flagged as requiring amendment.`),
      claim(payload, "pending_po", `${assertMetric(payload, "pending_po")} quote(s) are awaiting a purchase order.`),
      claim(payload, "invoices", `Your dashboard currently includes ${assertMetric(payload, "invoices")} invoice record(s).`)
    ];
  }
  throw new Error("This role is not enabled for the providerless assistant.");
}

export function buildAttentionItems(payload, role) {
  const claims = buildBriefing(payload, role);
  return claims.filter((item) => Number(item.value) > 0);
}

export function explainMetric(payload, role, metric) {
  if (!ROLE_METRICS[role]?.includes(metric)) {
    throw new Error("This metric is unavailable for your dashboard.");
  }
  const value = assertMetric(payload, metric);
  return claim(payload, metric, `${METRIC_LABELS[metric]} currently shows ${value} in your verified dashboard summary.`);
}
