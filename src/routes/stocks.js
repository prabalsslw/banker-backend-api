const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const StockHolding = require('../models/StockHolding');
const StockFavourite = require('../models/StockFavourite');
const WalletTransaction = require('../models/WalletTransaction');
const authenticate = require('../middleware/authenticate');
const asyncHandler = require('../utils/asyncHandler');
const { encryptPrivateField, decryptPrivateField } = require('../utils/privateFields');
const { notifyUser } = require('../utils/notifyUser');
const router = express.Router();
router.use(authenticate);
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const transactionId = () => `BK${Array.from({ length: 16 }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join('')}`;
const hashSymbol = (ownerId, symbol) => crypto.createHash('sha256').update(`${ownerId}:${String(symbol).trim().toUpperCase()}`).digest('hex');
const cleanSymbol = (v) => { const s = String(v || '').trim().toUpperCase(); if (!/^[A-Z0-9._-]{1,24}$/.test(s)) throw new Error('Enter a valid DSE stock ticker.'); return s; };
const paisa = (v, label) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0 || Math.abs(Math.round(n * 100) / 100 - n) > 0.000001) throw new Error(`${label} must be greater than zero and have at most two decimal places.`); return Math.round(n * 100); };
const encrypt = (v) => encryptPrivateField(JSON.stringify(v));
const decrypt = (v) => JSON.parse(decryptPrivateField(v));
const publicHolding = (doc) => { const data = decrypt(doc.portfolioEncrypted); return { id: String(doc._id), ...data }; };
const publicFavourite = (doc) => ({ ...decrypt(doc.stockEncrypted), id: String(doc._id) });
const newId = async () => { for (let i = 0; i < 10; i += 1) { const id = transactionId(); if (!(await WalletTransaction.exists({ transactionId: id }))) return id; } throw new Error('Could not generate a unique transaction reference.'); };

router.get('/portfolio', asyncHandler(async (req, res) => {
  const docs = await StockHolding.find({ ownerId: req.user.id }).select('+portfolioEncrypted').sort({ updatedAt: -1 }).lean();
  const holdings = docs.map(publicHolding).filter((h) => Number(h.quantity) > 0);
  const totalInvested = holdings.reduce((s, h) => s + Number(h.totalInvestedPaisa || 0), 0) / 100;
  const totalQuantity = holdings.reduce((s, h) => s + Number(h.quantity || 0), 0);
  res.json({ holdings, totalInvested, totalQuantity });
}));

router.get('/favourites', asyncHandler(async (req, res) => {
  const docs = await StockFavourite.find({ ownerId: req.user.id }).select('+stockEncrypted').sort({ createdAt: -1 }).lean();
  res.json({ favourites: docs.map(publicFavourite) });
}));

router.post('/favourites', asyncHandler(async (req, res) => {
  try {
    const symbol = cleanSymbol(req.body?.symbol);
    const name = String(req.body?.name || symbol).trim().slice(0, 120);
    const symbolHash = hashSymbol(req.user.id, symbol);
    const favourite = await StockFavourite.findOneAndUpdate({ ownerId: req.user.id, symbolHash },
      { $setOnInsert: { ownerId: req.user.id, symbolHash, stockEncrypted: encrypt({ symbol, name }) } }, { upsert: true, new: true });
    res.status(201).json({ favourite: { symbol, name, id: String(favourite._id) } });
  } catch (e) { res.status(400).json({ message: e.message }); }
}));
router.delete('/favourites/:symbol', asyncHandler(async (req, res) => {
  const symbol = cleanSymbol(req.params.symbol);
  await StockFavourite.deleteOne({ ownerId: req.user.id, symbolHash: hashSymbol(req.user.id, symbol) });
  res.json({ message: 'Favourite removed.' });
}));

// Public TradingView scanner data is indicative and may be delayed; it is not a licensed DSE real-time feed.
router.get('/market', asyncHandler(async (req, res) => {
  const search = String(req.query.search || '').trim().toUpperCase().slice(0, 40);
  const url = process.env.DSE_MARKET_API_URL || 'https://scanner.tradingview.com/bangladesh/scan';
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'bAnker/1.0' }, body: JSON.stringify({
    filter: [{ left: 'type', operation: 'in_range', right: ['stock'] }], options: { lang: 'en' }, markets: ['bangladesh'],
    symbols: { query: { types: [] }, tickers: [] }, columns: ['name', 'description', 'close', 'change', 'change_abs', 'volume', 'market_cap_basic', 'sector'],
    sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' }, range: [0, 500]
  }), signal: AbortSignal.timeout(12000) });
  if (!response.ok) return res.status(502).json({ message: 'DSE market data provider is temporarily unavailable.' });
  const payload = await response.json();
  const rows = Array.isArray(payload.data) ? payload.data : [];
  const stocks = rows.map((row) => { const d = row.d || []; return { symbol: String(d[0] || '').toUpperCase(), name: String(d[1] || d[0] || ''), price: Number(d[2] || 0), changePercent: Number(d[3] || 0), change: Number(d[4] || 0), volume: Number(d[5] || 0), marketCap: Number(d[6] || 0), sector: String(d[7] || '') }; })
    .filter((s) => s.symbol && s.price > 0 && (!search || s.symbol.includes(search) || s.name.toUpperCase().includes(search)))
    .slice(0, search ? 80 : 100);
  res.set('Cache-Control', 'private, max-age=30');
  res.json({ stocks, source: 'TradingView Bangladesh market scanner (unofficial indicative data)', delayed: true, timestamp: new Date().toISOString() });
}));

