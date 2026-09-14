import { randomUUID } from "node:crypto";
import { getActor, buildScopedSummary } from "./coreController.js";
import { metricsForRole, buildBriefing, buildAttentionItems, buildChatReply, explainMetric } from "../services/aiTemplates.js";
import { roles } from "../permissions.js";

const ENABLED_ROLES = new Set(Object.values(roles));

function allowedActor(req, res) {
  const actor = getActor(req);
  if (!actor?.is_active || !ENABLED_ROLES.has(actor.role)) {
    res.status(403).json({ success: false, message: "The providerless dashboard assistant is not enabled for this role." });
    return null;
  }
  return actor;
}

function audit(req, actor, requestId, intent, response) {
  req.store.audit(req.db, actor, "ai_request", requestId, "AI_PHASE_0_5_RESPONSE", null, {
    intent,
    response_mode: response.label,
    metric_keys: response.claims.map((item) => item.metric),
    evidence_targets: response.evidenceRefs.map((item) => item.targetId),
    generated_at: response.generatedAt
  });
}

function uniqueEvidenceRefs(claims) {
  const seen = new Set();
  const refs = [];
  for (const claim of claims) {
    for (const ref of claim.evidenceRefs || []) {
      if (!ref?.metric || !ref?.targetId || seen.has(`${ref.metric}:${ref.targetId}`)) continue;
      seen.add(`${ref.metric}:${ref.targetId}`);
      refs.push(ref);
    }
  }
  return refs;
}

function respond(req, res, actor, intent, build) {
  const requestId = randomUUID();
  let response;
  try {
    response = {
      requestId,
      intent,
      label: "Verified dashboard summary",
      claims: build(buildScopedSummary(req.db, actor)),
      generatedAt: new Date().toISOString()
    };
    response.evidenceRefs = uniqueEvidenceRefs(response.claims);
    response.message = response.claims.map((claim) => claim.sentence).join(" ");
  } catch {
    response = {
      requestId,
      intent,
      label: "Unavailable",
      claims: [],
      evidenceRefs: [],
      message: "I could not verify that from your current dashboard evidence.",
      generatedAt: new Date().toISOString()
    };
  }
  audit(req, actor, requestId, intent, response);
  res.json({ success: true, data: response });
}

export function getAiHealth(req, res) {
  const actor = allowedActor(req, res);
  if (!actor) return;
  res.json({
    success: true,
    data: {
      phase: "0.5",
      enabled: true,
      intents: ["dashboard_briefing", "attention_items", "metric_explanation", "dashboard_chat"],
      metrics: metricsForRole(actor.role)
    }
  });
}

export function getBriefing(req, res) {
  const actor = allowedActor(req, res);
  if (actor) respond(req, res, actor, "dashboard_briefing", (payload) => buildBriefing(payload, actor.role));
}

export function getAttentionItems(req, res) {
  const actor = allowedActor(req, res);
  if (actor) respond(req, res, actor, "attention_items", (payload) => buildAttentionItems(payload, actor.role));
}

export function getMetricExplanation(req, res) {
  const actor = allowedActor(req, res);
  if (!actor) return;
  const metric = typeof req.body?.metric === "string" ? req.body.metric : "";
  respond(req, res, actor, "metric_explanation", (payload) => [explainMetric(payload, actor.role, metric)]);
}

export function getChatResponse(req, res) {
  const actor = allowedActor(req, res);
  if (!actor) return;
  const question = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 500) : "";
  if (!question) {
    return res.status(400).json({ success: false, message: "Enter a dashboard question before sending." });
  }
  // The raw question is deliberately not stored in the audit record.
  respond(req, res, actor, "dashboard_chat", (payload) => buildChatReply(payload, actor.role, question));
}

export function flagAiResponse(req, res) {
  const actor = allowedActor(req, res);
  if (!actor) return;
  const requestId = typeof req.body?.request_id === "string" ? req.body.request_id.slice(0, 128) : "";
  if (!requestId) return res.status(400).json({ success: false, message: "A request id is required." });
  req.store.audit(req.db, actor, "ai_request", requestId, "AI_PHASE_0_5_FLAGGED", null, {
    category: "needs_review",
    flagged_at: new Date().toISOString()
  });
  res.json({ success: true, data: { requestId, flagged: true } });
}
