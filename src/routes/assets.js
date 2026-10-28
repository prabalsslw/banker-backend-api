const express = require('express');
const mongoose = require('mongoose');
const authenticate = require('../middleware/authenticate');
const asyncHandler = require('../utils/asyncHandler');
const Saving = require('../models/Saving');
const FiveYearSaving = require('../models/FiveYearSaving');
const FdrAccount = require('../models/FdrAccount');
const DpsAccount = require('../models/DpsAccount');
const WalletTransaction = require('../models/WalletTransaction');
const { decryptNumber } = require('../utils/privateFields');
const { getBalancePaisa } = require('../utils/walletLedger');

const router = express.Router();
router.use(authenticate);
const paisaToMoney = (v) => Number(v || 0) / 100;

router.get('/summary', asyncHandler(async (req, res) => {
  const ownerId = new mongoose.Types.ObjectId(req.user.id);
  const [savings, fiveYear, fdrs, dpsDocs, stockRows, balancePaisa] = await Promise.all([
    Saving.find({ ownerId, status: 'Active' }).select('+amountEncrypted +interestRateEncrypted'),
    FiveYearSaving.find({ ownerId, status: 'Active' }).select('+amountEncrypted +interestRateEncrypted'),
    FdrAccount.find({ ownerId, status: 'Active' }).select('+principalEncrypted +rateEncrypted +tenureEncrypted'),
    DpsAccount.find({ ownerId, status: 'Active' }).select('+monthlyInstallmentEncrypted +monthlyInstallmentPaisa +tenureEncrypted +tenure +interestRateEncrypted +interestRate +schemeNameEncrypted +schemeName'),
    WalletTransaction.find({ ownerId, type: { $in: ['stock_debit', 'stock_credit'] } }).select('amountPaisa type'),
    getBalancePaisa(req.user.id)
  ]);

  const savings3Month = savings.reduce((sum, x) => sum + decryptNumber(x.amountEncrypted), 0);
  const savings5Year = fiveYear.reduce((sum, x) => sum + decryptNumber(x.amountEncrypted), 0);
  const fdrByType = { monthly: 0, quarterly: 0, cumulative: 0 };
  fdrs.forEach((x) => {
    const principal = decryptNumber(x.principalEncrypted);
    const type = x.fdrType || 'Cumulative (Interest at Maturity)';
    if (type === 'Monthly Interest Payout') fdrByType.monthly += principal;
    else if (type === 'Quarterly Interest Payout') fdrByType.quarterly += principal;
    else fdrByType.cumulative += principal;
  });
  const dpsTotal = dpsDocs.reduce((sum, x) => sum + (x.payments || []).reduce((paid, p) => paid + (p.status === 'Paid' ? paisaToMoney(p.depositAmountPaisa ?? p.expectedAmountPaisa) : 0), 0), 0);
  // The ledger is the source of truth for recorded stock purchases/sales. Expenses are intentionally excluded.
  const stockInvested = Math.max(0, stockRows.reduce((sum, x) => sum + (x.type === 'stock_debit' ? Math.abs(Number(x.amountPaisa || 0)) : -Math.abs(Number(x.amountPaisa || 0))), 0) / 100);
  const savingsTotal = savings3Month + savings5Year;
  const fdrTotal = fdrByType.monthly + fdrByType.quarterly + fdrByType.cumulative;
  const currentBalance = paisaToMoney(balancePaisa);
  res.json({
    currentBalance,
    savings: { threeMonth: savings3Month, fiveYear: savings5Year, total: savingsTotal },
    fdr: { monthly: fdrByType.monthly, quarterly: fdrByType.quarterly, cumulative: fdrByType.cumulative, total: fdrTotal },
    dps: { total: dpsTotal },
    stockInvestment: stockInvested,
    grandTotal: currentBalance + savingsTotal + fdrTotal + dpsTotal + stockInvested
  });
}));
module.exports = router;
