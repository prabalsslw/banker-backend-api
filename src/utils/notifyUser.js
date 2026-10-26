const User = require('../models/User');
const Notification = require('../models/Notification');

async function notifyUser(ownerId, { type = 'info', title, message, relatedId = null }) {
  const user = await User.findById(ownerId).select('notificationsEnabled').lean();
  // Existing users without the field are treated as enabled; explicit false suppresses storage.
  if (user && user.notificationsEnabled === false) return null;
  return Notification.create({ ownerId, type, title: String(title).slice(0, 150), message: String(message).slice(0, 2000), relatedId: relatedId ? String(relatedId).slice(0, 100) : null });
}
module.exports = { notifyUser };
