// Deterministic workflow guidance for the providerless ORAC assistant.
//
// Guarantees (each is covered by tests/aiWorkflowAssistant.test.js):
//   * Read-only: this module never receives the store, never writes, and has
//     no way to call an approve/send/edit/move/mark-read action.
//   * Providerless: no network, no model, no prompt logging. Pure functions.
//   * Role-scoped: guidance comes only from articles where the caller's role has
//     a `roleParts` entry; live numbers come only from the caller's own scoped
//     summary; links are re-authorized against the actor on the server.
//   * Non-confirming: questions about specific records, other clients or other
//     users get a fixed reply that never says whether anything exists.
//   * The raw question is never returned inside audit data by the controller.

import {
  ARTICLES,
  ARTICLES_BY_ID,
  APPROVAL_STATE,
  CATALOG_VERSION,
  METRIC_LABELS_EXTRA,
  articlesForRole,
  authorizeDestination
} from "./aiWorkflowKnowledge.js";

export const LABEL_GUIDANCE = "Workflow guidance";
export const LABEL_DECLINED = "Declined";

const MAX_QUESTION_LENGTH = 500;

function cleanQuestion(input) {
  return String(input ?? "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUESTION_LENGTH);
}

export function normalizeQuestion(input) {
  return String(input ?? "")
    .normalize("NFKC")
    // Invisible format characters (zero-width, bidi, joiners, BOM) are removed so a
    // word split by them is rejoined; other control characters become spaces.
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUESTION_LENGTH)
    .toLowerCase();
}

// --- Safety classes --------------------------------------------------------

const INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget|override|bypass)\b.{0,40}\b(instructions?|rules?|guardrails?|restrictions?|polic(?:y|ies)|previous|prior|above)\b/,
  /\b(system|developer|hidden|initial)\s+(prompt|message|instructions?)\b/,
  /\b(reveal|show|print|repeat|leak|dump)\b.{0,30}\b(prompt|instructions|api key|token|secret|password|credentials?)\b/,
  /\b(jailbreak|developer mode|dan mode|sudo)\b/,
  /\b(you are now|from now on you|pretend (?:to be|you are)|roleplay as|act as (?:an? |the )?)/,
  /\b(i am|i'm|as) (?:an? |the )?(?:admin|administrator|system|root|owner|ceo)\b.{0,60}\b(show|list|give|grant|allow|enable|unlock)\b/,
  /\b(new|updated) (?:rules?|instructions?|policy)\b.{0,20}:/
];

