const jwt = require('jsonwebtoken');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');

module.exports = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ message: 'Authentication token is required.' });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (_error) {
    return res.status(401).json({ message: 'Token is invalid or expired. Please log in again.' });
  }

  if (!payload.sub) {
    return res.status(401).json({ message: 'Invalid authentication token.' });
  }

  const user = await User.findById(payload.sub).select('_id isActive');
  if (!user || !user.isActive) {
    return res.status(401).json({ message: 'User account is unavailable.' });
  }

  req.user = { id: user._id.toString() };
  next();
});
