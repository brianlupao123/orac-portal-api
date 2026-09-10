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
function getVisibleNotifications(db, jwtUser) {
  if (!db.notifications) return [];

  const user = resolveUser(db, jwtUser);

  return db.notifications.filter(notif => {
    // Client Viewer only sees their assigned client notifications
    if (user.role === "Client Viewer") {
      if (!user.client_id) return false;
      return notif.client_id === user.client_id && notif.target_roles.includes("Client Viewer");
    }

    // Role-based visibility for all other roles
    return notif.target_roles.includes(user.role);
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
    if (!notif.read_by.includes(user.id)) {
      notif.read_by.push(user.id);
    }
  }

  // Mutation committed automatically by server.js middleware on successful res.json
  res.json({ success: true, message: "All notifications marked as read." });
}
