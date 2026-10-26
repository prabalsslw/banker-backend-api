const express = require('express');
const bcrypt = require('bcryptjs');
const Saving = require('../models/Saving');
const Payment = require('../models/Payment');
const User = require('../models/User');
const { postWalletTransaction } = require('../utils/walletLedger');
const { notifyUser } = require('../utils/notifyUser');
const { isValidPin } = require('../utils/validators');
const authenticate = require('../middleware/authenticate');
const asyncHandler = require('../utils/asyncHandler');
const { isValidObjectId, isNonEmptyString, parseDate } = require('../utils/validators');
const { normalizeSavingsId, lookupHash, encryptPrivateField, decryptPrivateField, encryptNumber, decryptNumber } = require('../utils/privateFields');
const router = express.Router();
router.use(authenticate);

function validateSaving(body, partial = false) {
  const errors = [];
  const schemeType = body.schemeType || 'Sanchaypatra';
  if (schemeType !== 'Sanchaypatra') errors.push('This endpoint is only for 3-monthly Sanchayapatra. Use /api/five-year-savings for the five-year scheme.');
  for (const key of ['savingsId', 'amount', 'interestRate', 'issueDate', 'matureDate', 'status']) if (!partial && body[key] === undefined) errors.push(`${key} is required.`);
  if (!partial && schemeType === 'Sanchaypatra' && body.tenure === undefined) errors.push('tenure is required for 3-monthly Sanchaypatra.');
  if (body.savingsId !== undefined && !isNonEmptyString(body.savingsId, 80)) errors.push('savingsId must be a non-empty string up to 80 characters.');
  if (body.amount !== undefined && (!Number.isFinite(Number(body.amount)) || Number(body.amount) < 0)) errors.push('amount must be a non-negative number.');
  if (body.interestRate !== undefined && (!Number.isFinite(Number(body.interestRate)) || Number(body.interestRate) < 0)) errors.push('interestRate must be a non-negative number.');
  if (body.tenure !== undefined && (!Number.isInteger(Number(body.tenure)) || Number(body.tenure) < 1)) errors.push('tenure must be a positive integer.');
  if (body.schemeType !== undefined && body.schemeType !== 'Sanchaypatra') errors.push('This endpoint is only for 3-monthly Sanchayapatra. Use /api/five-year-savings for the five-year scheme.');
  for (const key of ['issueDate', 'matureDate']) if (body[key] !== undefined && !parseDate(body[key])) errors.push(`${key} must be a valid date.`);
  if (body.issueDate !== undefined && body.matureDate !== undefined && parseDate(body.matureDate) && parseDate(body.issueDate) && parseDate(body.matureDate) < parseDate(body.issueDate)) errors.push('matureDate must be on or after issueDate.');
  if (body.status !== undefined && !['Active', 'Matured', 'Closed', 'Inactive'].includes(body.status)) errors.push('status must be Active, Matured, Closed, or Inactive.');
  return errors;
}
function encryptedSavingFields(body) {
  const out = {};
  if (body.savingsId !== undefined) {
    const value = normalizeSavingsId(body.savingsId);
    out.savingsIdEncrypted = encryptPrivateField(value);
    out.savingsIdLookup = lookupHash(value, 'savingsId');
  }
  if (body.amount !== undefined) out.amountEncrypted = encryptNumber(body.amount);
  if (body.interestRate !== undefined) out.interestRateEncrypted = encryptNumber(body.interestRate);
  for (const key of ['tenure', 'status', 'schemeType']) if (body[key] !== undefined) out[key] = body[key];
  for (const key of ['issueDate', 'matureDate']) if (body[key] !== undefined) out[key] = parseDate(body[key]);
  return out;
}
function publicSaving(doc) {
  const s = doc.toObject ? doc.toObject() : doc;
  return {
    _id: s._id,
    ownerId: s.ownerId,
    savingsId: decryptPrivateField(s.savingsIdEncrypted),
    amount: decryptNumber(s.amountEncrypted),
    interestRate: decryptNumber(s.interestRateEncrypted),
    issueDate: s.issueDate,
    matureDate: s.matureDate,
    tenure: s.tenure || null,
    schemeType: s.schemeType || 'Sanchaypatra',
    totalInterest: (s.schemeType || 'Sanchaypatra') === 'Five-Year Bangladesh Sanchaypatra'
      ? Math.round(decryptNumber(s.amountEncrypted) * decryptNumber(s.interestRateEncrypted) / 100 * 100) / 100
      : null,
    status: s.status,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt
  };
}


