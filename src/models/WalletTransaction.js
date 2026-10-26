const mongoose = require('mongoose');
const walletTransactionSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  amountPaisa: { type: Number, required: true },
  type: { type: String, enum: ['deposit', 'savings_debit', 'savings_maturity', 'five_year_savings_debit', 'five_year_savings_maturity', 'dps_installment_debit', 'dps_installment_refund', 'dps_encashment', 'fdr_debit', 'fdr_interest_credit', 'fdr_interest_adjustment', 'fdr_interest_reversal', 'fdr_early_encash', 'fdr_maturity', 'stock_debit', 'expense', 'adjustment'], required: true },
  description: { type: String, required: true, maxlength: 200 },
  referenceKey: { type: String, required: true },
  occurredAt: { type: Date, default: Date.now }
}, { timestamps: true, versionKey: false, collection: 'wallet_transactions' });
walletTransactionSchema.index({ ownerId: 1, referenceKey: 1 }, { unique: true });
walletTransactionSchema.index({ ownerId: 1, occurredAt: -1 });
module.exports = mongoose.model('WalletTransaction', walletTransactionSchema);
