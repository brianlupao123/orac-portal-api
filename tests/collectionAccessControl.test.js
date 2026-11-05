import test from "node:test";
import assert from "node:assert/strict";

import { collectionGuards, getCollection } from "../src/controllers/coreController.js";
import { roles, hasPermission, effectivePermissionRoles } from "../src/permissions.js";

function createResponse() {
  return {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function requestFor(actor) {
  return {
    user: { id: actor.id },
    db: {
      users: [actor],
      clients: [{ id: "client-a" }],
      quotes: [{ id: "quote-a", client_id: "client-a" }],
      quote_lines: [{ id: "line-a", quotation_id: "quote-a" }, { id: "line-b", quotation_id: "quote-b" }],
      leads: [{ id: "lead-a", company_name: "Client A" }],
      stock_movements: [{ id: "movement-a", stock_item_id: "stock-a" }],
      mine_sites: [{ id: "mine-a" }],
      plants: [{ id: "plant-a" }],
      plant_sections: [{ id: "section-a" }],
      equipment_tags: [{ id: "equipment-a" }],
      catalog_items: [{ id: "catalog-a" }],
      suppliers: [{ id: "supplier-a" }],
      stock_items: [{ id: "stock-a" }],
      purchase_orders: [],
      invoices: [],
      audit_logs: [],
      access_requests: [],
      dispatch_cards: [{ id: "dispatch-a", quotation_id: "quote-a", assigned_technician_id: "tech-1", assigned_supervisor_id: "supervisor-1" }],
      field_worksheets: [{ id: "worksheet-a", dispatch_card_id: "dispatch-a", technician_id: "tech-1", supervisor_id: "supervisor-1" }],
      daily_timesheets: [{ id: "dts-a", technician_id: "tech-1" }],
      contractor_log_sheets: [{ id: "cls-a" }]
    }
  };
}

function expectDenied(collectionName, actor) {
  const response = createResponse();
  getCollection(collectionName)(requestFor(actor), response);
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.success, false);
}

test("Technician and Supervisor cannot read generic clients or quotes", () => {
  const technician = { id: "tech-1", role: "Technician", is_active: true };
  const supervisor = { id: "supervisor-1", role: "Supervisor", is_active: true };

  for (const actor of [technician, supervisor]) {
    expectDenied("clients", actor);
    expectDenied("quotes", actor);
    expectDenied("quote_lines", actor);
  }
});

test("Finance and Client Viewer cannot list generic field-work collections", () => {
  for (const actor of [
    { id: "finance-1", role: "Finance", is_active: true },
    { id: "client-1", role: "Client Viewer", client_id: "client-a", is_active: true }
  ]) {
    expectDenied("dispatch_cards", actor);
    expectDenied("field_worksheets", actor);
  }
});

test("Sales can list field-work collections (portfolio-scoped read-only access)", () => {
  const sales = { id: "sales-1", role: "Sales", is_active: true };
  const response = createResponse();
  getCollection("dispatch_cards")(requestFor(sales), response);
  assert.equal(response.statusCode, 200);
});

test("Operations retains permitted access to client, quote, and field-work collections", () => {
  const response = createResponse();
  const operations = { id: "ops-1", role: "Operations", is_active: true };

  getCollection("clients")(requestFor(operations), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.length, 1);
});

test("Client Viewer quote lines are server-scoped to the viewer's own client", () => {
  const clientViewer = { id: "client-1", role: "Client Viewer", client_id: "client-a", is_active: true };
  const response = createResponse();

  getCollection("quote_lines")(requestFor(clientViewer), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.data.map((line) => line.id), ["line-a"]);
});

test("commercial leads and stock movements reject roles without the relevant operational scope", () => {
  const technician = { id: "tech-1", role: "Technician", is_active: true };
  const sales = { id: "sales-1", role: "Sales", is_active: true };
  const operations = { id: "ops-1", role: "Operations", is_active: true };

  expectDenied("leads", technician);
  expectDenied("stock_movements", technician);

  const salesResponse = createResponse();
  getCollection("leads")(requestFor(sales), salesResponse);
  assert.equal(salesResponse.statusCode, 200);

  const inventoryResponse = createResponse();
  getCollection("stock_movements")(requestFor(operations), inventoryResponse);
  assert.equal(inventoryResponse.statusCode, 200);
});

test("every generic collection has an explicit eight-role read policy", () => {
  const genericCollections = [
    "users", "clients", "leads", "quotes", "quote_lines", "purchase_orders",
    "dispatch_cards", "field_worksheets", "invoices", "equipment_tags",
    "catalog_items", "audit_logs", "mine_sites", "plants", "plant_sections",
    "suppliers", "stock_items", "stock_movements", "access_requests"
  ];
  const knownRoles = new Set(Object.values(roles));

  for (const collectionName of genericCollections) {
    assert.ok(Array.isArray(collectionGuards[collectionName]), `${collectionName} must have a policy`);
    assert.ok(collectionGuards[collectionName].length > 0, `${collectionName} must not be open by omission`);
    for (const role of collectionGuards[collectionName]) {
      assert.ok(knownRoles.has(role), `${collectionName} contains an unknown role`);
    }
  }
});

test("unlisted generic data is denied by default", () => {
  const response = createResponse();
  const admin = { id: "admin-1", role: "Admin", is_active: true };
  const request = requestFor(admin);
  request.db.unreviewed_collection = [{ id: "private-a" }];

  getCollection("unreviewed_collection")(request, response);

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.success, false);
});

