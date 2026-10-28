const WalletTransaction = require('../models/WalletTransaction');

async function getBalancePaisa(ownerId, session) {
  const match = { ownerId: require('mongoose').Types.ObjectId.createFromHexString(String(ownerId)) };
  const rows = await WalletTransaction.aggregate([
    { $match: match },
    { $group: { _id: null, balancePaisa: { $sum: '$amountPaisa' } } }
  ]);
  return Number(rows[0]?.balancePaisa || 0);
}

async function postWalletTransaction({ ownerId, amountPaisa, type, description, referenceKey, allowNegative = false, transactionId, remark = '', sourceName = '', sourceReference = '' }) {
  if (!Number.isSafeInteger(amountPaisa) || amountPaisa === 0) throw new Error('Wallet transaction must be a non-zero amount in paisa.');
  const existing = await WalletTransaction.findOne({ ownerId, referenceKey });
  if (existing) return existing;
  if (amountPaisa < 0 && !allowNegative) {
    const balance = await getBalancePaisa(ownerId);
    if (balance + amountPaisa < 0) {
      const error = new Error(`Insufficient available balance. Required ৳ ${(Math.abs(amountPaisa) / 100).toFixed(2)}, available ৳ ${(balance / 100).toFixed(2)}.`);
      error.status = 409;
      throw error;
    }
  }
  return WalletTransaction.create({ ownerId, amountPaisa, type, description: String(description).slice(0, 200), referenceKey, transactionId, remark, sourceName, sourceReference, occurredAt: new Date() });
}

module.exports = { getBalancePaisa, postWalletTransaction };
