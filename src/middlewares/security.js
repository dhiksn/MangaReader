const cors = require('cors');
const { createBadRequest, createTooManyRequests, createBadGateway } = require('../utils/errors');

/**
 * Configure CORS middleware.
 * Supports CORS_ORIGIN from .env (e.g. 'https://myapp.com' or comma-separated, defaults to '*').
 */
function configureCors() {
  const allowedOrigin = process.env.CORS_ORIGIN || '*';
  return cors({
    origin: (origin, callback) => {
      if (allowedOrigin === '*' || !origin) {
        return callback(null, true);
      }
      const origins = allowedOrigin.split(',').map((o) => o.trim());
      if (origins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Origin tidak diizinkan oleh kebijakan CORS'));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    credentials: true,
    maxAge: 86400,
  });
}

/**
 * Request Timeout Middleware for incoming HTTP requests.
 * Times out if request processing exceeds maxTimeMs (default: 20 seconds).
 */
function requestTimeout(maxTimeMs = 20000) {
  return (req, res, next) => {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        next(createBadGateway('Permintaan melebihi batas waktu (request timeout)', 'REQUEST_TIMEOUT'));
      }
    }, maxTimeMs);

    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));
    next();
  };
}

/**
 * In-Memory Sliding Window Rate Limiter.
 * Protects API against abuse by tracking request counts per IP.
 * Default: 120 requests per minute per IP.
 */
function rateLimiter({ windowMs = 60000, maxRequests = 120 } = {}) {
  const requests = new Map();

  // Periodically clean up expired IP records every 2 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [ip, timestamps] of requests.entries()) {
      const active = timestamps.filter((t) => now - t < windowMs);
      if (active.length === 0) {
        requests.delete(ip);
      } else {
        requests.set(ip, active);
      }
    }
  }, 120000).unref();

  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || '127.0.0.1';
    const now = Date.now();
    const timestamps = requests.get(ip) || [];

    // Filter timestamps within the sliding window
    const recent = timestamps.filter((t) => now - t < windowMs);

    if (recent.length >= maxRequests) {
      return next(
        createTooManyRequests(
          `Terlalu banyak permintaan (maksimal ${maxRequests} req/menit). Silakan coba lagi beberapa saat.`,
          'RATE_LIMITED'
        )
      );
    }

    recent.push(now);
    requests.set(ip, recent);
    next();
  };
}

/**
 * URL Validator & SSRF Protection for Image Proxy.
 * Ensures the target URL uses http/https and blocks private/local IP ranges.
 * Set ALLOW_LOCAL_PROXY=true in .env to allow localhost/private IPs during local testing.
 */
function validateTargetUrl(rawUrl, { allowLocal = process.env.ALLOW_LOCAL_PROXY === 'true' } = {}) {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw createBadRequest('Parameter query "url" wajib diisi', 'INVALID_PARAMETER');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (_) {
    throw createBadRequest('Format URL tidak valid', 'INVALID_URL');
  }

  // Enforce http/https protocol only
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createBadRequest(
      `Protokol '${parsed.protocol}' tidak diizinkan. Hanya http: dan https: yang diperbolehkan`,
      'INVALID_PROTOCOL'
    );
  }

  // If allowLocal is enabled (e.g. for local dev/testing), skip SSRF check
  if (allowLocal) {
    return parsed;
  }

  // SSRF Protection: Block private and local networks
  const hostname = parsed.hostname.toLowerCase();
  const isPrivate =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname === '169.254.169.254' ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal');

  if (isPrivate) {
    throw createBadRequest('Alamat IP atau host lokal tidak diizinkan untuk diakses', 'BLOCKED_HOST');
  }

  return parsed;
}

/**
 * Validate standard query/params for manga routes.
 */
function validatePageParam(rawPage) {
  if (rawPage === undefined || rawPage === null || rawPage === '') {
    return 1;
  }
  const page = parseInt(rawPage, 10);
  if (isNaN(page) || page < 1) {
    throw createBadRequest("Parameter 'page' harus berupa angka positif (minimal 1)", 'INVALID_PARAMETER');
  }
  return page;
}

function validateCategoryParam(rawCategory) {
  if (!rawCategory) return 'all';
  const clean = String(rawCategory).toLowerCase().trim();
  const valid = ['all', 'normal', 'sensitive', 'nsfw'];
  if (!valid.includes(clean)) {
    throw createBadRequest(
      `Kategori '${rawCategory}' tidak valid. Pilihan yang tersedia: ${valid.join(', ')}`,
      'INVALID_PARAMETER'
    );
  }
  return clean;
}

function validateSlugParam(rawSlug) {
  if (!rawSlug || typeof rawSlug !== 'string' || !rawSlug.trim()) {
    throw createBadRequest('Parameter slug manga wajib diisi', 'INVALID_PARAMETER');
  }
  const clean = rawSlug.trim();
  // Ensure safe characters (alphanumeric, hyphens, underscores)
  if (!/^[a-zA-Z0-9_\-]+$/.test(clean)) {
    throw createBadRequest('Slug manga mengandung karakter tidak valid', 'INVALID_PARAMETER');
  }
  return clean;
}

module.exports = {
  configureCors,
  requestTimeout,
  rateLimiter,
  validateTargetUrl,
  validatePageParam,
  validateCategoryParam,
  validateSlugParam,
};
