const mongoose = require('mongoose');

// Separate collection for the Five-Year Bangladesh Sanchayapatra scheme.
// Sensitive values are encrypted at rest; the lookup hash supports per-user uniqueness.
const fiveYearSavingSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  savingsIdEncrypted: { type: String, required: true, select: false },
  savingsIdLookup: { type: String, required: true, select: false },
  amountEncrypted: { type: String, required: true, select: false },
  interestRateEncrypted: { type: String, required: true, select: false },
  issueDate: { type: Date, required: true },
  matureDate: { type: Date, required: true },
  status: { type: String, enum: ['Active', 'Matured', 'Closed', 'Inactive'], default: 'Active' }
}, { timestamps: true, versionKey: false, collection: 'five_year_savings' });

fiveYearSavingSchema.index({ ownerId: 1, savingsIdLookup: 1 }, { unique: true });
fiveYearSavingSchema.index({ ownerId: 1, createdAt: -1 });

module.exports = mongoose.model('FiveYearSaving', fiveYearSavingSchema);
