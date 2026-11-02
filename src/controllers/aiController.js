import { randomUUID } from "node:crypto";
import { getActor, buildScopedSummary } from "./coreController.js";
import { metricsForRole, buildBriefing, buildAttentionItems, buildChatReply, explainMetric, workflowClaim } from "../services/aiTemplates.js";
import { buildWorkflowReply, guidanceForArticle, unavailableGuide } from "../services/aiWorkflowAssistant.js";
import { APPROVAL_STATE, CATALOG_VERSION, articlesForRole } from "../services/aiWorkflowKnowledge.js";
import { roles } from "../permissions.js";
import { buildQuoteTrail, buildDispatchAnalysis, buildInvoiceAnalysis, buildPurchaseOrderAnalysis, buildSupplierAnalysis, buildMaintenanceScheduleAnalysis, buildEquipmentTagAnalysis, buildMaterialUsageAnalysis, buildFieldWorksheetAnalysis, buildCatalogItemAnalysis, buildStockItemAnalysis, buildWorksheetRegisterAnalysis, buildServiceRequestAnalysis, buildDailyTimesheetAnalysis, buildContractorLogAnalysis, recordAnalysisTypesForRole, recordTrailEnabled } from "../recordTrail.js";

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
      intents: ["dashboard_briefing", "attention_items", "metric_explanation", "dashboard_chat", "workflow_guidance", "record_analysis"],
      record_analysis: { mode: "deterministic-read-only", supported_types: recordAnalysisTypesForRole(actor.role), unsupported_types_are_not_inferred: true },
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