test("generic collection reads enforce the complete eight-role matrix", () => {
  for (const [collectionName, allowedRoles] of Object.entries(collectionGuards)) {
    for (const role of Object.values(roles)) {
      const actor = {
        id: role === roles.TECHNICIAN ? "tech-1" : role === roles.SUPERVISOR ? "supervisor-1" : `${role}-1`,
        role,
        client_id: role === roles.CLIENT_VIEWER ? "client-a" : undefined,
        is_active: true
      };
      const response = createResponse();

      getCollection(collectionName)(requestFor(actor), response);

      assert.equal(
        response.statusCode,
        allowedRoles.includes(role) ? 200 : 403,
        `${role} access to ${collectionName} must match the explicit policy`
      );
    }
  }
});

// ---- Phase 2: Sales Desk native paper entry ----------------------------------------------------
const FIELD_ENTRY_ROLES = [roles.ADMIN, roles.OPERATIONS, roles.SUPERVISOR, roles.TECHNICIAN, roles.SALES];

test("Sales holds create/submit rights for Timesheets and Daily Time Sheets, and exactly the intended roles do", () => {
  for (const permission of ["createWorksheet", "submitWorksheet", "createDailyTimesheet", "submitDailyTimesheet"]) {
    const allowed = effectivePermissionRoles(permission);
    assert.ok(allowed.includes(roles.SALES), `${permission} must include Sales`);
    assert.deepEqual([...allowed].sort(), [...FIELD_ENTRY_ROLES].sort(), `${permission} must not widen beyond Sales`);
    for (const role of [roles.FINANCE, roles.MANAGEMENT, roles.CLIENT_VIEWER]) {
      assert.equal(hasPermission({ role, is_active: true }, permission), false, `${role} must stay denied ${permission}`);
    }
  }
  assert.equal(hasPermission({ role: roles.SALES, is_active: false }, "createWorksheet"), false, "an inactive Sales account gets nothing");
});

test("Sales gains entry only: review, approval, materials and client acknowledgement stay closed to Sales", () => {
  for (const permission of [
    "reviewWorksheet", "reviewDailyTimesheet", "addTimesheet", "addMaterials", "acknowledgeWorksheet",
    "reviewContractorLog", "createContractorLog", "approveAmendment", "invoice"
  ]) {
    assert.equal(hasPermission({ role: roles.SALES, is_active: true }, permission), false, `Sales must not hold ${permission}`);
  }
});

test("granting Sales entry rights does not widen sensitive generic collection reads", () => {
  const sales = { id: "sales-1", role: "Sales", is_active: true };
  for (const collectionName of ["users", "audit_logs", "contractor_log_sheets"]) {
    expectDenied(collectionName, sales);
  }
});

test("Sales can list purchase orders and invoices scoped to its commercial portfolio", () => {
  const sales = { id: "sales-1", role: "Sales", is_active: true };
  const req = requestFor(sales);
  req.db.users.push({ id: "sales-2", role: "Sales", is_active: true });
  req.db.quotes = [
    { id: "quote-a", client_id: "client-a", sales_owner_id: "sales-1" },
    { id: "quote-b", client_id: "client-b", sales_owner_id: "sales-2" }
  ];
  req.db.clients = [{ id: "client-a" }, { id: "client-b" }];
  req.db.purchase_orders = [
    { id: "po-a", quotation_id: "quote-a", po_reference: "PO-A", po_amount: 1500 },
    { id: "po-b", quotation_id: "quote-b", po_reference: "PO-B", po_amount: 2500 }
  ];
  req.db.invoices = [
    { id: "inv-a", quotation_id: "quote-a", invoice_number: "INV-A", total_amount: 1500 },
    { id: "inv-b", quotation_id: "quote-b", invoice_number: "INV-B", total_amount: 2500 }
  ];

  const poRes = createResponse();
  getCollection("purchase_orders")(req, poRes);
  assert.equal(poRes.statusCode, 200);
  assert.deepEqual(poRes.body.data.map((p) => p.id), ["po-a"]);

  const invRes = createResponse();
  getCollection("invoices")(req, invRes);
  assert.equal(invRes.statusCode, 200);
  assert.deepEqual(invRes.body.data.map((i) => i.id), ["inv-a"]);
});

test("Sales sees only portfolio worksheets and its own paper entries, never another desk's", () => {
  const sales = { id: "sales-1", role: "Sales", is_active: true };
  const req = requestFor(sales);
  req.db.users.push({ id: "sales-2", role: "Sales", is_active: true });
  req.db.quotes = [{ id: "quote-a", client_id: "client-a", sales_owner_id: "sales-1" }, { id: "quote-b", client_id: "client-b", sales_owner_id: "sales-2" }];
  req.db.clients = [{ id: "client-a" }, { id: "client-b" }];
  req.db.dispatch_cards = [{ id: "dispatch-a", quotation_id: "quote-a" }, { id: "dispatch-b", quotation_id: "quote-b" }];
  req.db.field_worksheets = [
    { id: "ws-mine", dispatch_card_id: "dispatch-a", source: "paper_entry", created_by: "sales-1" },
    { id: "ws-other", dispatch_card_id: "dispatch-b", source: "paper_entry", created_by: "sales-2" }
  ];
  req.db.daily_timesheets = [
    { id: "dts-mine", source: "paper_entry", created_by: "sales-1" },
    { id: "dts-other", source: "paper_entry", created_by: "sales-2" },
    { id: "dts-tech", technician_id: "tech-1", created_by: "tech-1" }
  ];

  const worksheets = createResponse();
  getCollection("field_worksheets")(req, worksheets);
  assert.deepEqual(worksheets.body.data.map((row) => row.id), ["ws-mine"]);

  const dailies = createResponse();
  getCollection("daily_timesheets")(req, dailies);
  assert.deepEqual(dailies.body.data.map((row) => row.id), ["dts-mine"], "Sales sees the daily paper entries it keyed in, and no one else's");
});
