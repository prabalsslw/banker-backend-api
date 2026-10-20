# bAnker backend update: To-do + Five-Year Sanchayapatra

This project preserves the existing authentication, payments, profile, notifications, backup, and 3-monthly Sanchayapatra routes.

## Changes
- Registers `GET/POST/PATCH/DELETE /api/todos` and nested task routes under `/api/todos/:id/tasks`.
- Parent to-do and subtask titles are encrypted at rest using the existing `PII_ENCRYPTION_KEY`; API responses decrypt titles for the authenticated owner.
- Adds optional `schemeType`; existing records without it remain treated as 3-monthly `Sanchayapatra`.
- `Five-Year Bangladesh Sanchayapatra` creates no interval-based payment rows.
- Total interest = principal × entered total-term percentage / 100. The percentage is for the entire term, not annual.
- Savings ID, principal, and percentage remain encrypted; Savings ID uniqueness uses a keyed HMAC lookup hash.

## Deploy safely
1. Back up MongoDB and the backend repository.
2. Merge/push these changes to the same GitHub repository/branch connected to Render.
3. Keep `MONGODB_URI`, `JWT_SECRET`, `PII_ENCRYPTION_KEY`, and `PII_LOOKUP_HMAC_KEY` unchanged.
4. Wait for Render deployment and inspect logs.
5. Test `GET /api/health`, authenticated `GET /api/savings?schemeType=Sanchaypatra`, and authenticated `GET /api/todos`.
6. Test creating a five-year saving and a parent to-do with subtasks; confirm data remains after re-login.

## Existing plaintext to-do titles
New titles are encrypted. Existing records can still be read from legacy plaintext fields. Back up MongoDB first, then optionally run once with the same production environment variables: `CONFIRM_TODO_TITLE_ENCRYPTION_MIGRATION=true npm run migrate:encrypt-todo-titles`. Do not rotate encryption keys.

## API summary
- `GET /api/todos`
- `POST /api/todos` `{ "title": "...", "description": "", "dueDate": null }`
- `GET /api/todos/:id`, `PATCH /api/todos/:id`, `DELETE /api/todos/:id`
- `POST /api/todos/:id/tasks` `{ "title": "...", "dueDate": null }`
- `PATCH /api/todos/:id/tasks/:taskId` `{ "isCompleted": true }`
- `DELETE /api/todos/:id/tasks/:taskId`
- `GET /api/savings?schemeType=Five-Year%20Bangladesh%20Sanchayapatra`
- `POST /api/savings` with `schemeType`, `savingsId`, `amount`, `interestRate` (total-term percentage), `issueDate`, `matureDate`, and `status`.
