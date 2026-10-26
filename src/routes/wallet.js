const express = require('express');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const WalletTransaction = require('../models/WalletTransaction');
const User = require('../models/User');
const authenticate = require('../middleware/authenticate');
const asyncHandler = require('../utils/asyncHandler');
const { isValidPin, isNonEmptyString } = require('../utils/validators');
const { postWalletTransaction, getBalancePaisa } = require('../utils/walletLedger');
const { notifyUser } = require('../utils/notifyUser');
const router = express.Router();
router.use(authenticate);
const moneyToPaisa = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || Math.abs(Math.round(n * 100) / 100 - n) > 0.000001) throw new Error('Amount must be greater than zero and have at most two decimal places.');
  return Math.round(n * 100);
};
router.get('/', asyncHandler(async (req, res) => {
  const ownerId = new mongoose.Types.ObjectId(req.user.id);
  const [rows, balancePaisa] = await Promise.all([
    WalletTransaction.find({ ownerId }).sort({ occurredAt: -1 }).limit(100).lean(),
    getBalancePaisa(req.user.id)
  ]);
  res.json({ balance: balancePaisa / 100, transactions: rows.map(x => ({ id: String(x._id), amount: x.amountPaisa / 100, type: x.type, description: x.description, occurredAt: x.occurredAt })) });
}));
router.post('/deposit', asyncHandler(async (req, res) => {
  const { amount, method, pin } = req.body || {};
  let amountPaisa;
  try { amountPaisa = moneyToPaisa(amount); } catch (error) { return res.status(400).json({ message: error.message }); }
  if (amountPaisa > 1000000000) return res.status(400).json({ message: 'Maximum deposit per transaction is ৳1,00,00,000 (1 crore).' });
  if (!isNonEmptyString(method, 80)) return res.status(400).json({ message: 'A deposit method is required.' });
  if (!isValidPin(pin)) return res.status(400).json({ message: 'A valid 4-digit PIN is required.' });
  const user = await User.findById(req.user.id).select('+pinHash');
  if (!user || !(await bcrypt.compare(pin, user.pinHash))) return res.status(401).json({ message: 'Incorrect PIN.' });
  await postWalletTransaction({ ownerId: req.user.id, amountPaisa, type: 'deposit', description: `Deposit via ${method.trim()}`, referenceKey: `deposit:${new mongoose.Types.ObjectId()}`, allowNegative: true });
  await notifyUser(req.user.id, { type: 'success', title: 'Deposit recorded', message: `৳${(amountPaisa / 100).toFixed(2)} was added via ${method.trim()}.` });
  res.status(201).json({ message: 'Deposit recorded.', balance: (await getBalancePaisa(req.user.id)) / 100 });
}));

router.post('/debit', asyncHandler(async (req, res) => {
  const { amount, purpose, referenceKey, pin } = req.body || {};
  let amountPaisa;
  try { amountPaisa = moneyToPaisa(amount); } catch (error) { return res.status(400).json({ message: error.message }); }
  if (!isNonEmptyString(purpose, 150)) return res.status(400).json({ message: 'A purpose is required.' });
  if (!isValidPin(pin)) return res.status(400).json({ message: 'A valid 4-digit PIN is required.' });
  const user = await User.findById(req.user.id).select('+pinHash');
  if (!user || !(await bcrypt.compare(pin, user.pinHash))) return res.status(401).json({ message: 'Incorrect PIN.' });
  const safeRef = typeof referenceKey === 'string' && /^[a-zA-Z0-9:_-]{4,120}$/.test(referenceKey) ? referenceKey : `manual-debit:${new mongoose.Types.ObjectId()}`;
  await postWalletTransaction({ ownerId: req.user.id, amountPaisa: -amountPaisa, type: 'adjustment', description: purpose, referenceKey: safeRef });
  await notifyUser(req.user.id, { type: 'warning', title: 'Balance deducted', message: `৳${(amountPaisa / 100).toFixed(2)} was deducted for ${purpose}.` });
  res.status(201).json({ message: 'Balance deducted.', balance: (await getBalancePaisa(req.user.id)) / 100 });
}));

module.exports = router;
