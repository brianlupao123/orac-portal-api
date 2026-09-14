const ROLE_METRICS = {
  Admin: ["clients", "quotes", "dispatches", "invoices", "blocked_amendments"],
  Management: ["clients", "quotes", "dispatches", "invoices", "pending_review"],
  Sales: ["clients", "quotes"],
  Operations: ["dispatches", "worksheets", "pending_review", "returned_for_correction"],
  Finance: ["blocked_amendments", "pending_po", "invoices"],
  Supervisor: ["dispatches", "pending_review", "returned_for_correction"],
  Technician: ["dispatches", "worksheets", "pending_review"],
  "Client Viewer": ["clients", "quotes", "dispatches", "invoices"]
};

const METRIC_LABELS = {
  clients: "Clients",
  quotes: "Active quotes",
  dispatches: "Dispatch records",
  worksheets: "Field worksheets",
  pending_review: "Worksheets awaiting review",
  returned_for_correction: "Worksheets returned for correction",
  blocked_amendments: "POs requiring amendment",
  pending_po: "Quotes awaiting a purchase order",
  invoices: "Invoices"
};

const QUESTION_METRICS = [
  { pattern: /\b(clients?|organisations?|customers?)\b/i, metric: "clients" },
  { pattern: /\b(quotes?|quotations?|pipeline|sales)\b/i, metric: "quotes" },
  { pattern: /\b(dispatch(?:es)?|jobs?|service)\b/i, metric: "dispatches" },
  { pattern: /\b(invoices?|billing|payments?)\b/i, metric: "invoices" },
  { pattern: /\b(worksheets?|work sheets?|field work)\b/i, metric: "worksheets" },
  { pattern: /\b(reviews?|approvals?)\b/i, metric: "pending_review" },
  { pattern: /\b(return(?:ed)?|corrections?|resubmit)\b/i, metric: "returned_for_correction" },
  { pattern: /\b(purchase orders?|\bpo\b|pending po)\b/i, metric: "pending_po" },
  { pattern: /\b(amendments?|blocked|risks?)\b/i, metric: "blocked_amendments" }
];

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
  if (role === "Admin") {
    return [
      claim(payload, "clients", `${assertMetric(payload, "clients")} client organisation(s) are in the current system view.`),
      claim(payload, "quotes", `${assertMetric(payload, "quotes")} active quote record(s) are visible.`),
      claim(payload, "blocked_amendments", `${assertMetric(payload, "blocked_amendments")} PO amendment(s) need attention.`)
    ];
  }
  if (role === "Management") {
    return [
      claim(payload, "quotes", `${assertMetric(payload, "quotes")} quote record(s) are in the current business view.`),
      claim(payload, "dispatches", `${assertMetric(payload, "dispatches")} dispatch record(s) are visible.`),
      claim(payload, "pending_review", `${assertMetric(payload, "pending_review")} worksheet(s) await review.`)
    ];
  }
  if (role === "Sales") {
    return [
      claim(payload, "clients", `${assertMetric(payload, "clients")} client organisation(s) are available to Sales.`),
      claim(payload, "quotes", `${assertMetric(payload, "quotes")} active quote record(s) are available for follow-up.`)
    ];
  }
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
  if (role === "Supervisor") {
    return [
      claim(payload, "dispatches", `${assertMetric(payload, "dispatches")} dispatch record(s) are in your review scope.`),
      claim(payload, "pending_review", `${assertMetric(payload, "pending_review")} worksheet(s) await your review.`),
      claim(payload, "returned_for_correction", `${assertMetric(payload, "returned_for_correction")} worksheet(s) await technician correction.`)
    ];
  }
  if (role === "Technician") {
    return [
      claim(payload, "dispatches", `${assertMetric(payload, "dispatches")} dispatch record(s) are assigned to you.`),
      claim(payload, "worksheets", `${assertMetric(payload, "worksheets")} worksheet(s) are in your work scope.`),
      claim(payload, "pending_review", `${assertMetric(payload, "pending_review")} submitted worksheet(s) await review.`)
    ];
  }
  if (role === "Client Viewer") {
    return [
      claim(payload, "quotes", `${assertMetric(payload, "quotes")} quote record(s) belong to your organisation.`),
      claim(payload, "dispatches", `${assertMetric(payload, "dispatches")} service dispatch record(s) belong to your organisation.`),
      claim(payload, "invoices", `${assertMetric(payload, "invoices")} invoice record(s) belong to your organisation.`)
    ];
  }
  throw new Error("This role is not enabled for the providerless assistant.");
}

export function buildAttentionItems(payload, role) {
  const claims = buildBriefing(payload, role);
  return claims.filter((item) => Number(item.value) > 0);
}

export function buildChatReply(payload, role, question) {
  const allowedMetrics = ROLE_METRICS[role] || [];
  const requested = QUESTION_METRICS
    .filter(({ pattern, metric }) => pattern.test(question) && allowedMetrics.includes(metric))
    .map(({ metric }) => metric);
  const metrics = [...new Set(requested)].slice(0, 3);
  const selected = metrics.length > 0 ? metrics : allowedMetrics.slice(0, 3);

  return selected.map((metric) => claim(
    payload,
    metric,
    `${METRIC_LABELS[metric]} currently shows ${assertMetric(payload, metric)} in your verified dashboard summary.`
 ));
}

export function explainMetric(payload, role, metric) {
  if (!ROLE_METRICS[role]?.includes(metric)) {
    throw new Error("This metric is unavailable for your dashboard.");
  }
  const value = assertMetric(payload, metric);
  return claim(payload, metric, `${METRIC_LABELS[metric]} currently shows ${value} in your verified dashboard summary.`);
}
