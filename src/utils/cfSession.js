'use strict';

/**
 * CF Clearance session manager.
 * Communicates with a local cf-clearance-scraper instance to obtain
 * cf_clearance cookies + matching User-Agent for sites protected by
 * Cloudflare WAF/Turnstile.
 *
 * Start the scraper with:
 *   cd cf-clearance-scraper && PORT=8191 npm start
 *
 * Configure via .env:
 *   CF_SOLVER_URL=http://localhost:8191/cf-clearance-scraper
 */

const axios = require('axios');
const { createBadGateway } = require('./errors');

const CF_SOLVER_URL = process.env.CF_SOLVER_URL || 'http://localhost:8191/cf-clearance-scraper';
const SESSION_TTL_MS = 25 * 60 * 1000; // 25 minutes (cf_clearance valid ~30 min)

// Per-domain session cache
const _cache = new Map();
const _inflight = new Map();

async function _fetchSession(targetUrl) {
  let res;
  try {
    res = await axios.post(CF_SOLVER_URL, {
      url: targetUrl,
      mode: 'waf-session',
    }, { timeout: 120000 });
  } catch (err) {
    throw createBadGateway(
      `cf-clearance-scraper tidak dapat diakses (${CF_SOLVER_URL}): ${err.message}`,
      'CF_SOLVER_UNREACHABLE'
    );
  }

  const data = res.data;
  if (data.code !== 200) {
    throw createBadGateway(
      `cf-clearance-scraper mengembalikan error: ${data?.message || `code ${data?.code}`}`,
      'CF_SOLVER_ERROR'
    );
  }

  const cookies = data.cookies || [];
  if (!cookies.find((c) => c.name === 'cf_clearance')) {
    throw createBadGateway(
      'cf_clearance cookie tidak ada di response solver',
      'CF_SOLVER_NO_CLEARANCE'
    );
  }

  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const userAgent = data.headers?.['user-agent'] || data.headers?.['User-Agent'] || '';

  return { cookieHeader, userAgent };
}

function getSession(targetUrl, force = false) {
  const domain = new URL(targetUrl).hostname;
  const cached = _cache.get(domain);
  const expired = !cached || (Date.now() - cached.fetchedAt) > SESSION_TTL_MS;

  if (!force && !expired) return Promise.resolve(cached);

  if (_inflight.has(domain)) return _inflight.get(domain);

  const promise = _fetchSession(targetUrl)
    .then((session) => {
      const entry = { ...session, fetchedAt: Date.now() };
      _cache.set(domain, entry);
      _inflight.delete(domain);
      return entry;
    })
    .catch((err) => {
      _inflight.delete(domain);
      throw err;
    });

  _inflight.set(domain, promise);
  return promise;
}

function invalidateSession(targetUrl) {
  const domain = new URL(targetUrl).hostname;
  _cache.delete(domain);
}

module.exports = { getSession, invalidateSession };
