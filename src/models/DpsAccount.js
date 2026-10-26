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
  schemeName: { type: String, required: true, trim: true, maxlength: 120 },
  accountNumberEncrypted: { type: String, required: true, select: false },
  accountNumberLookup: { type: String, required: true, select: false },
  monthlyInstallmentPaisa: { type: Number, required: true, min: 1 },
  tenure: { type: Number, required: true, min: 1, max: 600 },
  tenureUnit: { type: String, enum: ['months', 'years'], required: true },
  interestRate: { type: Number, required: true, min: 0, max: 100 },
  startDate: { type: Date, required: true },
  maturityDate: { type: Date, required: true },
  status: { type: String, enum: ['Active', 'Matured'], default: 'Active', index: true },
  payments: { type: [dpsPaymentSchema], default: [] },
  encashedAt: { type: Date, default: null },
  encashmentAmountPaisa: { type: Number, default: null }
}, { timestamps: true, versionKey: false, collection: 'dps_accounts' });

dpsAccountSchema.index({ ownerId: 1, accountNumberLookup: 1 }, { unique: true });
dpsAccountSchema.index({ ownerId: 1, status: 1, maturityDate: 1 });
module.exports = mongoose.model('DpsAccount', dpsAccountSchema);
