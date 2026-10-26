const express = require('express');
const Expense = require('../models/Expense');
const authenticate = require('../middleware/authenticate');
const asyncHandler = require('../utils/asyncHandler');
const { isValidObjectId, isNonEmptyString } = require('../utils/validators');
const { encryptPrivateField, decryptPrivateField } = require('../utils/privateFields');
const { postWalletTransaction } = require('../utils/walletLedger');
const { notifyUser } = require('../utils/notifyUser');
const router = express.Router();
router.use(authenticate);
const paisa = (amount) => {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0 || Math.abs(Math.round(n * 100) / 100 - n) > 0.000001) throw new Error('Amount must be greater than zero with at most two decimal places.');
  return Math.round(n * 100);
};
function publicExpense(doc) { const e = doc.toObject ? doc.toObject() : doc; return { id: String(e._id), title: decryptPrivateField(e.titleEncrypted), category: e.category, amount: e.amountPaisa / 100, date: e.expenseDate, createdAt: e.createdAt }; }
router.get('/', asyncHandler(async (req, res) => {
  const docs = await Expense.find({ ownerId: req.user.id }).select('+titleEncrypted').sort({ expenseDate: -1 }).limit(500).lean();
  res.json({ count: docs.length, expenses: docs.map(publicExpense) });
}));
router.post('/', asyncHandler(async (req, res) => {
  const { title, category, amount } = req.body || {};
  if (!isNonEmptyString(title, 150)) return res.status(400).json({ message: 'Expense title is required.' });
  if (!isNonEmptyString(category, 60)) return res.status(400).json({ message: 'Expense category is required.' });
  let amountPaisa; try { amountPaisa = paisa(amount); } catch (e) { return res.status(400).json({ message: e.message }); }
  const expense = await Expense.create({ ownerId: req.user.id, titleEncrypted: encryptPrivateField(title.trim()), category: category.trim(), amountPaisa, expenseDate: new Date() });
  try { await postWalletTransaction({ ownerId: req.user.id, amountPaisa: -amountPaisa, type: 'expense', description: `Expense: ${title.trim()}`, referenceKey: `expense:${expense._id}` }); }
  catch (error) { await Expense.deleteOne({ _id: expense._id }); if (error.status === 409) return res.status(409).json({ message: error.message }); throw error; }
  await notifyUser(req.user.id, { type: 'info', title: 'Expense recorded', message: `${title.trim()} (${category.trim()}) — ৳${(amountPaisa / 100).toFixed(2)} deducted from your available balance.`, relatedId: String(expense._id) });
  res.status(201).json({ message: 'Expense recorded.', expense: publicExpense(expense) });
}));
router.delete('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid expense ID.' });
  const expense = await Expense.findOneAndDelete({ _id: req.params.id, ownerId: req.user.id }).select('+titleEncrypted');
  if (!expense) return res.status(404).json({ message: 'Expense not found.' });
  await postWalletTransaction({ ownerId: req.user.id, amountPaisa: expense.amountPaisa, type: 'adjustment', description: `Expense refund: ${decryptPrivateField(expense.titleEncrypted)}`, referenceKey: `expense:${expense._id}:refund`, allowNegative: true });
  await notifyUser(req.user.id, { type: 'success', title: 'Expense deleted', message: `${decryptPrivateField(expense.titleEncrypted)} was deleted and ৳${(expense.amountPaisa / 100).toFixed(2)} was returned to your available balance.`, relatedId: String(expense._id) });
  res.json({ message: 'Expense deleted and amount returned.' });
}));
module.exports = router;
