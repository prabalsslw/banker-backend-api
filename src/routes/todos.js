const express = require('express');
const Todo = require('../models/Todo');
const authenticate = require('../middleware/authenticate');
const asyncHandler = require('../utils/asyncHandler');
const { isValidObjectId, isNonEmptyString, parseDate } = require('../utils/validators');
const { encryptPrivateField, decryptPrivateField } = require('../utils/privateFields');

const router = express.Router();
router.use(authenticate);

function validateDateField(value, field) {
  if (value === null || value === '') return null;
  const parsed = parseDate(value);
  if (!parsed) throw new Error(`${field} must be a valid date.`);
  return parsed;
}

function decodeTitle(encrypted, legacy) {
  if (encrypted) return decryptPrivateField(encrypted);
  return legacy || '';
}

function cleanTodo(todo) {
  const obj = todo.toObject ? todo.toObject() : todo;
  const { titleEncrypted, title: legacyTitle, ...safeTodo } = obj;
  return {
    ...safeTodo,
    _id: String(obj._id),
    title: decodeTitle(titleEncrypted, legacyTitle),
    // Never return ciphertext or legacy internal storage fields.
    tasks: (obj.tasks || []).map((task) => {
      const { titleEncrypted: taskTitleEncrypted, title: legacyTaskTitle, ...safeTask } = task;
      return {
        ...safeTask,
        _id: String(task._id),
        title: decodeTitle(taskTitleEncrypted, legacyTaskTitle)
      };
    })
  };
}

router.get('/', asyncHandler(async (req, res) => {
  const filter = { ownerId: req.user.id };
  if (req.query.archived === 'true') filter.isArchived = true;
  else if (req.query.archived !== 'all') filter.isArchived = false;
  const todos = await Todo.find(filter).sort({ updatedAt: -1 });
  res.json({ count: todos.length, todos: todos.map(cleanTodo) });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { title, description = '', dueDate = null } = req.body || {};
  if (!isNonEmptyString(title, 160)) return res.status(400).json({ message: 'title is required and must be at most 160 characters.' });
  if (description && (typeof description !== 'string' || description.length > 1000)) return res.status(400).json({ message: 'description must be at most 1000 characters.' });
  let parsedDueDate;
  try { parsedDueDate = validateDateField(dueDate, 'dueDate'); }
  catch (error) { return res.status(400).json({ message: error.message }); }
  const todo = await Todo.create({
    ownerId: req.user.id,
    titleEncrypted: encryptPrivateField(title.trim()),
    description: String(description || '').trim(),
    dueDate: parsedDueDate
  });
  res.status(201).json({ message: 'To-do created.', todo: cleanTodo(todo) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid to-do ID.' });
  const todo = await Todo.findOne({ _id: req.params.id, ownerId: req.user.id });
  if (!todo) return res.status(404).json({ message: 'To-do not found.' });
  res.json({ todo: cleanTodo(todo) });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid to-do ID.' });
  const updates = {};
  const body = req.body || {};
  if (body.title !== undefined) {
    if (!isNonEmptyString(body.title, 160)) return res.status(400).json({ message: 'title is required and must be at most 160 characters.' });
    updates.titleEncrypted = encryptPrivateField(body.title.trim());
    // Remove plaintext from old-format records when title is changed.
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string' || body.description.length > 1000) return res.status(400).json({ message: 'description must be at most 1000 characters.' });
    updates.description = body.description.trim();
  }
  if (body.dueDate !== undefined) {
    try { updates.dueDate = validateDateField(body.dueDate, 'dueDate'); }
    catch (error) { return res.status(400).json({ message: error.message }); }
  }
  if (body.isArchived !== undefined) updates.isArchived = Boolean(body.isArchived);
  if (!Object.keys(updates).length) return res.status(400).json({ message: 'No valid fields supplied.' });
  const updateDoc = { $set: updates };
  if (body.title !== undefined) updateDoc.$unset = { title: 1 };
  const todo = await Todo.findOneAndUpdate({ _id: req.params.id, ownerId: req.user.id }, updateDoc, { new: true, runValidators: true });
  if (!todo) return res.status(404).json({ message: 'To-do not found.' });
  res.json({ message: 'To-do updated.', todo: cleanTodo(todo) });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid to-do ID.' });
  const todo = await Todo.findOneAndDelete({ _id: req.params.id, ownerId: req.user.id });
  if (!todo) return res.status(404).json({ message: 'To-do not found.' });
  res.json({ message: 'To-do and its tasks deleted.' });
}));

router.post('/:id/tasks', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid to-do ID.' });
  const { title, dueDate = null } = req.body || {};
  if (!isNonEmptyString(title, 160)) return res.status(400).json({ message: 'Task title is required and must be at most 160 characters.' });
  let parsedDueDate;
  try { parsedDueDate = validateDateField(dueDate, 'dueDate'); }
  catch (error) { return res.status(400).json({ message: error.message }); }
  const todo = await Todo.findOne({ _id: req.params.id, ownerId: req.user.id });
  if (!todo) return res.status(404).json({ message: 'To-do not found.' });
  todo.tasks.push({ titleEncrypted: encryptPrivateField(title.trim()), dueDate: parsedDueDate });
  await todo.save();
  const clean = cleanTodo(todo);
  res.status(201).json({ message: 'Task added.', todo: clean, task: clean.tasks[clean.tasks.length - 1] });
}));

router.patch('/:id/tasks/:taskId', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id) || !isValidObjectId(req.params.taskId)) return res.status(400).json({ message: 'Invalid to-do or task ID.' });
  const todo = await Todo.findOne({ _id: req.params.id, ownerId: req.user.id });
  if (!todo) return res.status(404).json({ message: 'To-do not found.' });
  const task = todo.tasks.id(req.params.taskId);
  if (!task) return res.status(404).json({ message: 'Task not found.' });
  const body = req.body || {};
  if (body.title !== undefined) {
    if (!isNonEmptyString(body.title, 160)) return res.status(400).json({ message: 'Task title is required and must be at most 160 characters.' });
    task.titleEncrypted = encryptPrivateField(body.title.trim());
    task.title = undefined;
  }
  if (body.isCompleted !== undefined) {
    task.isCompleted = Boolean(body.isCompleted);
    task.completedAt = task.isCompleted ? new Date() : null;
  }
  if (body.dueDate !== undefined) {
    try { task.dueDate = validateDateField(body.dueDate, 'dueDate'); }
    catch (error) { return res.status(400).json({ message: error.message }); }
  }
  await todo.save();
  const clean = cleanTodo(todo);
  res.json({ message: 'Task updated.', todo: clean, task: clean.tasks.find((item) => item._id === req.params.taskId) });
}));

router.delete('/:id/tasks/:taskId', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id) || !isValidObjectId(req.params.taskId)) return res.status(400).json({ message: 'Invalid to-do or task ID.' });
  const todo = await Todo.findOne({ _id: req.params.id, ownerId: req.user.id });
  if (!todo) return res.status(404).json({ message: 'To-do not found.' });
  const task = todo.tasks.id(req.params.taskId);
  if (!task) return res.status(404).json({ message: 'Task not found.' });
  task.deleteOne();
  await todo.save();
  res.json({ message: 'Task deleted.', todo: cleanTodo(todo) });
}));

module.exports = router;