router.post('/buy', asyncHandler(async (req, res) => {
  let symbol, name, quantity, investedPaisa;
  try { symbol = cleanSymbol(req.body?.symbol); name = String(req.body?.name || symbol).trim().slice(0, 120); quantity = Number(req.body?.quantity); if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error('Quantity must be a whole number greater than zero.'); investedPaisa = paisa(req.body?.investedAmount, 'Invested amount'); }
  catch (e) { return res.status(400).json({ message: e.message }); }
  if (investedPaisa > 100000000000) return res.status(400).json({ message: 'Purchase amount exceeds the permitted limit.' });
  const ownerId = new mongoose.Types.ObjectId(req.user.id); const symbolHash = hashSymbol(req.user.id, symbol); const refId = await newId();
  const session = await mongoose.startSession(); let saved;
  try {
    await session.withTransaction(async () => {
      const rows = await WalletTransaction.aggregate([{ $match: { ownerId } }, { $group: { _id: null, balance: { $sum: '$amountPaisa' } } }]).session(session);
      const balance = Number(rows[0]?.balance || 0);
      if (balance < investedPaisa) { const e = new Error(`Insufficient balance. Required ৳${(investedPaisa / 100).toFixed(2)}, available ৳${(balance / 100).toFixed(2)}.`); e.status = 409; throw e; }
      const doc = await StockHolding.findOne({ ownerId, symbolHash }).select('+portfolioEncrypted').session(session);
      const data = doc ? decrypt(doc.portfolioEncrypted) : { symbol, name, quantity: 0, totalInvestedPaisa: 0, purchases: [], sales: [] };
      const unitPrice = investedPaisa / 100 / quantity; const at = new Date();
      data.name = name || data.name; data.quantity += quantity; data.totalInvestedPaisa += investedPaisa;
      if (!Number.isSafeInteger(data.totalInvestedPaisa) || !Number.isSafeInteger(data.quantity)) throw new Error('Portfolio total exceeds the supported accounting limit.');
      data.purchases.unshift({ transactionId: refId, quantity, investedAmount: investedPaisa / 100, unitPrice, occurredAt: at.toISOString() });
      const holding = doc || new StockHolding({ ownerId, symbolHash }); holding.portfolioEncrypted = encrypt(data); await holding.save({ session });
      await WalletTransaction.create([{ ownerId, amountPaisa: -investedPaisa, type: 'stock_debit', description: 'Stock purchase', referenceKey: `stock:buy:${refId}`, transactionId: refId, occurredAt: at }], { session });
      saved = { id: String(holding._id), ...data };
    });
  } finally { await session.endSession(); }
  try { await notifyUser(req.user.id, { type: 'success', title: 'Stock purchase recorded', message: `${quantity} ${symbol} shares purchased for ৳${(investedPaisa / 100).toFixed(2)}. Ref: ${refId}`, relatedId: refId }); } catch (_error) { /* A notification failure must not undo a committed trade. */ }
  res.status(201).json({ message: 'Stock purchase recorded.', holding: saved, transactionId: refId });
}));

router.post('/sell', asyncHandler(async (req, res) => {
  let symbol, quantity, pricePaisa;
  try { symbol = cleanSymbol(req.body?.symbol); quantity = Number(req.body?.quantity); if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error('Quantity must be a whole number greater than zero.'); pricePaisa = paisa(req.body?.sellingPrice, 'Selling price per share'); }
  catch (e) { return res.status(400).json({ message: e.message }); }
  const ownerId = new mongoose.Types.ObjectId(req.user.id); const symbolHash = hashSymbol(req.user.id, symbol); const refId = await newId(); const session = await mongoose.startSession(); let saved; let proceedsPaisa;
  try {
    await session.withTransaction(async () => {
      const holding = await StockHolding.findOne({ ownerId, symbolHash }).select('+portfolioEncrypted').session(session);
      if (!holding) { const e = new Error('Stock holding not found.'); e.status = 404; throw e; }
      const data = decrypt(holding.portfolioEncrypted);
      if (quantity > data.quantity) { const e = new Error(`You currently hold only ${data.quantity} shares.`); e.status = 409; throw e; }
      proceedsPaisa = pricePaisa * quantity; if (!Number.isSafeInteger(proceedsPaisa)) throw new Error('Selling amount is too large.');
      const at = new Date(); const averageCostPaisa = data.quantity ? Math.round(data.totalInvestedPaisa / data.quantity) : 0;
      const costBasisPaisa = quantity === data.quantity ? data.totalInvestedPaisa : averageCostPaisa * quantity;
      data.quantity -= quantity; data.totalInvestedPaisa = Math.max(0, data.totalInvestedPaisa - costBasisPaisa);
      data.sales.unshift({ transactionId: refId, quantity, sellingPrice: pricePaisa / 100, proceeds: proceedsPaisa / 100, costBasis: costBasisPaisa / 100, realizedProfitLoss: (proceedsPaisa - costBasisPaisa) / 100, occurredAt: at.toISOString() });
      holding.portfolioEncrypted = encrypt(data); await holding.save({ session });
      await WalletTransaction.create([{ ownerId, amountPaisa: proceedsPaisa, type: 'stock_credit', description: 'Stock sale', referenceKey: `stock:sell:${refId}`, transactionId: refId, occurredAt: at }], { session });
      saved = { id: String(holding._id), ...data };
    });
  } finally { await session.endSession(); }
  try { await notifyUser(req.user.id, { type: 'success', title: 'Stock sale recorded', message: `${quantity} ${symbol} shares sold. ৳${(proceedsPaisa / 100).toFixed(2)} credited to your balance. Ref: ${refId}`, relatedId: refId }); } catch (_error) { /* A notification failure must not undo a committed trade. */ }
  res.json({ message: 'Stock sale recorded.', holding: saved, transactionId: refId, creditedAmount: proceedsPaisa / 100 });
}));
module.exports = router;
