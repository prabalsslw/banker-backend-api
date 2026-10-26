const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const DpsAccount = require('../models/DpsAccount');
const User = require('../models/User');
const authenticate = require('../middleware/authenticate');
const asyncHandler = require('../utils/asyncHandler');
const { isValidObjectId, isNonEmptyString, isValidPin } = require('../utils/validators');
const { encryptPrivateField, decryptPrivateField, encryptNumber, decryptNumber, lookupHash } = require('../utils/privateFields');
const { postWalletTransaction, getBalancePaisa } = require('../utils/walletLedger');
const { notifyUser } = require('../utils/notifyUser');

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
const selectSensitive = '+accountNumberEncrypted +schemeNameEncrypted +monthlyInstallmentEncrypted +tenureEncrypted +interestRateEncrypted +schemeName +monthlyInstallmentPaisa +tenure +interestRate';
function addMonthsClamp(date, months) {
  const d = new Date(date); const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); d.setDate(Math.min(day, last)); return d;
}
function values(account) {
  const a = account.toObject ? account.toObject() : account;
  const schemeName = a.schemeNameEncrypted ? decryptPrivateField(a.schemeNameEncrypted) : (a.schemeName || 'DPS');
  const monthlyInstallmentPaisa = a.monthlyInstallmentEncrypted ? moneyToPaisa(decryptNumber(a.monthlyInstallmentEncrypted)) : Number(a.monthlyInstallmentPaisa || 0);
  const tenure = a.tenureEncrypted ? Number(decryptNumber(a.tenureEncrypted)) : Number(a.tenure || 1);
  const interestRate = a.interestRateEncrypted ? Number(decryptNumber(a.interestRateEncrypted)) : Number(a.interestRate || 0);
  return { ...a, schemeName, monthlyInstallmentPaisa, tenure, interestRate };
}
function calc(account) {
  const a = values(account);
  const n = tenureMonths(a.tenure, a.tenureUnit);
  const monthlyPaisa = a.monthlyInstallmentPaisa;
  const principalPaisa = monthlyPaisa * n;
  // Approximate recurring-deposit interest: monthly deposits earn interest for n..1 months.
  const interestPaisa = Math.max(0, Math.round(monthlyPaisa * a.interestRate / 1200 * (n * (n + 1) / 2)));
  return { months: n, principalPaisa, interestPaisa, maturityPaisa: principalPaisa + interestPaisa };
}
function buildPayments(account, oldPayments = []) {
  const a = values(account); const { months } = calc(a);
  const oldByDue = new Map(oldPayments.map(p => [new Date(p.dueDate).toISOString().slice(0, 10), p]));
  const oldPaid = oldPayments.filter(p => p.status === 'Paid');
  const count = Math.max(months, oldPaid.length); const payments = [];
  for (let i = 1; i <= count; i++) {
    const dueDate = addMonthsClamp(a.startDate, i); const key = dueDate.toISOString().slice(0, 10);
    const old = oldByDue.get(key) || oldPaid[i - 1];
    payments.push({ ...(old?._id ? { _id: old._id } : {}), dueDate, expectedAmountPaisa: a.monthlyInstallmentPaisa,
      depositAmountPaisa: old?.status === 'Paid' ? old.depositAmountPaisa : null,
      deductionDate: old?.status === 'Paid' ? old.deductionDate : null,
      paidAt: old?.status === 'Paid' ? old.paidAt : null, status: old?.status === 'Paid' ? 'Paid' : 'Pending' });
  }
  return payments;
}
function publicDps(doc) {
  const a = values(doc); const totals = calc(a);
  const payments = (a.payments || []).map(p => ({ id: String(p._id), dueDate: p.dueDate,
    expectedAmount: paisaToMoney(p.expectedAmountPaisa), depositAmount: p.depositAmountPaisa == null ? null : paisaToMoney(p.depositAmountPaisa),
    deductionDate: p.deductionDate, status: p.status, paidAt: p.paidAt }));
  return { id: String(a._id), schemeName: a.schemeName,
    dpsAccountNumber: a.accountNumberEncrypted ? decryptPrivateField(a.accountNumberEncrypted) : '',
    monthlyInstallment: paisaToMoney(a.monthlyInstallmentPaisa), tenure: a.tenure, tenureUnit: a.tenureUnit, tenureMonths: totals.months,
    interestRate: a.interestRate, principalAmount: paisaToMoney(totals.principalPaisa), totalInterest: paisaToMoney(totals.interestPaisa),
    maturityAmount: paisaToMoney(totals.maturityPaisa), startDate: a.startDate, maturityDate: a.maturityDate, status: a.status,
    paidInstallments: payments.filter(p => p.status === 'Paid').length, remainingInstallments: payments.filter(p => p.status !== 'Paid').length,
    payments, encashedAt: a.encashedAt, encashmentAmount: a.encashmentAmountPaisa == null ? null : paisaToMoney(a.encashmentAmountPaisa),
    createdAt: a.createdAt, updatedAt: a.updatedAt };
}
function validatePayload(body, partial = false) {
  const errors = []; const required = ['schemeName', 'dpsAccountNumber', 'monthlyInstallment', 'tenure', 'tenureUnit', 'interestRate'];
  if (!partial) required.forEach(k => { if (body[k] === undefined || body[k] === '') errors.push(`${k} is required.`); });
  if (body.schemeName !== undefined && !isNonEmptyString(body.schemeName, 120)) errors.push('schemeName must be 1-120 characters.');
  if (body.dpsAccountNumber !== undefined && !isNonEmptyString(body.dpsAccountNumber, 80)) errors.push('dpsAccountNumber must be 1-80 characters.');
  if (body.monthlyInstallment !== undefined) { try { if (moneyToPaisa(body.monthlyInstallment) < 1) errors.push('monthlyInstallment must be at least 0.01.'); } catch (e) { errors.push(e.message); } }
  if (body.tenure !== undefined && (!Number.isInteger(Number(body.tenure)) || Number(body.tenure) < 1 || Number(body.tenure) > 600)) errors.push('tenure must be an integer from 1 to 600.');
  if (body.tenureUnit !== undefined && !['months', 'years'].includes(body.tenureUnit)) errors.push('tenureUnit must be months or years.');
  if (body.interestRate !== undefined && (!Number.isFinite(Number(body.interestRate)) || Number(body.interestRate) < 0 || Number(body.interestRate) > 100)) errors.push('interestRate must be from 0 to 100.');
  if (body.status !== undefined && !['Active', 'Matured', 'Closed'].includes(body.status)) errors.push('status must be Active, Matured, or Closed.');
  return errors;
}
async function verifyPin(ownerId, pin) {
  if (!isValidPin(pin)) return false;
  const user = await User.findById(ownerId).select('+pinHash');
  return !!user && await bcrypt.compare(pin, user.pinHash);
}
async function encash(account) {
  if (account.encashedAt) return false;
  const a = values(account); const totals = calc(a); const referenceKey = `dps:${account._id}:encashment`;
  await postWalletTransaction({ ownerId: account.ownerId, amountPaisa: totals.maturityPaisa, type: 'dps_encashment', description: `DPS encashment: ${a.schemeName}`, referenceKey, allowNegative: true });
  account.status = 'Matured'; account.encashedAt = new Date(); account.encashmentAmountPaisa = totals.maturityPaisa;
  await account.save();
  await notifyUser(account.ownerId, { type: 'success', title: 'DPS encashed', message: `${a.schemeName} was encashed. ${paisaToMoney(totals.maturityPaisa).toFixed(2)} Tk was credited to your available balance.`, relatedId: String(account._id) });
  return true;
}
function encryptedFields(body) {
  const out = {};
  if (body.schemeName !== undefined) out.schemeNameEncrypted = encryptPrivateField(body.schemeName.trim());
  if (body.dpsAccountNumber !== undefined) { const accountNumber = body.dpsAccountNumber.trim(); out.accountNumberEncrypted = encryptPrivateField(accountNumber); out.accountNumberLookup = lookupHash(accountNumber, 'savingsId'); }
  if (body.monthlyInstallment !== undefined) out.monthlyInstallmentEncrypted = encryptNumber(moneyToPaisa(body.monthlyInstallment) / 100);
  if (body.tenure !== undefined) out.tenureEncrypted = encryptNumber(Number(body.tenure));
  if (body.interestRate !== undefined) out.interestRateEncrypted = encryptNumber(Number(body.interestRate));
  if (body.tenureUnit !== undefined) out.tenureUnit = body.tenureUnit;
  return out;
}

