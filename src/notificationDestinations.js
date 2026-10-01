import { roles, permissions } from "./permissions.js";

// Typed, validated notification destinations.
//
// A notification stores only a { kind, id } pair. It never stores a URL, a route
// or a free-text link. The route is resolved here, at read time, for the
// CURRENT viewer, from a fixed table that mirrors the frontend ROUTE_ACCESS
// policy. That keeps three properties:
//   1. a stored notification can never point outside the application;
//   2. a viewer is only ever sent to a workspace their role can open;
//   3. a missing, deleted or out-of-scope record produces the same honest
//      "no longer available" fallback, so it cannot be used to probe whether a
//      record exists or which client owns it.

const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

const {
  ADMIN, MANAGEMENT, SALES, FINANCE, OPERATIONS, SUPERVISOR, TECHNICIAN, CLIENT_VIEWER
} = roles;

// kind -> { collection, label, routes: { role: { path, query?, exact? } } }
// `exact: true` means the destination page can open/focus that one record from
// the `focus` query value. Only pages that really do this may set it; every
// other page opens its list and the message says so honestly.
export const DESTINATIONS = Object.freeze({
  access_request: {
    collection: "access_requests",
    label: "Access requests",
    routes: Object.fromEntries(permissions.viewAccessRequests.map((role) => [role, { path: "/admin", query: { tab: "access-requests" }, exact: true }]))
  },
  internal_work_request: {
    collection: "internal_work_requests",
    label: "Internal requests",
    routes: Object.fromEntries([ADMIN, MANAGEMENT, SALES, FINANCE, OPERATIONS, SUPERVISOR, TECHNICIAN].map((role) => [role, { path: "/internal-requests" }]))
  },
  service_request: {
    collection: "service_requests",
    label: "Service requests",
    routes: {
      [SALES]: { path: "/service-requests" },
      [OPERATIONS]: { path: "/service-requests" },
      [CLIENT_VIEWER]: { path: "/portal" }
    }
  },
  worksheet: {
    collection: "field_worksheets",
    label: "Timesheets",
    routes: {
      ...Object.fromEntries([ADMIN, MANAGEMENT, OPERATIONS, SUPERVISOR, TECHNICIAN].map((role) => [role, { path: "/worksheets" }])),
      [CLIENT_VIEWER]: { path: "/portal" }
    }
  },
  dispatch_card: {
    collection: "dispatch_cards",
    label: "Timesheets",
    routes: Object.fromEntries([ADMIN, MANAGEMENT, OPERATIONS, SUPERVISOR, TECHNICIAN].map((role) => [role, { path: "/worksheets" }]))
  },
  quote: {
    collection: "quotes",
    label: "Quotations",
    routes: {
      [ADMIN]: { path: "/quotations" },
      [SALES]: { path: "/quotations" },
      [FINANCE]: { path: "/finance" },
      [CLIENT_VIEWER]: { path: "/portal" }
    }
  },
  purchase_order: {
    collection: "purchase_orders",
    label: "PO & Invoicing",
    routes: { [ADMIN]: { path: "/finance" }, [FINANCE]: { path: "/finance" }, [CLIENT_VIEWER]: { path: "/portal" } }
  },
  invoice: {
    collection: "invoices",
    label: "PO & Invoicing",
    routes: { [ADMIN]: { path: "/finance" }, [FINANCE]: { path: "/finance" }, [CLIENT_VIEWER]: { path: "/portal" } }
  },
  stock_item: {
    collection: "stock_items",
    label: "Inventory",
    routes: Object.fromEntries([ADMIN, MANAGEMENT, OPERATIONS].map((role) => [role, { path: "/inventory" }]))
  },
  lead: {
    collection: "leads",
    label: "Leads",
    routes: {}
  }
});

export const DESTINATION_KINDS = Object.freeze(Object.keys(DESTINATIONS));

/** Returns a clean { kind, id } or null. Never throws; anything odd becomes null. */
export function buildDestination(kind, id) {
  if (typeof kind !== "string" || !Object.hasOwn(DESTINATIONS, kind)) return null;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
  return { kind, id };
}

