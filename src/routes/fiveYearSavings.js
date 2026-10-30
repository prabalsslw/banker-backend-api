const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { isValidPin } = require('../utils/validators');
const { postWalletTransaction } = require('../utils/walletLedger');
const { notifyUser } = require('../utils/notifyUser');
const FiveYearSaving = require('../models/FiveYearSaving');
const authenticate = require('../middleware/authenticate');
const asyncHandler = require('../utils/asyncHandler');
const { isValidObjectId, isNonEmptyString, parseDate } = require('../utils/validators');
const {
  normalizeSavingsId, lookupHash, encryptPrivateField, decryptPrivateField,
  encryptNumber, decryptNumber
} = require('../utils/privateFields');

const router = express.Router();
router.use(authenticate);

const ALLOWED_STATUS = ['Active', 'Matured', 'Closed', 'Inactive'];

function validate(body, partial = false) {
  const errors = [];
  for (const key of ['savingsId', 'amount', 'interestRate', 'issueDate', 'matureDate']) {
    if (!partial && body[key] === undefined) errors.push(`${key} is required.`);
  }
  if (body.savingsId !== undefined && !isNonEmptyString(body.savingsId, 80)) {
    errors.push('savingsId must be a non-empty string up to 80 characters.');
  }
  for (const key of ['amount', 'interestRate']) {
    if (body[key] !== undefined && (!Number.isFinite(Number(body[key])) || Number(body[key]) < 0)) {
      errors.push(`${key} must be a non-negative number.`);
    }
  }
  for (const key of ['issueDate', 'matureDate']) {
    if (body[key] !== undefined && !parseDate(body[key])) errors.push(`${key} must be a valid date.`);
  }
  const issue = body.issueDate !== undefined ? parseDate(body.issueDate) : null;
  const maturity = body.matureDate !== undefined ? parseDate(body.matureDate) : null;
  if (issue && maturity && maturity <= issue) errors.push('matureDate must be after issueDate.');
  if (body.status !== undefined && !ALLOWED_STATUS.includes(body.status)) {
    errors.push('status must be Active, Matured, or Inactive.');
  }
  return errors;
}

function durationYears(issueDate, matureDate) {
  const start = new Date(issueDate);
  const end = new Date(matureDate);
  return Math.max(0, (end.getTime() - start.getTime()) / (365.2425 * 24 * 60 * 60 * 1000));
}

