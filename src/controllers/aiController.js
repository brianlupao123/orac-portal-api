import { randomUUID } from "node:crypto";
import { getActor, buildScopedSummary } from "./coreController.js";
import { metricsForRole, buildBriefing, buildAttentionItems, buildChatReply, explainMetric, workflowClaim } from "../services/aiTemplates.js";
import { buildWorkflowReply, guidanceForArticle, unavailableGuide } from "../services/aiWorkflowAssistant.js";
import { APPROVAL_STATE, CATALOG_VERSION, articlesForRole } from "../services/aiWorkflowKnowledge.js";
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
    // Structured, non-sensitive outcome data only. The question text, the
    // answer text and any record content are never stored.
    outcome: response.outcome,
    article_ids: (response.guidance ? [response.guidance.articleId] : []),
    article_versions: (response.guidance ? [response.guidance.version] : []),
    catalog_version: CATALOG_VERSION,
    link_ids: response.links.map((item) => item.id),
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
    const claims = build(buildScopedSummary(req.db, actor));
    const meta = claims.meta || {};
    response = {
      requestId,
      intent,
      label: meta.label || "Verified dashboard summary",
      outcome: meta.outcome || "answered",
      claims,
      guidance: meta.guidance || null,
      links: Array.isArray(meta.links) ? meta.links : [],
      generatedAt: new Date().toISOString()
    };
    response.evidenceRefs = uniqueEvidenceRefs(response.claims);
    response.message = response.claims.message || response.claims.map((claim) => claim.sentence).join(" ");
  } catch {
    response = {
      requestId,
      intent,
      label: "Unavailable",
      outcome: "unavailable",
      claims: [],
      evidenceRefs: [],
      guidance: null,
      links: [],
      message: "I could not verify that from your current ORAC evidence. Nothing was changed. Try again later, or open the screen for your role directly.",
      generatedAt: new Date().toISOString()
    };
  }
  audit(req, actor, requestId, intent, response);
  res.json({ success: true, data: response });
}

// Adapt a workflow result to the claims-array shape respond() already uses.
function fromWorkflow(result) {
  const claims = [...result.claims];
  claims.message = result.message;
  claims.meta = { label: result.label, outcome: result.outcome, guidance: result.guidance, links: result.links };
  return claims;
}

export function getAiHealth(req, res) {
  const actor = allowedActor(req, res);
  if (!actor) return;
  res.json({
    success: true,
    data: {
      phase: "0.5",
      enabled: true,
      // Providerless and read-only: no model, no outbound calls, no mutations.
      mode: "deterministic-read-only",
      provider: null,
      intents: ["dashboard_briefing", "attention_items", "metric_explanation", "dashboard_chat", "workflow_guidance"],
      metrics: metricsForRole(actor.role),
      catalog_version: CATALOG_VERSION,
      approval: APPROVAL_STATE,
      workflow_topics: articlesForRole(actor.role).map((article) => ({ id: article.id, title: article.title }))
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
  const lastContext = req.body?.lastContext && typeof req.body.lastContext === "object" ? {
    metric: typeof req.body.lastContext.metric === "string" ? req.body.lastContext.metric : "",
    targetId: typeof req.body.lastContext.targetId === "string" ? req.body.lastContext.targetId : "",
    label: typeof req.body.lastContext.label === "string" ? req.body.lastContext.label : "",
    // Only an id; it is re-validated against the caller's role before use.
    articleId: typeof req.body.lastContext.articleId === "string" ? req.body.lastContext.articleId.slice(0, 64) : ""
  } : null;
  respond(req, res, actor, "dashboard_chat", (payload) => {
    // The actor comes from the authenticated session, never from the body.
    const workflow = buildWorkflowReply({ actor, question, payload, lastContext, claimFactory: workflowClaim });
    return workflow ? fromWorkflow(workflow) : buildChatReply(payload, actor.role, question, { lastContext });
  });
}

// Quick-start guide by article id. The id is data, not authority: the guide is
// returned only if the caller's own role has a part in that article.
export function getWorkflowGuide(req, res) {
  const actor = allowedActor(req, res);
  if (!actor) return;
  const articleId = typeof req.body?.article_id === "string" ? req.body.article_id.slice(0, 64) : "";
  respond(req, res, actor, "workflow_guidance", (payload) => {
    const reply = guidanceForArticle(actor, articleId, payload, workflowClaim) || unavailableGuide(actor);
    return fromWorkflow(reply);
  });
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
