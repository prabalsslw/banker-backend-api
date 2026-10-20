# bAnker additive database design: Five-Year Sanchaypatra + parent To-dos

This change is additive. It does not drop, rename, or migrate existing `users`, `savings`, `payments`, or `notifications` collections.

## 1. `savings` collection (existing collection; one optional field added)

Existing records are interpreted as `schemeType: "Sanchaypatra"` when the field is absent. The current 3-monthly workflow keeps the existing API behavior and payment generation.

New field:

```js
schemeType: {
  type: String,
  enum: ['Sanchaypatra', 'Five-Year Bangladesh Sanchaypatra'],
  default: 'Sanchaypatra'
}
```

Five-year records reuse the existing encrypted `savingsIdEncrypted`, `amountEncrypted`, and `interestRateEncrypted` fields. For this scheme only, `interestRateEncrypted` contains the total interest percentage for the full term (e.g. `11.28`), while the quarterly scheme continues to store the expected credited amount per payment in the same existing field. `schemeType` tells the API/frontend which meaning applies.

No `tenure` is required for the five-year scheme, and the backend deliberately does not generate payment documents for it.

The API returns `totalInterest` for five-year records using:

`principal × totalInterestPercentage / 100`

No annual-rate or duration multiplier is used. This is the app calculation from the percentage entered by the user, not an official government payout/tax calculation.

## 2. `todos` collection (new collection)

MongoDB creates this collection automatically when the first to-do is created. Existing collections are untouched.

```js
{
  _id: ObjectId,
  ownerId: ObjectId,           // references users._id
  titleEncrypted: String,      // AES-256-GCM encrypted parent to-do name
  title: String,               // legacy plaintext field for backward compatibility only
  description: String,         // optional, max 1000 characters
  dueDate: Date | null,
  isArchived: Boolean,
  tasks: [
    {
      _id: ObjectId,
      titleEncrypted: String,   // AES-256-GCM encrypted task name
      title: String,            // legacy plaintext field for backward compatibility only
      isCompleted: Boolean,
      dueDate: Date | null,
      completedAt: Date | null,
      createdAt: Date,
      updatedAt: Date
    }
  ],
  createdAt: Date,
  updatedAt: Date
}
```

Indexes: `{ ownerId: 1 }` and `{ ownerId: 1, updatedAt: -1 }`. All routes require a valid JWT and filter by `ownerId`, so users can only access their own records. Subtasks are embedded under their parent to-do; deleting a parent deletes its subtasks automatically.

## 3. API routes

All require `Authorization: Bearer <JWT>`.

### Savings
- `GET /api/savings?schemeType=Sanchaypatra` — existing quarterly savings (also includes legacy records without `schemeType`).
- `GET /api/savings?schemeType=Five-Year%20Bangladesh%20Sanchaypatra` — five-year savings.
- `POST /api/savings` — create a savings record; include `schemeType` and omit `tenure` for five-year records.
- Existing `GET /api/savings/:id/details`, `PATCH /api/savings/:id`, and `DELETE /api/savings/:id` remain in place.

Example five-year body:

```json
{
  "savingsId": "5Y-SP-001",
  "amount": 500000,
  "interestRate": 11.28,
  "issueDate": "2026-10-20",
  "matureDate": "2031-10-20",
  "schemeType": "Five-Year Bangladesh Sanchaypatra",
  "status": "Active"
}
```

### To-do and subtasks
- `GET /api/todos`
- `POST /api/todos` body `{ "title": "Renew passport" }`
- `GET /api/todos/:id`
- `PATCH /api/todos/:id` (title, description, dueDate, isArchived)
- `DELETE /api/todos/:id`
- `POST /api/todos/:id/tasks` body `{ "title": "Collect photo" }`
- `PATCH /api/todos/:id/tasks/:taskId` body `{ "isCompleted": true }`
- `DELETE /api/todos/:id/tasks/:taskId`

## 4. Deploy into the existing Render backend

1. Back up the current GitHub backend repository (or create a release/branch) before editing.
2. Copy the changed backend files from `backend/banker-backend/` into the **root of your existing backend repository**, preserving paths. In particular: `src/models/Saving.js`, `src/routes/savings.js`, `src/models/Todo.js` (new), `src/routes/todos.js` (new), `src/app.js`, and `package.json`.
3. Do not replace Render environment variables. Keep `MONGODB_URI`, `JWT_SECRET`, `PII_ENCRYPTION_KEY`, and `PII_LOOKUP_HMAC_KEY` unchanged.
4. Commit and push to the branch connected to the existing Render service. Render should deploy automatically. Do not create a second Render service unless you intentionally want a separate backend.
5. Check `GET https://banker-backend-api.onrender.com/api/health` and Render logs.
6. Log in to the app again and test: list existing quarterly savings, create one five-year record, create a parent to-do, add a subtask, mark it complete, and delete a test to-do.

No manual MongoDB migration is required. The first successful to-do creation creates the `todos` collection. Existing savings records are retained and treated as quarterly Sanchaypatra.


## Encryption at rest

- Savings ID is stored as `savingsIdEncrypted` with `savingsIdLookup` used only for duplicate checks.
- Principal and interest percentage are stored in encrypted fields (`amountEncrypted`, `interestRateEncrypted`).
- New parent to-do titles and subtask titles are stored in `titleEncrypted`; plaintext titles are decrypted only for authenticated API responses. Descriptions are not encrypted in this iteration.
- Existing legacy to-do titles remain readable; use the optional one-time migration script after backing up MongoDB to encrypt existing titles too.


## 5. Encrypted names and existing records

New savings IDs and interest percentages use the existing encrypted fields and encryption key. New parent to-do names and child task names are stored in `titleEncrypted`; API responses decrypt names only for the authenticated owner. New writes do not persist plaintext titles. Existing older to-dos may still have legacy plaintext `title` fields until the one-time migration is run.

Before migrating old to-do records, back up MongoDB. With the existing `MONGODB_URI` and exact existing `PII_ENCRYPTION_KEY` set in the environment, run from the backend folder:

```bash
CONFIRM_TODO_TITLE_ENCRYPTION_MIGRATION=true npm run migrate:encrypt-todo-titles
```

Do not change or regenerate encryption keys. This migration encrypts legacy parent and child task names without deleting to-dos or subtasks. Descriptions are not encrypted by this change.
