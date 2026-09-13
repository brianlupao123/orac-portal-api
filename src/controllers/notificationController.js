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

  return db.notifications.filter(notif => {
    const targetRoles = Array.isArray(notif.target_roles) ? notif.target_roles : [];

    // Curated and legacy notifications can target one specific user. Keep this
    // narrow path separate from role and client visibility.
    if (notif.user_id) {
      return notif.user_id === user.id;
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

export function getNotifications(req, res) {
  const visible = getVisibleNotifications(req.db, req.user);
  res.json({ success: true, data: visible });
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
  res.json({ success: true, data: notif });
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
