const express = require('express');
const Saving = require('../models/Saving');
const Payment = require('../models/Payment');
const authenticate = require('../middleware/authenticate');
const asyncHandler = require('../utils/asyncHandler');
const { isValidObjectId, isNonEmptyString, parseDate } = require('../utils/validators');
const { normalizeSavingsId, lookupHash, encryptPrivateField, decryptPrivateField, encryptNumber, decryptNumber } = require('../utils/privateFields');
const router = express.Router();
router.use(authenticate);

function validateSaving(body, partial = false) {
  const errors = [];
  for (const key of ['savingsId', 'amount', 'interestRate', 'issueDate', 'matureDate', 'tenure', 'status']) if (!partial && body[key] === undefined) errors.push(`${key} is required.`);
  if (body.savingsId !== undefined && !isNonEmptyString(body.savingsId, 80)) errors.push('savingsId must be a non-empty string up to 80 characters.');
  if (body.amount !== undefined && (!Number.isFinite(Number(body.amount)) || Number(body.amount) < 0)) errors.push('amount must be a non-negative number.');
  if (body.interestRate !== undefined && (!Number.isFinite(Number(body.interestRate)) || Number(body.interestRate) < 0)) errors.push('interestRate must be a non-negative number.');
  if (body.tenure !== undefined && (!Number.isInteger(Number(body.tenure)) || Number(body.tenure) < 1)) errors.push('tenure must be a positive integer.');
  for (const key of ['issueDate', 'matureDate']) if (body[key] !== undefined && !parseDate(body[key])) errors.push(`${key} must be a valid date.`);
  if (body.issueDate !== undefined && body.matureDate !== undefined && parseDate(body.matureDate) && parseDate(body.issueDate) && parseDate(body.matureDate) < parseDate(body.issueDate)) errors.push('matureDate must be on or after issueDate.');
  if (body.status !== undefined && !['Active', 'Matured', 'Inactive'].includes(body.status)) errors.push('status must be Active, Matured, or Inactive.');
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
  for (const key of ['tenure', 'status']) if (body[key] !== undefined) out[key] = body[key];
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
    tenure: s.tenure,
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
  const docs = await Saving.find({ ownerId: req.user.id }).select('+savingsIdEncrypted +amountEncrypted +interestRateEncrypted').sort({ createdAt: -1 });
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
  await ensurePaymentSchedule(saving, req.user.id);
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

router.patch('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid saving ID.' });
  const body = req.body || {};
  const errors = validateSaving(body, true);
  if (errors.length) return res.status(400).json({ message: 'Invalid saving data.', errors });
  const updates = encryptedSavingFields(body);
  if (!Object.keys(updates).length) return res.status(400).json({ message: 'No valid fields supplied.' });
  const saving = await Saving.findOneAndUpdate({ _id: req.params.id, ownerId: req.user.id }, { $set: updates }, { new: true, runValidators: true }).select('+savingsIdEncrypted +amountEncrypted +interestRateEncrypted');
  if (!saving) return res.status(404).json({ message: 'Saving not found.' });
  res.json({ message: 'Saving updated.', saving: publicSaving(saving) });
}));
router.delete('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid saving ID.' });
  const saving = await Saving.findOneAndDelete({ _id: req.params.id, ownerId: req.user.id });
  if (!saving) return res.status(404).json({ message: 'Saving not found.' });
  await Payment.deleteMany({ savingId: saving._id, ownerId: req.user.id });
  res.json({ message: 'Saving and its payment schedule deleted.' });
}));
module.exports = router;
