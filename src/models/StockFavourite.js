const mongoose = require('mongoose');
const stockFavouriteSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  symbolHash: { type: String, required: true },
  stockEncrypted: { type: String, required: true, select: false }
}, { timestamps: true, versionKey: false, collection: 'stock_favourites' });
stockFavouriteSchema.index({ ownerId: 1, symbolHash: 1 }, { unique: true });
module.exports = mongoose.model('StockFavourite', stockFavouriteSchema);
