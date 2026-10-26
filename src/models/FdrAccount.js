const mongoose = require('mongoose');
const fdrAccountSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  bankEncrypted: { type: String, required: true, select: false },
  principalEncrypted: { type: String, required: true, select: false },
  rateEncrypted: { type: String, required: true, select: false },
  tenureEncrypted: { type: String, required: true, select: false },
  startDate: { type: Date, required: true },
  maturityDate: { type: Date, required: true },
  status: { type: String, enum: ['Active', 'Matured', 'Closed'], default: 'Active' }
}, { timestamps: true, versionKey: false, collection: 'fdr_accounts' });
fdrAccountSchema.index({ ownerId: 1, createdAt: -1 });
module.exports = mongoose.model('FdrAccount', fdrAccountSchema);
