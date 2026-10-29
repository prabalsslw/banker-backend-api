const mongoose = require('mongoose');
const expenseSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  titleEncrypted: { type: String, required: true, select: false },
  category: { type: String, required: true, trim: true, maxlength: 60 },
  reasonEncrypted: { type: String, default: '', select: false },
  remarkEncrypted: { type: String, default: '', select: false },
  amountPaisa: { type: Number, required: true, min: 1 },
  expenseDate: { type: Date, default: Date.now }
}, { timestamps: true, versionKey: false, collection: 'expenses' });
expenseSchema.index({ ownerId: 1, expenseDate: -1 });
module.exports = mongoose.model('Expense', expenseSchema);
