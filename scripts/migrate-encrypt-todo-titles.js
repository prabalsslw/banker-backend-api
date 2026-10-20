require('dotenv').config();
const mongoose = require('mongoose');
const Todo = require('../src/models/Todo');
const { encryptPrivateField } = require('../src/utils/privateFields');

async function main() {
  if (process.env.CONFIRM_TODO_TITLE_ENCRYPTION_MIGRATION !== 'true') {
    throw new Error('Set CONFIRM_TODO_TITLE_ENCRYPTION_MIGRATION=true to run this one-time migration. Back up MongoDB first.');
  }
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
  await mongoose.connect(process.env.MONGODB_URI);
  let updated = 0;
  const cursor = Todo.find({}).cursor();
  for await (const todo of cursor) {
    let changed = false;
    if (todo.title && !todo.titleEncrypted) {
      todo.titleEncrypted = encryptPrivateField(todo.title);
      todo.title = undefined;
      changed = true;
    }
    for (const task of todo.tasks || []) {
      if (task.title && !task.titleEncrypted) {
        task.titleEncrypted = encryptPrivateField(task.title);
        task.title = undefined;
        changed = true;
      }
    }
    if (changed) {
      await todo.save();
      updated += 1;
    }
  }
  console.log(`Encrypted parent and subtask titles in ${updated} to-do document(s).`);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error.message || error);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exitCode = 1;
});
