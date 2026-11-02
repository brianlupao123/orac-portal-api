import bcrypt from "bcrypt";

export const phase5BrowserUatPassword = "OracUAT2026!";

const roles = ["Finance", "Admin", "Management", "Sales", "Operations", "Supervisor", "Technician", "Client Viewer"];

const slugFor = (role) => role.toLowerCase().replace(/\s+/g, "-");
const emailFor = (role) => `phase5-uat-${slugFor(role)}@fixture.invalid`;

/**
 * Builds a completely fictional legacy-billing journey for local browser UAT.
 * It deliberately has no V5 commercial flag or V5 invoice data.
 */
export async function buildPhase5BrowserUatFixture() {
  const passwordHash = await bcrypt.hash(phase5BrowserUatPassword, 10);
  const users = roles.map((role, index) => ({
    id: `phase5-uat-${slugFor(role)}-${index + 1}`,
    name: `Phase 5 UAT ${role}`,
    email: emailFor(role),
    role,
    is_active: true,
    password_hash: passwordHash
  }));
  const financeOne = users.find((user) => user.role === "Finance");
  const financeTwo = {
    id: "phase5-uat-finance-reviewer",
    name: "Phase 5 UAT Finance Reviewer",
    email: "phase5-uat-finance-reviewer@fixture.invalid",
    role: "Finance",
    is_active: true,
    password_hash: passwordHash
  };
  users.push(financeTwo);

  const client = users.find((user) => user.role === "Client Viewer");
  client.client_id = "phase5-uat-client";

  return {
    db: {
      company_profile: {
        company_name: "Orac Systems",
        legal_name: "Handon Enterprises (Pvt) Ltd",
        address: "Harare, Zimbabwe",
        v5_commercial_policy: { currency: "USD", tax_rate: null, tax_status: "unconfigured" }
      },
      users,
      clients: [{ id: "phase5-uat-client", name: "Phase 5 Fictional Mining Client", email: "accounts@phase5-fixture.invalid" }],
      quotes: [{
        id: "phase5-uat-quote",
        quote_number: "UAT-Q-5001-R1",
        client_id: "phase5-uat-client",
        status: "Field_Dispatch",
        currency: "USD",
        tax_status: "provisional",
        applied_tax_rate: 0.15,
        total_amount: 800,
        revision_number: 1,
        v5_commercial_workflow: false
      }],
      quote_lines: [{ id: "phase5-uat-line", quotation_id: "phase5-uat-quote", description: "Fictional field service labour", quantity: 8, unit_price: 100, line_total: 800 }],
      purchase_orders: [{
        id: "phase5-uat-po",
        quotation_id: "phase5-uat-quote",
        po_reference: "UAT-PO-5001",
        po_amount: 1000,
        currency: "USD",
        status: "verified",
        requires_amendment: false
      }],
      dispatch_cards: [{
        id: "phase5-uat-dispatch",
        quotation_id: "phase5-uat-quote",
        purchase_order_id: "phase5-uat-po",
        dispatch_number: "UAT-JOB-5001",
        status: "active",
        assigned_supervisor_id: users.find((user) => user.role === "Supervisor").id,
        assigned_technician_id: users.find((user) => user.role === "Technician").id
      }],
      field_worksheets: [{
        id: "phase5-uat-worksheet",
        dispatch_card_id: "phase5-uat-dispatch",
        technician_id: users.find((user) => user.role === "Technician").id,
        status: "Supervisor_Approved",
        hours: 8
      }],
      timesheets: [{
        id: "phase5-uat-timesheet",
        dispatch_card_id: "phase5-uat-dispatch",
        user_id: users.find((user) => user.role === "Technician").id,
        source_worksheet_id: "phase5-uat-worksheet",
        hours_logged: 8,
        hourly_rate: 100
      }],
      material_usage: [],
      invoices: [],
      invoice_lines: [],
      invoice_payments: [],
      legacy_invoice_drafts: [],
      legacy_invoice_idempotency: [],
      pastel_export_batches: [],
      pastel_export_lines: [],
      audit_logs: [],
      v5_invoices: [],
      v5_invoice_drafts: []
    },
    accounts: Object.fromEntries(users.map((user) => [user.role === "Finance" && user.id === financeTwo.id ? "Finance reviewer" : user.role, user.email])),
    financePreparerEmail: financeOne.email,
    financeReviewerEmail: financeTwo.email
  };
}
