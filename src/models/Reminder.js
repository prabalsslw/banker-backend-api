const mongoose = require('mongoose');
const reminderSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 100 },
  description: { type: String, default: '', trim: true, maxlength: 100 },
  scheduledAt: { type: Date, required: true, index: true },
  status: { type: String, enum: ['active', 'completed'], default: 'active', index: true },
  localNotificationId: { type: String, default: null },
  firedAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false });
reminderSchema.index({ ownerId: 1, scheduledAt: 1, status: 1 });
module.exports = mongoose.model('Reminder', reminderSchema);
