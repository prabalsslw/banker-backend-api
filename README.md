# bAnker Backend API — Encrypted sensitive fields

Node.js + Express + MongoDB Atlas REST API for the bAnker React Native/Expo application. Deployable to Render and usable by Android over HTTPS.

> This is a development starter, not a certified banking system. Do not store real financial-account credentials or sensitive production data before a professional security review, backup/recovery plan, and monitoring are in place.

## Project structure

```text
banker-backend/
├── .env.example
├── .gitignore
├── package.json
├── render.yaml
└── src/
    ├── app.js
    ├── server.js
    ├── config/db.js
    ├── middleware/authenticate.js
    ├── middleware/errorHandler.js
    ├── models/User.js
    ├── models/Saving.js
    ├── models/Payment.js
    ├── models/Notification.js
    ├── routes/auth.js
    ├── routes/profile.js
    ├── routes/savings.js
    ├── routes/payments.js
    ├── routes/notifications.js
    ├── routes/backup.js
    ├── routes/health.js
    └── utils/privateFields.js
```

## What is encrypted at rest

| API field (normal value returned to the app) | MongoDB field | Protection |
|---|---|---|
| `phone` | `phoneEncrypted` | AES-256-GCM ciphertext |
| `email` | `emailEncrypted` | AES-256-GCM ciphertext |
| `savingsId` | `savingsIdEncrypted` | AES-256-GCM ciphertext |
| `amount` on a saving | `amountEncrypted` | AES-256-GCM ciphertext |
| `interestRate` on a saving | `interestRateEncrypted` | AES-256-GCM ciphertext |
| `amount` on a payment | `amountEncrypted` | AES-256-GCM ciphertext |
| `interestAmount` on a payment | `interestAmountEncrypted` | AES-256-GCM ciphertext |
| PIN | `pinHash` | bcrypt hash; cannot be decrypted |
| phone/email/savings ID lookup | `phoneLookup`, `emailLookup`, `savingsIdLookup` | keyed HMAC-SHA-256, not reversible |

The internal MongoDB reference `savingId` on a payment remains an ObjectId so the backend can relate the payment to its saving. It is not the human-facing `savingsId` value. Date, tenure, status, payment number and ownership/reference IDs are not encrypted in this version.

The API keeps the same public field names and types: it accepts normal `savingsId`, numeric `amount`, numeric `interestRate`, and numeric `interestAmount`; it encrypts them before saving and decrypts them in responses. The app does not need to implement encryption/decryption.

AES-GCM uses a random IV for each value. HMAC lookup hashes allow login, duplicate checks, and saving-ID uniqueness checks without storing plaintext values. HMAC keys and encryption keys must be separate.

## 1. Requirements

Install Node.js 20+ and Git. Create accounts at MongoDB Atlas, GitHub, and Render.

## 2. Atlas setup

1. Create an Atlas project and cluster.
2. In Database Access, create a dedicated database user with access limited to `banker_db` where possible.
3. Configure Atlas Network Access for the hosted service according to current Atlas/Render connectivity guidance.
4. Choose Connect → Drivers → Node.js and copy the connection string.
5. Set the database path to `banker_db`. Example template only:

   `mongodb+srv://DB_USER:URL_ENCODED_PASSWORD@YOUR_CLUSTER.mongodb.net/banker_db?retryWrites=true&w=majority`

Never place the Atlas URI in the Expo app or commit it to Git.

## 3. Local setup on Windows

Extract the project and open PowerShell in the `banker-backend` directory:

```powershell
npm install
Copy-Item .env.example .env
```

Generate a JWT secret:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Generate one base64 32-byte key for AES encryption:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Run the second command again to generate a **different** HMAC lookup key. Put the values into `.env`:

- `MONGODB_URI`: your Atlas URI
- `JWT_SECRET`: the generated hex secret
- `PII_ENCRYPTION_KEY`: first generated base64 key
- `PII_LOOKUP_HMAC_KEY`: second generated base64 key
- `PORT=3000`
- `NODE_ENV=development`
- `JWT_EXPIRES_IN=1h`

Do not share or commit `.env`. Back up the encryption and lookup keys securely. Losing the encryption key means the protected data cannot be decrypted; losing the HMAC key means login/duplicate lookup hashes cannot be recomputed. Key rotation requires a planned migration.

Start the API:

```powershell
npm run dev
```

Test `http://localhost:3000/` and `http://localhost:3000/api/health`. The health response should show `status: ok` and `database: connected`.

## 4. Test with Postman

Base URL: `http://localhost:3000`.

### Signup

`POST /api/auth/signup` with raw JSON:

```json
{
  "name": "Test User",
  "phone": "01712345678",
  "email": "test.user@example.com",
  "pin": "1234"
}
```

Use only test credentials. The response returns a JWT and a normal public user object. Phone/email are decrypted in the authorized response; MongoDB stores ciphertext.

### Login

`POST /api/auth/login`:

```json
{
  "phone": "01712345678",
  "pin": "1234"
}
```

