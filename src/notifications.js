const generateId = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const now = () => new Date().toISOString();

/**
 * Hook into audit events to generate notifications
 * @param {Object} db 
 * @param {Object} auditEntry 
 */
export function handleAuditForNotifications(db, auditEntry) {
  if (!db.notifications) db.notifications = [];

  // Prevent duplicate notifications for the exact same audit log
  if (db.notifications.some(n => n.audit_log_id === auditEntry.id)) {
    return;
  }

  const { action, entity_type, entity_id, new_values, old_values } = auditEntry;
  let notif = null;

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
      // Try to find client_id from quote
      if (new_values?.quotation_id) {
        const q = db.quotes.find(q => q.id === new_values.quotation_id);
        if (q) notif.client_id = q.client_id;
      }
      break;

    case "WORKSHEET_SUBMITTED":
      notif = {
        type: "worksheet",
        title: "Worksheet Submitted",
        message: `Worksheet submitted and awaits supervisor review.`,
        severity: "info",
        target_roles: ["Supervisor", "Operations", "Admin", "Management"],
        client_id: null
      };
      break;

    case "WORKSHEET_RETURNED":
      notif = {
        type: "worksheet",
        title: "Worksheet Returned",
        message: `Worksheet returned for correction.`,
        severity: "warning",
        target_roles: ["Technician", "Supervisor", "Operations", "Admin"],
        client_id: null
      };
      break;

    case "PO_AMENDMENT_REQUIRED":
      notif = {
        type: "po",
        title: "PO Amendment Required",
        message: `Logged value exceeds PO amount for ${new_values?.po_reference || entity_id}.`,
        severity: "warning",
        target_roles: ["Finance", "Admin", "Management", "Operations"],
        client_id: null
      };
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
      break;

    case "INVOICE_GENERATED":
      notif = {
        type: "invoice",
        title: "Invoice Generated",
        message: `Invoice ${new_values?.invoice_number || entity_id} is ready.`,
        severity: "success",
        target_roles: ["Finance", "Admin", "Management"],
        client_id: null
      };
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
          client_id: null
        };
      }
      break;
    }
  }

  if (notif) {
    db.notifications.push({
      id: generateId("notif"),
      audit_log_id: auditEntry.id,
      type: notif.type,
      title: notif.title,
      message: notif.message,
      severity: notif.severity,
      target_roles: notif.target_roles || [],
      client_id: notif.client_id || null,
      entity_type,
      entity_id,
      read_by: [], // Array of user IDs who have read this
      created_at: auditEntry.created_at || now()
    });
  }
}