router.get('/', asyncHandler(async (req, res) => {
  const accounts = await DpsAccount.find({ ownerId: req.user.id }).select(selectSensitive).sort({ createdAt: -1 }).lean();
  const dps = accounts.map(publicDps); const active = dps.filter(x => x.status === 'Active');
  res.json({ count: dps.length, totalActivePrincipal: active.reduce((s, x) => s + x.principalAmount, 0), totalActiveInterest: active.reduce((s, x) => s + x.totalInterest, 0), totalActiveMaturity: active.reduce((s, x) => s + x.maturityAmount, 0), dps });
}));
router.post('/', asyncHandler(async (req, res) => {
  const body = req.body || {}; const errors = validatePayload(body); if (errors.length) return res.status(400).json({ message: 'Invalid DPS details.', errors });
  const months = tenureMonths(Number(body.tenure), body.tenureUnit); if (months > 600) return res.status(400).json({ message: 'DPS tenure cannot exceed 600 months.' });
  const availablePaisa = await getBalancePaisa(req.user.id);
  const firstInstallmentPaisa = moneyToPaisa(body.monthlyInstallment);
  if (availablePaisa < firstInstallmentPaisa) {
    return res.status(409).json({ message: `Insufficient available balance. DPS monthly installment is ৳${paisaToMoney(firstInstallmentPaisa).toFixed(2)}, but available balance is ৳${paisaToMoney(availablePaisa).toFixed(2)}. Deposit money before creating this DPS.` });
  }
  const startDate = new Date(); const fields = encryptedFields(body);
  const doc = new DpsAccount({ ownerId: req.user.id, ...fields, startDate, maturityDate: addMonthsClamp(startDate, months), status: 'Active' });
  doc.payments = buildPayments(doc);
  try { await doc.save(); } catch (error) { if (error?.code === 11000) return res.status(409).json({ message: 'This DPS account number already exists.' }); throw error; }
  await notifyUser(req.user.id, { type: 'success', title: 'DPS created', message: `${body.schemeName.trim()} was created. Monthly installment: ৳${Number(body.monthlyInstallment).toFixed(2)}; maturity date ${doc.maturityDate.toISOString().slice(0, 10)}.`, relatedId: String(doc._id) });
  res.status(201).json({ message: 'DPS created.', dps: publicDps(doc) });
}));
router.get('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid DPS ID.' });
  const doc = await DpsAccount.findOne({ _id: req.params.id, ownerId: req.user.id }).select(selectSensitive);
  if (!doc) return res.status(404).json({ message: 'DPS not found.' }); res.json({ dps: publicDps(doc) });
}));
router.patch('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid DPS ID.' });
  const body = req.body || {}; const errors = validatePayload(body, true); if (errors.length) return res.status(400).json({ message: 'Invalid DPS details.', errors });
  const doc = await DpsAccount.findOne({ _id: req.params.id, ownerId: req.user.id }).select(selectSensitive);
  if (!doc) return res.status(404).json({ message: 'DPS not found.' });
  if (doc.encashedAt || doc.status === 'Matured' || doc.status === 'Closed') return res.status(409).json({ message: 'A matured/closed DPS cannot be edited.' });
  const currentValues = values(doc);
  const immutableChecks = [
    ['dpsAccountNumber', String(body.dpsAccountNumber ?? body.accountNumber ?? (doc.accountNumberEncrypted ? require('../utils/privateFields').decryptPrivateField(doc.accountNumberEncrypted) : '')) === String(doc.accountNumberEncrypted ? require('../utils/privateFields').decryptPrivateField(doc.accountNumberEncrypted) : '')],
    ['monthlyInstallment', body.monthlyInstallment === undefined && body.monthly === undefined || Math.round(Number(body.monthlyInstallment ?? body.monthly) * 100) === currentValues.monthlyInstallmentPaisa],
    ['tenure', body.tenure === undefined || Number(body.tenure) === Number(currentValues.tenure)],
    ['tenureUnit', body.tenureUnit === undefined || body.tenureUnit === currentValues.tenureUnit],
    ['interestRate', body.interestRate === undefined && body.rate === undefined || Number(body.interestRate ?? body.rate) === Number(currentValues.interestRate)],
  ];
  const changedImmutable = immutableChecks.find(([field, same]) => !same);
  if (changedImmutable) return res.status(400).json({ message: `${changedImmutable[0]} cannot be changed after a DPS is created.` });
  const { pin, status, ...updates } = body; delete updates.dpsAccountNumber; delete updates.accountNumber; delete updates.monthlyInstallment; delete updates.monthly; delete updates.tenure; delete updates.tenureUnit; delete updates.interestRate; delete updates.rate; const shouldEncash = status === 'Matured';
  if (status === 'Closed') return res.status(400).json({ message: 'Use POST /api/dps/:id/close with PIN and earlyEncashAmount to close a DPS early.' } );
  if (shouldEncash && new Date(doc.maturityDate) > new Date()) return res.status(409).json({ message: 'This DPS has not reached its maturity date. Use Close for early encashment.' });
  if (shouldEncash && !(await verifyPin(req.user.id, pin))) return res.status(401).json({ message: 'Correct 4-digit PIN is required to mature and encash this DPS.' });
  const oldPayments = doc.payments || []; const fields = encryptedFields(updates); Object.assign(doc, fields);
  const a = values(doc); const months = tenureMonths(a.tenure, a.tenureUnit); if (months > 600) return res.status(400).json({ message: 'DPS tenure cannot exceed 600 months.' });
  doc.maturityDate = addMonthsClamp(doc.startDate, months); doc.payments = buildPayments(doc, oldPayments);
  try { await doc.save(); } catch (error) { if (error?.code === 11000) return res.status(409).json({ message: 'This DPS account number already exists.' }); throw error; }
  if (shouldEncash) { await encash(doc); const fresh = await DpsAccount.findById(doc._id).select(selectSensitive); return res.json({ message: 'DPS matured and proceeds credited to wallet.', dps: publicDps(fresh) }); }
  await notifyUser(req.user.id, { type: 'info', title: 'DPS updated', message: `${a.schemeName} information was updated.`, relatedId: String(doc._id) });
  res.json({ message: 'DPS updated.', dps: publicDps(doc) });
}));
router.post('/:id/encash', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid DPS ID.' });
  const doc = await DpsAccount.findOne({ _id: req.params.id, ownerId: req.user.id }).select(selectSensitive);
  if (!doc) return res.status(404).json({ message: 'DPS not found.' });
  if (doc.encashedAt || doc.status === 'Closed' || doc.status === 'Matured') return res.status(409).json({ message: 'This DPS has already been matured or closed.' });
  if (new Date(doc.maturityDate) > new Date()) return res.status(409).json({ message: 'This DPS has not reached its maturity date. Use Close for early encashment.' });
  if (!(await verifyPin(req.user.id, req.body?.pin))) return res.status(401).json({ message: 'Correct 4-digit PIN is required to encash this DPS.' });
  await encash(doc); const refreshed = await DpsAccount.findById(doc._id).select(selectSensitive); res.json({ message: 'DPS encashed and proceeds credited to wallet.', dps: publicDps(refreshed) });
}));
router.post('/:id/close', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid DPS ID.' });
  const doc = await DpsAccount.findOne({ _id: req.params.id, ownerId: req.user.id }).select(selectSensitive);
  if (!doc) return res.status(404).json({ message: 'DPS not found.' });
  if (doc.encashedAt || doc.status !== 'Active') return res.status(409).json({ message: 'Only active DPS can be closed early.' });
  if (new Date(doc.maturityDate) <= new Date()) return res.status(409).json({ message: 'This DPS has reached its maturity date. Use Encash DPS instead.' });
  const { pin, earlyEncashAmount } = req.body || {};
  if (!(await verifyPin(req.user.id, pin))) return res.status(401).json({ message: 'Correct 4-digit PIN is required to close this DPS.' });
  let creditPaisa; try { creditPaisa = moneyToPaisa(earlyEncashAmount); } catch (e) { return res.status(400).json({ message: e.message }); }
  if (creditPaisa < 1) return res.status(400).json({ message: 'Early encashment amount must be greater than zero.' });
  const totals = calc(doc);
  if (creditPaisa > totals.maturityPaisa) return res.status(400).json({ message: 'Early encashment amount cannot exceed the DPS maturity amount.' });
  const a = values(doc);
  await postWalletTransaction({ ownerId: req.user.id, amountPaisa: creditPaisa, type: 'dps_early_close', description: `Early closure of DPS: ${a.schemeName}`, referenceKey: `dps:${doc._id}:early-close` });
  doc.status = 'Closed'; doc.encashedAt = new Date(); doc.encashmentAmountPaisa = creditPaisa; await doc.save();
  await notifyUser(req.user.id, { type: 'warning', title: 'DPS closed early', message: `${a.schemeName} was closed early. ৳${paisaToMoney(creditPaisa).toFixed(2)} was credited to available balance.`, relatedId: String(doc._id) });
  res.json({ message: 'DPS closed and early encashment credited.', dps: publicDps(doc) });
}));

