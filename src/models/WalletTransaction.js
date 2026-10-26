const mongoose = require('mongoose');
const walletTransactionSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  amountPaisa: { type: Number, required: true },
  type: { type: String, enum: ['dps_encashment'], required: true },
  description: { type: String, required: true, maxlength: 200 },
  referenceKey: { type: String, required: true },
  occurredAt: { type: Date, default: Date.now }
}, { timestamps: true, versionKey: false, collection: 'wallet_transactions' });
walletTransactionSchema.index({ ownerId: 1, referenceKey: 1 }, { unique: true });
walletTransactionSchema.index({ ownerId: 1, occurredAt: -1 });
module.exports = mongoose.model('WalletTransaction', walletTransactionSchema);
