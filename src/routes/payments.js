const express = require('express');
const Payment = require('../models/Payment');
const { notifyUser } = require('../utils/notifyUser');
const { postWalletTransaction } = require('../utils/walletLedger');
const crypto = require('crypto');
const Saving = require('../models/Saving');
const authenticate = require('../middleware/authenticate');
const asyncHandler = require('../utils/asyncHandler');
const { isValidObjectId, parseDate } = require('../utils/validators');
const { encryptNumber, decryptNumber } = require('../utils/privateFields');
const router = express.Router();
router.use(authenticate);

function publicPayment(doc) {
  const p = doc.toObject ? doc.toObject() : doc;
  return {
    _id: p._id, ownerId: p.ownerId, savingId: p.savingId,
    paymentNumber: p.paymentNumber,
    amount: decryptNumber(p.amountEncrypted),
    interestAmount: decryptNumber(p.interestAmountEncrypted),
    creditedInterestAmount: p.creditedInterestAmountEncrypted ? decryptNumber(p.creditedInterestAmountEncrypted) : 0,
    tenure: p.tenure, paymentDate: p.paymentDate,
    paymentReceivedDate: p.paymentReceivedDate, isPaid: p.isPaid,
    createdAt: p.createdAt, updatedAt: p.updatedAt
  };
}
function encryptedUpdates(body) {
  const out = {};
  if (body.paymentNumber !== undefined) out.paymentNumber = Number(body.paymentNumber);
  if (body.amount !== undefined) out.amountEncrypted = encryptNumber(body.amount);
  if (body.interestAmount !== undefined) out.interestAmountEncrypted = encryptNumber(body.interestAmount);
  if (body.creditedInterestAmount !== undefined) out.creditedInterestAmountEncrypted = encryptNumber(body.creditedInterestAmount);
  if (body.tenure !== undefined) out.tenure = Number(body.tenure);
  if (body.paymentDate !== undefined) out.paymentDate = parseDate(body.paymentDate);
  if (body.paymentReceivedDate !== undefined) out.paymentReceivedDate = body.paymentReceivedDate === null ? null : parseDate(body.paymentReceivedDate);
  if (body.isPaid !== undefined) out.isPaid = body.isPaid;
  return out;
}

router.get('/', asyncHandler(async (req, res) => {
  const filter = { ownerId: req.user.id };
  if (req.query.savingId) {
    if (!isValidObjectId(req.query.savingId)) return res.status(400).json({ message: 'Invalid savingId.' });
    filter.savingId = req.query.savingId;
  }
  if (req.query.isPaid !== undefined) {
    if (!['true', 'false'].includes(req.query.isPaid)) return res.status(400).json({ message: 'isPaid must be true or false.' });
    filter.isPaid = req.query.isPaid === 'true';
  }
  const docs = await Payment.find(filter).select('+amountEncrypted +interestAmountEncrypted +creditedInterestAmountEncrypted').sort({ paymentDate: 1 });
  res.json({ count: docs.length, payments: docs.map(publicPayment) });
}));

