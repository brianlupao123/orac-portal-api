import test from "node:test";
import assert from "node:assert/strict";

import { buildCuratedDemoData } from "../src/curatedDemoData.js";

const users = [
  { id: "admin-1", role: "Admin" },
  { id: "sales-1", role: "Sales" },
  { id: "tech-1", role: "Technician" },
  { id: "supervisor-1", role: "Supervisor" }
];

test("curated demo data uses valid pipeline states and connected asset hierarchy", () => {
  const data = buildCuratedDemoData(users);
  const clientIds = new Set(data.clients.map((client) => client.id));
  const siteIds = new Set(data.mine_sites.map((site) => site.id));
  const plantIds = new Set(data.plants.map((plant) => plant.id));
  const sectionIds = new Set(data.plant_sections.map((section) => section.id));
  const validQuoteStates = new Set(["Draft", "Sent", "Approved_Pending_PO", "PO_Verified", "Invoiced"]);

  assert.ok(data.quotes.every((quote) => validQuoteStates.has(quote.status)));
  assert.ok(data.mine_sites.every((site) => clientIds.has(site.client_id)));
  assert.ok(data.plants.every((plant) => siteIds.has(plant.mine_site_id)));
  assert.ok(data.plant_sections.every((section) => plantIds.has(section.plant_id)));
  assert.ok(data.equipment_tags.every((tag) => sectionIds.has(tag.plant_section_id)));
});

test("curated demo data keeps dispatch, worksheet, PO, and invoice references connected", () => {
  const data = buildCuratedDemoData(users);
  const quoteIds = new Set(data.quotes.map((quote) => quote.id));
  const poIds = new Set(data.purchase_orders.map((po) => po.id));
  const dispatchIds = new Set(data.dispatch_cards.map((dispatch) => dispatch.id));

  assert.ok(data.purchase_orders.every((po) => quoteIds.has(po.quotation_id)));
  assert.ok(data.dispatch_cards.every((dispatch) => quoteIds.has(dispatch.quotation_id) && poIds.has(dispatch.purchase_order_id)));
  assert.ok(data.field_worksheets.every((worksheet) => dispatchIds.has(worksheet.dispatch_card_id)));
  assert.ok(data.invoices.every((invoice) => dispatchIds.has(invoice.dispatch_card_id)));
});