// Add months without JavaScript's month-end overflow (e.g. Jan 31 -> Feb 28/29).
function addMonths(date, months) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function expectedPaymentDates(saving) {
  const dates = [];
  const issue = new Date(saving.issueDate);
  const maturity = new Date(saving.matureDate);
  for (let n = 1; n <= 600; n += 1) {
    const date = addMonths(issue, n * saving.tenure);
    if (date > maturity) break;
    dates.push(date);
  }
  return dates;
}

async function ensurePaymentSchedule(saving, ownerId) {
  // Five-year certificates do not have a generated payment schedule in this workflow.
  if ((saving.schemeType || 'Sanchaypatra') !== 'Sanchaypatra') return;
  const existingCount = await Payment.countDocuments({ ownerId, savingId: saving._id });
  if (existingCount > 0) return;
  const dates = expectedPaymentDates(saving);
  if (!dates.length) return;
  const expectedInterest = decryptNumber(saving.interestRateEncrypted);
  const principal = decryptNumber(saving.amountEncrypted);
  await Payment.insertMany(dates.map((paymentDate, index) => ({
    ownerId,
    savingId: saving._id,
    paymentNumber: index + 1,
    amountEncrypted: encryptNumber(principal),
    interestAmountEncrypted: encryptNumber(expectedInterest),
    creditedInterestAmountEncrypted: encryptNumber(0),
    tenure: saving.tenure,
    paymentDate,
    paymentReceivedDate: null,
    isPaid: false
  })), { ordered: true });
}

router.get('/', asyncHandler(async (req, res) => {
  const schemeType = req.query.schemeType;
  let filter = { ownerId: req.user.id };
  if (schemeType === 'Sanchaypatra') filter = { ...filter, $or: [{ schemeType: 'Sanchaypatra' }, { schemeType: { $exists: false } }] };
  else if (schemeType) filter.schemeType = schemeType;
  const docs = await Saving.find(filter).select('+savingsIdEncrypted +amountEncrypted +interestRateEncrypted').sort({ createdAt: -1 });
  res.json({ count: docs.length, savings: docs.map(publicSaving) });
}));
router.get('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid saving ID.' });
  const doc = await Saving.findOne({ _id: req.params.id, ownerId: req.user.id }).select('+savingsIdEncrypted +amountEncrypted +interestRateEncrypted');
  if (!doc) return res.status(404).json({ message: 'Saving not found.' });
  res.json({ saving: publicSaving(doc) });
}));
router.post('/', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const errors = validateSaving(body);
  if (errors.length) return res.status(400).json({ message: 'Invalid saving data.', errors });
  const saving = await Saving.create({ ...encryptedSavingFields(body), ownerId: req.user.id });
  try {
    const principalPaisa = Math.round(Number(body.amount) * 100);
    await postWalletTransaction({ ownerId: req.user.id, amountPaisa: -principalPaisa, type: 'savings_debit', description: `Purchase 3-month Sanchayapatra ${String(body.savingsId).trim()}`, referenceKey: `savings:${saving._id}:purchase` });
    await ensurePaymentSchedule(saving, req.user.id);
  } catch (error) {
    await Payment.deleteMany({ ownerId: req.user.id, savingId: saving._id });
    await Saving.deleteOne({ _id: saving._id, ownerId: req.user.id });
    if (error.status === 409) return res.status(409).json({ message: error.message });
    throw error;
  }
  await notifyUser(req.user.id, { type: 'success', title: 'Sanchayapatra created', message: `${String(body.savingsId).trim()} was created and ৳${Number(body.amount).toFixed(2)} was deducted from your available balance.`, relatedId: String(saving._id) });
  res.status(201).json({ message: 'Saving created.', saving: publicSaving(saving) });
}));

