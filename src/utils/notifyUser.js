const User = require('../models/User');
const Notification = require('../models/Notification');

// Only service activity is configurable. Account/security/profile events are intentionally
// not routed through this helper and therefore cannot be toggled here.
async function notifyUser(ownerId, { type = 'info', title, message, relatedId = null, service = 'wallet' }) {
  const user = await User.findById(ownerId).select('notificationsEnabled notificationPreferences').lean();
  if (!user || user.notificationsEnabled === false) return null;
  const prefs = user.notificationPreferences || {};
  if (prefs[service] === false) return null;
  return Notification.create({ ownerId, type, title: String(title).slice(0, 150), message: String(message).slice(0, 2000), relatedId: relatedId ? String(relatedId).slice(0, 100) : null, service });
}
module.exports = { notifyUser };
