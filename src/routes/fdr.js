const express = require('express');
const FdrAccount = require('../models/FdrAccount');
const authenticate = require('../middleware/authenticate');
const asyncHandler = require('../utils/asyncHandler');
const { isValidObjectId, isNonEmptyString } = require('../utils/validators');
const { encryptPrivateField, decryptPrivateField, encryptNumber, decryptNumber } = require('../utils/privateFields');
const { postWalletTransaction } = require('../utils/walletLedger');
const { notifyUser } = require('../utils/notifyUser');
const router = express.Router();
router.use(authenticate);

const moneyToPaisa = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || Math.abs(Math.round(n * 100) / 100 - n) > 1e-6) throw new Error('Principal must be positive and have at most two decimal places.');
  return Math.round(n * 100);
};
const addMonthsClamp = (date, months) => {
  const d = new Date(date); const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); d.setDate(Math.min(day, last)); return d;
};
const asYmd = (d) => new Date(d).toISOString().slice(0, 10);
const roundPaisa = (n) => Math.round(Number(n) * 100);
function publicFdr(doc) {
  const x = doc.toObject ? doc.toObject() : doc;
  const principal = decryptNumber(x.principalEncrypted);
  const rate = decryptNumber(x.rateEncrypted);
  const tenure = decryptNumber(x.tenureEncrypted);
  const start = new Date(x.startDate); const maturity = new Date(x.maturityDate);
  const years = Math.max(0, (maturity - start) / (365.2425 * 86400000));
  const fdrType = x.fdrType || 'Cumulative (Interest at Maturity)';
  const totalInterest = Math.round(principal * rate / 100 * years * 100) / 100;
  const interestPerPayout = fdrType === 'Monthly Interest Payout' ? Math.round(principal * rate / 1200 * 100) / 100 : fdrType === 'Quarterly Interest Payout' ? Math.round(principal * rate / 400 * 100) / 100 : 0;
  const interest = fdrType === 'Cumulative (Interest at Maturity)' ? totalInterest : interestPerPayout;
  const maturityValue = fdrType === 'Cumulative (Interest at Maturity)' ? Math.round((principal + totalInterest) * 100) / 100 : principal;
  const payments = (x.payments || []).map(p => ({
    id: String(p._id), monthNumber: p.monthNumber, dueDate: asYmd(p.dueDate),
    expectedAmount: Number(p.expectedAmountPaisa || 0) / 100,
    actualAmount: p.actualAmountPaisa == null ? null : Number(p.actualAmountPaisa) / 100,
    receivedDate: p.receivedDate ? asYmd(p.receivedDate) : null, status: p.status
  }));
  return { id: String(x._id), bank: decryptPrivateField(x.bankEncrypted), fdrType, principal, rate, tenure,
    start: asYmd(start), maturityDate: asYmd(maturity), status: x.status, maturityValue, interest,
    totalInterest: fdrType === 'Monthly Interest Payout' ? interestPerPayout * tenure : totalInterest,
    interestPerPayout, payoutFrequency: fdrType === 'Monthly Interest Payout' ? 'Monthly' : fdrType === 'Quarterly Interest Payout' ? 'Quarterly' : 'At maturity', payments };
}
router.get('/', asyncHandler(async (req, res) => {
  const docs = await FdrAccount.find({ ownerId: req.user.id }).select('+bankEncrypted +principalEncrypted +rateEncrypted +tenureEncrypted').sort({ createdAt: -1 });
  // Backfill monthly schedules for existing monthly FDRs created before payment tracking was introduced.
  for (const doc of docs) {
    if (doc.fdrType === 'Monthly Interest Payout' && (!doc.payments || doc.payments.length === 0)) {
      const principal = decryptNumber(doc.principalEncrypted); const rate = decryptNumber(doc.rateEncrypted); const tenure = decryptNumber(doc.tenureEncrypted);
      const monthlyPaisa = Math.round(principal * rate / 1200 * 100);
      doc.payments = Array.from({ length: Math.min(600, tenure) }, (_, i) => ({ monthNumber: i + 1, dueDate: addMonthsClamp(doc.startDate, i + 1), expectedAmountPaisa: monthlyPaisa, status: 'Pending' }));
      await doc.save();
    }
  }
  const fdr = docs.map(publicFdr); res.json({ count: fdr.length, fdr });
}));
router.post('/', asyncHandler(async (req, res) => {
  const { bank, principal, rate, tenure } = req.body || {};
  const allowedFdrTypes = ['Monthly Interest Payout', 'Cumulative (Interest at Maturity)', 'Quarterly Interest Payout'];
  const fdrType = req.body?.fdrType || 'Cumulative (Interest at Maturity)';
  if (!allowedFdrTypes.includes(fdrType)) return res.status(400).json({ message: 'Select a valid FDR type.' });
  if (!isNonEmptyString(bank, 120)) return res.status(400).json({ message: 'Bank / institution is required.' });
  let principalPaisa; try { principalPaisa = moneyToPaisa(principal); } catch (e) { return res.status(400).json({ message: e.message }); }
  if (!Number.isFinite(Number(rate)) || Number(rate) < 0 || Number(rate) > 100) return res.status(400).json({ message: 'Interest rate must be between 0 and 100.' });
  if (!Number.isInteger(Number(tenure)) || Number(tenure) < 1 || Number(tenure) > 600) return res.status(400).json({ message: 'Tenure must be between 1 and 600 months.' });
  const startDate = new Date(); const maturityDate = addMonthsClamp(startDate, Number(tenure));
  const monthlyPaisa = Math.round((principalPaisa / 100) * Number(rate) / 1200 * 100);
  const payments = fdrType === 'Monthly Interest Payout' ? Array.from({ length: Number(tenure) }, (_, i) => ({
    monthNumber: i + 1, dueDate: addMonthsClamp(startDate, i + 1), expectedAmountPaisa: monthlyPaisa, status: 'Pending'
  })) : [];
  const fdr = await FdrAccount.create({ ownerId: req.user.id, fdrType, bankEncrypted: encryptPrivateField(bank.trim()), principalEncrypted: encryptNumber(principalPaisa / 100), rateEncrypted: encryptNumber(Number(rate)), tenureEncrypted: encryptNumber(Number(tenure)), startDate, maturityDate, payments });
  try { await postWalletTransaction({ ownerId: req.user.id, amountPaisa: -principalPaisa, type: 'fdr_debit', description: `FDR principal: ${bank.trim()}`, referenceKey: `fdr:${fdr._id}:purchase` }); }
  catch (e) { await FdrAccount.deleteOne({ _id: fdr._id, ownerId: req.user.id }); if (e.status === 409) return res.status(409).json({ message: e.message }); throw e; }
  await notifyUser(req.user.id, { type: 'success', title: 'FDR created', message: `${bank.trim()} (${fdrType}) FDR opened; ৳${(principalPaisa/100).toFixed(2)} was deducted from available balance.`, relatedId: String(fdr._id) });
  res.status(201).json({ message: 'FDR created.', fdr: publicFdr(fdr) });
}));
router.patch('/:id/payments/:paymentId', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id) || !isValidObjectId(req.params.paymentId)) return res.status(400).json({ message: 'Invalid FDR or payment ID.' });
  const doc = await FdrAccount.findOne({ _id: req.params.id, ownerId: req.user.id }).select('+bankEncrypted +principalEncrypted +rateEncrypted +tenureEncrypted');
  if (!doc) return res.status(404).json({ message: 'FDR not found.' });
  if (doc.fdrType !== 'Monthly Interest Payout') return res.status(400).json({ message: 'Monthly payments are only available for monthly interest payout FDRs.' });
  const payment = doc.payments.id(req.params.paymentId);
  if (!payment) return res.status(404).json({ message: 'Payment not found.' });
  const nextStatus = req.body?.status;
  if (!['Pending', 'Received'].includes(nextStatus)) return res.status(400).json({ message: 'Status must be Pending or Received.' });
  if (payment.status === 'Received' && nextStatus === 'Received') {
    if (req.body.actualAmount != null) payment.actualAmountPaisa = roundPaisa(req.body.actualAmount);
    if (req.body.receivedDate) { const dt = new Date(req.body.receivedDate); if (Number.isNaN(dt.getTime())) return res.status(400).json({ message: 'Invalid received date.' }); payment.receivedDate = dt; }
    await doc.save(); return res.json({ message: 'Payment updated.', payment: publicFdr(doc).payments.find(p => p.id === String(payment._id)) });
  }
  if (nextStatus === 'Received') {
    const actual = req.body.actualAmount == null ? Number(payment.expectedAmountPaisa) : roundPaisa(req.body.actualAmount);
    if (!Number.isSafeInteger(actual) || actual < 0) return res.status(400).json({ message: 'Actual amount must be zero or greater with at most two decimals.' });
    const receivedDate = req.body.receivedDate ? new Date(req.body.receivedDate) : new Date();
    if (Number.isNaN(receivedDate.getTime())) return res.status(400).json({ message: 'Invalid received date.' });
    await postWalletTransaction({ ownerId: req.user.id, amountPaisa: actual, type: 'fdr_interest_credit', description: `FDR monthly interest: ${decryptPrivateField(doc.bankEncrypted)} · payment ${payment.monthNumber}`, referenceKey: `fdr:${doc._id}:payment:${payment._id}:credit` });
    payment.actualAmountPaisa = actual; payment.receivedDate = receivedDate; payment.status = 'Received';
  } else {
    if (payment.status === 'Received') return res.status(409).json({ message: 'A received payment cannot be changed back to pending because its wallet credit has already been posted.' });
    payment.status = 'Pending'; payment.actualAmountPaisa = null; payment.receivedDate = null;
  }
  await doc.save();
  await notifyUser(req.user.id, { type: nextStatus === 'Received' ? 'success' : 'warning', title: 'FDR payment updated', message: `${decryptPrivateField(doc.bankEncrypted)} monthly payment #${payment.monthNumber} marked ${nextStatus.toLowerCase()}.`, relatedId: String(doc._id) });
  res.json({ message: 'Payment updated.', payment: publicFdr(doc).payments.find(p => p.id === String(payment._id)) });
}));
router.patch('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid FDR ID.' });
  const doc = await FdrAccount.findOne({ _id: req.params.id, ownerId: req.user.id }).select('+bankEncrypted +principalEncrypted +rateEncrypted +tenureEncrypted');
  if (!doc) return res.status(404).json({ message: 'FDR not found.' });
  if (doc.status !== 'Active') return res.status(409).json({ message: 'Only active FDR accounts can be edited.' });
  if ((doc.payments || []).some(p => p.status === 'Received')) return res.status(409).json({ message: 'FDR cannot be edited after a monthly payment has been received.' });
  const { bank, rate } = req.body || {};
  if (!isNonEmptyString(bank, 120)) return res.status(400).json({ message: 'Bank / institution is required.' });
  if (!Number.isFinite(Number(rate)) || Number(rate) < 0 || Number(rate) > 100) return res.status(400).json({ message: 'Interest rate must be between 0 and 100.' });
  doc.bankEncrypted = encryptPrivateField(bank.trim()); doc.rateEncrypted = encryptNumber(Number(rate));
  if (doc.fdrType === 'Monthly Interest Payout') {
    const principal = decryptNumber(doc.principalEncrypted); const tenure = decryptNumber(doc.tenureEncrypted);
    const monthlyPaisa = Math.round(principal * Number(rate) / 1200 * 100);
    doc.payments = Array.from({ length: tenure }, (_, i) => ({ monthNumber: i + 1, dueDate: addMonthsClamp(doc.startDate, i + 1), expectedAmountPaisa: monthlyPaisa, status: 'Pending' }));
  }
  await doc.save(); res.json({ message: 'FDR updated.', fdr: publicFdr(doc) });
}));
router.delete('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid FDR ID.' });
  const doc = await FdrAccount.findOne({ _id: req.params.id, ownerId: req.user.id }).select('+bankEncrypted +principalEncrypted +rateEncrypted +tenureEncrypted');
  if (!doc) return res.status(404).json({ message: 'FDR not found.' });
  if (doc.status !== 'Active') return res.status(409).json({ message: 'Only active FDR can be deleted.' });
  const item = publicFdr(doc); await postWalletTransaction({ ownerId: req.user.id, amountPaisa: Math.round(item.principal * 100), type: 'adjustment', description: `FDR principal returned: ${item.bank}`, referenceKey: `fdr:${doc._id}:refund`, allowNegative: true });
  await FdrAccount.deleteOne({ _id: doc._id, ownerId: req.user.id });
  await notifyUser(req.user.id, { type: 'warning', title: 'FDR deleted', message: `${item.bank} FDR was deleted and principal ৳${item.principal.toFixed(2)} returned to available balance.`, relatedId: String(doc._id) });
  res.json({ message: 'FDR deleted and principal returned.' });
}));
module.exports = router;
