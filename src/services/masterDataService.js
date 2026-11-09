// Shared create operations for master data that is created in bulk by the importer
// and one at a time by the admin forms. Each function does exactly what the
// request handler did before it was moved here: permission check, defaults,
// append to the collection, audit entry. Behaviour of the admin routes is unchanged.
import { requirePermission } from "../permissions.js";

// A rule that the old handler answered with HTTP 400. The handler catches this and
// answers with the same status and body as before.
export class MasterDataRuleError extends Error {
  constructor(message) {
    super(message);
    this.name = "MasterDataRuleError";
    this.status = 400;
  }
}

export function createClientRecord({ db, store, actor, input }) {
  requirePermission(actor, "manageClients");
  const client = {
    id: store.id("c"),
    name: input.name,
    client_type: input.client_type,
    contact_person: input.contact_person || "",
    email: input.email || "",
    is_active: true
  };
  db.clients.push(client);
  store.audit(db, actor, "client", client.id, "ADMIN_CLIENT_CREATED", null, client);
  return client;
}

export function createCatalogItemRecord({ db, store, actor, input }) {
  requirePermission(actor, "manageCatalog");
  // Negative-price guard: enforced by the schema and again here (kept from the old handler).
  if (Number(input.unit_price) < 0) {
    throw new MasterDataRuleError("Unit price cannot be negative.");
  }
  const item = {
    id: store.id("cat"),
    item_code: input.item_code,
    item_name: input.item_name,
    category: input.category || "",
    unit_of_measure: input.unit_of_measure || "",
    unit_price: Number(input.unit_price),
    material_grade: input.material_grade || "",
    dimensions: input.dimensions || ""
  };
  db.catalog_items.push(item);
  store.audit(db, actor, "catalog_item", item.id, "ADMIN_CATALOG_ITEM_CREATED", null, item);
  return item;
}
