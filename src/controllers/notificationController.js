import { resolveDestination } from "../notificationDestinations.js";

const MAX_NOTIFICATIONS_RETURNED = 100;

/**
 * Resolve the full user record from db (JWT payload may not include client_id).
 */
function resolveUser(db, jwtUser) {
  const full = db.users.find(u => u.id === jwtUser.id);
  return full || jwtUser;
}

/**
 * Filter notifications based on role visibility rules and client-scoped isolation.
 * Server-side enforcement — frontend filtering is only UX.
 */
export function getVisibleNotifications(db, jwtUser) {
  if (!db.notifications) return [];

  const user = resolveUser(db, jwtUser);
  if (user.is_active === false) return [];

  return db.notifications.filter(notif => {
    const targetRoles = Array.isArray(notif.target_roles) ? notif.target_roles : [];

    // Curated and legacy notifications can target one specific user. Keep this
    // narrow path separate from role and client visibility.
    if (notif.user_id) {
      return notif.user_id === user.id;
    }

    // A person who raised an item is not also told about it as a "recipient".
    if (Array.isArray(notif.exclude_user_ids) && notif.exclude_user_ids.includes(user.id)) {
      return false;
    }

    // Client Viewer only sees their assigned client notifications
    if (user.role === "Client Viewer") {
      if (!user.client_id) return false;
      return notif.client_id === user.client_id && targetRoles.includes("Client Viewer");
    }

    // Role-based visibility for all other roles
    return targetRoles.includes(user.role);
  }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

/**
 * The shape a viewer receives. Read state is projected for THIS viewer only:
 * the stored read_by list (other people's user IDs), target_roles, exclusion
 * lists and audit ids never leave the server.
 */
export function toNotificationView(db, user, notif) {
  const readBy = Array.isArray(notif.read_by) ? notif.read_by : [];
  return {
    id: notif.id,
    type: notif.type,
    title: notif.title,
    message: notif.message,
    severity: notif.severity,
    created_at: notif.created_at,
    read: readBy.includes(user.id),
    destination: resolveDestination(db, user, notif.destination)
  };
}

export function getNotifications(req, res) {
  const user = resolveUser(req.db, req.user);
  const visible = getVisibleNotifications(req.db, req.user);
  const data = visible.slice(0, MAX_NOTIFICATIONS_RETURNED).map((notif) => toNotificationView(req.db, user, notif));
  res.json({ success: true, data });
}

export function markRead(req, res) {
  // Must apply visibility check before allowing mark-read
  const visible = getVisibleNotifications(req.db, req.user);
  const notif = visible.find(n => n.id === req.params.id);

  if (!notif) {
    return res.status(404).json({ success: false, message: "Notification not found or not visible." });
  }

  const user = resolveUser(req.db, req.user);
  if (!Array.isArray(notif.read_by)) notif.read_by = [];
  if (!notif.read_by.includes(user.id)) {
    notif.read_by.push(user.id);
  }

  // Mutation committed automatically by server.js middleware on successful res.json
  res.json({ success: true, data: toNotificationView(req.db, user, notif) });
}

export function markAllRead(req, res) {
  const visible = getVisibleNotifications(req.db, req.user);
  const user = resolveUser(req.db, req.user);

  for (const notif of visible) {
    if (!Array.isArray(notif.read_by)) notif.read_by = [];
    if (!notif.read_by.includes(user.id)) {
      notif.read_by.push(user.id);
    }
  }

  // Mutation committed automatically by server.js middleware on successful res.json
  res.json({ success: true, message: "All notifications marked as read." });
}