For protected requests set `Authorization: Bearer YOUR_TOKEN`.

### Create saving

`POST /api/savings`:

```json
{
  "savingsId": "SAV-0001",
  "amount": 50000,
  "interestRate": 6.5,
  "issueDate": "2026-01-01",
  "matureDate": "2027-01-01",
  "tenure": 12,
  "status": "Active"
}
```

The response shows the normal human-readable values. In Atlas, the stored document should contain `savingsIdEncrypted`, `savingsIdLookup`, `amountEncrypted`, and `interestRateEncrypted`; it should not contain plaintext `savingsId`, `amount`, or `interestRate` fields.

### Create payment

Use the MongoDB `_id` returned for the saving as `savingId` in the payment API. `savingId` here is an internal MongoDB reference, not the human-facing encrypted `savingsId`.

`POST /api/payments`:

```json
{
  "savingId": "REPLACE_WITH_SAVING_OBJECT_ID",
  "paymentNumber": 1,
  "amount": 5000,
  "interestAmount": 250,
  "paymentDate": "2026-11-01",
  "paymentReceivedDate": null,
  "isPaid": false
}
```

The response returns numeric `amount` and `interestAmount`. MongoDB stores `amountEncrypted` and `interestAmountEncrypted` instead.

### Other API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | API/database health |
| POST | `/api/auth/signup` | Register |
| POST | `/api/auth/login` | Login |
| GET | `/api/profile` | Current user's decrypted profile |
| PATCH | `/api/profile` | Update name/email |
| PATCH | `/api/profile/pin` | Change PIN |
| PATCH | `/api/profile/biometric` | Store biometric preference |
| GET | `/api/savings` | List own savings, decrypted |
| GET | `/api/savings/:id` | Read own saving, decrypted |
| POST | `/api/savings` | Create saving, encrypt sensitive fields |
| PATCH | `/api/savings/:id` | Update own saving, encrypt sensitive fields |
| DELETE | `/api/savings/:id` | Delete saving and its payments |
| GET | `/api/payments` | List own payments, decrypted |
| POST | `/api/payments` | Create payment, encrypt amount fields |
| PATCH | `/api/payments/:id` | Update payment, encrypt amount fields |
| DELETE | `/api/payments/:id` | Delete payment |
| GET | `/api/notifications` | List own notifications |
| POST | `/api/notifications` | Create notification |
| PATCH | `/api/notifications/:id/read` | Mark read/unread |
| DELETE | `/api/notifications/:id` | Delete notification |
| GET | `/api/backup/export` | Export current user's records, decrypted for the authorized caller |

## 5. Deploy to Render

1. Create a private GitHub repository and push the project. Confirm `.env` is not committed.
2. Render → New → Web Service → connect the repository.
3. Use Runtime `Node`, Build Command `npm install`, Start Command `npm start`, Health Check Path `/api/health` and Free instance for testing.
4. Add environment variables in Render: `NODE_ENV=production`, `MONGODB_URI`, `JWT_SECRET`, `JWT_EXPIRES_IN=1h`, `PII_ENCRYPTION_KEY`, `PII_LOOKUP_HMAC_KEY`, and `CORS_ORIGINS` as appropriate.
5. Use new production secrets, not the same JWT secret used locally. Protect and back up both PII keys securely.
6. Deploy and open `https://YOUR-SERVICE.onrender.com/api/health`.

Render free services may sleep after inactivity and wake slowly. Do not use free hosting for a production financial service.

## 6. Android/Expo later

The mobile app uses the Render HTTPS URL. It sends ordinary field values and receives ordinary values from the API. The mobile app must never contain `MONGODB_URI`, `JWT_SECRET`, `PII_ENCRYPTION_KEY`, or `PII_LOOKUP_HMAC_KEY`. Store access tokens in secure device storage if persistence is needed; do not store PINs.

## 7. Important migration warning

This encrypted schema is not compatible with existing plaintext records from the previous starter backend. Before deploying it against a database that already has users/savings/payments, take a backup and run a one-time migration that encrypts the old fields and builds the lookup hashes. Do not simply replace the code and assume existing records will work. The project intentionally does not include an automatic destructive migration.

## 8. Security notes

- Encryption at rest does not hide fields from an authorized backend response; the API decrypts them for the authenticated user.
- HTTPS protects data in transit. Avoid logging request bodies or decrypted values.
- Amounts and interest rates are encrypted strings in the database, so MongoDB cannot natively sort, aggregate, or filter by those numeric values. Do such calculations in trusted backend code after decryption, or keep carefully considered non-sensitive derived fields if the product requires database-side analytics.
- All protected queries must scope data by the verified user's `ownerId`.
- Four-digit PINs are weak even when hashed. Add stronger authentication, account-level lockout, monitoring, audit logging, backups and a professional security review before production use.

## Reminders

The authenticated `/api/reminders` endpoints support multiple per-user reminders with a title, optional short description, scheduled date/time, completion state, and device notification identifier. See the project-root `REMINDER_FEATURE_UPDATE.md` for the frontend scheduling and native build requirements.
