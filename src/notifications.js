import { hasPermission, permissions } from "./permissions.js";
import { buildDestination } from "./notificationDestinations.js";

const generateId = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const now = () => new Date().toISOString();

const uniq = (list) => [...new Set(list.filter(Boolean))];

// Client that owns a dispatch card, through its quote. null = cannot be resolved,
// and callers then fail closed (no Client Viewer copy is created).
const clientIdForDispatch = (db, dispatchId) => {
  const dispatch = (db.dispatch_cards || []).find((d) => d.id === dispatchId);
  const quote = dispatch ? (db.quotes || []).find((q) => q.id === dispatch.quotation_id) : null;
  return quote?.client_id || null;
};

// Supervisors are assignment-scoped (same rule as isAssignedToDispatch), so a
// worksheet event is never broadcast to the whole Supervisor role.
const assignedSupervisorIds = (db, worksheet) => {
  const dispatchId = worksheet?.dispatch_card_id;
  const dispatch = (db.dispatch_cards || []).find((d) => d.id === dispatchId);
  const linked = (db.field_worksheets || []).filter((w) => w.dispatch_card_id === dispatchId).map((w) => w.supervisor_id);
  return uniq([worksheet?.supervisor_id, dispatch?.assigned_supervisor_id, dispatch?.supervisor_id, ...linked])
    .filter((id) => (db.users || []).some((u) => u.id === id && u.role === "Supervisor" && u.is_active !== false));
};

// Reviewer roles that are not assignment-scoped. Supervisors are added per user.
const unscopedReviewerRoles = () => permissions.reviewWorksheet.filter((role) => role !== "Supervisor");

// Internal Work Request and Client Service Request notifications are ON.
// Owner decision (Task 01): recipients must see actionable notifications that
// link to the right record. Earlier controllers stated these events create no
// notification and two real-store tests pinned that; those tests now assert the
// exact, content-free notifications instead. Set to false to switch them off.
export const WORK_REQUEST_NOTIFICATIONS_ENABLED = true;

/**
 * Hook into audit events to generate notifications
 * @param {Object} db 
 * @param {Object} auditEntry 
 * @param {{ workRequestNotifications?: boolean }} [options]
 */
