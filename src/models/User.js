const mongoose = require('mongoose');
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
  phoneEncrypted: { type: String, required: true, select: false },
  phoneLookup: { type: String, required: true, unique: true, index: true, select: false },
  emailEncrypted: { type: String, required: true, select: false },
  emailLookup: { type: String, required: true, unique: true, index: true, select: false },
  pinHash: { type: String, required: true, select: false },
  biometricEnabled: { type: Boolean, default: false },
  notificationsEnabled: { type: Boolean, default: true },
  isActive: { type: Boolean, default: true }
}, { timestamps: true, versionKey: false });
module.exports = mongoose.model('User', userSchema);
