const express = require('express');
const WalletTransaction = require('../models/WalletTransaction');
const authenticate = require('../middleware/authenticate');
const asyncHandler = require('../utils/asyncHandler');
const router = express.Router();
router.use(authenticate);
router.get('/', asyncHandler(async (req, res) => {
  const rows = await WalletTransaction.find({ ownerId: req.user.id }).sort({ occurredAt: -1 }).limit(100);
  const aggregate = await WalletTransaction.aggregate([{ $match: { ownerId: require('mongoose').Types.ObjectId.createFromHexString(req.user.id) } }, { $group: { _id: null, balancePaisa: { $sum: '$amountPaisa' } } }]);
  res.json({ balance: Number(aggregate[0]?.balancePaisa || 0) / 100, transactions: rows.map(x => ({ id: String(x._id), amount: x.amountPaisa / 100, type: x.type, description: x.description, occurredAt: x.occurredAt })) });
}));
module.exports = router;
