const crypto = require('crypto');

function getKey(envName) {
  const value = process.env[envName];
  if (!value) throw new Error(`${envName} is not configured.`);
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error(`${envName} must be a base64-encoded 32-byte key.`);
  return key;
}

function encryptPrivateField(value, envName = 'PII_ENCRYPTION_KEY') {
  if (typeof value !== 'string') throw new TypeError('Encrypted value must be a string.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(envName), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decryptPrivateField(payload, envName = 'PII_ENCRYPTION_KEY') {
  if (typeof payload !== 'string') throw new TypeError('Encrypted value is missing.');
  const [version, iv64, tag64, ciphertext64] = payload.split(':');
  if (version !== 'v1' || !iv64 || !tag64 || ciphertext64 === undefined) {
    throw new Error('Encrypted value has an unsupported format.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(envName), Buffer.from(iv64, 'base64'));
  decipher.setAuthTag(Buffer.from(tag64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext64, 'base64')), decipher.final()]).toString('utf8');
}

function normalizePhone(value) { return String(value || '').trim(); }
function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function normalizeSavingsId(value) { return String(value || '').trim(); }
function normalizeNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError('Value must be a finite number.');
  // Avoid storing insignificant floating-point formatting differences.
  return n.toString();
}

function lookupHash(value, kind) {
  const normalized = kind === 'email' ? normalizeEmail(value)
    : kind === 'savingsId' ? normalizeSavingsId(value)
    : normalizePhone(value);
  return crypto.createHmac('sha256', getKey('PII_LOOKUP_HMAC_KEY'))
    .update(`${kind}:${normalized}`, 'utf8').digest('hex');
}

function encryptNumber(value, envName = 'PII_ENCRYPTION_KEY') {
  return encryptPrivateField(normalizeNumber(value), envName);
}
function decryptNumber(payload, envName = 'PII_ENCRYPTION_KEY') {
  const value = Number(decryptPrivateField(payload, envName));
  if (!Number.isFinite(value)) throw new Error('Decrypted numeric value is invalid.');
  return value;
}

module.exports = {
  encryptPrivateField, decryptPrivateField, encryptNumber, decryptNumber,
  normalizePhone, normalizeEmail, normalizeSavingsId, lookupHash
};
