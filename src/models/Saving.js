const mongoose = require('mongoose');
const savingSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // These sensitive fields are ciphertext at rest. Lookup hash supports uniqueness without plaintext.
  savingsIdEncrypted: { type: String, required: true, select: false },
  savingsIdLookup: { type: String, required: true, select: false },
  amountEncrypted: { type: String, required: true, select: false },
  interestRateEncrypted: { type: String, required: true, select: false },
  issueDate: { type: Date, required: true },
  matureDate: { type: Date, required: true },
  // Additive field: old documents without schemeType are treated as quarterly Sanchaypatra.
  schemeType: { type: String, enum: ['Sanchaypatra', 'Five-Year Bangladesh Sanchaypatra'], default: 'Sanchaypatra', index: true },
  tenure: { type: Number, min: 1 },
  status: { type: String, enum: ['Active', 'Matured', 'Closed', 'Inactive'], default: 'Active' }
}, { timestamps: true, versionKey: false });
savingSchema.index({ ownerId: 1, savingsIdLookup: 1 }, { unique: true });
savingSchema.index({ ownerId: 1, createdAt: -1 });
module.exports = mongoose.model('Saving', savingSchema);