function publicSaving(doc) {
  const item = doc.toObject ? doc.toObject() : doc;
  const amount = decryptNumber(item.amountEncrypted);
  const interestRate = decryptNumber(item.interestRateEncrypted);
  const years = durationYears(item.issueDate, item.matureDate);
  const totalInterest = Math.round(amount * interestRate / 100 * years * 100) / 100;
  return {
    _id: item._id,
    savingsId: decryptPrivateField(item.savingsIdEncrypted),
    amount,
    interestRate,
    issueDate: item.issueDate,
    matureDate: item.matureDate,
    durationYears: Math.round(years * 10000) / 10000,
    totalInterest,
    maturityValue: Math.round((amount + totalInterest) * 100) / 100,
    status: item.status === 'Inactive' ? 'Closed' : (item.status || 'Active'),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function encryptedFields(body) {
  const output = {};
  if (body.savingsId !== undefined) {
    const normalized = normalizeSavingsId(body.savingsId);
    output.savingsIdEncrypted = encryptPrivateField(normalized);
    output.savingsIdLookup = lookupHash(normalized, 'savingsId');
  }
  if (body.amount !== undefined) output.amountEncrypted = encryptNumber(body.amount);
  if (body.interestRate !== undefined) output.interestRateEncrypted = encryptNumber(body.interestRate);
  if (body.issueDate !== undefined) output.issueDate = parseDate(body.issueDate);
  if (body.matureDate !== undefined) output.matureDate = parseDate(body.matureDate);
  if (body.status !== undefined) output.status = body.status;
  return output;
}

router.get('/', asyncHandler(async (req, res) => {
  const filter = { ownerId: req.user.id };
  if (req.query.status && ALLOWED_STATUS.includes(req.query.status)) filter.status = req.query.status;
  const docs = await FiveYearSaving.find(filter)
    .select('+savingsIdEncrypted +amountEncrypted +interestRateEncrypted')
    .sort({ createdAt: -1 });
  const savings = docs.map(publicSaving);
  res.json({
    count: savings.length,
    totalActivePrincipal: savings.filter((item) => item.status === 'Active').reduce((sum, item) => sum + item.amount, 0),
    savings
  });
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const errors = validate(body);
  if (errors.length) return res.status(400).json({ message: 'Invalid five-year savings data.', errors });
  try {
    const saving = await FiveYearSaving.create({ ...encryptedFields(body), ownerId: req.user.id });
    try {
      await postWalletTransaction({ ownerId: req.user.id, amountPaisa: -Math.round(Number(body.amount) * 100), type: 'five_year_savings_debit', description: `Purchase five-year Sanchayapatra ${String(body.savingsId).trim()}`, referenceKey: `five-year:${saving._id}:purchase` });
    } catch (walletError) {
      await FiveYearSaving.deleteOne({ _id: saving._id, ownerId: req.user.id });
      if (walletError.status === 409) return res.status(409).json({ message: walletError.message });
      throw walletError;
    }
    await notifyUser(req.user.id, { type: 'success', title: 'Five-Year Sanchayapatra created', message: `${String(body.savingsId).trim()} was created and ৳${Number(body.amount).toFixed(2)} was deducted from your available balance.`, relatedId: String(saving._id), service: 'savings5Year' });
    return res.status(201).json({ message: 'Five-year Sanchayapatra created.', saving: publicSaving(saving) });
  } catch (error) {
    if (error && error.code === 11000) return res.status(409).json({ message: 'Savings ID already exists in the five-year scheme.' });
    throw error;
  }
}));

router.post('/:id/close', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid five-year savings record ID.' });
  const { pin, earlyEncashAmount } = req.body || {};
  if (!isValidPin(pin)) return res.status(400).json({ message: 'A valid 4-digit PIN is required.' });
  const amount = Number(earlyEncashAmount);
  if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) / 100 !== amount) return res.status(400).json({ message: 'Early encashment amount must be positive with at most two decimal places.' });
  const user = await User.findById(req.user.id).select('+pinHash');
  if (!user || !(await bcrypt.compare(pin, user.pinHash))) return res.status(401).json({ message: 'Incorrect PIN.' });
  const saving = await FiveYearSaving.findOne({ _id: req.params.id, ownerId: req.user.id }).select('+savingsIdEncrypted +amountEncrypted +interestRateEncrypted');
  if (!saving) return res.status(404).json({ message: 'Five-year savings record not found.' });
  if (saving.status !== 'Active') return res.status(409).json({ message: 'Only active five-year Sanchayapatra can be closed early.' });
  if (new Date(saving.matureDate) <= new Date()) return res.status(409).json({ message: 'This Sanchayapatra has reached its maturity date. Use Mature instead of early closure.' });
  const item = publicSaving(saving); const principalPaisa = Math.round(item.amount * 100); const creditPaisa = Math.round(amount * 100);
  if (creditPaisa > principalPaisa) return res.status(400).json({ message: 'Early encashment amount cannot exceed the principal amount.' });
  await postWalletTransaction({ ownerId: req.user.id, amountPaisa: creditPaisa, type: 'five_year_savings_early_close', description: `Early closure of five-year Sanchayapatra ${item.savingsId}`, referenceKey: `five-year:${saving._id}:early-close` });
  saving.status = 'Closed'; await saving.save();
  await notifyUser(req.user.id, { type: 'warning', title: 'Five-Year Sanchayapatra closed early', message: `${item.savingsId} was closed. ৳${(creditPaisa / 100).toFixed(2)} was credited to available balance.`, relatedId: String(saving._id), service: 'savings5Year' });
  return res.json({ message: 'Five-year Sanchayapatra closed and early encashment credited.', saving: publicSaving(saving) });
}));