// Complete details journey: saving + generated schedule + payment totals.
router.get('/:id/details', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid saving ID.' });
  const saving = await Saving.findOne({ _id: req.params.id, ownerId: req.user.id })
    .select('+savingsIdEncrypted +amountEncrypted +interestRateEncrypted');
  if (!saving) return res.status(404).json({ message: 'Saving not found.' });

  await ensurePaymentSchedule(saving, req.user.id);
  const payments = await Payment.find({ ownerId: req.user.id, savingId: saving._id })
    .select('+amountEncrypted +interestAmountEncrypted +creditedInterestAmountEncrypted')
    .sort({ paymentNumber: 1 });
  const paymentItems = payments.map((p) => ({
    _id: p._id,
    paymentNumber: p.paymentNumber,
    amount: decryptNumber(p.amountEncrypted),
    expectedInterestAmount: decryptNumber(p.interestAmountEncrypted),
    creditedInterestAmount: p.creditedInterestAmountEncrypted ? decryptNumber(p.creditedInterestAmountEncrypted) : 0,
    paymentDate: p.paymentDate,
    paymentReceivedDate: p.paymentReceivedDate,
    isPaid: p.isPaid,
    status: p.isPaid ? 'Paid' : 'Pending'
  }));
  const paidPayments = paymentItems.filter((p) => p.isPaid);
  const unpaidPayments = paymentItems.filter((p) => !p.isPaid);
  const totalExpectedInterest = paymentItems.reduce((sum, p) => sum + p.expectedInterestAmount, 0);
  const totalCreditedInterest = paymentItems.reduce((sum, p) => sum + (p.isPaid ? p.creditedInterestAmount : 0), 0);
  const totalUnpaidInterest = unpaidPayments.reduce((sum, p) => sum + p.expectedInterestAmount, 0);
  res.json({
    saving: publicSaving(saving),
    summary: {
      totalPayments: paymentItems.length,
      paidPayments: paidPayments.length,
      unpaidPayments: unpaidPayments.length,
      totalPaidInterest: totalCreditedInterest,
      totalUnpaidInterest,
      totalInterest: totalExpectedInterest,
      nextPaymentDue: unpaidPayments.length ? unpaidPayments[0].paymentDate : null
    },
    payments: paymentItems
  });
}));

router.post('/:id/close', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid saving ID.' });
  const { pin, earlyEncashAmount } = req.body || {};
  if (!isValidPin(pin)) return res.status(400).json({ message: 'A valid 4-digit PIN is required.' });
  const amount = Number(earlyEncashAmount);
  if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) / 100 !== amount) return res.status(400).json({ message: 'Early encashment amount must be positive with at most two decimal places.' });
  const user = await User.findById(req.user.id).select('+pinHash');
  if (!user || !(await bcrypt.compare(pin, user.pinHash))) return res.status(401).json({ message: 'Incorrect PIN.' });
  const saving = await Saving.findOne({ _id: req.params.id, ownerId: req.user.id }).select('+savingsIdEncrypted +amountEncrypted +interestRateEncrypted');
  if (!saving) return res.status(404).json({ message: 'Saving not found.' });
  if (saving.status !== 'Active') return res.status(409).json({ message: 'Only active Sanchayapatra can be closed early.' });
  if (new Date(saving.matureDate) <= new Date()) return res.status(409).json({ message: 'This Sanchayapatra has reached its maturity date. Use Mature instead of early closure.' });
  const principalPaisa = Math.round(decryptNumber(saving.amountEncrypted) * 100);
  const creditPaisa = Math.round(amount * 100);
  if (creditPaisa > principalPaisa) return res.status(400).json({ message: 'Early encashment amount cannot exceed the principal amount.' });
  await postWalletTransaction({ ownerId: req.user.id, amountPaisa: creditPaisa, type: 'savings_early_close', description: `Early closure of 3-month Sanchayapatra ${decryptPrivateField(saving.savingsIdEncrypted)}`, referenceKey: `savings:${saving._id}:early-close` });
  saving.status = 'Closed'; await saving.save();
  await notifyUser(req.user.id, { type: 'warning', title: 'Sanchayapatra closed early', message: `${decryptPrivateField(saving.savingsIdEncrypted)} was closed. ৳${(creditPaisa / 100).toFixed(2)} was credited to available balance.`, relatedId: String(saving._id) });
  return res.json({ message: 'Sanchayapatra closed and early encashment credited.', saving: publicSaving(saving) });
}));

