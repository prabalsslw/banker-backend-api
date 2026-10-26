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
const moneyToPaisa = (v) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0 || Math.abs(Math.round(n * 100) / 100 - n) > 1e-6) throw new Error('Principal must be positive and have at most two decimal places.'); return Math.round(n * 100); };
const addMonthsClamp = (date, months) => { const d = new Date(date); const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + months); const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); d.setDate(Math.min(day, last)); return d; };
function publicFdr(doc) { const x = doc.toObject ? doc.toObject() : doc; const principal = decryptNumber(x.principalEncrypted); const rate = decryptNumber(x.rateEncrypted); const tenure = decryptNumber(x.tenureEncrypted); const start = new Date(x.startDate); const maturity = new Date(x.maturityDate); const years = Math.max(0, (maturity - start) / (365.2425 * 86400000)); const fdrType = x.fdrType || 'Cumulative (Interest at Maturity)'; const totalInterest = Math.round(principal * rate / 100 * years * 100) / 100; const interestPerPayout = fdrType === 'Monthly Interest Payout' ? Math.round(principal * rate / 1200 * 100) / 100 : fdrType === 'Quarterly Interest Payout' ? Math.round(principal * rate / 400 * 100) / 100 : 0; const interest = fdrType === 'Cumulative (Interest at Maturity)' ? totalInterest : interestPerPayout; const maturityValue = fdrType === 'Cumulative (Interest at Maturity)' ? Math.round((principal + totalInterest) * 100) / 100 : principal; return { id: String(x._id), bank: decryptPrivateField(x.bankEncrypted), fdrType, principal, rate, tenure, start: start.toISOString().slice(0,10), maturityDate: maturity.toISOString().slice(0,10), status: x.status, maturityValue, interest, totalInterest, interestPerPayout, payoutFrequency: fdrType === 'Monthly Interest Payout' ? 'Monthly' : fdrType === 'Quarterly Interest Payout' ? 'Quarterly' : 'At maturity' }; }
router.get('/', asyncHandler(async (req, res) => { const docs = await FdrAccount.find({ ownerId: req.user.id }).select('+bankEncrypted +principalEncrypted +rateEncrypted +tenureEncrypted').sort({ createdAt: -1 }).lean(); const fdr = docs.map(publicFdr); res.json({ count: fdr.length, fdr }); }));
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
  const fdr = await FdrAccount.create({ ownerId: req.user.id, fdrType, bankEncrypted: encryptPrivateField(bank.trim()), principalEncrypted: encryptNumber(principalPaisa / 100), rateEncrypted: encryptNumber(Number(rate)), tenureEncrypted: encryptNumber(Number(tenure)), startDate, maturityDate });
  try { await postWalletTransaction({ ownerId: req.user.id, amountPaisa: -principalPaisa, type: 'fdr_debit', description: `FDR principal: ${bank.trim()}`, referenceKey: `fdr:${fdr._id}:purchase` }); }
  catch (e) { await FdrAccount.deleteOne({ _id: fdr._id, ownerId: req.user.id }); if (e.status === 409) return res.status(409).json({ message: e.message }); throw e; }
  await notifyUser(req.user.id, { type: 'success', title: 'FDR created', message: `${bank.trim()} (${fdrType}) FDR opened; ৳${(principalPaisa/100).toFixed(2)} was deducted from available balance.`, relatedId: String(fdr._id) });
  res.status(201).json({ message: 'FDR created.', fdr: publicFdr(fdr) });
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
