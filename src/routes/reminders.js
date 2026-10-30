const express = require('express');
const Reminder = require('../models/Reminder');
const Notification = require('../models/Notification');
const authenticate = require('../middleware/authenticate');
const asyncHandler = require('../utils/asyncHandler');
const { isValidObjectId, isNonEmptyString } = require('../utils/validators');
const router = express.Router();
router.use(authenticate);
const serialize = (item) => ({ ...item.toObject(), id: item._id.toString() });
router.get('/', asyncHandler(async (req, res) => {
  const reminders = await Reminder.find({ ownerId: req.user.id }).sort({ scheduledAt: 1 }).limit(500);
  // Due reminders are surfaced in the in-app notification feed as virtual entries.
  const due = reminders.filter((r) => r.status === 'active' && r.scheduledAt <= new Date());
  for (const reminder of due) {
    const exists = await Notification.exists({ ownerId: req.user.id, relatedId: `reminder:${reminder._id}` });
    if (!exists) await Notification.create({ ownerId: req.user.id, type: 'reminder', service: 'reminder', title: reminder.title, message: reminder.description || 'Your reminder is due now.', relatedId: `reminder:${reminder._id}` });
    if (!reminder.firedAt) { reminder.firedAt = new Date(); await reminder.save(); }
  }
  res.json({ reminders: reminders.map(serialize) });
}));
router.post('/', asyncHandler(async (req, res) => {
  const { title, description = '', scheduledAt } = req.body || {};
  if (!isNonEmptyString(title, 100)) return res.status(400).json({ message: 'Reminder title is required (maximum 100 characters).' });
  if (typeof description !== 'string' || description.length > 100) return res.status(400).json({ message: 'Description must be 100 characters or fewer.' });
  const date = new Date(scheduledAt);
  if (!scheduledAt || Number.isNaN(date.getTime())) return res.status(400).json({ message: 'A valid reminder date and time is required.' });
  if (date <= new Date()) return res.status(400).json({ message: 'Choose a future date and time.' });
  const reminder = await Reminder.create({ ownerId: req.user.id, title: title.trim(), description: description.trim(), scheduledAt: date });
  res.status(201).json({ message: 'Reminder created.', reminder: serialize(reminder) });
}));
router.patch('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid reminder ID.' });
  const patch = {};
  if (req.body.title !== undefined) { if (!isNonEmptyString(req.body.title, 100)) return res.status(400).json({ message: 'Title is required (maximum 100 characters).' }); patch.title = req.body.title.trim(); }
  if (req.body.description !== undefined) { if (typeof req.body.description !== 'string' || req.body.description.length > 100) return res.status(400).json({ message: 'Description must be 100 characters or fewer.' }); patch.description = req.body.description.trim(); }
  if (req.body.scheduledAt !== undefined) { const date = new Date(req.body.scheduledAt); if (Number.isNaN(date.getTime()) || date <= new Date()) return res.status(400).json({ message: 'Choose a valid future date and time.' }); patch.scheduledAt = date; patch.firedAt = null; patch.localNotificationId = null; }
  if (req.body.status !== undefined) { if (!['active', 'completed'].includes(req.body.status)) return res.status(400).json({ message: 'Invalid reminder status.' }); patch.status = req.body.status; }
  if (req.body.localNotificationId !== undefined) patch.localNotificationId = typeof req.body.localNotificationId === 'string' ? req.body.localNotificationId.slice(0, 200) : null;
  const reminder = await Reminder.findOneAndUpdate({ _id: req.params.id, ownerId: req.user.id }, { $set: patch }, { new: true, runValidators: true });
  if (!reminder) return res.status(404).json({ message: 'Reminder not found.' });
  res.json({ message: 'Reminder updated.', reminder: serialize(reminder) });
}));
router.delete('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid reminder ID.' });
  const reminder = await Reminder.findOneAndDelete({ _id: req.params.id, ownerId: req.user.id });
  if (!reminder) return res.status(404).json({ message: 'Reminder not found.' });
  await Notification.deleteMany({ ownerId: req.user.id, relatedId: `reminder:${reminder._id}` });
  res.json({ message: 'Reminder deleted.' });
}));
module.exports = router;
