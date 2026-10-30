const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const FdrAccount = require('../models/FdrAccount');
const authenticate = require('../middleware/authenticate');
const asyncHandler = require('../utils/asyncHandler');
const { isValidObjectId, isNonEmptyString, isValidPin } = require('../utils/validators');
const { encryptPrivateField, decryptPrivateField, encryptNumber, decryptNumber } = require('../utils/privateFields');
const { postWalletTransaction } = require('../utils/walletLedger');
const { notifyUser } = require('../utils/notifyUser');
const { processDueCumulativeFdrs } = require('../utils/fdrMaturity');
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
  return { id: String(x._id), bank: decryptPrivateField(x.bankEncrypted), accountNumber: x.accountNumberEncrypted ? decryptPrivateField(x.accountNumberEncrypted) : '', fdrType, principal, rate, tenure,
    start: asYmd(start), maturityDate: asYmd(maturity), status: x.status, maturityValue, interest,
    totalInterest: fdrType === 'Monthly Interest Payout' ? interestPerPayout * tenure : totalInterest,
    interestPerPayout, payoutFrequency: fdrType === 'Monthly Interest Payout' ? 'Monthly' : fdrType === 'Quarterly Interest Payout' ? 'Quarterly' : 'At maturity', payments };
}
router.get('/', asyncHandler(async (req, res) => {
  // Reconcile any due cumulative FDRs before returning the list. The scheduled
  // worker also runs this, so opening the app is an additional safety net.
  await processDueCumulativeFdrs({ ownerId: req.user.id });
  const docs = await FdrAccount.find({ ownerId: req.user.id }).select('+bankEncrypted +accountNumberEncrypted +principalEncrypted +rateEncrypted +tenureEncrypted').sort({ createdAt: -1 });
  // Backfill payout schedules for existing monthly and quarterly FDRs.
  for (const doc of docs) {
    if (['Monthly Interest Payout', 'Quarterly Interest Payout'].includes(doc.fdrType) && (!doc.payments || doc.payments.length === 0)) {
      const principal = decryptNumber(doc.principalEncrypted); const rate = decryptNumber(doc.rateEncrypted); const tenure = decryptNumber(doc.tenureEncrypted);
      const interval = doc.fdrType === 'Quarterly Interest Payout' ? 3 : 1;
      const payoutPaisa = Math.round(principal * rate / (1200 / interval) * 100);
      doc.payments = Array.from({ length: Math.min(600, Math.floor(tenure / interval)) }, (_, i) => ({ monthNumber: (i + 1) * interval, dueDate: addMonthsClamp(doc.startDate, (i + 1) * interval), expectedAmountPaisa: payoutPaisa, status: 'Pending' }));
      await doc.save();
    }
  }
  const fdr = docs.map(publicFdr); res.json({ count: fdr.length, fdr });
}));
router.post('/', asyncHandler(async (req, res) => {
  const { bank, accountNumber, principal, rate, tenure } = req.body || {};
  const allowedFdrTypes = ['Monthly Interest Payout', 'Cumulative (Interest at Maturity)', 'Quarterly Interest Payout'];
  const fdrType = req.body?.fdrType || 'Cumulative (Interest at Maturity)';
  if (!allowedFdrTypes.includes(fdrType)) return res.status(400).json({ message: 'Select a valid FDR type.' });
  if (!isNonEmptyString(bank, 120)) return res.status(400).json({ message: 'Bank / institution is required.' });
  if (!isNonEmptyString(accountNumber, 80)) return res.status(400).json({ message: 'FDR account number is required.' });
  let principalPaisa; try { principalPaisa = moneyToPaisa(principal); } catch (e) { return res.status(400).json({ message: e.message }); }
  if (!Number.isFinite(Number(rate)) || Number(rate) < 0 || Number(rate) > 100) return res.status(400).json({ message: 'Interest rate must be between 0 and 100.' });
  if (!Number.isInteger(Number(tenure)) || Number(tenure) < 1 || Number(tenure) > 600) return res.status(400).json({ message: 'Tenure must be between 1 and 600 months.' });
  const startDate = new Date(); const maturityDate = addMonthsClamp(startDate, Number(tenure));
  const monthlyPaisa = Math.round((principalPaisa / 100) * Number(rate) / 1200 * 100);
  const payoutMonths = fdrType === 'Monthly Interest Payout' ? 1 : fdrType === 'Quarterly Interest Payout' ? 3 : 0;
  const payoutCount = payoutMonths ? Math.floor(Number(tenure) / payoutMonths) : 0;
  const payoutPaisa = fdrType === 'Quarterly Interest Payout' ? Math.round((principalPaisa / 100) * Number(rate) / 400 * 100) : monthlyPaisa;
  const payments = payoutMonths ? Array.from({ length: payoutCount }, (_, i) => ({
    monthNumber: (i + 1) * payoutMonths, dueDate: addMonthsClamp(startDate, (i + 1) * payoutMonths), expectedAmountPaisa: payoutPaisa, status: 'Pending'
  })) : [];
  const fdr = await FdrAccount.create({ ownerId: req.user.id, fdrType, bankEncrypted: encryptPrivateField(bank.trim()), accountNumberEncrypted: encryptPrivateField(accountNumber.trim()), principalEncrypted: encryptNumber(principalPaisa / 100), rateEncrypted: encryptNumber(Number(rate)), tenureEncrypted: encryptNumber(Number(tenure)), startDate, maturityDate, payments });
  try { await postWalletTransaction({ ownerId: req.user.id, amountPaisa: -principalPaisa, type: 'fdr_debit', description: `FDR principal: ${bank.trim()}`, referenceKey: `fdr:${fdr._id}:purchase` }); }
  catch (e) { await FdrAccount.deleteOne({ _id: fdr._id, ownerId: req.user.id }); if (e.status === 409) return res.status(409).json({ message: e.message }); throw e; }
  await notifyUser(req.user.id, { type: 'success', title: 'FDR created', message: `${bank.trim()} (${fdrType}) FDR opened; ৳${(principalPaisa/100).toFixed(2)} was deducted from available balance.`, relatedId: String(fdr._id), service: (fdr.fdrType === 'Cumulative Deposit' ? 'fdrCumulative' : (fdr.fdrType === 'Quarterly Interest Payout' ? 'fdrQuarterly' : 'fdrMonthly')) });
  res.status(201).json({ message: 'FDR created.', fdr: publicFdr(fdr) });
}));
router.patch('/:id/payments/:paymentId', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id) || !isValidObjectId(req.params.paymentId)) return res.status(400).json({ message: 'Invalid FDR or payment ID.' });
  const doc = await FdrAccount.findOne({ _id: req.params.id, ownerId: req.user.id }).select('+bankEncrypted +accountNumberEncrypted +principalEncrypted +rateEncrypted +tenureEncrypted');
  if (!doc) return res.status(404).json({ message: 'FDR not found.' });
  if (!['Monthly Interest Payout', 'Quarterly Interest Payout'].includes(doc.fdrType)) return res.status(400).json({ message: 'Interest payments are only available for payout FDRs.' });
  if (doc.status !== 'Active') return res.status(409).json({ message: 'Payments cannot be changed after FDR maturity or closure.' });
  const payment = doc.payments.id(req.params.paymentId);
  if (!payment) return res.status(404).json({ message: 'Payment not found.' });
  const body = req.body || {};
  const nextStatus = body.status || payment.status;
  if (!['Pending', 'Received'].includes(nextStatus)) return res.status(400).json({ message: 'Status must be Pending or Received.' });
  if (body.expectedAmount != null) {
    const expected = Number(body.expectedAmount);
    if (!Number.isFinite(expected) || expected < 0 || Math.round(expected * 100) / 100 !== expected) return res.status(400).json({ message: 'Expected amount must be zero or greater with at most two decimals.' });
    payment.expectedAmountPaisa = Math.round(expected * 100);
  }
  if (nextStatus === 'Received') {
    const actual = body.actualAmount == null ? Number(payment.actualAmountPaisa ?? payment.expectedAmountPaisa) / 100 : Number(body.actualAmount);
    if (!Number.isFinite(actual) || actual < 0 || Math.round(actual * 100) / 100 !== actual) return res.status(400).json({ message: 'Actual amount must be zero or greater with at most two decimals.' });
    const receivedDate = body.receivedDate ? new Date(body.receivedDate) : new Date();
    if (Number.isNaN(receivedDate.getTime())) return res.status(400).json({ message: 'Invalid received date.' });
    const actualPaisa = Math.round(actual * 100);
    if (payment.status !== 'Received') {
      const nextVersion = Number(payment.creditVersion || 0) + 1;
      await postWalletTransaction({ ownerId: req.user.id, amountPaisa: actualPaisa, type: 'fdr_interest_credit', description: `FDR ${doc.fdrType === 'Quarterly Interest Payout' ? 'quarterly' : 'monthly'} interest: ${decryptPrivateField(doc.bankEncrypted)} · payment ${payment.monthNumber}`, referenceKey: `fdr:${doc._id}:payment:${payment._id}:credit:${nextVersion}` });
      payment.creditVersion = nextVersion;
    } else {
      const previous = Number(payment.actualAmountPaisa ?? 0);
      const delta = actualPaisa - previous;
      if (delta !== 0) await postWalletTransaction({ ownerId: req.user.id, amountPaisa: delta, type: 'fdr_interest_adjustment', description: `FDR interest adjustment: ${decryptPrivateField(doc.bankEncrypted)} · payment ${payment.monthNumber}`, referenceKey: `fdr:${doc._id}:payment:${payment._id}:adjust:${actualPaisa}:${receivedDate.getTime()}`, allowNegative: true });
    }
    payment.actualAmountPaisa = actualPaisa; payment.receivedDate = receivedDate; payment.status = 'Received';
  } else {
    if (payment.status === 'Received') {
      const previous = Number(payment.actualAmountPaisa ?? 0);
      if (previous > 0) await postWalletTransaction({ ownerId: req.user.id, amountPaisa: -previous, type: 'fdr_interest_reversal', description: `Reverse FDR interest: ${decryptPrivateField(doc.bankEncrypted)} · payment ${payment.monthNumber}`, referenceKey: `fdr:${doc._id}:payment:${payment._id}:reversal:${payment.creditVersion || 1}`, allowNegative: true });
    }
    payment.status = 'Pending'; payment.actualAmountPaisa = null; payment.receivedDate = null;
  }
  await doc.save();
  await notifyUser(req.user.id, { type: nextStatus === 'Received' ? 'success' : 'warning', title: 'FDR payment updated', message: `${decryptPrivateField(doc.bankEncrypted)} ${doc.fdrType === 'Quarterly Interest Payout' ? 'quarterly' : 'monthly'} payment #${payment.monthNumber} marked ${nextStatus.toLowerCase()}.`, relatedId: String(doc._id), service: (doc.fdrType === 'Cumulative Deposit' ? 'fdrCumulative' : (doc.fdrType === 'Quarterly Interest Payout' ? 'fdrQuarterly' : 'fdrMonthly')) });
  res.json({ message: 'Payment updated.', payment: publicFdr(doc).payments.find(p => p.id === String(payment._id)) });
}));