function ownerClientId(db, kind, entity) {
  const quoteClient = (quoteId) => (db.quotes || []).find((q) => q.id === quoteId)?.client_id || null;
  const dispatchClient = (dispatchId) => {
    const dispatch = (db.dispatch_cards || []).find((d) => d.id === dispatchId);
    return dispatch ? quoteClient(dispatch.quotation_id) : null;
  };
  switch (kind) {
    case "quote": return entity.client_id || null;
    case "service_request": return entity.client_id || null;
    case "purchase_order": return quoteClient(entity.quotation_id);
    case "worksheet": return dispatchClient(entity.dispatch_card_id);
    case "invoice": return dispatchClient(entity.dispatch_card_id);
    default: return null;
  }
}

// Conservative record-level check. Page APIs still enforce their own scope; this
// only decides whether it is honest to say "this record" to this viewer.
function viewerMaySee(db, user, kind, entity) {
  if (user.role === CLIENT_VIEWER) {
    const owner = ownerClientId(db, kind, entity);
    return Boolean(user.client_id) && owner === user.client_id;
  }
  if (user.role === TECHNICIAN && kind === "worksheet") {
    return entity.technician_id === user.id || entity.submitted_by === user.id || entity.created_by === user.id;
  }
  if (kind === "internal_work_request") {
    // Only the requester, the addressed role, or the read-only Admin audit may be
    // told a request is "this record"; anyone else gets the honest fallback.
    return entity.created_by_user_id === user.id || entity.recipient_role === user.role || user.role === ADMIN;
  }
  if (user.role === SUPERVISOR && (kind === "worksheet" || kind === "dispatch_card")) {
    const dispatchId = kind === "worksheet" ? entity.dispatch_card_id : entity.id;
    const dispatch = (db.dispatch_cards || []).find((d) => d.id === dispatchId);
    const linked = (db.field_worksheets || []).filter((w) => w.dispatch_card_id === dispatchId);
    return entity.supervisor_id === user.id || dispatch?.assigned_supervisor_id === user.id ||
      dispatch?.supervisor_id === user.id || linked.some((w) => w.supervisor_id === user.id);
  }
  if (user.role === TECHNICIAN && kind === "dispatch_card") {
    return false; // technicians reach dispatches only through their own worksheets
  }
  return true;
}

function fallback(note, resolved = false) {
  return { route: "/", exact: false, resolved, note };
}

function toRoute(rule, id, exact) {
  const params = new URLSearchParams(rule.query || {});
  if (exact) params.set("focus", id);
  const query = params.toString();
  return query ? `${rule.path}?${query}` : rule.path;
}

/**
 * Resolve a stored { kind, id } for the CURRENT viewer.
 * Always returns { route, exact, resolved, note, kind?, id? }; never throws.
 */
export function resolveDestination(db, user, destination) {
  const clean = destination ? buildDestination(destination.kind, destination.id) : null;
  if (!clean || !user) {
    return fallback("This notification has no linked record. Showing your dashboard.");
  }
  const spec = DESTINATIONS[clean.kind];
  const rule = spec.routes[user.role];
  if (!rule) {
    return { ...fallback(`This item is not available in your workspace. Showing your dashboard.`), kind: clean.kind };
  }

  const entity = (db[spec.collection] || []).find((item) => item.id === clean.id);
  if (!entity || !viewerMaySee(db, user, clean.kind, entity)) {
    // Same answer for "does not exist", "was deleted" and "belongs to someone
    // else": nothing about the record is revealed.
    return {
      route: toRoute(rule, clean.id, false),
      exact: false,
      resolved: false,
      kind: clean.kind,
      note: `That record is no longer available to you. Showing ${spec.label}.`
    };
  }

  const exact = Boolean(rule.exact);
  return {
    route: toRoute(rule, clean.id, exact),
    exact,
    resolved: true,
    kind: clean.kind,
    id: clean.id,
    note: exact ? "" : `Opened ${spec.label}. Look for this item in the list.`
  };
}
