const { getAuthor } = require('../utils/responseHelper');

/**
 * 404 Not Found Middleware for unmatched routes.
 */
function notFoundHandler(req, res, next) {
  let source = req.mangaSource?.name || req.params?.source;
  if (!source && req.originalUrl) {
    const match = req.originalUrl.match(/\/sources\/([^/?#]+)/i);
    if (match) {
      source = match[1].toLowerCase();
    }
  }

  res.status(404).json({
    success: false,
    author: getAuthor(),
    ...(source ? { source } : {}),
    error: {
      code: 'NOT_FOUND',
      message: `Endpoint ${req.method} ${req.originalUrl} tidak ditemukan`,
    },
  });
}

/**
 * Global Centralized Error Handler Middleware.
 * Strictly adheres to the error format:
 * {
 *   "success": false,
 *   "author": "{nama}",
 *   "error": {
 *     "code": "CODE",
 *     "message": "pesan error"
 *   }
 * }
 */
function errorHandler(err, req, res, next) {
  // If response headers are already sent, delegate to default Express handler
  if (res.headersSent) {
    return next(err);
  }

  let statusCode = err.statusCode || err.status || 500;
  let code = err.code || 'INTERNAL_SERVER_ERROR';
  let message = err.message || 'Terjadi kesalahan pada server';

  // Detect network / upstream scraping errors (502 Target website gagal diakses)
  const isUpstreamError =
    err.name === 'TimeoutError' ||
    err.name === 'AbortError' ||
    err.code === 'ECONNREFUSED' ||
    err.code === 'ENOTFOUND' ||
    err.code === 'ETIMEDOUT' ||
    err.code === 'UND_ERR_CONNECT_TIMEOUT' ||
    (typeof message === 'string' &&
      (message.includes('fetch failed') ||
        message.includes('upstream') ||
        message.includes('Target website') ||
        message.includes('Failed to find __NEXT_DATA__')));

  if (isUpstreamError && statusCode === 500) {
    statusCode = 502;
    code = 'UPSTREAM_ERROR';
    if (message.includes('TimeoutError') || message.includes('timed out')) {
      message = 'Target website gagal diakses (waktu tunggu habis)';
    } else {
      message = 'Target website gagal diakses atau sedang mengalami gangguan';
    }
  }

  // Detect 400 errors
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    statusCode = 400;
    code = 'INVALID_PARAMETER';
    message = 'Format JSON dalam request body tidak valid';
  }

  // Ensure status code is valid HTTP number
  if (typeof statusCode !== 'number' || statusCode < 100 || statusCode > 599) {
    statusCode = 500;
  }

  // Map known status codes to default codes if unspecified
  if (code === 'INTERNAL_SERVER_ERROR') {
    if (statusCode === 400) code = 'INVALID_PARAMETER';
    else if (statusCode === 404) code = 'NOT_FOUND';
    else if (statusCode === 429) code = 'TOO_MANY_REQUESTS';
    else if (statusCode === 502) code = 'UPSTREAM_ERROR';
  }

  // Log non-operational (unexpected) server errors
  if (statusCode >= 500) {
    console.error(`[API Error ${statusCode}] [${code}]:`, err.message);
  }

  let source = err.source || req.mangaSource?.name || req.params?.source;
  if (!source && req.originalUrl) {
    const match = req.originalUrl.match(/\/sources\/([^/?#]+)/i);
    if (match) {
      source = match[1].toLowerCase();
    }
  }

  res.status(statusCode).json({
    success: false,
    author: getAuthor(),
    ...(source ? { source } : {}),
    error: {
      code,
      message,
    },
  });
}

module.exports = {
  notFoundHandler,
  errorHandler,
};
