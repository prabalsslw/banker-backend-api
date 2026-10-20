# Additive backend patch: five-year interest and encrypted to-do names

This patch is designed to merge into the existing bAnker backend repository, not replace the whole repository.

## Files to merge
Copy `src/models/Saving.js`, `src/models/Todo.js`, `src/routes/savings.js`, `src/routes/todos.js`, `scripts/migrate-encrypt-todo-titles.js`, and merge the `migrate:encrypt-todo-titles` script into your existing `package.json`. Keep your current auth, payments, user, notification, middleware, and server files. Confirm `src/app.js` already mounts `app.use('/api/todos', require('./routes/todos'));`.

## Important behavior
- Five-year total interest = principal × entered total interest percentage / 100. No annual or date-duration multiplier.
- Savings ID, amount and percentage remain encrypted using existing encrypted fields.
- New parent to-do and subtask titles are encrypted using the existing `PII_ENCRYPTION_KEY`; API responses decrypt them for the authenticated owner.
- Existing old to-do title fields can still be read. Back up MongoDB, then optionally migrate existing plaintext names with the command below.

## Deploy
1. Back up MongoDB and create a Git branch.
2. Merge the files above into the existing backend repo. Do not replace `.env` or Render environment values.
3. Commit and push to the Render-connected branch.
4. Wait for Render deployment, inspect logs, and test `GET /api/health`, savings list/create, to-do create/list, task create/complete.
5. If migrating old to-do titles, run from the backend root with the same `MONGODB_URI` and existing `PII_ENCRYPTION_KEY` after backup:
   `CONFIRM_TODO_TITLE_ENCRYPTION_MIGRATION=true npm run migrate:encrypt-todo-titles`

Never generate a new encryption key for this patch. The migration does not encrypt the optional description field.
