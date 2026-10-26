const mongoose = require('mongoose');
const paymentSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // savingId is the internal MongoDB reference needed to associate a payment with its saving.
  savingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Saving', required: true, index: true },
  paymentNumber: { type: Number, required: true, min: 1 },
  amountEncrypted: { type: String, required: true, select: false },
  interestAmountEncrypted: { type: String, required: true, select: false },
  creditedInterestAmountEncrypted: { type: String, default: null, select: false },
  tenure: { type: Number, min: 1 },
  paymentDate: { type: Date, required: true },
  paymentReceivedDate: { type: Date, default: null },
  isPaid: { type: Boolean, default: false }
}, { timestamps: true, versionKey: false });
paymentSchema.index({ ownerId: 1, savingId: 1, paymentNumber: 1 }, { unique: true });
paymentSchema.index({ ownerId: 1, paymentDate: 1 });
module.exports = mongoose.model('Payment', paymentSchema);