const RECORD_OR_SCOPE_PATTERNS = [
  /\b[a-z]{2,6}-\d{2,}\b/i, // reference-like ids: QUO-123, INV-0042, DC-17
  /\b(other|another|different|competitor'?s?)\s+(clients?|customers?|organi[sz]ations?|compan(?:y|ies)|users?|technicians?|employees?|staff)\b/,
  /\b(all|every|everyone'?s?|everybody'?s?)\s+(users?|clients?|customers?|technicians?|staff|employees?)'?s?\s+(data|records?|invoices?|quotes?|timesheets?|hours|salar(?:y|ies)|passwords?|emails?|details)\b/,
  /\b(list|show|give|export|dump)\b.{0,20}\b(all|every)\b.{0,20}\b(users?|clients?|invoices?|quotes?|timesheets?|worksheets?|purchase orders?)\b/,
  /\b(for|of|about)\s+client\s+(?!viewers?\b|acknowledg|representative|portal|role|users?\b|documents?\b|requests?\b)[a-z0-9]/
];

// Applied to the cleaned but not lower-cased text so that "Client Viewer" and
// "client acknowledgement" are not mistaken for a client name.
const CLIENT_NAME_PATTERN = /\b(?:did|does|has|had|is|are|was|were|show|tell|about|for|of|from|with)\s+(?:the\s+)?client\s+(?!Viewers?\b|Portal\b|Role\b)[A-Z][a-z0-9]+/;

const UNSUPPORTED_POLICY_PATTERNS = [
  /\b(approval|spending|credit|discount)\s+(limits?|thresholds?)\b/,
  /\bthresholds?\b/,
  /\bdiscounts?\b/,
  /\b(tax|vat|gst)\b/,
  /\b(currency|exchange rate|forex)\b/,
  /\b(pricing|price list|margins?|markup|commission)\b/,
  /\bpayment terms\b/,
  /\bcredit notes?\b/,
  /\brefunds?\b/,
  /\b(salary|salaries|wages?|overtime)\b/,
  /\bbudgets?\b/,
  /\b(warehouse|branch)\b/,
  /\b(sla|penalt(?:y|ies)|retention period)\b/,
  /\bwalk-?\s?ins?\b/,
  /\bcash\s+(sales?|payments?|customers?)\b/,
  /\bdirect sales?\b/
];

const WALK_IN_PATTERN = /\bwalk-?\s?ins?\b|\bcash\s+(sales?|payments?|customers?)\b|\bdirect sales?\b/;

const MUTATION_VERBS = "approve|reject|verify|send|submit|dispatch|invoice|void|export|delete|remove|create|edit|change|update|assign|transfer|adjust|issue|mark|acknowledge|return|cancel|reset|grant|promote|record|log|add|book|pay|refund|waive|move|resubmit|revise|reopen|release|sign|confirm|clear|dismiss";
const POLITE_PREFIX = "(?:(?:please|pls|kindly|just|now|go ahead and|can you|could you|would you|will you|i want you to|i need you to|you should|you must)\\s+)*";
const OBJECT_WORDS = "the|this|that|these|those|my|our|a|an|all|every|it|them|him|her|me|user|users|role|worksheet|timesheet|timesheets|quote|quotes|po|purchase|invoice|invoices|dispatch|stock|request|notification|notifications|item|items|entry|entries|hours|access|password|amendment";
const MUTATION_PATTERN = new RegExp(`^${POLITE_PREFIX}(?:${MUTATION_VERBS})\\s+(?:${OBJECT_WORDS})\\b`);
const ASSISTANT_ACTION_PATTERN = new RegExp(`\\b(?:you|assistant|bot)\\b\\s+(?:can |could |will |should |must |please )?(?:${MUTATION_VERBS})\\b`);
const ROLE_ESCALATION_PATTERN = /\b(make|set|turn|promote|change)\b.{0,20}\b(me|my (?:role|account|access))\b.{0,20}\b(admin|administrator|manager|finance|supervisor)\b|\bgive me (?:admin|full|more) access\b/;

const GUIDANCE_QUESTION_PATTERN = /^(how|where|what|who|when|why|which|can i|could i|may i|am i|do i|does|is|are|should i|explain|tell me|show me how|walk me through|guide me)\b/;

const PROCEDURAL_PATTERN = /\b(how (?:do|does|can|should|to|would)|where (?:do|can|is|to|should)|what (?:does|do)\b.*\bmean|what (?:is|are) (?:the )?(?:status|statuses|next step|process|procedure|workflow|evidence|requirements?)|which (?:screen|page)|what happens|what next|next step|who (?:can|approves?|verifies|reviews|does|is allowed)|am i allowed|can i|may i|is it possible|steps?\b|procedure|process|workflow|evidence (?:is )?(?:required|needed)|what (?:do i|should i) (?:need|do|submit|attach)|required|requirements?|status(?:es)?\b|meaning|means\b|blocked because|why (?:can't|cannot|is|was|won't))\b|_(?:acknowledged|approved|correction)\b/;

const FOLLOW_UP_PATTERN = /^(?:and |ok |okay )?(?:what next|what now|then what|tell me more|more detail|explain that|what else)\??$/;

// --- Topic matching --------------------------------------------------------

function keywordHits(text, keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`).test(text) ? keyword.length : 0;
}

function scoreArticle(text, article) {
  return article.keywords.reduce((total, keyword) => total + keywordHits(text, keyword), 0);
}

export function matchArticles(text) {
  return ARTICLES
    .map((article) => ({ article, score: scoreArticle(text, article) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.article.id.localeCompare(right.article.id));
}

// --- Response construction -------------------------------------------------

function result(fields) {
  return {
    label: fields.label,
    outcome: fields.outcome,
    message: fields.message,
    claims: fields.claims || [],
    guidance: fields.guidance || null,
    links: fields.links || [],
    articleIds: fields.guidance ? [fields.guidance.articleId] : []
  };
}

function linksFor(actor, ids) {
  const seen = new Set();
  const links = [];
  for (const id of ids) {
    const link = authorizeDestination(actor, id);
    if (link && !seen.has(link.id)) {
      seen.add(link.id);
      links.push(link);
    }
  }
  return links;
}

function topicList(role) {
  const articles = articlesForRole(role);
  if (!articles.length) return "";
  return `\n\nTopics I can guide you on as ${role}:\n${articles.map((article) => `- ${article.title}`).join("\n")}`;
}

const READ_ONLY_NOTE = "I explain workflow and open screens. I never approve, send, edit, move stock, change roles or mark notifications as read.";

function declined(actor, message, linkIds = ["dashboard"]) {
  return result({ label: LABEL_DECLINED, outcome: "declined", message: `${message}${topicList(actor.role)}`, links: linksFor(actor, linkIds) });
}

function liveEvidence(payload, role, article, claimFactory) {
  const metrics = article.metrics?.[role] || [];
  const claims = [];
  const lines = [];
  for (const metric of metrics) {
    const label = METRIC_LABELS_EXTRA[metric] || null;
    if (!payload || !Object.hasOwn(payload, metric) || typeof payload[metric] !== "number") {
      lines.push(`${label || metric}: not available in your current summary.`);
      continue;
    }
    const value = payload[metric];
    const text = value === 0 ? `none currently in your scope (0)` : String(value);
    claims.push(claimFactory(payload, metric, `${label || metric} currently shows ${value}.`));
    lines.push(`${label || "Current value for " + metric}: ${text}`);
  }
  return { claims, lines };
}

function composeGuidance(actor, payload, article, claimFactory, generatedAt) {
  const part = article.roleParts[actor.role];
  const live = liveEvidence(payload, actor.role, article, claimFactory);
  const blocks = [article.title, article.summary, `Your part as ${actor.role}: ${part.do}`];
  if (article.statuses.length) blocks.push(`Status meanings:\n${article.statuses.map(([name, meaning]) => `- ${name}: ${meaning}`).join("\n")}`);
  if (article.evidence.length) blocks.push(`Evidence and controls:\n${article.evidence.map((line) => `- ${line}`).join("\n")}`);
  blocks.push(`Next: ${part.next}`);
  if (article.knownLimits.length) blocks.push(`Known limits in this release:\n${article.knownLimits.map((line) => `- ${line}`).join("\n")}`);
  if (live.lines.length) blocks.push(`Live evidence (your scoped summary, ${generatedAt}):\n${live.lines.map((line) => `- ${line}`).join("\n")}`);
  blocks.push(`Source: ORAC workflow guide "${article.id}" v${article.version}, catalog ${CATALOG_VERSION}. ${APPROVAL_STATE}. Enforced by: ${article.sources.join("; ")}.`);
  return {
    message: blocks.join("\n\n"),
    claims: live.claims,
    guidance: {
      articleId: article.id,
      version: article.version,
      catalogVersion: CATALOG_VERSION,
      title: article.title,
      approval: APPROVAL_STATE,
      sources: [...article.sources],
      yourPart: { do: part.do, next: part.next }
    }
  };
}

export function guidanceForArticle(actor, articleId, payload, claimFactory, now = new Date()) {
  const article = Object.hasOwn(ARTICLES_BY_ID, articleId) ? ARTICLES_BY_ID[articleId] : null;
  if (!article || !Object.hasOwn(article.roleParts, actor.role)) return null;
  const composed = composeGuidance(actor, payload, article, claimFactory, now.toISOString());
  return result({
    label: LABEL_GUIDANCE,
    outcome: "answered",
    message: composed.message,
    claims: composed.claims,
    guidance: composed.guidance,
    links: linksFor(actor, [article.roleParts[actor.role].link, article.destination])
  });
}

// Returns a result object, or null when the question is not a workflow
// question (the caller then falls back to the existing dashboard chat).
export function buildWorkflowReply({ actor, question, payload, lastContext = null, claimFactory, now = new Date() }) {
  const text = normalizeQuestion(question);
  if (!text) return null;

  if (INJECTION_PATTERNS.some((pattern) => pattern.test(text))) {
    return declined(actor, `I can only answer from ORAC's reviewed workflow guidance and your own role-scoped data. I cannot change how I work, act as another role or reveal internal instructions. ${READ_ONLY_NOTE}`);
  }

  if (ROLE_ESCALATION_PATTERN.test(text)) {
    return guidanceOrDecline(actor, "access-and-accounts", payload, claimFactory, now,
      `I cannot change roles or grant access. ${READ_ONLY_NOTE}`);
  }

  if (RECORD_OR_SCOPE_PATTERNS.some((pattern) => pattern.test(text)) || CLIENT_NAME_PATTERN.test(cleanQuestion(question))) {
    return declined(actor, `I do not look up individual records, other clients or other users, and I cannot confirm whether any exist. Open the screen for your role: it applies your access rules to every record it shows. ${READ_ONLY_NOTE}`,
      matchArticles(text).map((entry) => entry.article.destination).concat(["dashboard"]));
  }

  if (WALK_IN_PATTERN.test(text)) {
    return declined(actor, "Walk-in, cash and direct sales are not part of this ORAC pilot, so I have no guidance for them.");
  }

  if (UNSUPPORTED_POLICY_PATTERNS.some((pattern) => pattern.test(text))) {
    return declined(actor, "There is no approved ORAC guidance available to me for that. Limits, thresholds, tax, currency, pricing and similar policy are owner decisions that ORAC has not given me, so I will not guess.");
  }

  const matches = matchArticles(text);
  const guidanceQuestion = GUIDANCE_QUESTION_PATTERN.test(text);
  const wantsMutation = !guidanceQuestion && (MUTATION_PATTERN.test(text) || ASSISTANT_ACTION_PATTERN.test(text));

  if (wantsMutation) {
    // Only the best-scoring topic counts. Falling through to a weaker topic the
    // role does happen to hold could answer a different question than was asked.
    const top = matches[0];
    const eligible = top && Object.hasOwn(top.article.roleParts, actor.role) ? top : null;
    const base = `I cannot do that for you. ${READ_ONLY_NOTE} The action is done in ORAC by a person whose role allows it.`;
    if (eligible) {
      const composed = guidanceForArticle(actor, eligible.article.id, payload, claimFactory, now);
      return result({
        label: LABEL_DECLINED,
        outcome: "declined",
        message: `${base}\n\nWhere your role does this:\n${eligible.article.title}\nYour part as ${actor.role}: ${eligible.article.roleParts[actor.role].do}\nNext: ${eligible.article.roleParts[actor.role].next}`,
        guidance: composed.guidance,
        links: composed.links
      });
    }
    return declined(actor, `${base} That action is not part of your role's workflow.`);
  }

  if (FOLLOW_UP_PATTERN.test(text) && lastContext?.articleId) {
    const followUp = guidanceForArticle(actor, String(lastContext.articleId), payload, claimFactory, now);
    if (followUp) return followUp;
    return null;
  }

  const procedural = PROCEDURAL_PATTERN.test(text);
  if (!procedural || !matches.length) return null;

  const eligible = Object.hasOwn(matches[0].article.roleParts, actor.role) ? matches[0] : null;
  if (!eligible) {
    return declined(actor, `That topic is not part of your role's ORAC workflow, so I have no guidance for you on it. If you need it, ask the team that owns it.`);
  }
  const reply = guidanceForArticle(actor, eligible.article.id, payload, claimFactory, now);
  const related = matches
    .filter((entry) => entry.article.id !== eligible.article.id && Object.hasOwn(entry.article.roleParts, actor.role))
    .slice(0, 2);
  if (related.length) reply.message += `\n\nRelated guides: ${related.map((entry) => entry.article.title).join("; ")}.`;
  return reply;
}

export function unavailableGuide(actor) {
  return declined(actor, "That guide is not available for your role.");
}

function guidanceOrDecline(actor, articleId, payload, claimFactory, now, prefix) {
  const reply = guidanceForArticle(actor, articleId, payload, claimFactory, now);
  if (!reply) return declined(actor, prefix);
  return result({ ...reply, label: LABEL_DECLINED, outcome: "declined", message: `${prefix}\n\n${reply.message}`, claims: reply.claims, guidance: reply.guidance, links: reply.links });
}