router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!isValidObjectId(b.savingId)) return res.status(400).json({ message: 'A valid savingId is required.' });
  if (!Number.isInteger(Number(b.paymentNumber)) || Number(b.paymentNumber) < 1) return res.status(400).json({ message: 'paymentNumber must be a positive integer.' });
  if (!Number.isFinite(Number(b.amount)) || Number(b.amount) < 0) return res.status(400).json({ message: 'amount must be a non-negative number.' });
  const interestAmount = b.interestAmount === undefined ? 0 : Number(b.interestAmount);
  if (!Number.isFinite(interestAmount) || interestAmount < 0) return res.status(400).json({ message: 'interestAmount must be non-negative.' });
  if (b.creditedInterestAmount !== undefined && (!Number.isFinite(Number(b.creditedInterestAmount)) || Number(b.creditedInterestAmount) < 0)) return res.status(400).json({ message: 'creditedInterestAmount must be non-negative.' });
  if (!parseDate(b.paymentDate)) return res.status(400).json({ message: 'paymentDate must be a valid date.' });
  if (b.paymentReceivedDate !== undefined && b.paymentReceivedDate !== null && !parseDate(b.paymentReceivedDate)) return res.status(400).json({ message: 'paymentReceivedDate must be a valid date or null.' });
  if (b.isPaid !== undefined && typeof b.isPaid !== 'boolean') return res.status(400).json({ message: 'isPaid must be true or false.' });
  if (b.tenure !== undefined && (!Number.isInteger(Number(b.tenure)) || Number(b.tenure) < 1)) return res.status(400).json({ message: 'tenure must be a positive integer.' });

  const saving = await Saving.findOne({ _id: b.savingId, ownerId: req.user.id });
  if (!saving) return res.status(404).json({ message: 'Saving not found for this account.' });
  const payment = await Payment.create({
    ownerId: req.user.id, savingId: saving._id,
    paymentNumber: Number(b.paymentNumber), amountEncrypted: encryptNumber(b.amount),
    interestAmountEncrypted: encryptNumber(interestAmount),
    creditedInterestAmountEncrypted: encryptNumber(b.creditedInterestAmount === undefined ? 0 : Number(b.creditedInterestAmount)),
    tenure: b.tenure === undefined ? undefined : Number(b.tenure),
    paymentDate: parseDate(b.paymentDate),
    paymentReceivedDate: b.paymentReceivedDate ? parseDate(b.paymentReceivedDate) : null,
    isPaid: b.isPaid === true
  });
  await notifyUser(req.user.id, { type: 'info', title: 'Sanchayapatra payment scheduled', message: `Payment #${payment.paymentNumber} was added to the schedule for ${parseDate(b.paymentDate).toISOString().slice(0, 10)}.`, relatedId: String(saving._id) });
  res.status(201).json({ message: 'Payment created.', payment: publicPayment(payment) });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid payment ID.' });
  const allowed = ['paymentNumber', 'amount', 'interestAmount', 'creditedInterestAmount', 'tenure', 'paymentDate', 'paymentReceivedDate', 'isPaid'];
  for (const key of Object.keys(req.body || {})) if (!allowed.includes(key)) return res.status(400).json({ message: `Field ${key} cannot be updated.` });
  const b = req.body || {};
  if (b.paymentNumber !== undefined && (!Number.isInteger(Number(b.paymentNumber)) || Number(b.paymentNumber) < 1)) return res.status(400).json({ message: 'paymentNumber must be a positive integer.' });
  for (const key of ['amount', 'interestAmount', 'creditedInterestAmount']) if (b[key] !== undefined && (!Number.isFinite(Number(b[key])) || Number(b[key]) < 0)) return res.status(400).json({ message: `${key} must be non-negative.` });
  if (b.tenure !== undefined && (!Number.isInteger(Number(b.tenure)) || Number(b.tenure) < 1)) return res.status(400).json({ message: 'tenure must be a positive integer.' });
  if (b.paymentDate !== undefined && !parseDate(b.paymentDate)) return res.status(400).json({ message: 'paymentDate must be a valid date.' });
  if (b.paymentReceivedDate !== undefined && b.paymentReceivedDate !== null && !parseDate(b.paymentReceivedDate)) return res.status(400).json({ message: 'paymentReceivedDate must be a valid date or null.' });
  if (b.isPaid !== undefined && typeof b.isPaid !== 'boolean') return res.status(400).json({ message: 'isPaid must be true or false.' });
  const current = await Payment.findOne({ _id: req.params.id, ownerId: req.user.id }).select('+amountEncrypted +interestAmountEncrypted +creditedInterestAmountEncrypted');
  if (!current) return res.status(404).json({ message: 'Payment not found.' });
  const updates = encryptedUpdates(b);
  if (!Object.keys(updates).length) return res.status(400).json({ message: 'No fields supplied.' });
  const wasPaid = current.isPaid;
  const oldCredited = wasPaid ? Number(current.creditedInterestAmountEncrypted ? decryptNumber(current.creditedInterestAmountEncrypted) : 0) : 0;
  if (b.isPaid === true && b.creditedInterestAmount === undefined && !wasPaid) {
    updates.creditedInterestAmountEncrypted = current.interestAmountEncrypted;
  }
  Object.assign(current, updates);
  const willBePaid = current.isPaid;
  const newCredited = willBePaid ? Number(current.creditedInterestAmountEncrypted ? decryptNumber(current.creditedInterestAmountEncrypted) : 0) : 0;
  const deltaPaisa = Math.round((newCredited - oldCredited) * 100);
  if (deltaPaisa !== 0) await postWalletTransaction({
    ownerId: req.user.id, amountPaisa: deltaPaisa, type: 'adjustment',
    description: `${deltaPaisa > 0 ? 'Sanchayapatra profit received' : 'Sanchayapatra profit reversal'} payment #${current.paymentNumber}`,
    referenceKey: `saving-payment:${current._id}:interest:${crypto.randomUUID()}`, allowNegative: true
  });
  await current.save();
  const payment = await Payment.findById(current._id).select('+amountEncrypted +interestAmountEncrypted +creditedInterestAmountEncrypted');
  await notifyUser(req.user.id, { type: 'payment', title: payment.isPaid ? 'Sanchayapatra payment received' : 'Sanchayapatra payment updated', message: `Payment #${payment.paymentNumber} was ${payment.isPaid ? `marked received with ৳${newCredited.toFixed(2)} credited to your available balance` : 'updated/returned to pending'}.`, relatedId: String(payment.savingId) });
  res.json({ message: 'Payment updated.', payment: publicPayment(payment) });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid payment ID.' });
  const payment = await Payment.findOneAndDelete({ _id: req.params.id, ownerId: req.user.id });
  if (!payment) return res.status(404).json({ message: 'Payment not found.' });
  await notifyUser(req.user.id, { type: 'warning', title: 'Sanchayapatra payment deleted', message: `Payment #${payment.paymentNumber} was removed from the schedule.`, relatedId: String(payment.savingId) });
  res.json({ message: 'Payment deleted.' });
}));
module.exports = router;