// Source-backed record analysis. It deliberately accepts a typed
// record reference instead of asking a model to extract identifiers or choose
// tools. The quote trail applies the same role scopes as the underlying lists.
export function getRecordAnalysis(req, res) {
  const actor = allowedActor(req, res);
  if (!actor) return;
  if (!recordTrailEnabled()) {
    return res.status(404).json({ success: false, code: "RECORD_ANALYSIS_DISABLED", message: "Not found." });
  }

  const recordType = typeof req.body?.record_type === "string" ? req.body.record_type : "";
  const recordId = typeof req.body?.record_id === "string" ? req.body.record_id.trim() : "";
  if (!["quote", "dispatch", "invoice", "purchase_order", "supplier", "maintenance_schedule", "equipment_tag", "material_usage", "field_worksheet", "catalog_item", "stock_item", "worksheet_register", "service_request", "daily_timesheet", "contractor_log_sheet"].includes(recordType) || !recordId || recordId.length > 128) {
    return res.status(400).json({ success: false, code: "INVALID_RECORD_REFERENCE", message: "Provide a supported record type and record id." });
  }

  const result = recordType === "quote"
    ? buildQuoteTrail(req.db, recordId, actor)
    : recordType === "dispatch"
      ? buildDispatchAnalysis(req.db, recordId, actor)
      : recordType === "invoice"
        ? buildInvoiceAnalysis(req.db, recordId, actor)
        : recordType === "purchase_order"
          ? buildPurchaseOrderAnalysis(req.db, recordId, actor)
          : recordType === "supplier"
            ? buildSupplierAnalysis(req.db, recordId, actor)
          : recordType === "maintenance_schedule"
            ? buildMaintenanceScheduleAnalysis(req.db, recordId, actor)
          : recordType === "equipment_tag"
            ? buildEquipmentTagAnalysis(req.db, recordId, actor)
          : recordType === "material_usage"
            ? buildMaterialUsageAnalysis(req.db, recordId, actor)
          : recordType === "field_worksheet"
            ? buildFieldWorksheetAnalysis(req.db, recordId, actor)
          : recordType === "catalog_item"
            ? buildCatalogItemAnalysis(req.db, recordId, actor)
          : recordType === "stock_item"
            ? buildStockItemAnalysis(req.db, recordId, actor)
            : recordType === "worksheet_register"
              ? buildWorksheetRegisterAnalysis(req.db, recordId, actor)
              : recordType === "daily_timesheet"
                ? buildDailyTimesheetAnalysis(req.db, recordId, actor)
                : recordType === "contractor_log_sheet"
                  ? buildContractorLogAnalysis(req.db, recordId, actor)
                  : buildServiceRequestAnalysis(req.db, recordId, actor);
  if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });

  if (recordType === "dispatch" || recordType === "invoice" || recordType === "purchase_order" || recordType === "supplier" || recordType === "maintenance_schedule" || recordType === "equipment_tag" || recordType === "material_usage" || recordType === "field_worksheet" || recordType === "catalog_item" || recordType === "stock_item" || recordType === "worksheet_register" || recordType === "service_request" || recordType === "daily_timesheet" || recordType === "contractor_log_sheet") {
    const analysisId = randomUUID();
    const evidenceRefs = result.data.evidenceRefs;
    const data = {
      analysisId,
      mode: "deterministic-evidence-summary",
      generatedAt: result.data.generated_at,
      record: recordType === "dispatch"
        ? { type: "dispatch", id: result.data.dispatch.id, human_ref: result.data.dispatch.human_ref }
        : recordType === "invoice"
          ? { type: "invoice", id: result.data.invoice.id, human_ref: result.data.invoice.human_ref }
          : recordType === "purchase_order"
            ? { type: "purchase_order", id: result.data.purchase_order.id }
            : recordType === "supplier"
              ? { type: "supplier", id: result.data.supplier.id, human_ref: result.data.supplier.name }
            : recordType === "maintenance_schedule"
              ? { type: "maintenance_schedule", id: result.data.maintenance_schedule.id }
            : recordType === "equipment_tag"
              ? { type: "equipment_tag", id: result.data.equipment_tag.id, human_ref: result.data.equipment_tag.tag_code }
            : recordType === "material_usage"
              ? { type: "material_usage", id: result.data.material_usage.id }
            : recordType === "field_worksheet"
              ? { type: "field_worksheet", id: result.data.field_worksheet.id }
            : recordType === "catalog_item"
              ? { type: "catalog_item", id: result.data.catalog_item.id, human_ref: result.data.catalog_item.item_code }
            : recordType === "stock_item"
              ? { type: "stock_item", id: result.data.stock_item.id, human_ref: result.data.stock_item.item_code }
              : recordType === "worksheet_register"
                ? { type: "worksheet_register", id: result.data.worksheet_register.id, human_ref: result.data.worksheet_register.human_ref }
                : recordType === "daily_timesheet"
                  ? { type: "daily_timesheet", id: result.data.daily_timesheet.id }
                  : recordType === "contractor_log_sheet"
                    ? { type: "contractor_log_sheet", id: result.data.contractor_log_sheet.id }
                    : { type: "service_request", id: result.data.service_request.id },
      ...(["worksheet_register", "service_request", "daily_timesheet", "contractor_log_sheet", "purchase_order", "supplier", "maintenance_schedule", "equipment_tag", "material_usage", "field_worksheet", "catalog_item", "stock_item"].includes(recordType) ? {} : { purchase_order: result.data.purchase_order }),
      ...(recordType === "purchase_order" ? { purchaseOrder: result.data.purchase_order, quotation: result.data.quotation } : {}),
      ...(recordType === "supplier" ? { supplier: result.data.supplier, linked_stock_items: result.data.linked_stock_items, evidence_truncated: result.data.evidence_truncated } : {}),
      ...(recordType === "maintenance_schedule" ? { maintenance_schedule: result.data.maintenance_schedule, contract: result.data.contract, equipment: result.data.equipment } : {}),
      ...(recordType === "equipment_tag" ? { equipment_tag: result.data.equipment_tag, hierarchy: result.data.hierarchy } : {}),
      ...(recordType === "material_usage" ? { material_usage: result.data.material_usage } : {}),
      ...(recordType === "field_worksheet" ? { field_worksheet: result.data.field_worksheet } : {}),
      ...(recordType === "daily_timesheet" ? { daily_timesheet: result.data.daily_timesheet } : {}),
      ...(recordType === "contractor_log_sheet" ? { contractor_log_sheet: result.data.contractor_log_sheet } : {}),
      ...(recordType === "catalog_item" ? { catalogItem: result.data.catalog_item, linked_stock_items: result.data.linked_stock_items } : {}),
      ...(recordType === "stock_item" ? { stockItem: result.data.stock_item, evidence_truncated: result.data.evidence_truncated } : {}),
      ...(recordType === "invoice" ? { invoice: result.data.invoice, payment_assessment: result.data.payment_assessment, settlement: result.data.settlement } : {}),
      findings: result.data.findings,
      evidence: recordType === "daily_timesheet"
        ? { status: result.data.daily_timesheet.status, work_dates: result.data.daily_timesheet.distinct_work_dates, signoff: result.data.daily_timesheet.signoff, approved_register_overlap: result.data.daily_timesheet.approved_register_overlap }
        : recordType === "contractor_log_sheet"
          ? { status: result.data.contractor_log_sheet.status, log_date: result.data.contractor_log_sheet.log_date, worker_row_count: result.data.contractor_log_sheet.worker_row_count, validation: result.data.contractor_log_sheet.validation, signoff_recorded: result.data.contractor_log_sheet.foreman_or_supervisor_signoff_recorded, recorded_hours_total: result.data.contractor_log_sheet.recorded_hours_total }
        : recordType === "worksheet_register"
        ? { coverage_status: result.data.coverage_status, covered_worker_dates: result.data.covered_worker_dates, truncated: result.data.evidence_truncated }
        : recordType === "service_request"
          ? { request: result.data.service_request, ...(result.data.conversion ? { conversion: result.data.conversion } : {}), next_step: result.data.next_step, action_history: result.data.action_history }
          : recordType === "purchase_order"
            ? { purchase_order: result.data.purchase_order, quotation: result.data.quotation }
            : recordType === "supplier"
              ? { linked_stock_item_count: result.data.linked_stock_items.length, receipt_count: result.data.linked_stock_items.reduce((sum, item) => sum + item.receipt_summary.receipt_count, 0), evidence_truncated: result.data.evidence_truncated }
            : recordType === "maintenance_schedule"
              ? { contract_id: result.data.contract?.id || null, equipment_id: result.data.equipment?.id || null }
            : recordType === "equipment_tag"
              ? { hierarchy_ids: result.data.hierarchy.map((item) => item.id) }
            : recordType === "material_usage"
              ? { dispatch_id: result.data.material_usage.dispatch_card_id, stock_item_id: result.data.material_usage.stock_item_id, stock_ledger_status: result.data.material_usage.stock_ledger_status }
            : recordType === "field_worksheet"
              ? { dispatch_id: result.data.field_worksheet.dispatch_card_id, state: result.data.field_worksheet.state, hours_total: result.data.field_worksheet.hours_total, signoff: result.data.field_worksheet.signoff, daily_source_eligibility: result.data.field_worksheet.daily_source_eligibility }
            : recordType === "catalog_item"
              ? { linked_stock_item_count: result.data.linked_stock_items.length }
            : recordType === "stock_item"
              ? { reconciliation_status: result.data.stock_item.reconciliation_status, quantities: { quantity_on_hand: result.data.stock_item.quantity_on_hand, ledger_balance: result.data.stock_item.ledger_balance, movement_sum: result.data.stock_item.movement_sum }, by_category: result.data.stock_item.by_category, by_unit: result.data.stock_item.by_unit, movement_count: result.data.stock_item.movement_count, truncated: result.data.evidence_truncated }
            : result.data.evidence,
      evidenceRefs,
      limitations: result.data.limitations
    };
    req.store.audit(req.db, actor, "ai_request", analysisId, "AI_RECORD_ANALYSIS", null, {
      record_type: recordType,
      target_ids: evidenceRefs.map((item) => item.targetId),
      finding_codes: data.findings.map((item) => item.code),
      generated_at: data.generatedAt
    });
    return res.json({ success: true, data });
  }

  const trail = result.data;
  const evidenceRefs = trail.stages
    .filter((item) => item.status === "recorded" && item.ref?.id)
    .map((item) => ({ stage: item.stage, targetType: item.ref.type, targetId: item.ref.id }));
  const findings = [];
  for (const gap of trail.gaps) findings.push({ kind: "gap", code: gap.code, message: gap.message });
  for (const item of trail.stages) {
    if (item.exception) findings.push({
      kind: "exception",
      code: item.exception,
      message: item.exception === "URGENT_BEFORE_PO"
        ? "Historical dispatch evidence indicates work started before a verified PO. This is an exception, not authorization."
        : "Historical dispatch evidence exists without a verified PO. This is an exception, not authorization."
    });
  }

  const analysisId = randomUUID();
  const data = {
    analysisId,
    mode: "deterministic-evidence-summary",
    generatedAt: trail.generated_at,
    record: { type: "quote", id: trail.quote.id, human_ref: trail.quote.human_ref },
    findings,
    evidenceRefs,
    limitations: [
      "Only recorded links are shown; missing links are not inferred.",
      "This analysis covers Lead, Quote, PO and Dispatch only; it does not verify attachments, field evidence, invoice payment or accounting settlement."
    ]
  };
  req.store.audit(req.db, actor, "ai_request", analysisId, "AI_RECORD_ANALYSIS", null, {
    record_type: "quote",
    target_ids: evidenceRefs.map((item) => item.targetId),
    finding_codes: findings.map((item) => item.code),
    generated_at: data.generatedAt
  });
  return res.json({ success: true, data });
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
