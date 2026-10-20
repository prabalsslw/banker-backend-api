const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const { isValidPhone, isValidPin, isNonEmptyString } = require('../utils/validators');
const { normalizePhone, normalizeEmail, encryptPrivateField, decryptPrivateField, lookupHash } = require('../utils/privateFields');
const router = express.Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { message: 'Too many login attempts. Please wait and try again.' } });
const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { message: 'Too many signup attempts. Please try again later.' } });

function publicUser(user) {
  return { id: user._id.toString(), name: user.name, phone: decryptPrivateField(user.phoneEncrypted), email: decryptPrivateField(user.emailEncrypted), biometricEnabled: user.biometricEnabled, createdAt: user.createdAt };
}
function createToken(user) {
  return jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '1h' });
}

router.post('/signup', signupLimiter, asyncHandler(async (req, res) => {
  const { name, phone, email, pin } = req.body || {};
  if (!isNonEmptyString(name, 100) || name.trim().length < 2) return res.status(400).json({ message: 'Name must be between 2 and 100 characters.' });
  if (!isValidPhone(phone)) return res.status(400).json({ message: 'Enter a valid Bangladesh mobile number, e.g. 01712345678.' });
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || email.length > 254) return res.status(400).json({ message: 'Enter a valid email address.' });
  if (!isValidPin(pin)) return res.status(400).json({ message: 'PIN must contain exactly 4 digits.' });

  const normalizedPhone = normalizePhone(phone);
  const normalizedEmail = normalizeEmail(email);
  const phoneLookup = lookupHash(normalizedPhone, 'phone');
  const emailLookup = lookupHash(normalizedEmail, 'email');
  const existing = await User.findOne({ $or: [{ phoneLookup }, { emailLookup }] }).select('+phoneLookup +emailLookup');
  if (existing) return res.status(409).json({ message: existing.phoneLookup === phoneLookup ? 'This phone number is already registered.' : 'This email address is already registered.' });

  const user = await User.create({
    name: name.trim(), phoneEncrypted: encryptPrivateField(normalizedPhone), phoneLookup,
    emailEncrypted: encryptPrivateField(normalizedEmail), emailLookup,
    pinHash: await bcrypt.hash(pin, 12)
  });
  return res.status(201).json({ message: 'Account created successfully.', token: createToken(user), user: publicUser(user) });
}));

router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const { phone, pin } = req.body || {};
  if (!isValidPhone(phone) || !isValidPin(pin)) return res.status(400).json({ message: 'Enter a valid mobile number and 4-digit PIN.' });
  const phoneLookup = lookupHash(normalizePhone(phone), 'phone');
  const user = await User.findOne({ phoneLookup }).select('+pinHash +phoneEncrypted +emailEncrypted');
  if (!user || !user.isActive) return res.status(401).json({ message: 'Invalid phone number or PIN.' });
  if (!(await bcrypt.compare(pin, user.pinHash))) return res.status(401).json({ message: 'Invalid phone number or PIN.' });
  return res.json({ message: 'Login successful.', token: createToken(user), user: publicUser(user) });
}));
module.exports = router;
