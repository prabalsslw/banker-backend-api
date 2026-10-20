const express = require('express');
const Notification = require('../models/Notification');
const authenticate = require('../middleware/authenticate');
const asyncHandler = require('../utils/asyncHandler');
const { isValidObjectId, isNonEmptyString } = require('../utils/validators');

const router = express.Router();
router.use(authenticate);

router.get('/', asyncHandler(async (req, res) => {
  const filter = { ownerId: req.user.id };
  if (req.query.isRead !== undefined) {
    if (!['true', 'false'].includes(req.query.isRead)) return res.status(400).json({ message: 'isRead must be true or false.' });
    filter.isRead = req.query.isRead === 'true';
  }
  const notifications = await Notification.find(filter).sort({ createdAt: -1 }).limit(100);
  res.json({ count: notifications.length, notifications });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { type, title, message, relatedId } = req.body || {};
  if (!isNonEmptyString(title, 150)) return res.status(400).json({ message: 'title is required (maximum 150 characters).' });
  if (!isNonEmptyString(message, 2000)) return res.status(400).json({ message: 'message is required (maximum 2000 characters).' });
  const validTypes = ['info', 'success', 'warning', 'payment', 'system'];
  if (type !== undefined && !validTypes.includes(type)) return res.status(400).json({ message: 'Invalid notification type.' });
  if (relatedId !== undefined && relatedId !== null && (typeof relatedId !== 'string' || relatedId.length > 100)) return res.status(400).json({ message: 'relatedId must be a string up to 100 characters.' });

  const notification = await Notification.create({
    ownerId: req.user.id,
    type: type || 'info',
    title: title.trim(),
    message: message.trim(),
    relatedId: relatedId || null
  });
  res.status(201).json({ message: 'Notification created.', notification });
}));

router.patch('/:id/read', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid notification ID.' });
  const { isRead } = req.body || {};
  if (isRead !== undefined && typeof isRead !== 'boolean') return res.status(400).json({ message: 'isRead must be true or false.' });

  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, ownerId: req.user.id },
    { $set: { isRead: isRead === undefined ? true : isRead } },
    { new: true }
  );
  if (!notification) return res.status(404).json({ message: 'Notification not found.' });
  res.json({ message: 'Notification updated.', notification });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid notification ID.' });
  const notification = await Notification.findOneAndDelete({ _id: req.params.id, ownerId: req.user.id });
  if (!notification) return res.status(404).json({ message: 'Notification not found.' });
  res.json({ message: 'Notification deleted.' });
}));

module.exports = router;