router.post('/:id/mature', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid saving ID.' });
  const { pin } = req.body || {};
  if (!isValidPin(pin)) return res.status(400).json({ message: 'A valid 4-digit PIN is required.' });
  const user = await User.findById(req.user.id).select('+pinHash');
  if (!user || !(await bcrypt.compare(pin, user.pinHash))) return res.status(401).json({ message: 'Incorrect PIN.' });
  const saving = await Saving.findOne({ _id: req.params.id, ownerId: req.user.id }).select('+savingsIdEncrypted +amountEncrypted +interestRateEncrypted');
  if (!saving) return res.status(404).json({ message: 'Saving not found.' });
  if (saving.status === 'Matured') return res.status(409).json({ message: 'This Sanchayapatra has already matured.' });
  if (saving.status !== 'Active') return res.status(409).json({ message: 'Only Active Sanchayapatra can be matured.' });
  if (new Date(saving.matureDate) > new Date()) return res.status(409).json({ message: 'This Sanchayapatra has not reached its maturity date yet.' });
  const principalPaisa = Math.round(decryptNumber(saving.amountEncrypted) * 100);
  await postWalletTransaction({ ownerId: req.user.id, amountPaisa: principalPaisa, type: 'savings_maturity', description: `3-month Sanchayapatra maturity: ${decryptPrivateField(saving.savingsIdEncrypted)}`, referenceKey: `savings:${saving._id}:maturity`, allowNegative: true });
  saving.status = 'Matured'; await saving.save();
  await notifyUser(req.user.id, { type: 'success', title: 'Sanchayapatra matured', message: `${decryptPrivateField(saving.savingsIdEncrypted)} matured; principal ৳${(principalPaisa / 100).toFixed(2)} was credited to your available balance.`, relatedId: String(saving._id) });
  res.json({ message: 'Sanchayapatra matured and principal credited.', saving: publicSaving(saving) });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid saving ID.' });
  const body = req.body || {};
  const errors = validateSaving(body, true);
  if (errors.length) return res.status(400).json({ message: 'Invalid saving data.', errors });
  const current = await Saving.findOne({ _id: req.params.id, ownerId: req.user.id }).select('+savingsIdEncrypted +amountEncrypted +interestRateEncrypted');
  if (!current) return res.status(404).json({ message: 'Saving not found.' });
  if (body.status === 'Matured') return res.status(400).json({ message: 'Use POST /api/savings/:id/mature with your PIN to credit maturity proceeds.' });
  if (body.status === 'Closed') return res.status(400).json({ message: 'Use POST /api/savings/:id/close with your PIN and earlyEncashAmount to close early.' });
  if (current.status !== 'Active') return res.status(409).json({ message: 'Only Active Sanchayapatra can be edited. Matured or Closed records are read-only.' });
  const updates = encryptedSavingFields(body);
  if (!Object.keys(updates).length) return res.status(400).json({ message: 'No valid fields supplied.' });
  if (body.amount !== undefined && current.status === 'Active') {
    const oldAmount = decryptNumber(current.amountEncrypted);
    const deltaPaisa = Math.round((Number(body.amount) - oldAmount) * 100);
    if (deltaPaisa !== 0) await postWalletTransaction({ ownerId: req.user.id, amountPaisa: -deltaPaisa, type: deltaPaisa > 0 ? 'savings_debit' : 'adjustment', description: `Adjust Sanchayapatra principal ${String(decryptPrivateField(current.savingsIdEncrypted))}`, referenceKey: `savings:${current._id}:principal-adjust:${require('crypto').randomUUID()}` });
  }
  const saving = await Saving.findOneAndUpdate({ _id: req.params.id, ownerId: req.user.id }, { $set: updates }, { new: true, runValidators: true }).select('+savingsIdEncrypted +amountEncrypted +interestRateEncrypted');
  if (body.interestRate !== undefined && (saving.schemeType || 'Sanchaypatra') === 'Sanchaypatra') {
    await Payment.updateMany({ ownerId: req.user.id, savingId: saving._id }, { $set: { interestAmountEncrypted: encryptNumber(Number(body.interestRate)) } });
  }
  await notifyUser(req.user.id, { type: 'info', title: 'Sanchayapatra updated', message: `${decryptPrivateField(saving.savingsIdEncrypted)} details were updated.`, relatedId: String(saving._id) });
  res.json({ message: 'Saving updated.', saving: publicSaving(saving) });
}));
router.delete('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid saving ID.' });
  const existing = await Saving.findOne({ _id: req.params.id, ownerId: req.user.id }).select('+savingsIdEncrypted');
  if (!existing) return res.status(404).json({ message: 'Saving not found.' });
  if (existing.status !== 'Active') return res.status(409).json({ message: 'Matured or Closed Sanchayapatra records cannot be deleted.' });
  const saving = await Saving.findOneAndDelete({ _id: req.params.id, ownerId: req.user.id }).select('+savingsIdEncrypted');
  if (!saving) return res.status(404).json({ message: 'Saving not found.' });
  await Payment.deleteMany({ savingId: saving._id, ownerId: req.user.id });
  await notifyUser(req.user.id, { type: 'warning', title: 'Sanchayapatra deleted', message: `${decryptPrivateField(saving.savingsIdEncrypted)} and its payment schedule were deleted.`, relatedId: String(saving._id) });
  res.json({ message: 'Saving and its payment schedule deleted.' });
}));
module.exports = router;
