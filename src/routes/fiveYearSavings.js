const express = require('express');
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
    errors.push('status must be Active, Matured, or Closed.');
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
    return res.status(201).json({ message: 'Five-year Sanchayapatra created.', saving: publicSaving(saving) });
  } catch (error) {
    if (error && error.code === 11000) return res.status(409).json({ message: 'Savings ID already exists in the five-year scheme.' });
    throw error;
  }
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
  const current = await FiveYearSaving.findOne({ _id: req.params.id, ownerId: req.user.id });
  if (!current) return res.status(404).json({ message: 'Five-year savings record not found.' });

  // Matured/Closed records are read-only. The user may change the status to
  // Active (and may edit details in the same request once reactivating).
  const currentStatus = current.status === 'Inactive' ? 'Closed' : (current.status || 'Active');
  const hasDetailChanges = ['savingsId', 'amount', 'interestRate', 'issueDate', 'matureDate']
    .some((key) => body[key] !== undefined);
  if (currentStatus !== 'Active' && hasDetailChanges && body.status !== 'Active') {
    return res.status(409).json({
      message: 'This savings record is read-only while Matured or Closed. Change its status to Active before editing other fields.'
    });
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
    return res.json({ message: 'Five-year Sanchayapatra updated.', saving: publicSaving(fresh) });
  } catch (error) {
    if (error && error.code === 11000) return res.status(409).json({ message: 'Savings ID already exists in the five-year scheme.' });
    throw error;
  }
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid five-year savings record ID.' });
  const result = await FiveYearSaving.deleteOne({ _id: req.params.id, ownerId: req.user.id });
  if (!result.deletedCount) return res.status(404).json({ message: 'Five-year savings record not found.' });
  res.json({ message: 'Five-year Sanchayapatra deleted.' });
}));

module.exports = router;
