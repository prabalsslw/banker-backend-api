const express = require('express');
const User = require('../models/User');
const Saving = require('../models/Saving');
const Payment = require('../models/Payment');
const Notification = require('../models/Notification');
const authenticate = require('../middleware/authenticate');
const asyncHandler = require('../utils/asyncHandler');
const { decryptPrivateField, decryptNumber } = require('../utils/privateFields');
const router = express.Router();
router.use(authenticate);
function savingOut(s) { return { _id:s._id, ownerId:s.ownerId, savingsId:decryptPrivateField(s.savingsIdEncrypted), amount:decryptNumber(s.amountEncrypted), interestRate:decryptNumber(s.interestRateEncrypted), issueDate:s.issueDate, matureDate:s.matureDate, tenure:s.tenure, status:s.status, createdAt:s.createdAt, updatedAt:s.updatedAt }; }
function paymentOut(p) { return { _id:p._id, ownerId:p.ownerId, savingId:p.savingId, paymentNumber:p.paymentNumber, amount:decryptNumber(p.amountEncrypted), interestAmount:decryptNumber(p.interestAmountEncrypted), tenure:p.tenure, paymentDate:p.paymentDate, paymentReceivedDate:p.paymentReceivedDate, isPaid:p.isPaid, createdAt:p.createdAt, updatedAt:p.updatedAt }; }
router.get('/export', asyncHandler(async (req, res) => {
  const [user, savings, payments, notifications] = await Promise.all([
    User.findById(req.user.id).select('name phoneEncrypted emailEncrypted biometricEnabled createdAt'),
    Saving.find({ ownerId:req.user.id }).select('+savingsIdEncrypted +amountEncrypted +interestRateEncrypted').lean(),
    Payment.find({ ownerId:req.user.id }).select('+amountEncrypted +interestAmountEncrypted').lean(),
    Notification.find({ ownerId:req.user.id }).lean()
  ]);
  if (!user) return res.status(404).json({ message:'User not found.' });
  res.json({ exportedAt:new Date().toISOString(), user:{ id:user._id.toString(), name:user.name, phone:decryptPrivateField(user.phoneEncrypted), email:decryptPrivateField(user.emailEncrypted), biometricEnabled:user.biometricEnabled, createdAt:user.createdAt }, savings:savings.map(savingOut), payments:payments.map(paymentOut), notifications });
}));
module.exports = router;
