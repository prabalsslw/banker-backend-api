const mongoose = require('mongoose');

const BD_PHONE = /^01[3-9]\d{8}$/;
const FOUR_DIGIT_PIN = /^\d{4}$/;

function isValidPhone(value) {
  return typeof value === 'string' && BD_PHONE.test(value.trim());
}

function isValidPin(value) {
  return typeof value === 'string' && FOUR_DIGIT_PIN.test(value);
}

function isValidObjectId(value) {
  return mongoose.isValidObjectId(value);
}

function isNonEmptyString(value, max = 200) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
}

function parseDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

module.exports = {
  isValidPhone,
  isValidPin,
  isValidObjectId,
  isNonEmptyString,
  parseDate
};
