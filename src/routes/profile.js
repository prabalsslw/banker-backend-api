const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const authenticate = require('../middleware/authenticate');
const asyncHandler = require('../utils/asyncHandler');
const { isValidPin, isNonEmptyString } = require('../utils/validators');
const { normalizeEmail, encryptPrivateField, decryptPrivateField, lookupHash } = require('../utils/privateFields');
const router = express.Router();
router.use(authenticate);
function publicUser(user) { return { id: user._id.toString(), name: user.name, phone: decryptPrivateField(user.phoneEncrypted), email: decryptPrivateField(user.emailEncrypted), biometricEnabled: user.biometricEnabled, createdAt: user.createdAt }; }

router.get('/', asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id).select('+phoneEncrypted +emailEncrypted');
  if (!user) return res.status(404).json({ message: 'User not found.' });
  res.json({ user: publicUser(user) });
}));

router.patch('/', asyncHandler(async (req, res) => {
  const { name, email } = req.body || {};
  const updates = {};
  if (name !== undefined) {
    if (!isNonEmptyString(name, 100) || name.trim().length < 2) return res.status(400).json({ message: 'Name must be between 2 and 100 characters.' });
    updates.name = name.trim();
  }
  if (email !== undefined) {
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || email.length > 254) return res.status(400).json({ message: 'Enter a valid email address.' });
    const normalizedEmail = normalizeEmail(email);
    const emailLookup = lookupHash(normalizedEmail, 'email');
    const existing = await User.findOne({ emailLookup, _id: { $ne: req.user.id } });
    if (existing) return res.status(409).json({ message: 'This email address is already registered.' });
    updates.emailEncrypted = encryptPrivateField(normalizedEmail);
    updates.emailLookup = emailLookup;
  }
  if (!Object.keys(updates).length) return res.status(400).json({ message: 'Provide name or email to update.' });
  const user = await User.findByIdAndUpdate(req.user.id, { $set: updates }, { new: true, runValidators: true }).select('+phoneEncrypted +emailEncrypted');
  res.json({ message: 'Profile updated.', user: publicUser(user) });
}));

router.patch('/pin', asyncHandler(async (req, res) => {
  const { currentPin, newPin } = req.body || {};
  if (!isValidPin(currentPin) || !isValidPin(newPin)) return res.status(400).json({ message: 'Current and new PIN must each contain exactly 4 digits.' });
  if (currentPin === newPin) return res.status(400).json({ message: 'New PIN must be different from current PIN.' });
  const user = await User.findById(req.user.id).select('+pinHash');
  if (!user || !(await bcrypt.compare(currentPin, user.pinHash))) return res.status(401).json({ message: 'Current PIN is incorrect.' });
  user.pinHash = await bcrypt.hash(newPin, 12);
  await user.save();
  res.json({ message: 'PIN changed successfully. Log in again if requested.' });
}));

router.patch('/biometric', asyncHandler(async (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ message: 'enabled must be true or false.' });
  const user = await User.findByIdAndUpdate(req.user.id, { $set: { biometricEnabled: enabled } }, { new: true });
  res.json({ biometricEnabled: user.biometricEnabled });
}));
module.exports = router;