router.post('/:id/mature', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid five-year savings record ID.' });
  const { pin } = req.body || {};
  if (!isValidPin(pin)) return res.status(400).json({ message: 'A valid 4-digit PIN is required.' });
  const user = await User.findById(req.user.id).select('+pinHash');
  if (!user || !(await bcrypt.compare(pin, user.pinHash))) return res.status(401).json({ message: 'Incorrect PIN.' });
  const saving = await FiveYearSaving.findOne({ _id: req.params.id, ownerId: req.user.id }).select('+savingsIdEncrypted +amountEncrypted +interestRateEncrypted');
  if (!saving) return res.status(404).json({ message: 'Five-year savings record not found.' });
  if (saving.status === 'Matured') return res.status(409).json({ message: 'This five-year Sanchayapatra has already matured.' });
  if (saving.status !== 'Active') return res.status(409).json({ message: 'Only Active records can be matured.' });
  if (new Date(saving.matureDate) > new Date()) return res.status(409).json({ message: 'This Sanchayapatra has not reached its maturity date yet.' });
  const item = publicSaving(saving); const amountPaisa = Math.round(item.maturityValue * 100);
  await postWalletTransaction({ ownerId: req.user.id, amountPaisa, type: 'five_year_savings_maturity', description: `Five-year Sanchayapatra maturity: ${item.savingsId}`, referenceKey: `five-year:${saving._id}:maturity`, allowNegative: true });
  saving.status = 'Matured'; await saving.save();
  await notifyUser(req.user.id, { type: 'success', title: 'Five-Year Sanchayapatra matured', message: `${item.savingsId} matured; principal plus estimated profit ৳${item.maturityValue.toFixed(2)} was credited to your available balance.`, relatedId: String(saving._id), service: 'savings5Year' });
  res.json({ message: 'Five-year Sanchayapatra matured and proceeds credited.', saving: publicSaving(saving) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid five-year savings record ID.' });
  const saving = await FiveYearSaving.findOne({ _id: req.params.id, ownerId: req.user.id })
    .select('+savingsIdEncrypted +amountEncrypted +interestRateEncrypted');
  if (!saving) return res.status(404).json({ message: 'Five-year savings record not found.' });
  res.json({ saving: publicSaving(saving) });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid five-year savings record ID.' });
  const body = req.body || {};
  const errors = validate(body, true);
  if (errors.length) return res.status(400).json({ message: 'Invalid five-year savings data.', errors });
  const current = await FiveYearSaving.findOne({ _id: req.params.id, ownerId: req.user.id }).select('+savingsIdEncrypted +amountEncrypted +interestRateEncrypted');
  if (!current) return res.status(404).json({ message: 'Five-year savings record not found.' });
  if (body.status === 'Matured') return res.status(400).json({ message: 'Use POST /api/five-year-savings/:id/mature with your PIN to credit maturity proceeds.' });
  if (body.status === 'Closed') return res.status(400).json({ message: 'Use POST /api/five-year-savings/:id/close with your PIN and earlyEncashAmount to close early.' });
  if (current.status !== 'Active') return res.status(409).json({ message: 'Only Active five-year Sanchayapatra can be edited. Matured or Closed records are read-only.' });
  if (body.amount !== undefined && current.status === 'Active') {
    const oldAmount = decryptNumber(current.amountEncrypted);
    const deltaPaisa = Math.round((Number(body.amount) - oldAmount) * 100);
    if (deltaPaisa !== 0) await postWalletTransaction({ ownerId: req.user.id, amountPaisa: -deltaPaisa, type: deltaPaisa > 0 ? 'five_year_savings_debit' : 'adjustment', description: `Adjust five-year Sanchayapatra principal`, referenceKey: `five-year:${current._id}:principal-adjust:${require('crypto').randomUUID()}` });
  }

  // Validate date ordering against unchanged values too.
  const issue = body.issueDate !== undefined ? parseDate(body.issueDate) : current.issueDate;
  const maturity = body.matureDate !== undefined ? parseDate(body.matureDate) : current.matureDate;
  if (maturity <= issue) return res.status(400).json({ message: 'matureDate must be after issueDate.' });

  try {
    Object.assign(current, encryptedFields(body));
    await current.save();
    const fresh = await FiveYearSaving.findOne({ _id: current._id, ownerId: req.user.id })
      .select('+savingsIdEncrypted +amountEncrypted +interestRateEncrypted');
    await notifyUser(req.user.id, { type: 'info', title: 'Five-Year Sanchayapatra updated', message: `${publicSaving(fresh).savingsId} details were updated.`, relatedId: String(fresh._id), service: 'savings5Year' });
    return res.json({ message: 'Five-year Sanchayapatra updated.', saving: publicSaving(fresh) });
  } catch (error) {
    if (error && error.code === 11000) return res.status(409).json({ message: 'Savings ID already exists in the five-year scheme.' });
    throw error;
  }
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid five-year savings record ID.' });
  const existing = await FiveYearSaving.findOne({ _id: req.params.id, ownerId: req.user.id }).select('+savingsIdEncrypted');
  if (!existing) return res.status(404).json({ message: 'Five-year savings record not found.' });
  if (existing.status !== 'Active') return res.status(409).json({ message: 'Matured or Closed five-year savings cannot be deleted.' });
  const deleted = await FiveYearSaving.findOneAndDelete({ _id: req.params.id, ownerId: req.user.id }).select('+savingsIdEncrypted');
  if (!deleted) return res.status(404).json({ message: 'Five-year savings record not found.' });
  await notifyUser(req.user.id, { type: 'warning', title: 'Five-Year Sanchayapatra deleted', message: `${decryptPrivateField(deleted.savingsIdEncrypted)} was deleted.`, relatedId: String(deleted._id), service: 'savings5Year' });
  res.json({ message: 'Five-year Sanchayapatra deleted.' });
}));

module.exports = router;
