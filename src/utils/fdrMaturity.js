const FdrAccount = require('../models/FdrAccount');
const { decryptNumber, decryptPrivateField } = require('./privateFields');
const { postWalletTransaction } = require('./walletLedger');
const { notifyUser } = require('./notifyUser');

const CUMULATIVE = 'Cumulative (Interest at Maturity)';

/**
 * Credits due cumulative FDRs exactly once using a stable wallet-ledger reference.
 * If ownerId is supplied, only that user's accounts are reconciled; otherwise
 * this processes all users for the server-side scheduled worker.
 */
async function processDueCumulativeFdrs({ ownerId = null } = {}) {
  const filter = {
    status: 'Active',
    fdrType: CUMULATIVE,
    maturityDate: { $lte: new Date() },
  };
  if (ownerId) filter.ownerId = ownerId;
  const due = await FdrAccount.find(filter).select('+bankEncrypted +principalEncrypted +rateEncrypted +tenureEncrypted');
  let processed = 0;
  for (const doc of due) {
    // A conditional status claim prevents overlapping timer/HTTP runs from
    // processing the same account concurrently.
    const claimed = await FdrAccount.findOneAndUpdate(
      { _id: doc._id, ownerId: doc.ownerId, status: 'Active', fdrType: CUMULATIVE, maturityDate: { $lte: new Date() } },
      { $set: { status: 'Matured' } },
      { new: false }
    );
    if (!claimed) continue;
    try {
      const principal = decryptNumber(doc.principalEncrypted);
      const rate = decryptNumber(doc.rateEncrypted);
      const tenure = decryptNumber(doc.tenureEncrypted);
      const principalPaisa = Math.round(principal * 100);
      const years = Math.max(0, (new Date(doc.maturityDate) - new Date(doc.startDate)) / (365.2425 * 86400000));
      const interestPaisa = Math.round(principal * rate / 100 * years * 100);
      const creditPaisa = principalPaisa + interestPaisa;
      const bank = decryptPrivateField(doc.bankEncrypted);
      await postWalletTransaction({
        ownerId: doc.ownerId,
        amountPaisa: creditPaisa,
        type: 'fdr_maturity',
        description: `FDR maturity: ${bank}`,
        referenceKey: `fdr:${doc._id}:maturity`,
        allowNegative: true,
        occurredAt: doc.maturityDate,
      });
      await notifyUser(doc.ownerId, {
        type: 'success',
        title: 'Cumulative FDR matured',
        message: `${bank} cumulative FDR matured. ৳${(creditPaisa / 100).toFixed(2)} (principal plus interest) was credited to your available balance. The FDR is now read-only.`,
        relatedId: String(doc._id),
      });
      processed += 1;
    } catch (error) {
      // Restore Active only if ledger posting failed, allowing a later retry.
      await FdrAccount.updateOne({ _id: doc._id, ownerId: doc.ownerId, status: 'Matured' }, { $set: { status: 'Active' } });
      throw error;
    }
  }
  return processed;
}

module.exports = { processDueCumulativeFdrs };
