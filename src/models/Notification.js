const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: ['info', 'success', 'warning', 'payment', 'system'],
    default: 'info'
  },
  title: { type: String, required: true, trim: true, maxlength: 150 },
  message: { type: String, required: true, trim: true, maxlength: 2000 },
  relatedId: { type: String, default: null, maxlength: 100 },
  isRead: { type: Boolean, default: false }
}, { timestamps: true, versionKey: false });

notificationSchema.index({ ownerId: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
