const mongoose = require('mongoose');

// New records store task names encrypted. `title` remains optional only to read
// older records created before encryption was introduced.
const subTaskSchema = new mongoose.Schema({
  titleEncrypted: { type: String, required: false },
  title: { type: String, required: false, trim: true, maxlength: 160 }, // legacy plaintext field
  isCompleted: { type: Boolean, default: false },
  dueDate: { type: Date, default: null },
  completedAt: { type: Date, default: null }
}, { timestamps: true });

const todoSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  titleEncrypted: { type: String, required: false },
  title: { type: String, required: false, trim: true, maxlength: 160 }, // legacy plaintext field
  description: { type: String, default: '', trim: true, maxlength: 1000 },
  dueDate: { type: Date, default: null },
  isArchived: { type: Boolean, default: false },
  tasks: { type: [subTaskSchema], default: [] }
}, { timestamps: true, versionKey: false });

todoSchema.index({ ownerId: 1, updatedAt: -1 });
module.exports = mongoose.model('Todo', todoSchema);
