const express = require('express');
const mongoose = require('mongoose');
const Expense = require('../models/Expense');
const WalletTransaction = require('../models/WalletTransaction');
const authenticate = require('../middleware/authenticate');
const asyncHandler = require('../utils/asyncHandler');
const { isValidObjectId, isNonEmptyString } = require('../utils/validators');
const { encryptPrivateField, decryptPrivateField } = require('../utils/privateFields');
const { postWalletTransaction, getBalancePaisa } = require('../utils/walletLedger');
const { notifyUser } = require('../utils/notifyUser');
const router = express.Router();
router.use(authenticate);
const paisa = (amount) => {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0 || Math.abs(Math.round(n * 100) / 100 - n) > 0.000001) throw new Error('Amount must be greater than zero with at most two decimal places.');
  return Math.round(n * 100);
};
const validYmd = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`));
const parseExpenseDate = (v) => {
  if (v === undefined || v === null || v === '') return new Date();
  if (!validYmd(v)) throw new Error('Expense date must be a valid date in YYYY-MM-DD format.');
  const d = new Date(`${v}T12:00:00.000Z`);
  if (d.toISOString().slice(0, 10) !== v) throw new Error('Expense date is invalid.');
  return d;
};
function publicExpense(doc) {
  const e = doc.toObject ? doc.toObject() : doc;
  return { id: String(e._id), title: decryptPrivateField(e.titleEncrypted), category: e.category,
    reason: e.reasonEncrypted ? decryptPrivateField(e.reasonEncrypted) : '',
    remark: e.remarkEncrypted ? decryptPrivateField(e.remarkEncrypted) : '',
    amount: e.amountPaisa / 100, date: e.expenseDate, createdAt: e.createdAt, updatedAt: e.updatedAt };
}
function encrypted(v) { return v ? encryptPrivateField(v) : ''; }
function cleanText(v, max, label) {
  const value = typeof v === 'string' ? v.trim() : '';
  if (value.length > max) throw new Error(`${label} must be ${max} characters or fewer.`);
  return value;
}
function expensePayload(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const category = typeof body.category === 'string' ? body.category.trim() : '';
  if (!isNonEmptyString(title, 150)) throw new Error('Expense title is required (maximum 150 characters).');
  if (!isNonEmptyString(category, 60)) throw new Error('Expense category is required.');
  const amountPaisa = paisa(body.amount);
  const reason = cleanText(body.reason, 180, 'Reason');
  const remark = cleanText(body.remark, 180, 'Remark');
  if (category.toLowerCase() === 'other' && !reason) throw new Error('Please enter a reason for an Other-category expense.');
  return { title, category, amountPaisa, reason, remark, expenseDate: parseExpenseDate(body.date) };
}
router.get('/', asyncHandler(async (req, res) => {
  const filter = { ownerId: req.user.id };
  const { from, to, category } = req.query || {};
  if (from && !validYmd(from)) return res.status(400).json({ message: 'From date must be YYYY-MM-DD.' });
  if (to && !validYmd(to)) return res.status(400).json({ message: 'To date must be YYYY-MM-DD.' });
  if (from && to && from > to) return res.status(400).json({ message: 'From date must be on or before To date.' });
  if (from || to) {
    filter.expenseDate = {};
    if (from) filter.expenseDate.$gte = new Date(`${from}T00:00:00.000Z`);
    if (to) { const end = new Date(`${to}T00:00:00.000Z`); end.setUTCDate(end.getUTCDate() + 1); filter.expenseDate.$lt = end; }
  }
  if (typeof category === 'string' && category.trim()) filter.category = category.trim();
  const docs = await Expense.find(filter).select('+titleEncrypted +reasonEncrypted +remarkEncrypted').sort({ expenseDate: -1, createdAt: -1 }).limit(2000).lean();
  const expenses = docs.map(publicExpense);
  const total = expenses.reduce((sum, e) => sum + e.amount, 0);
  const byCategory = expenses.reduce((acc, e) => { acc[e.category] = (acc[e.category] || 0) + e.amount; return acc; }, {});
  res.json({ count: expenses.length, total, byCategory, expenses });
}));
router.post('/', asyncHandler(async (req, res) => {
  let data;
  try { data = expensePayload(req.body || {}); } catch (e) { return res.status(400).json({ message: e.message }); }
  if (data.amountPaisa > 1000000000) return res.status(400).json({ message: 'Maximum expense per transaction is ৳1,00,00,000 (1 crore).' });
  const expense = await Expense.create({ ownerId: req.user.id, titleEncrypted: encryptPrivateField(data.title), category: data.category,
    reasonEncrypted: encrypted(data.reason), remarkEncrypted: encrypted(data.remark), amountPaisa: data.amountPaisa, expenseDate: data.expenseDate });
  try {
    await postWalletTransaction({ ownerId: req.user.id, amountPaisa: -data.amountPaisa, type: 'expense',
      description: `Expense [${data.category}]: ${data.title}${data.reason ? ` · Reason: ${data.reason}` : ''}`.slice(0, 200),
      referenceKey: `expense:${expense._id}`, remark: data.remark, occurredAt: data.expenseDate });
  } catch (error) {
    await Expense.deleteOne({ _id: expense._id });
    if (error.status === 409) return res.status(409).json({ message: error.message });
    throw error;
  }
  await notifyUser(req.user.id, { type: 'info', title: 'Expense recorded', message: `${data.title} (${data.category}) — ৳${(data.amountPaisa / 100).toFixed(2)} deducted from your available balance.`, relatedId: String(expense._id), service: 'expense' });
  res.status(201).json({ message: 'Expense recorded.', expense: publicExpense(expense) });
}));
router.patch('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid expense ID.' });
  let data;
  try { data = expensePayload(req.body || {}); } catch (e) { return res.status(400).json({ message: e.message }); }
  const expense = await Expense.findOne({ _id: req.params.id, ownerId: req.user.id }).select('+titleEncrypted +reasonEncrypted +remarkEncrypted');
  if (!expense) return res.status(404).json({ message: 'Expense not found.' });
  const tx = await WalletTransaction.findOne({ ownerId: req.user.id, referenceKey: `expense:${expense._id}` });
  if (!tx) return res.status(409).json({ message: 'The wallet ledger entry for this expense was not found, so it cannot be safely edited.' });
  const balance = await getBalancePaisa(req.user.id);
  const nextLedgerAmount = -data.amountPaisa;
  if (balance - tx.amountPaisa + nextLedgerAmount < 0) return res.status(409).json({ message: 'Insufficient available balance for this updated expense amount.' });
  expense.titleEncrypted = encryptPrivateField(data.title);
  expense.category = data.category;
  expense.reasonEncrypted = encrypted(data.reason);
  expense.remarkEncrypted = encrypted(data.remark);
  expense.amountPaisa = data.amountPaisa;
  expense.expenseDate = data.expenseDate;
  await expense.save();
  tx.amountPaisa = nextLedgerAmount;
  tx.description = `Expense: ${data.title}${data.reason ? ` · Reason: ${data.reason}` : ''}`.slice(0, 200);
  tx.remark = data.remark;
  tx.occurredAt = data.expenseDate;
  await tx.save();
  res.json({ message: 'Expense updated.', expense: publicExpense(expense) });
}));
router.delete('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid expense ID.' });
  const expense = await Expense.findOne({ _id: req.params.id, ownerId: req.user.id }).select('+titleEncrypted +reasonEncrypted +remarkEncrypted');
  if (!expense) return res.status(404).json({ message: 'Expense not found.' });
  const title = decryptPrivateField(expense.titleEncrypted);
  const tx = await WalletTransaction.findOne({ ownerId: req.user.id, referenceKey: `expense:${expense._id}` });
  if (tx) {
    // Refund as a separate ledger transaction so the statement retains a clear audit trail.
    await postWalletTransaction({ ownerId: req.user.id, amountPaisa: Math.abs(tx.amountPaisa), type: 'adjustment',
      description: `Expense refund: ${title}`, referenceKey: `expense:${expense._id}:refund`, allowNegative: true,
      remark: 'Expense record deleted' });
  }
  await Expense.deleteOne({ _id: expense._id, ownerId: req.user.id });
  await notifyUser(req.user.id, { type: 'success', title: 'Expense deleted', message: `${title} was deleted and the amount was returned to your available balance.`, relatedId: String(expense._id), service: 'expense' });
  res.json({ message: 'Expense deleted and amount returned.' });
}));
module.exports = router;
