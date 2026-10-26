# bAnker DPS backend and frontend deployment

## What is added
- `DpsAccount` model and `dps_accounts` collection, with embedded monthly installments.
- `WalletTransaction` model and `wallet_transactions` collection for idempotent DPS encashment credits.
- `/api/dps` APIs for create/list/edit, installment updates, and PIN-protected encashment.
- `/api/wallet` read endpoint; Home displays its available balance.
- DPS frontend includes decimal monthly amount (max 2 decimal places), month/year tenure, backend-calculated maturity estimates, payment tracking, edit and encash.

## Interest estimate
Principal = monthly installment × number of monthly installments. Estimate interest uses a recurring-deposit approximation: monthly installment × annual rate / 1200 × n(n+1)/2. The backend is authoritative. Confirm the financial institution's exact DPS method/rate before treating estimates as contractual values.

## Deployment
1. Back up current repo and MongoDB.
2. Merge new files `src/models/DpsAccount.js`, `src/models/WalletTransaction.js`, `src/routes/dps.js`, `src/routes/wallet.js`; replace `src/app.js`, `package.json`, frontend `src/database/bankerdatabase.js`, `src/screens/DpsScreen.js`, and `src/screens/HomeScreen.js`.
3. Keep existing Render secrets and encryption keys unchanged.
4. Push backend files to the connected GitHub branch; Render deploys automatically.
5. In frontend folder run `npm install` and `npx expo start --clear`.
6. Test create DPS, record installment, edit DPS, incorrect PIN rejection, encash once, and verify wallet balance.

No existing collection is dropped. New collections are created on first write. Existing DPS demo data was in-memory and does not migrate automatically.

## Additive updates (wallet ledger, notification preferences, encrypted DPS fields)

- `wallet_transactions.amountPaisa` is signed: credits are positive, debits are negative. Existing `dps_encashment` rows remain valid.
- New collections: `expenses`; the existing `wallet_transactions` collection receives additional transaction types. No existing collection is dropped.
- Notifications are written only when the user's persisted `notificationsEnabled` preference is not false.
- New DPS scheme name, account number, monthly installment, tenure, and interest rate are encrypted at rest. Account number is already encrypted in older records; the migration encrypts legacy plaintext DPS name/installment/tenure/rate.
- Back up MongoDB before running the one-time migration, then use the same existing production encryption keys:
  `CONFIRM_DPS_ENCRYPTION_MIGRATION=true npm run migrate:encrypt-dps-fields`
- Do not rotate `PII_ENCRYPTION_KEY` or `PII_LOOKUP_HMAC_KEY` while existing encrypted data is in use.
