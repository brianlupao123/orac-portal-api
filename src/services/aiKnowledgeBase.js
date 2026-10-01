export const ORAC_WORKFLOW_KNOWLEDGE = {
  quote_to_cash: {
    title: "Quote to PO to dispatch to invoice",
    explanation:
      "ORAC connects commercial and operational work from a client quote, through purchase order confirmation, dispatch, worksheet evidence, review, and invoice readiness.",
    nextAction:
      "Use the dashboard evidence to identify the earliest blocked stage before pushing work forward."
  },
  clients: {
    title: "Client records",
    explanation:
      "Client records identify organisations visible within the user's permitted dashboard scope.",
    nextAction:
      "Use client counts as context, then inspect quotes, dispatches, and invoices for active work."
  },
  quotes: {
    title: "Quote records",
    explanation:
      "Quotes represent commercial work being prepared, approved, amended, or moved toward purchase order confirmation.",
    nextAction:
      "Follow up active quotes that are waiting for approval, amendment, or PO evidence."
  },
  dispatches: {
    title: "Dispatch records",
    explanation:
      "Dispatch records represent operational service work released for execution or review.",
    nextAction:
      "Check dispatches for worksheet submission, completion evidence, and correction delays."
  },
  worksheets: {
    title: "Field worksheets",
    explanation:
      "Worksheets capture field execution evidence before operational or supervisor review.",
    nextAction:
      "Submit, review, approve, or return worksheets according to the role's permitted workflow."
  },
  pending_review: {
    title: "Pending worksheet review",
    explanation:
      "Pending review counts Submitted entries (waiting for the client representative to acknowledge) plus Client_Acknowledged entries (waiting for an independent reviewer). Only Client_Acknowledged entries can be approved or returned.",
    nextAction:
      "Reviewers act on Client_Acknowledged entries; Submitted entries wait for client acknowledgement. Approval of a Client_Acknowledged entry unlocks downstream progress."
  },
  returned_for_correction: {
    title: "Returned for correction",
    explanation:
      "Returned correction items were reviewed but require updates before they can proceed.",
    nextAction:
      "Check the correction reason in the workflow area, update the record, and resubmit where permitted."
  },
  blocked_amendments: {
    title: "Blocked amendments",
    explanation:
      "Blocked amendments indicate PO or quote changes that cannot safely proceed until corrected or approved.",
    nextAction:
      "Clear blocked amendments before progressing related finance or invoice work."
  },
  pending_po: {
    title: "Awaiting purchase order",
    explanation:
      "Awaiting PO means approved commercial work still needs purchase order evidence before finance can safely continue.",
    nextAction:
      "Confirm PO evidence with the responsible owner before invoice movement."
  },
  invoices: {
    title: "Invoices",
    explanation:
      "Invoices represent finance records created from approved commercial and operational evidence.",
    nextAction:
      "Prioritise invoices connected to approved work and confirmed purchase orders."
  }
};

export const ROLE_GUIDANCE = {
  Admin: {
    purpose: "Admin monitors master data, access, clients, quotes, dispatch flow, invoice visibility, and blocked amendments.",
    topics: ["clients", "quotes", "dispatches", "invoices", "blocked_amendments"],
    priorities: ["Review blocked amendments.", "Monitor quote and dispatch movement.", "Keep master data and access requests controlled."]
  },
  Management: {
    purpose: "Management monitors business flow across quotes, dispatches, invoices, and worksheet review pressure.",
    topics: ["clients", "quotes", "dispatches", "invoices", "pending_review"],
    priorities: ["Watch review bottlenecks.", "Compare commercial and operational movement.", "Escalate stalled pipeline stages."]
  },
  Sales: {
    purpose: "Sales monitors clients and active quote follow-up.",
    topics: ["clients", "quotes"],
    priorities: ["Follow up active quotes.", "Keep client opportunities moving.", "Escalate quote blockers through the approved workflow."]
  },
  Finance: {
    purpose: "Finance monitors blocked amendments, purchase order readiness, and invoices.",
    topics: ["blocked_amendments", "pending_po", "invoices"],
    priorities: ["Clear blocked amendments.", "Confirm PO evidence.", "Review invoice readiness."]
  },
  Operations: {
    purpose: "Operations monitors dispatches, worksheets, pending review, and returned correction work.",
    topics: ["dispatches", "worksheets", "pending_review", "returned_for_correction"],
    priorities: ["Review pending worksheets.", "Clear returned correction items.", "Keep dispatch work moving."]
  },
  Supervisor: {
    purpose: "Supervisor monitors dispatches and worksheet review work inside the supervisor review scope.",
    topics: ["dispatches", "pending_review", "returned_for_correction"],
    priorities: ["Review submitted worksheets.", "Return incomplete work with clear comments.", "Keep assigned review work moving."]
  },
  Technician: {
    purpose: "Technician monitors assigned dispatches, worksheets, and submitted work awaiting review.",
    topics: ["dispatches", "worksheets", "pending_review"],
    priorities: ["Complete assigned dispatch work.", "Submit worksheet evidence.", "Follow up returned work if it appears in the workflow."]
  },
  "Client Viewer": {
    purpose: "Client Viewer monitors only their organisation's quotes, dispatches, and invoices.",
    topics: ["quotes", "dispatches", "invoices"],
    priorities: ["Track quote status.", "Monitor service dispatch progress.", "Review invoice visibility for the organisation."]
  }
};

export function getKnowledgeForMetric(metric) {
  return ORAC_WORKFLOW_KNOWLEDGE[metric] || null;
}

export function getRoleGuidance(role) {
  return ROLE_GUIDANCE[role] || null;
}
