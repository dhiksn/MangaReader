/**
 * Custom Operational Application Error Class.
 */
class AppError extends Error {
  /**
   * @param {string} message Error message
   * @param {number} statusCode HTTP Status Code (400, 404, 429, 500, 502)
   * @param {string} code Error code string (e.g. 'NOT_FOUND', 'INVALID_PARAMETER')
   */
  constructor(message, statusCode = 500, code = 'INTERNAL_SERVER_ERROR') {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * 400 - Invalid Parameter / Bad Request
 */
function createBadRequest(message = 'Parameter tidak valid', code = 'INVALID_PARAMETER') {
  return new AppError(message, 400, code);
}

/**
 * 404 - Data Tidak Ditemukan / Not Found
 */
function createNotFound(message = 'Data tidak ditemukan', code = 'NOT_FOUND') {
  return new AppError(message, 404, code);
}

/**
 * 429 - Terlalu Banyak Request / Rate Limited
 */
function createTooManyRequests(
  message = 'Terlalu banyak permintaan, silakan coba lagi beberapa saat',
  code = 'TOO_MANY_REQUESTS'
) {
  return new AppError(message, 429, code);
}

/**
 * 502 - Target Website Gagal Diakses / Upstream Bad Gateway
 */
function createBadGateway(message = 'Target website gagal diakses', code = 'UPSTREAM_ERROR') {
  return new AppError(message, 502, code);
}

/**
 * 500 - Server Error / Internal Error
 */
function createInternalError(message = 'Terjadi kesalahan pada server', code = 'INTERNAL_SERVER_ERROR') {
  return new AppError(message, 500, code);
}

module.exports = {
  AppError,
  createBadRequest,
  createNotFound,
  createTooManyRequests,
  createBadGateway,
  createInternalError,
};
