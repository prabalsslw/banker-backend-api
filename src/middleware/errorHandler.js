function notFound(req, res) {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
}

function errorHandler(err, req, res, _next) {
  if (err && err.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0] || 'field';
    return res.status(409).json({ message: `A record with this ${field} already exists.` });
  }

  if (err && err.name === 'ValidationError') {
    return res.status(400).json({ message: 'Validation failed.', details: err.message });
  }

  if (err && err.name === 'CastError') {
    return res.status(400).json({ message: 'Invalid identifier or field value.' });
  }

  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Request body contains invalid JSON.' });
  }

  const status = Number.isInteger(err.status) ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    message: status >= 500 ? 'An unexpected server error occurred.' : err.message
  });
}

module.exports = { notFound, errorHandler };
