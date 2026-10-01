import { getKnowledgeForMetric, getRoleGuidance, ORAC_WORKFLOW_KNOWLEDGE } from "./aiKnowledgeBase.js";

export const ROLE_METRICS = {
  Admin: ["clients", "quotes", "dispatches", "invoices", "blocked_amendments"],
  Management: ["clients", "quotes", "dispatches", "invoices", "pending_review"],
  Sales: ["clients", "quotes"],
  Operations: ["dispatches", "worksheets", "pending_review", "returned_for_correction"],
  Finance: ["blocked_amendments", "pending_po", "invoices"],
  Supervisor: ["dispatches", "pending_review", "returned_for_correction"],
  Technician: ["dispatches", "worksheets", "pending_review"],
  "Client Viewer": ["clients", "quotes", "dispatches", "invoices"]
};

export const METRIC_LABELS = {
  clients: "Clients",
  quotes: "Active quotes",
  dispatches: "Dispatch records",
  worksheets: "Field worksheets",
  pending_review: "Worksheets awaiting review",
  returned_for_correction: "Worksheets returned for correction",
  blocked_amendments: "POs requiring amendment",
  pending_po: "Quotes awaiting a purchase order",
  invoices: "Invoices",
  pending_client_acknowledgement: "Timesheets awaiting client acknowledgement",
  pending_supervisor_review: "Timesheets awaiting Supervisor review"
};

const QUESTION_METRICS = [
  { pattern: /\b(clients?|organisations?|organizations?|customers?)\b/i, metric: "clients" },
  { pattern: /\b(quotes?|quotations?|pipeline|sales)\b/i, metric: "quotes" },
  { pattern: /\b(dispatch(?:es)?|jobs?|service)\b/i, metric: "dispatches" },
  { pattern: /\b(invoices?|billing|payments?)\b/i, metric: "invoices" },
  { pattern: /\b(worksheets?|work sheets?|field work)\b/i, metric: "worksheets" },
  { pattern: /\b(reviews?|approvals?)\b/i, metric: "pending_review" },
  { pattern: /\b(return(?:ed)?|corrections?|resubmit)\b/i, metric: "returned_for_correction" },
  { pattern: /\b(purchase orders?|\bpo\b|pending po)\b/i, metric: "pending_po" },
  { pattern: /\b(amendments?|blocked|risks?|problem|delay|stuck)\b/i, metric: "blocked_amendments" }
];

const KNOWN_TOPIC_WORDS = [
  "client", "customer", "quote", "quotation", "pipeline", "sales", "dispatch", "job", "service",
  "invoice", "billing", "payment", "worksheet", "field work", "review", "approval", "returned",
  "correction", "po", "purchase order", "amendment", "blocked", "risk", "attention", "summary",
  "next", "priority", "workflow", "what should"
];

const FOLLOW_UP_PATTERN = /\b(that|that one|this|this one|tell me more|explain that|more detail|which one|why|what next)\b/i;

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

// Same grounding rule as the dashboard claims: value comes from the scoped payload.
export function workflowClaim(payload, metric, sentence) {
  return claim(payload, metric, sentence);
}

function attachMessage(claims, message) {
  claims.message = message;
  return claims;
}

function formatDashboardAnswer({ title, finding, evidence, nextAction }) {
  return [
    title,
    finding ? `Finding: ${finding}` : "",
    evidence ? `Evidence: ${evidence}` : "",
    nextAction ? `Next action: ${nextAction}` : ""
  ].filter(Boolean).join("\n\n");
}

function metricEvidence(payload, metrics) {
  return metrics
    .filter((metric) => Object.hasOwn(payload, metric))
    .map((metric) => `${METRIC_LABELS[metric]} = ${assertMetric(payload, metric)}`)
    .join("; ");
}

function metricFinding(payload, metrics) {
  return metrics
    .filter((metric) => Object.hasOwn(payload, metric))
    .map((metric) => `${METRIC_LABELS[metric].toLowerCase()} currently shows ${assertMetric(payload, metric)}`)
    .join(", ");
}

