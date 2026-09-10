import { roles } from "../permissions.js";

// True only for the Client Viewer role. Internal roles are never scoped —
// scoping exists solely to isolate one client's data from another's.
export function isClientViewer(actor) {
  return actor?.role === roles.CLIENT_VIEWER;
}

// Filters `items` down to the ones belonging to `actor`'s client, using
// `resolveClientId(item)` to determine each item's owning client_id.
// No-op for any non-Client-Viewer actor. A Client Viewer with no client_id
// on their user record sees nothing, rather than everything.
export function scopeByClient(items, actor, resolveClientId) {
  if (!isClientViewer(actor)) return items;
  if (!actor.client_id) return [];
  return items.filter((item) => resolveClientId(item) === actor.client_id);
}