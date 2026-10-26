const express = require('express');
const bcrypt = require('bcryptjs');
const DpsAccount = require('../models/DpsAccount');
const WalletTransaction = require('../models/WalletTransaction');
const User = require('../models/User');
const authenticate = require('../middleware/authenticate');
const asyncHandler = require('../utils/asyncHandler');
const { isValidObjectId, isNonEmptyString, isValidPin } = require('../utils/validators');
const { encryptPrivateField, decryptPrivateField, lookupHash } = require('../utils/privateFields');

const router = express.Router();
router.use(authenticate);
const moneyToPaisa = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('Amount must be a valid non-negative number.');
  const fixed = Math.round((n + Number.EPSILON) * 100);
  if (Math.abs(fixed / 100 - n) > 0.000001) throw new Error('Amounts can have at most two decimal places.');
  return fixed;
};
const paisaToMoney = (value) => Number(value || 0) / 100;
const tenureMonths = (tenure, unit) => Number(tenure) * (unit === 'years' ? 12 : 1);
function addMonthsClamp(date, months) {
  const d = new Date(date); const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); d.setDate(Math.min(day, last)); return d;
}
function calc(account) {
  const n = tenureMonths(account.tenure, account.tenureUnit);
  const monthlyPaisa = account.monthlyInstallmentPaisa;
  const principalPaisa = monthlyPaisa * n;
  // Approximate recurring-deposit interest: monthly deposits earn interest for n..1 months.
  const interestPaisa = Math.max(0, Math.round(monthlyPaisa * Number(account.interestRate) / 1200 * (n * (n + 1) / 2)));
  return { months: n, principalPaisa, interestPaisa, maturityPaisa: principalPaisa + interestPaisa };
}
function buildPayments(account, oldPayments = []) {
  const { months } = calc(account);
  const oldByDue = new Map(oldPayments.map(p => [new Date(p.dueDate).toISOString().slice(0, 10), p]));
  const oldPaid = oldPayments.filter(p => p.status === 'Paid');
  const count = Math.max(months, oldPaid.length);
  const payments = [];
  for (let i = 1; i <= count; i++) {
    const dueDate = addMonthsClamp(account.startDate, i);
    const key = dueDate.toISOString().slice(0, 10);
    const old = oldByDue.get(key) || oldPaid[i - 1];
    payments.push({
      ...(old?._id ? { _id: old._id } : {}),
      dueDate,
      expectedAmountPaisa: account.monthlyInstallmentPaisa,
      depositAmountPaisa: old?.status === 'Paid' ? old.depositAmountPaisa : null,
      deductionDate: old?.status === 'Paid' ? old.deductionDate : null,
      paidAt: old?.status === 'Paid' ? old.paidAt : null,
      status: old?.status === 'Paid' ? 'Paid' : 'Pending'
    });
  }
  return payments;
}
function publicDps(doc) {
  const a = doc.toObject ? doc.toObject() : doc;
  const accountNumber = a.accountNumberEncrypted ? decryptPrivateField(a.accountNumberEncrypted) : '';
  const totals = calc(a);
  const payments = (a.payments || []).map(p => ({
    id: String(p._id), dueDate: p.dueDate, expectedAmount: paisaToMoney(p.expectedAmountPaisa),
    depositAmount: p.depositAmountPaisa == null ? null : paisaToMoney(p.depositAmountPaisa),
    deductionDate: p.deductionDate, status: p.status, paidAt: p.paidAt
  }));
  return {
    id: String(a._id), schemeName: a.schemeName, dpsAccountNumber: accountNumber,
    monthlyInstallment: paisaToMoney(a.monthlyInstallmentPaisa), tenure: a.tenure, tenureUnit: a.tenureUnit,
    tenureMonths: totals.months, interestRate: Number(a.interestRate), principalAmount: paisaToMoney(totals.principalPaisa),
    totalInterest: paisaToMoney(totals.interestPaisa), maturityAmount: paisaToMoney(totals.maturityPaisa),
    startDate: a.startDate, maturityDate: a.maturityDate, status: a.status,
    paidInstallments: payments.filter(p => p.status === 'Paid').length,
    remainingInstallments: payments.filter(p => p.status !== 'Paid').length,
    payments, encashedAt: a.encashedAt, encashmentAmount: a.encashmentAmountPaisa == null ? null : paisaToMoney(a.encashmentAmountPaisa),
    createdAt: a.createdAt, updatedAt: a.updatedAt
  };
}
function validatePayload(body, partial = false) {
  const errors = [];
  const required = ['schemeName', 'dpsAccountNumber', 'monthlyInstallment', 'tenure', 'tenureUnit', 'interestRate'];
  if (!partial) required.forEach(k => { if (body[k] === undefined || body[k] === '') errors.push(`${k} is required.`); });
  if (body.schemeName !== undefined && !isNonEmptyString(body.schemeName, 120)) errors.push('schemeName must be 1-120 characters.');
  if (body.dpsAccountNumber !== undefined && !isNonEmptyString(body.dpsAccountNumber, 80)) errors.push('dpsAccountNumber must be 1-80 characters.');
  if (body.monthlyInstallment !== undefined) {
    try { if (moneyToPaisa(body.monthlyInstallment) < 1) errors.push('monthlyInstallment must be at least 0.01.'); }
    catch (e) { errors.push(e.message); }
  }
  if (body.tenure !== undefined && (!Number.isInteger(Number(body.tenure)) || Number(body.tenure) < 1 || Number(body.tenure) > 600)) errors.push('tenure must be an integer from 1 to 600.');
  if (body.tenureUnit !== undefined && !['months', 'years'].includes(body.tenureUnit)) errors.push('tenureUnit must be months or years.');
  if (body.interestRate !== undefined && (!Number.isFinite(Number(body.interestRate)) || Number(body.interestRate) < 0 || Number(body.interestRate) > 100)) errors.push('interestRate must be from 0 to 100.');
  if (body.status !== undefined && !['Active', 'Matured'].includes(body.status)) errors.push('status must be Active or Matured.');
  return errors;
}
async function verifyPin(ownerId, pin) {
  if (!isValidPin(pin)) return false;
  const user = await User.findById(ownerId).select('+pinHash');
  return !!user && await bcrypt.compare(pin, user.pinHash);
}
async function encash(account) {
  if (account.encashedAt) return false;
  const totals = calc(account);
  const referenceKey = `dps:${account._id}:encashment`;
  try {
    await WalletTransaction.create({ ownerId: account.ownerId, amountPaisa: totals.maturityPaisa, type: 'dps_encashment', description: `DPS encashment: ${account.schemeName}`, referenceKey, occurredAt: new Date() });
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
  account.status = 'Matured';
  account.encashedAt = new Date();
  account.encashmentAmountPaisa = totals.maturityPaisa;
  await account.save();
  return true;
}

router.get('/', asyncHandler(async (req, res) => {
  const accounts = await DpsAccount.find({ ownerId: req.user.id }).select('+accountNumberEncrypted').sort({ createdAt: -1 });
  const dps = accounts.map(publicDps);
  const active = dps.filter(x => x.status === 'Active');
  res.json({ count: dps.length, totalActivePrincipal: active.reduce((s, x) => s + x.principalAmount, 0), totalActiveInterest: active.reduce((s, x) => s + x.totalInterest, 0), totalActiveMaturity: active.reduce((s, x) => s + x.maturityAmount, 0), dps });
}));
router.post('/', asyncHandler(async (req, res) => {
  const body = req.body || {}; const errors = validatePayload(body);
  if (errors.length) return res.status(400).json({ message: 'Invalid DPS details.', errors });
  const monthlyPaisa = moneyToPaisa(body.monthlyInstallment);
  const months = tenureMonths(Number(body.tenure), body.tenureUnit);
  if (months > 600) return res.status(400).json({ message: 'DPS tenure cannot exceed 600 months.' });
  const startDate = new Date();
  const doc = new DpsAccount({ ownerId: req.user.id, schemeName: body.schemeName.trim(), accountNumberEncrypted: encryptPrivateField(body.dpsAccountNumber.trim()), accountNumberLookup: lookupHash(body.dpsAccountNumber.trim(), 'savingsId'), monthlyInstallmentPaisa: monthlyPaisa, tenure: Number(body.tenure), tenureUnit: body.tenureUnit, interestRate: Number(body.interestRate), startDate, maturityDate: addMonthsClamp(startDate, months), status: 'Active' });
  doc.payments = buildPayments(doc);
  try { await doc.save(); } catch (error) { if (error?.code === 11000) return res.status(409).json({ message: 'This DPS account number already exists.' }); throw error; }
  res.status(201).json({ message: 'DPS created.', dps: publicDps(doc) });
}));
router.get('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid DPS ID.' });
  const doc = await DpsAccount.findOne({ _id: req.params.id, ownerId: req.user.id }).select('+accountNumberEncrypted');
  if (!doc) return res.status(404).json({ message: 'DPS not found.' });
  res.json({ dps: publicDps(doc) });
}));
router.patch('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid DPS ID.' });
  const body = req.body || {}; const errors = validatePayload(body, true);
  if (errors.length) return res.status(400).json({ message: 'Invalid DPS details.', errors });
  const doc = await DpsAccount.findOne({ _id: req.params.id, ownerId: req.user.id }).select('+accountNumberEncrypted');
  if (!doc) return res.status(404).json({ message: 'DPS not found.' });
  if (doc.encashedAt || doc.status === 'Matured') return res.status(409).json({ message: 'A matured/encashed DPS cannot be edited.' });
  const { pin, status, ...updates } = body;
  const shouldEncash = status === 'Matured';
  if (shouldEncash && !(await verifyPin(req.user.id, pin))) {
    return res.status(401).json({ message: 'Correct 4-digit PIN is required to mature and encash this DPS.' });
  }
  const oldPayments = doc.payments || [];
  if (updates.schemeName !== undefined) doc.schemeName = updates.schemeName.trim();
  if (updates.dpsAccountNumber !== undefined) { doc.accountNumberEncrypted = encryptPrivateField(updates.dpsAccountNumber.trim()); doc.accountNumberLookup = lookupHash(updates.dpsAccountNumber.trim(), 'savingsId'); }
  if (updates.monthlyInstallment !== undefined) doc.monthlyInstallmentPaisa = moneyToPaisa(updates.monthlyInstallment);
  if (updates.tenure !== undefined) doc.tenure = Number(updates.tenure);
  if (updates.tenureUnit !== undefined) doc.tenureUnit = updates.tenureUnit;
  if (updates.interestRate !== undefined) doc.interestRate = Number(updates.interestRate);
  const months = tenureMonths(doc.tenure, doc.tenureUnit);
  if (months > 600) return res.status(400).json({ message: 'DPS tenure cannot exceed 600 months.' });
  doc.maturityDate = addMonthsClamp(doc.startDate, months);
  doc.payments = buildPayments(doc, oldPayments);
  try { await doc.save(); } catch (error) { if (error?.code === 11000) return res.status(409).json({ message: 'This DPS account number already exists.' }); throw error; }
  if (shouldEncash) {
    await encash(doc);
    const refreshed = await DpsAccount.findOne({ _id: doc._id, ownerId: req.user.id }).select('+accountNumberEncrypted');
    return res.json({ message: 'DPS matured and proceeds credited to wallet.', dps: publicDps(refreshed) });
  }
  res.json({ message: 'DPS updated.', dps: publicDps(doc) });
}));
router.post('/:id/encash', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid DPS ID.' });
  const doc = await DpsAccount.findOne({ _id: req.params.id, ownerId: req.user.id }).select('+accountNumberEncrypted');
  if (!doc) return res.status(404).json({ message: 'DPS not found.' });
  if (doc.encashedAt) return res.status(409).json({ message: 'This DPS has already been encashed.' });
  if (!(await verifyPin(req.user.id, req.body?.pin))) return res.status(401).json({ message: 'Correct 4-digit PIN is required to encash this DPS.' });
  await encash(doc);
  const refreshed = await DpsAccount.findOne({ _id: doc._id, ownerId: req.user.id }).select('+accountNumberEncrypted');
  res.json({ message: 'DPS encashed and proceeds credited to wallet.', dps: publicDps(refreshed) });
}));
router.patch('/:id/payments/:paymentId', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id) || !isValidObjectId(req.params.paymentId)) return res.status(400).json({ message: 'Invalid DPS or installment ID.' });
  const doc = await DpsAccount.findOne({ _id: req.params.id, ownerId: req.user.id });
  if (!doc) return res.status(404).json({ message: 'DPS not found.' });
  if (doc.status !== 'Active') return res.status(409).json({ message: 'Installments cannot be edited after DPS maturity.' });
  const payment = doc.payments.id(req.params.paymentId);
  if (!payment) return res.status(404).json({ message: 'Installment not found.' });
  const body = req.body || {};
  if (body.depositAmount === null || body.depositAmount === '') {
    payment.depositAmountPaisa = null; payment.deductionDate = null; payment.paidAt = null; payment.status = 'Pending';
  } else {
    let amount; try { amount = moneyToPaisa(body.depositAmount); } catch (e) { return res.status(400).json({ message: e.message }); }
    if (amount < 1) return res.status(400).json({ message: 'Deposit amount must be greater than zero.' });
    const date = new Date(body.deductionDate || Date.now());
    if (Number.isNaN(date.getTime())) return res.status(400).json({ message: 'deductionDate must be a valid date.' });
    payment.depositAmountPaisa = amount; payment.deductionDate = date; payment.paidAt = new Date(); payment.status = 'Paid';
  }
  await doc.save();
  res.json({ message: 'DPS installment updated.', dps: publicDps(doc), payment: publicDps(doc).payments.find(p => p.id === String(payment._id)) });
}));
module.exports = router;
