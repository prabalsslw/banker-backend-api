const mongoose = require('mongoose');

const dpsPaymentSchema = new mongoose.Schema({
  dueDate: { type: Date, required: true },
  expectedAmountPaisa: { type: Number, required: true, min: 1 },
  depositAmountPaisa: { type: Number, default: null, min: 0 },
  deductionDate: { type: Date, default: null },
  status: { type: String, enum: ['Pending', 'Paid'], default: 'Pending' },
  paidAt: { type: Date, default: null }
}, { timestamps: true });

const dpsAccountSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // New encrypted fields. Legacy plaintext fields below are retained only for backward-compatible migration.
  schemeNameEncrypted: { type: String, select: false },
  accountNumberEncrypted: { type: String, required: true, select: false },
  accountNumberLookup: { type: String, required: true, select: false },
  monthlyInstallmentEncrypted: { type: String, select: false },
  tenureEncrypted: { type: String, select: false },
  interestRateEncrypted: { type: String, select: false },
  schemeName: { type: String, trim: true, maxlength: 120, select: false },
  monthlyInstallmentPaisa: { type: Number, min: 1, select: false },
  tenure: { type: Number, min: 1, max: 600, select: false },
  tenureUnit: { type: String, enum: ['months', 'years'], required: true },
  interestRate: { type: Number, min: 0, max: 100, select: false },
  startDate: { type: Date, required: true },
  maturityDate: { type: Date, required: true },
  status: { type: String, enum: ['Active', 'Matured', 'Closed'], default: 'Active', index: true },
  payments: { type: [dpsPaymentSchema], default: [] },
  encashedAt: { type: Date, default: null },
  encashmentAmountPaisa: { type: Number, default: null }
}, { timestamps: true, versionKey: false, collection: 'dps_accounts' });

dpsAccountSchema.index({ ownerId: 1, accountNumberLookup: 1 }, { unique: true });
dpsAccountSchema.index({ ownerId: 1, status: 1, maturityDate: 1 });
dpsAccountSchema.index({ ownerId: 1, createdAt: -1 });
module.exports = mongoose.model('DpsAccount', dpsAccountSchema);