function priorityMetricsForRole(role) {
  if (role === "Finance") return ["blocked_amendments", "pending_po", "invoices"];
  if (role === "Operations") return ["pending_review", "returned_for_correction", "dispatches"];
  if (role === "Supervisor") return ["pending_review", "returned_for_correction", "dispatches"];
  if (role === "Technician") return ["dispatches", "worksheets", "pending_review"];
  if (role === "Sales") return ["quotes", "clients"];
  if (role === "Client Viewer") return ["quotes", "dispatches", "invoices"];
  if (role === "Management") return ["pending_review", "quotes", "dispatches"];
  return ["blocked_amendments", "quotes", "clients"];
}

function classifyConversationIntent(text) {
  const q = String(text || "").toLowerCase().trim();
  if (/^(hi|hello|hey|good morning|good afternoon|good evening)\b/.test(q)) return "greeting";
  if (q.includes("what can you do") || q.includes("help") || q.includes("how do i use") || q.includes("what should i ask")) return "help";
  if (q.includes("confused") || q.includes("worried") || q.includes("anxious") || q.includes("stress") || q.includes("stuck") || q.includes("not working") || q.includes("don't understand") || q.includes("do not understand")) return "support";
  if (q.includes("stupid") || q.includes("useless") || q.includes("nonsense") || q.includes("idiot") || q.includes("shut up")) return "boundary";
  if (FOLLOW_UP_PATTERN.test(q)) return "follow_up";
  if (!KNOWN_TOPIC_WORDS.some((word) => q.includes(word))) return "no_match";
  return "dashboard";
}

function guidanceMessage(role) {
  const guidance = getRoleGuidance(role);
  if (!guidance) return "I can help explain verified dashboard evidence for your role.";
  return `${guidance.purpose}\n\nYou can ask about:\n${guidance.topics.map((topic) => `- ${METRIC_LABELS[topic] || topic}`).join("\n")}\n\nUseful questions:\n- Summarize my dashboard\n- What needs attention?\n- What should I do next?`;
}

function nextActionFor(role, metrics) {
  const guidance = getRoleGuidance(role);
  if (!guidance?.priorities?.length) return "Use the highlighted evidence to decide the next permitted workflow action.";
  const first = metrics[0];
  const knowledge = getKnowledgeForMetric(first);
  return knowledge?.nextAction || guidance.priorities[0];
}

export function metricsForRole(role) {
  return (ROLE_METRICS[role] || []).map((key) => ({ key, label: METRIC_LABELS[key] }));
}

export function buildBriefing(payload, role) {
  const metrics = (ROLE_METRICS[role] || []).slice(0, 3);
  if (!metrics.length) throw new Error("This role is not enabled for the providerless assistant.");
  const claims = metrics.map((metric) => claim(payload, metric, `${METRIC_LABELS[metric]} currently shows ${assertMetric(payload, metric)} in this role-scoped dashboard.`));
  return attachMessage(claims, formatDashboardAnswer({
    title: `${role} dashboard summary`,
    finding: metricFinding(payload, metrics),
    evidence: metricEvidence(payload, metrics),
    nextAction: nextActionFor(role, metrics)
  }));
}

export function buildAttentionItems(payload, role) {
  const metrics = priorityMetricsForRole(role).filter((metric) => Object.hasOwn(payload, metric));
  const positive = metrics.filter((metric) => Number(assertMetric(payload, metric)) > 0);
  const selected = (positive.length > 0 ? positive : metrics).slice(0, 3);
  const claims = selected.map((metric) => claim(payload, metric, `${METRIC_LABELS[metric]} currently shows ${assertMetric(payload, metric)}.`));
  return attachMessage(claims, formatDashboardAnswer({
    title: `${role} attention check`,
    finding: positive.length > 0 ? metricFinding(payload, selected) : "no positive attention metric is visible in the current dashboard summary",
    evidence: metricEvidence(payload, selected),
    nextAction: nextActionFor(role, selected)
  }));
}

