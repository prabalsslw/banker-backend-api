require('dotenv').config();
const mongoose = require('mongoose');
const DpsAccount = require('../src/models/DpsAccount');
const { encryptPrivateField, encryptNumber } = require('../src/utils/privateFields');

async function main() {
  if (process.env.CONFIRM_DPS_ENCRYPTION_MIGRATION !== 'true') {
    throw new Error('Set CONFIRM_DPS_ENCRYPTION_MIGRATION=true after taking a MongoDB backup.');
  }
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
  await mongoose.connect(process.env.MONGODB_URI);
  const collection = DpsAccount.collection;
  const cursor = collection.find({ $or: [
    { schemeName: { $exists: true } }, { monthlyInstallmentPaisa: { $exists: true } },
    { tenure: { $exists: true } }, { interestRate: { $exists: true } }
  ] });
  let migrated = 0;
  for await (const doc of cursor) {
    const set = {};
    const unset = {};
    if (!doc.schemeNameEncrypted && doc.schemeName != null) set.schemeNameEncrypted = encryptPrivateField(String(doc.schemeName));
    if (!doc.monthlyInstallmentEncrypted && doc.monthlyInstallmentPaisa != null) set.monthlyInstallmentEncrypted = encryptNumber(Number(doc.monthlyInstallmentPaisa) / 100);
    if (!doc.tenureEncrypted && doc.tenure != null) set.tenureEncrypted = encryptNumber(Number(doc.tenure));
    if (!doc.interestRateEncrypted && doc.interestRate != null) set.interestRateEncrypted = encryptNumber(Number(doc.interestRate));
    for (const key of ['schemeName', 'monthlyInstallmentPaisa', 'tenure', 'interestRate']) if (doc[key] !== undefined) unset[key] = '';
    if (Object.keys(set).length || Object.keys(unset).length) {
      await collection.updateOne({ _id: doc._id }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
      migrated += 1;
    }
  }
  await mongoose.disconnect();
  process.stdout.write(`Encrypted DPS fields for ${migrated} record(s).\n`);
}
main().catch(async (error) => { console.error(error); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