router.patch('/:id/payments/:paymentId', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id) || !isValidObjectId(req.params.paymentId)) return res.status(400).json({ message: 'Invalid DPS or installment ID.' });
  const doc = await DpsAccount.findOne({ _id: req.params.id, ownerId: req.user.id });
  if (!doc) return res.status(404).json({ message: 'DPS not found.' });
  if (doc.status !== 'Active' || doc.encashedAt) return res.status(409).json({ message: 'Installments cannot be edited after DPS encashment.' });
  const payment = doc.payments.id(req.params.paymentId); if (!payment) return res.status(404).json({ message: 'Installment not found.' });
  const body = req.body || {}; const wasPaid = payment.status === 'Paid'; const oldPaisa = wasPaid ? Number(payment.depositAmountPaisa || 0) : 0;
  let newPaisa = 0; let newDate = null;
  if (body.depositAmount !== null && body.depositAmount !== '') {
    try { newPaisa = moneyToPaisa(body.depositAmount); } catch (e) { return res.status(400).json({ message: e.message }); }
    if (newPaisa < 1) return res.status(400).json({ message: 'Deposit amount must be greater than zero.' });
    newDate = new Date(body.deductionDate || Date.now()); if (Number.isNaN(newDate.getTime())) return res.status(400).json({ message: 'deductionDate must be a valid date.' });
  }
  const delta = oldPaisa - newPaisa; // positive means refund, negative means debit
  if (delta !== 0) await postWalletTransaction({ ownerId: req.user.id, amountPaisa: delta, type: delta > 0 ? 'dps_installment_refund' : 'dps_installment_debit', description: `DPS installment ${newPaisa ? 'payment' : 'reversal'}: ${String(doc._id)}`, referenceKey: `dps:${doc._id}:payment:${payment._id}:${crypto.randomUUID()}` });
  if (!newPaisa) { payment.depositAmountPaisa = null; payment.deductionDate = null; payment.paidAt = null; payment.status = 'Pending'; }
  else { payment.depositAmountPaisa = newPaisa; payment.deductionDate = newDate; payment.paidAt = new Date(); payment.status = 'Paid'; }
  await doc.save();
  const a = values(doc); await notifyUser(req.user.id, { type: 'payment', title: newPaisa ? 'DPS installment paid' : 'DPS installment reverted to pending', message: `${a.schemeName}: installment due ${payment.dueDate.toISOString().slice(0, 10)} is ${newPaisa ? `Paid (৳${paisaToMoney(newPaisa).toFixed(2)})` : 'Pending'}.`, relatedId: String(doc._id) });
  res.json({ message: 'DPS installment updated.', dps: publicDps(doc), payment: publicDps(doc).payments.find(p => p.id === String(payment._id)) });
}));
module.exports = router;