export function buildChatReply(payload, role, question, options = {}) {
  const allowedMetrics = ROLE_METRICS[role] || [];
  const intent = classifyConversationIntent(question);
  const guidance = getRoleGuidance(role);

  if (intent === "greeting") {
    return attachMessage([], `Hello. I can help you understand the ${role} dashboard using role-scoped evidence.\n\nTry asking: what needs attention, summarize this dashboard, or what should I do next.`);
  }

  if (intent === "help") {
    return attachMessage([], guidanceMessage(role));
  }

  if (intent === "boundary") {
    return attachMessage([], `I am here to help with the dashboard. I will keep answers focused on verified role-scoped evidence.\n\nTry asking: what needs attention, summarize this dashboard, or what should I do next.`);
  }

  if (intent === "no_match") {
    return attachMessage([], `I do not have verified dashboard data for that question.\n\nFor ${role}, I can help with:\n${(guidance?.topics || allowedMetrics).map((topic) => `- ${METRIC_LABELS[topic] || topic}`).join("\n")}\n\nI can also explain the ORAC workflow: ${ORAC_WORKFLOW_KNOWLEDGE.quote_to_cash.explanation}`);
  }

  if (intent === "follow_up") {
    const metric = options.lastContext?.metric;
    if (metric && allowedMetrics.includes(metric) && Object.hasOwn(payload, metric)) {
      const detail = explainMetric(payload, role, metric);
      return attachMessage([detail], formatDashboardAnswer({
        title: `More detail: ${METRIC_LABELS[metric]}`,
        finding: `${METRIC_LABELS[metric]} currently shows ${assertMetric(payload, metric)} for your role.`,
        evidence: metricEvidence(payload, [metric]),
        nextAction: nextActionFor(role, [metric])
      }));
    }
    return attachMessage([], "I can only follow up on the previous evidence if it is still available in your current role-scoped dashboard. Please ask about a visible dashboard metric.");
  }

  if (intent === "support") {
    const metrics = priorityMetricsForRole(role).filter((metric) => allowedMetrics.includes(metric) && Object.hasOwn(payload, metric)).slice(0, 2);
    const claims = metrics.map((metric) => claim(payload, metric, `${METRIC_LABELS[metric]} currently shows ${assertMetric(payload, metric)}.`));
    return attachMessage(claims, formatDashboardAnswer({
      title: "Let us make this simple",
      finding: metricFinding(payload, metrics),
      evidence: metricEvidence(payload, metrics),
      nextAction: nextActionFor(role, metrics)
    }));
  }

  const requested = QUESTION_METRICS
    .filter(({ pattern, metric }) => pattern.test(question) && allowedMetrics.includes(metric))
    .map(({ metric }) => metric);
  const selected = [...new Set(requested)].slice(0, 3);
  const metrics = selected.length > 0 ? selected : allowedMetrics.slice(0, 3);
  const claims = metrics.map((metric) => claim(payload, metric, `${METRIC_LABELS[metric]} currently shows ${assertMetric(payload, metric)} in your verified dashboard summary.`));
  return attachMessage(claims, formatDashboardAnswer({
    title: `${role} dashboard answer`,
    finding: metricFinding(payload, metrics),
    evidence: metricEvidence(payload, metrics),
    nextAction: nextActionFor(role, metrics)
  }));
}

export function explainMetric(payload, role, metric) {
  if (!ROLE_METRICS[role]?.includes(metric)) {
    throw new Error("This metric is unavailable for your dashboard.");
  }
  const value = assertMetric(payload, metric);
  const knowledge = getKnowledgeForMetric(metric);
  const sentence = knowledge
    ? `${knowledge.title}: current value is ${value}. ${knowledge.explanation} Next action: ${knowledge.nextAction}`
    : `${METRIC_LABELS[metric]} currently shows ${value} in your verified dashboard summary.`;
  return claim(payload, metric, sentence);
}
