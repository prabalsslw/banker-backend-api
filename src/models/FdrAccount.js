const mongoose = require('mongoose');

const fdrPaymentSchema = new mongoose.Schema({
  monthNumber: { type: Number, required: true, min: 1 },
  dueDate: { type: Date, required: true },
  expectedAmountPaisa: { type: Number, required: true, min: 0 },
  actualAmountPaisa: { type: Number, default: null, min: 0 },
  receivedDate: { type: Date, default: null },
  status: { type: String, enum: ['Pending', 'Received'], default: 'Pending' },
}, { timestamps: true });

const fdrAccountSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  bankEncrypted: { type: String, required: true, select: false },
  fdrType: { type: String, enum: ['Monthly Interest Payout', 'Cumulative (Interest at Maturity)', 'Quarterly Interest Payout'], default: 'Cumulative (Interest at Maturity)', index: true },
  principalEncrypted: { type: String, required: true, select: false },
  rateEncrypted: { type: String, required: true, select: false },
  tenureEncrypted: { type: String, required: true, select: false },
  startDate: { type: Date, required: true },
  maturityDate: { type: Date, required: true },
  status: { type: String, enum: ['Active', 'Matured', 'Closed'], default: 'Active' },
  payments: { type: [fdrPaymentSchema], default: [] }
}, { timestamps: true, versionKey: false, collection: 'fdr_accounts' });
fdrAccountSchema.index({ ownerId: 1, createdAt: -1 });
module.exports = mongoose.model('FdrAccount', fdrAccountSchema);
