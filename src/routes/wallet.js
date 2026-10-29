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
const crypto = require('crypto');
const makeTransactionId = () => { const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; let id = 'BK'; for (let i = 0; i < 16; i += 1) id += alphabet[crypto.randomInt(0, alphabet.length)]; return id; };
const createUniqueTransactionId = async () => { for (let attempt = 0; attempt < 8; attempt += 1) { const id = makeTransactionId(); if (!(await WalletTransaction.exists({ transactionId: id }))) return id; } throw new Error('Could not generate a unique transaction ID. Please try again.'); };
router.use(authenticate);
const moneyToPaisa = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || Math.abs(Math.round(n * 100) / 100 - n) > 0.000001) throw new Error('Amount must be greater than zero and have at most two decimal places.');
  return Math.round(n * 100);
};
router.get('/statement', asyncHandler(async (req, res) => {
  const { from, to } = req.query || {};
  const validDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
  if (!validDate(from) || !validDate(to)) return res.status(400).json({ message: 'Valid from and to dates are required (YYYY-MM-DD).' });
  if (from > to) return res.status(400).json({ message: 'From date must be on or before the To date.' });
  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toExclusive = new Date(`${to}T00:00:00.000Z`); toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
  const ownerId = new mongoose.Types.ObjectId(req.user.id);
  const baseFilter = { ownerId };
  const [openingRows, rows] = await Promise.all([
    WalletTransaction.aggregate([{ $match: { ...baseFilter, occurredAt: { $lt: fromDate } } }, { $group: { _id: null, amountPaisa: { $sum: '$amountPaisa' } } }]),
    WalletTransaction.find({ ...baseFilter, occurredAt: { $gte: fromDate, $lt: toExclusive } }).sort({ occurredAt: -1, createdAt: -1, _id: -1 }).limit(10000).lean()
  ]);
  const openingBalance = Number(openingRows[0]?.amountPaisa || 0) / 100;
  const transactions = rows.map((x) => ({
    id: String(x._id), amount: x.amountPaisa / 100,
    direction: x.amountPaisa >= 0 ? 'Credit' : 'Debit',
    type: x.type, description: x.description, transactionId: x.transactionId || '', remark: x.remark || '', sourceName: x.sourceName || '', sourceReference: x.sourceReference || '',
    occurredAt: x.occurredAt || x.createdAt, createdAt: x.createdAt, referenceKey: x.referenceKey
  }));
  const credit = transactions.reduce((sum, x) => sum + (x.amount > 0 ? x.amount : 0), 0);
  const debit = transactions.reduce((sum, x) => sum + (x.amount < 0 ? Math.abs(x.amount) : 0), 0);
  res.json({ from, to, openingBalance, totalCredit: credit, totalDebit: debit, closingBalance: openingBalance + credit - debit, count: transactions.length, truncated: rows.length === 10000, transactions });
}));

router.get('/', asyncHandler(async (req, res) => {
  const ownerId = new mongoose.Types.ObjectId(req.user.id);
  const [rows, balancePaisa] = await Promise.all([
    WalletTransaction.find({ ownerId }).sort({ occurredAt: -1 }).limit(100).lean(),
    getBalancePaisa(req.user.id)
  ]);
  res.json({ balance: balancePaisa / 100, transactions: rows.map(x => ({ id: String(x._id), amount: x.amountPaisa / 100, type: x.type, description: x.description, transactionId: x.transactionId || '', remark: x.remark || '', sourceName: x.sourceName || '', sourceReference: x.sourceReference || '', occurredAt: x.occurredAt || x.createdAt, createdAt: x.createdAt })) });
}));
router.post('/deposit', asyncHandler(async (req, res) => {
  const { amount, method, pin } = req.body || {};
  const sourceName = typeof req.body?.sourceName === 'string' ? req.body.sourceName.trim() : '';
  const remark = typeof req.body?.remark === 'string' ? req.body.remark.trim() : '';
  const sourceReference = typeof req.body?.reference === 'string' ? req.body.reference.trim() : '';
  if (sourceName.length > 80 || remark.length > 180 || sourceReference.length > 80) return res.status(400).json({ message: 'Source name, remark or reference is too long.' });
  let amountPaisa;
  try { amountPaisa = moneyToPaisa(amount); } catch (error) { return res.status(400).json({ message: error.message }); }
  if (amountPaisa > 1000000000) return res.status(400).json({ message: 'Maximum deposit per transaction is ৳1,00,00,000 (1 crore).' });
  if (!isNonEmptyString(method, 80)) return res.status(400).json({ message: 'A deposit method is required.' });
  if (!isValidPin(pin)) return res.status(400).json({ message: 'A valid 4-digit PIN is required.' });
  const user = await User.findById(req.user.id).select('+pinHash');
  if (!user || !(await bcrypt.compare(pin, user.pinHash))) return res.status(401).json({ message: 'Incorrect PIN.' });
  const transactionId = await createUniqueTransactionId();
  const sourceLabel = sourceName ? ` · ${sourceName}` : '';
  const description = `Deposit via ${method.trim()}${sourceLabel}${remark ? ` · ${remark}` : ''}`.slice(0, 200);
  await postWalletTransaction({ ownerId: req.user.id, amountPaisa, type: 'deposit', description, referenceKey: `deposit:${transactionId}`, allowNegative: true, transactionId, remark, sourceName, sourceReference });
  await notifyUser(req.user.id, { type: 'success', title: 'Deposit recorded', message: `৳${(amountPaisa / 100).toFixed(2)} was added via ${method.trim()}. Transaction ID: ${transactionId}` });
  res.status(201).json({ message: 'Deposit recorded.', transactionId, balance: (await getBalancePaisa(req.user.id)) / 100 });
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