router.post('/:id/mature', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid FDR ID.' });
  const { pin } = req.body || {};
  if (!isValidPin(pin)) return res.status(400).json({ message: 'A valid 4-digit PIN is required.' });
  const user = await User.findById(req.user.id).select('+pinHash');
  if (!user || !(await bcrypt.compare(pin, user.pinHash))) return res.status(401).json({ message: 'Incorrect PIN.' });
  const doc = await FdrAccount.findOne({ _id: req.params.id, ownerId: req.user.id }).select('+bankEncrypted +accountNumberEncrypted +principalEncrypted +rateEncrypted +tenureEncrypted');
  if (!doc) return res.status(404).json({ message: 'FDR not found.' });
  if (doc.status !== 'Active') return res.status(409).json({ message: 'Only active FDR accounts can mature.' });
  if (new Date(doc.maturityDate) > new Date()) return res.status(409).json({ message: `This FDR has not reached maturity date ${asYmd(doc.maturityDate)} yet.` });
  const principal = decryptNumber(doc.principalEncrypted);
  const rate = decryptNumber(doc.rateEncrypted);
  const tenure = decryptNumber(doc.tenureEncrypted);
  const principalPaisa = Math.round(principal * 100);
  const maturityInterestPaisa = doc.fdrType === 'Cumulative (Interest at Maturity)' ? Math.round(principal * rate / 100 * tenure / 12 * 100) : 0;
  const credit = principalPaisa + maturityInterestPaisa;
  await postWalletTransaction({ ownerId: req.user.id, amountPaisa: credit, type: 'fdr_maturity', description: `FDR maturity: ${decryptPrivateField(doc.bankEncrypted)}`, referenceKey: `fdr:${doc._id}:maturity`, allowNegative: true });
  doc.status = 'Matured'; await doc.save();
  await notifyUser(req.user.id, { type: 'success', title: 'FDR matured', message: `${decryptPrivateField(doc.bankEncrypted)} matured and ${ (credit / 100).toFixed(2)} Tk was credited to your available balance.`, relatedId: String(doc._id), service: (doc.fdrType === 'Cumulative Deposit' ? 'fdrCumulative' : (doc.fdrType === 'Quarterly Interest Payout' ? 'fdrQuarterly' : 'fdrMonthly')) });
  res.json({ message: 'FDR matured and proceeds credited.', fdr: publicFdr(doc) });
}));