export function handleAuditForNotifications(db, auditEntry, options = {}) {
  if (!db.notifications) db.notifications = [];
  const workRequestsEnabled = options.workRequestNotifications ?? WORK_REQUEST_NOTIFICATIONS_ENABLED;

  // Prevent duplicate notifications for the exact same audit log
  if (db.notifications.some(n => n.audit_log_id === auditEntry.id)) {
    return;
  }

  const { action, entity_type, entity_id, new_values, old_values } = auditEntry;
  let notif = null;
  // Extra notifications addressed to ONE user (e.g. the requester whose request
  // was just decided). They share this audit entry's id, so the duplicate guard
  // above covers the whole set: replaying one audit entry never re-notifies.
  const personal = [];
  // Extra role-scoped notifications for the same event (e.g. a client-facing copy).
  const groups = [];
  const roleCanSeeInbox = (role) => hasPermission({ is_active: true, role }, "viewInternalWorkRequestInbox");

  // Notification generation map
  switch (action) {
    case "LEAD_CREATED":
      notif = {
        type: "lead",
        title: "New Lead Created",
        message: `A new lead has been recorded.`,
        severity: "info",
        target_roles: ["Sales", "Admin", "Management"],
        client_id: new_values?.client_id || null
      };
      notif.destination = buildDestination("lead", entity_id);
      break;

    case "QUOTE_TRANSITION_Sent_TO_Approved_Pending_PO":
      notif = {
        type: "quote",
        title: "Quote Approved",
        message: `Quote ${new_values?.quote_number || entity_id} approved. Awaiting PO.`,
        severity: "success",
        target_roles: ["Sales", "Admin", "Management", "Finance", "Client Viewer"],
        client_id: new_values?.client_id || null
      };
      notif.destination = buildDestination("quote", entity_id);
      break;

    case "URGENT_DISPATCH_CREATED":
      notif = {
        type: "dispatch",
        title: "Urgent Dispatch Started",
        message: `Dispatch ${new_values?.dispatch_number || entity_id} started before PO was received.`,
        severity: "warning",
        target_roles: ["Operations", "Supervisor", "Admin", "Management", "Sales"],
        client_id: null // Dispatch cards don't have client_id directly, would need to fetch quote. But omitting for now unless easily accessible.
      };
      notif.destination = buildDestination("dispatch_card", entity_id);
      // Try to find client_id from quote
      if (new_values?.quotation_id) {
        const q = db.quotes.find(q => q.id === new_values.quotation_id);
        if (q) notif.client_id = q.client_id;
      }
      break;

    case "WORKSHEET_SUBMITTED": {
      // Submitted is NOT yet reviewable: the client representative acknowledges first
      // (Submitted -> Client_Acknowledged), and only then can a Supervisor review.
      // So: the client is asked to acknowledge; staff are told it is waiting on the client.
      const destination = buildDestination("worksheet", entity_id);
      notif = {
        type: "worksheet",
        title: "Timesheet Submitted",
        message: "A timesheet was submitted and is waiting for client acknowledgement before Supervisor review.",
        severity: "info",
        target_roles: ["Operations", "Admin", "Management"],
        client_id: null,
        destination
      };
      const clientId = clientIdForDispatch(db, new_values?.dispatch_card_id);
      if (clientId) {
        groups.push({
          type: "worksheet",
          title: "Timesheet Awaiting Your Acknowledgement",
          message: "A timesheet was submitted for your site and needs your acknowledgement.",
          severity: "info",
          target_roles: ["Client Viewer"],
          client_id: clientId,
          destination
        });
      }
      for (const userId of assignedSupervisorIds(db, new_values)) {
        if (userId === auditEntry.actor_id) continue;
        personal.push({
          type: "worksheet",
          title: "Timesheet Submitted",
          message: "A timesheet on your dispatch was submitted and is waiting for client acknowledgement.",
          severity: "info",
          user_id: userId,
          destination
        });
      }
      break;
    }

    case "WORKSHEET_CLIENT_ACKNOWLEDGED": {
      // The actionable moment for review. Only roles holding reviewWorksheet; Supervisors
      // only when assigned. The submitter cannot approve their own worksheet, so they
      // are not told it is ready for them.
      const destination = buildDestination("worksheet", entity_id);
      const submitter = new_values?.submitted_by;
      notif = {
        type: "worksheet",
        title: "Timesheet Ready for Review",
        message: "A client acknowledged a worksheet. It is ready for Supervisor review.",
        severity: "info",
        target_roles: unscopedReviewerRoles(),
        exclude_user_ids: [submitter].filter(Boolean),
        client_id: null,
        destination
      };
      for (const userId of assignedSupervisorIds(db, new_values)) {
        if (userId === submitter) continue;
        personal.push({
          type: "worksheet",
          title: "Timesheet Ready for Review",
          message: "A client acknowledged a timesheet on your dispatch. It is ready for your review.",
          severity: "info",
          user_id: userId,
          destination
        });
      }
      break;
    }

    case "WORKSHEET_RETURNED": {
      // Unscoped reviewers see the return. The technician who owns the work and the
      // assigned Supervisor(s) are told individually; no role-wide broadcast.
      const destination = buildDestination("worksheet", entity_id);
      notif = {
        type: "worksheet",
        title: "Timesheet Returned",
        message: "Timesheet returned for correction.",
        severity: "warning",
        target_roles: unscopedReviewerRoles(),
        client_id: null,
        destination
      };
      const owners = uniq([new_values?.submitted_by, new_values?.technician_id]);
      for (const userId of owners) {
        if (userId === auditEntry.actor_id) continue;
        personal.push({
          type: "worksheet",
          title: "Your timesheet was returned",
          message: "A reviewer returned your timesheet for correction. Open Timesheets to see the reason.",
          severity: "warning",
          user_id: userId,
          destination
        });
      }
      for (const userId of assignedSupervisorIds(db, new_values)) {
        if (userId === auditEntry.actor_id || owners.includes(userId)) continue;
        personal.push({
          type: "worksheet",
          title: "Timesheet Returned",
          message: "A timesheet on your dispatch was returned for correction.",
          severity: "warning",
          user_id: userId,
          destination
        });
      }
      break;
    }

    // Worksheet (the monthly register). Content-free: names no hours and no workers.
    case "REGISTER_SUBMITTED": {
      notif = {
        type: "worksheet_register", title: "Worksheet awaiting approval", message: "A monthly Worksheet was submitted and needs an independent approver.",
        severity: "info", target_roles: ["Admin", "Operations", "Supervisor"], exclude_user_ids: [auditEntry.actor_id].filter(Boolean),
        client_id: null, destination: buildDestination("worksheet_register", entity_id)
      };
      break;
    }
    case "REGISTER_APPROVED":
    case "REGISTER_RETURNED": {
      const approved = action === "REGISTER_APPROVED";
      for (const userId of new Set([new_values?.submitted_by, old_values?.submitted_by, new_values?.built_by].filter(Boolean))) {
        if (userId === auditEntry.actor_id) continue;
        personal.push({
          type: "worksheet_register", title: approved ? "Worksheet approved" : "Worksheet returned",
          message: approved ? "A monthly Worksheet you prepared was approved." : "A monthly Worksheet you prepared was returned for correction. Open Worksheets to see the reason.",
          severity: approved ? "success" : "warning", user_id: userId, destination: buildDestination("worksheet_register", entity_id)
        });
      }
      break;
    }

    case "WORKSHEET_APPROVED":
      for (const userId of new Set([new_values?.submitted_by, new_values?.technician_id].filter(Boolean))) {
        if (userId === auditEntry.actor_id) continue;
        personal.push({
          type: "worksheet",
          title: "Your timesheet was approved",
          message: "Your timesheet was approved.",
          severity: "success",
          user_id: userId,
          destination: buildDestination("worksheet", entity_id)
        });
      }
      break;

    case "PO_SUBMITTED_BY_CLIENT": {
      notif = {
        type: "po",
        title: "Client PO Submitted",
        message: "A client submitted a purchase order that needs verification.",
        severity: "info",
        target_roles: ["Finance", "Operations", "Admin"],
        client_id: null,
        destination: buildDestination("purchase_order", entity_id)
      };
      const quote = new_values?.quotation_id ? (db.quotes || []).find((q) => q.id === new_values.quotation_id) : null;
      if (quote) notif.client_id = quote.client_id;
      break;
    }

    case "ACCESS_REQUEST_CREATED":
      // Deliberately minimal: no name, email or reason is copied into the
      // notification. The Admin inbox (GET /access_requests) stays the source
      // of truth, so a lost or unread notification never hides a request.
      notif = {
        type: "access_request",
        title: "Access Request",
        message: "A new access request is waiting for Admin review.",
        severity: "info",
        target_roles: [...permissions.viewAccessRequests],
        client_id: null,
        destination: buildDestination("access_request", entity_id)
      };
      break;

    case "INTERNAL_WORK_REQUEST_CREATED": {
      if (!workRequestsEnabled) break;
      const recipientRole = new_values?.recipient_role;
      if (recipientRole && roleCanSeeInbox(recipientRole)) {
        notif = {
          type: "internal_request",
          title: "New Internal Request",
          message: "A new internal request is waiting in your inbox.",
          severity: "info",
          target_roles: [recipientRole],
          exclude_user_ids: [new_values?.created_by_user_id].filter(Boolean),
          client_id: null,
          destination: buildDestination("internal_work_request", entity_id)
        };
      }
      break;
    }

    case "INTERNAL_WORK_REQUEST_ACKNOWLEDGED":
    case "INTERNAL_WORK_REQUEST_STARTED":
    case "INTERNAL_WORK_REQUEST_COMPLETED":
    case "INTERNAL_WORK_REQUEST_REJECTED": {
      if (!workRequestsEnabled) break;
      const requesterId = new_values?.created_by_user_id;
      if (requesterId && requesterId !== auditEntry.actor_id) {
        const verb = action.replace("INTERNAL_WORK_REQUEST_", "").toLowerCase();
        personal.push({
          type: "internal_request",
          title: "Internal Request Update",
          message: `Your internal request was ${verb}.`,
          severity: verb === "rejected" ? "warning" : "info",
          user_id: requesterId,
          destination: buildDestination("internal_work_request", entity_id)
        });
      }
      break;
    }

    case "INTERNAL_WORK_REQUEST_CANCELLED": {
      if (!workRequestsEnabled) break;
      // The requester cancelled: tell the person who had picked it up.
      const assigneeId = new_values?.assigned_to_user_id || old_values?.assigned_to_user_id;
      if (assigneeId && assigneeId !== auditEntry.actor_id) {
        personal.push({
          type: "internal_request",
          title: "Internal Request Cancelled",
          message: "An internal request assigned to you was cancelled.",
          severity: "warning",
          user_id: assigneeId,
          destination: buildDestination("internal_work_request", entity_id)
        });
      }
      break;
    }

    case "SERVICE_REQUEST_CREATED":
      if (!workRequestsEnabled) break;
      notif = {
        type: "service_request",
        title: "New Service Request",
        message: "A client submitted a new service request for triage.",
        severity: "info",
        target_roles: [...permissions.triageServiceRequests],
        client_id: null,
        destination: buildDestination("service_request", entity_id)
      };
      break;

    case "SERVICE_REQUEST_ACKNOWLEDGED":
    case "SERVICE_REQUEST_ACCEPTED":
    case "SERVICE_REQUEST_DECLINED": {
      if (!workRequestsEnabled) break;
      const clientUserId = new_values?.created_by_user_id;
      if (clientUserId && clientUserId !== auditEntry.actor_id) {
        const verb = action.replace("SERVICE_REQUEST_", "").toLowerCase();
        personal.push({
          type: "service_request",
          title: "Service Request Update",
          message: `Your service request was ${verb}.`,
          severity: verb === "declined" ? "warning" : "success",
          user_id: clientUserId,
          client_id: new_values?.client_id || null,
          destination: buildDestination("service_request", entity_id)
        });
      }
      break;
    }

    case "PO_AMENDMENT_REQUIRED":
      notif = {
        type: "po",
        title: "PO Amendment Required",
        message: `Logged value exceeds PO amount for ${new_values?.po_reference || entity_id}.`,
        severity: "warning",
        target_roles: ["Finance", "Admin", "Management", "Operations"],
        client_id: null
      };
      notif.destination = buildDestination("purchase_order", entity_id);
      // Attempt to find client via quote
      if (new_values?.quotation_id) {
        const q = db.quotes.find(q => q.id === new_values.quotation_id);
        if (q) notif.client_id = q.client_id;
      }
      break;

    case "PO_AMENDMENT_APPROVED":
      notif = {
        type: "po",
        title: "PO Amendment Approved",
        message: `Amendment approved for PO ${new_values?.po?.po_reference || entity_id}.`,
        severity: "success",
        target_roles: ["Finance", "Admin", "Management", "Operations"],
        client_id: null
      };
      notif.destination = buildDestination("purchase_order", entity_id);
      break;

    // Timesheet workflow packet (dark: these audit actions are only emitted behind their flags).
    case "TIMESHEET_AWAITING_AUTHORITY": {
      const destination = buildDestination("worksheet", entity_id);
      notif = { type: "worksheet", title: "Timesheet Awaiting Client Authority",
        message: "A submitted Timesheet is paused: its client has no active authoriser or delegate. Appoint one or use the paper exception.",
        severity: "warning", target_roles: ["Sales", "Admin"], client_id: null, destination };
      break;
    }
    case "TIMESHEET_REMINDER":
    case "TIMESHEET_ESCALATION": {
      const destination = buildDestination("worksheet", entity_id);
      const escalated = action === "TIMESHEET_ESCALATION";
      notif = { type: "worksheet", title: escalated ? "Timesheet Confirmation Overdue" : "Timesheet Awaiting Your Confirmation",
        message: escalated ? "A Timesheet has waited past the escalation threshold for client confirmation." : "A Timesheet is waiting for client confirmation.",
        severity: escalated ? "warning" : "info", target_roles: escalated ? ["Sales", "Admin"] : ["Client Viewer"],
        client_id: escalated ? null : clientIdForDispatch(db, new_values?.dispatch_card_id), destination };
      if (!escalated && !notif.client_id) notif = null; // fail closed: never broadcast a client copy without a client
      break;
    }
    case "VARIANCE_OVERRIDE_REQUESTED": {
      notif = { type: "invoice", title: "Variance Override Needs Second Approval",
        message: "An invoice variance override was requested and needs a second approver.", severity: "warning",
        target_roles: ["Finance", "Admin"], exclude_user_ids: [auditEntry.actor_id].filter(Boolean), client_id: null,
        destination: buildDestination("dispatch_card", new_values?.dispatch_card_id) };
      break;
    }
    case "INVOICE_GENERATED":
      notif = {
        type: "invoice",
        title: "Invoice Generated",
        message: `Invoice ${new_values?.invoice_number || entity_id} is ready.`,
        severity: "success",
        target_roles: ["Finance", "Admin", "Management"],
        client_id: null
      };
      notif.destination = buildDestination("invoice", entity_id);
      // Client shouldn't see internal generation per say unless instructed, but instructions say Client Viewer never internal finance/audit details.
      break;

    case "STOCK_MOVEMENT_RECORDED":
    case "STOCK_DEDUCTED_VIA_WORKSHEET": {
      const stockItem = new_values?.stock_item || new_values;
      if (stockItem && stockItem.quantity_on_hand <= stockItem.reorder_level) {
        const isNegative = stockItem.quantity_on_hand < 0;
        notif = {
          type: "inventory",
          title: isNegative ? "Negative Stock Alert" : "Low Stock Alert",
          message: `${stockItem.item_name} has fallen to ${stockItem.quantity_on_hand} ${stockItem.unit_of_measure}.`,
          severity: isNegative ? "critical" : "warning",
          target_roles: ["Operations", "Admin", "Management"],
          client_id: null,
          destination: buildDestination("stock_item", stockItem.id || (entity_type === "stock_item" ? entity_id : null))
        };
      }
      break;
    }
  }

  const build = (item) => ({
    id: generateId("notif"),
    audit_log_id: auditEntry.id,
    type: item.type,
    title: item.title,
    message: item.message,
    severity: item.severity,
    target_roles: item.target_roles || [],
    exclude_user_ids: item.exclude_user_ids || [],
    ...(item.user_id ? { user_id: item.user_id } : {}),
    client_id: item.client_id || null,
    entity_type,
    entity_id,
    destination: item.destination || null, // { kind, id } only; the route is resolved per viewer at read time
    read_by: [], // user IDs that have read this; per-user, never shared
    created_at: auditEntry.created_at || now()
  });

  // Build everything first, then push, so a failure while building leaves the
  // notification list untouched.
  const created = [];
  if (notif) created.push(build(notif));
  for (const item of groups) created.push(build(item));
  for (const item of personal) created.push(build(item));
  db.notifications.push(...created);
}
