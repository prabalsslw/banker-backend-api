const mongoose = require('mongoose');
const stockHoldingSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  symbolHash: { type: String, required: true },
  portfolioEncrypted: { type: String, required: true, select: false }
}, { timestamps: true, versionKey: false, collection: 'stock_holdings' });
stockHoldingSchema.index({ ownerId: 1, symbolHash: 1 }, { unique: true });
module.exports = mongoose.model('StockHolding', stockHoldingSchema);