router.post('/:id/close', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid FDR ID.' });
  const { pin, earlyEncashAmount } = req.body || {};
  if (!isValidPin(pin)) return res.status(400).json({ message: 'A valid 4-digit PIN is required.' });
  const amount = Number(earlyEncashAmount);
  if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) / 100 !== amount) return res.status(400).json({ message: 'Encashment amount must be positive with at most two decimal places.' });
  const user = await User.findById(req.user.id).select('+pinHash');
  if (!user || !(await bcrypt.compare(pin, user.pinHash))) return res.status(401).json({ message: 'Incorrect PIN.' });
  const doc = await FdrAccount.findOne({ _id: req.params.id, ownerId: req.user.id }).select('+bankEncrypted +accountNumberEncrypted +principalEncrypted +rateEncrypted +tenureEncrypted');
  if (!doc) return res.status(404).json({ message: 'FDR not found.' });
  if (doc.status !== 'Active') return res.status(409).json({ message: 'Only active FDR accounts can be encashed.' });
  if (new Date(doc.maturityDate) <= new Date()) return res.status(409).json({ message: 'This FDR has reached maturity. Use Mature instead of early encashment.' });
  const principal = decryptNumber(doc.principalEncrypted);
  if (amount > principal) return res.status(400).json({ message: 'Encashment amount cannot exceed the principal amount.' });
  const creditPaisa = Math.round(amount * 100);
  await postWalletTransaction({ ownerId: req.user.id, amountPaisa: creditPaisa, type: 'fdr_early_encash', description: `Early encashment: ${decryptPrivateField(doc.bankEncrypted)}`, referenceKey: `fdr:${doc._id}:early-close` });
  doc.status = 'Closed'; await doc.save();
  await notifyUser(req.user.id, { type: 'warning', title: 'FDR encashed early', message: `${decryptPrivateField(doc.bankEncrypted)} was encashed and ${(creditPaisa / 100).toFixed(2)} Tk was credited.`, relatedId: String(doc._id), service: (doc.fdrType === 'Cumulative Deposit' ? 'fdrCumulative' : (doc.fdrType === 'Quarterly Interest Payout' ? 'fdrQuarterly' : 'fdrMonthly')) });
  res.json({ message: 'FDR encashed and proceeds credited.', fdr: publicFdr(doc) });
}));
router.patch('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid FDR ID.' });
  const doc = await FdrAccount.findOne({ _id: req.params.id, ownerId: req.user.id }).select('+bankEncrypted +accountNumberEncrypted +principalEncrypted +rateEncrypted +tenureEncrypted');
  if (!doc) return res.status(404).json({ message: 'FDR not found.' });
  if (doc.status !== 'Active') return res.status(409).json({ message: 'Only active FDR accounts can be edited.' });
  if ((doc.payments || []).some(p => p.status === 'Received')) return res.status(409).json({ message: 'FDR cannot be edited after a monthly payment has been received.' });
  const { bank, accountNumber, rate } = req.body || {};
  if (!isNonEmptyString(bank, 120)) return res.status(400).json({ message: 'Bank / institution is required.' });
  if (!isNonEmptyString(accountNumber, 80)) return res.status(400).json({ message: 'FDR account number is required.' });
  if (!Number.isFinite(Number(rate)) || Number(rate) < 0 || Number(rate) > 100) return res.status(400).json({ message: 'Interest rate must be between 0 and 100.' });
  doc.bankEncrypted = encryptPrivateField(bank.trim()); doc.accountNumberEncrypted = encryptPrivateField(accountNumber.trim()); doc.rateEncrypted = encryptNumber(Number(rate));
  if (['Monthly Interest Payout', 'Quarterly Interest Payout'].includes(doc.fdrType)) {
    const principal = decryptNumber(doc.principalEncrypted); const tenure = decryptNumber(doc.tenureEncrypted);
    const interval = doc.fdrType === 'Quarterly Interest Payout' ? 3 : 1;
    const payoutPaisa = Math.round(principal * Number(rate) / (1200 / interval) * 100);
    doc.payments = Array.from({ length: Math.floor(tenure / interval) }, (_, i) => ({ monthNumber: (i + 1) * interval, dueDate: addMonthsClamp(doc.startDate, (i + 1) * interval), expectedAmountPaisa: payoutPaisa, status: 'Pending' }));
  }
  await doc.save(); res.json({ message: 'FDR updated.', fdr: publicFdr(doc) });
}));
router.delete('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid FDR ID.' });
  const doc = await FdrAccount.findOne({ _id: req.params.id, ownerId: req.user.id }).select('+bankEncrypted +accountNumberEncrypted +principalEncrypted +rateEncrypted +tenureEncrypted');
  if (!doc) return res.status(404).json({ message: 'FDR not found.' });
  if (doc.status !== 'Active') return res.status(409).json({ message: 'Only active FDR can be deleted.' });
  const item = publicFdr(doc); await postWalletTransaction({ ownerId: req.user.id, amountPaisa: Math.round(item.principal * 100), type: 'adjustment', description: `FDR principal returned: ${item.bank}`, referenceKey: `fdr:${doc._id}:refund`, allowNegative: true });
  await FdrAccount.deleteOne({ _id: doc._id, ownerId: req.user.id });
  await notifyUser(req.user.id, { type: 'warning', title: 'FDR deleted', message: `${item.bank} FDR was deleted and principal ৳${item.principal.toFixed(2)} returned to available balance.`, relatedId: String(doc._id), service: (doc.fdrType === 'Cumulative Deposit' ? 'fdrCumulative' : (doc.fdrType === 'Quarterly Interest Payout' ? 'fdrQuarterly' : 'fdrMonthly')) });
  res.json({ message: 'FDR deleted and principal returned.' });
}));
module.exports = router;
