const { createBadGateway, createNotFound } = require('./errors');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Fetch helper with standard browser headers, request timeout, and error classification.
 */
async function fetchWithHeaders(url, options = {}) {
  const timeoutMs = options.timeout || 25000;
  const headers = {
    'User-Agent': DEFAULT_USER_AGENT,
    Accept: options.json
      ? 'application/json, text/plain, */*'
      : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache',
    ...options.headers,
  };

  let response;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      break;
    } catch (err) {
      lastErr = err;
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        break;
      }
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
    }
  }

  if (!response) {
    if (lastErr?.name === 'TimeoutError' || lastErr?.name === 'AbortError') {
      throw createBadGateway(
        `Target website gagal diakses (waktu tunggu habis setelah ${timeoutMs / 1000}s)`,
        'UPSTREAM_TIMEOUT'
      );
    }
    throw createBadGateway(
      `Target website gagal diakses: ${lastErr?.message || 'Koneksi terputus'}`,
      'UPSTREAM_ERROR'
    );
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw createNotFound(`Data tidak ditemukan pada target website (${url})`, 'NOT_FOUND');
    }
    throw createBadGateway(
      `Target website mengembalikan status error HTTP ${response.status}`,
      'UPSTREAM_ERROR'
    );
  }

  return response;
}

async function getJson(url, options = {}) {
  const res = await fetchWithHeaders(url, { ...options, json: true });
  return await res.json();
}

async function getHtml(url, options = {}) {
  const res = await fetchWithHeaders(url, { ...options, json: false });
  return await res.text();
}

module.exports = {
  fetchWithHeaders,
  getJson,
  getHtml,
};

// ─── CF-protected fetch ───────────────────────────────────────────────────────

/**
 * Fetch HTML from a Cloudflare-protected page using cf-clearance-scraper.
 * Automatically obtains/reuses cf_clearance cookie + matching User-Agent.
 * On 403, invalidates session and retries once.
 *
 * @param {string} url
 * @param {object} [options]  Same as fetchWithHeaders options
 */
async function getHtmlCf(url, options = {}) {
  const { getSession, invalidateSession } = require('./cfSession');

  let session = await getSession(url);

  const cfHeaders = {
    'User-Agent': session.userAgent,
    Cookie: session.cookieHeader,
    Referer: new URL(url).origin + '/',
    ...options.headers,
  };

  try {
    return await getHtml(url, { ...options, headers: cfHeaders });
  } catch (err) {
    // 403 → session expired, refresh once and retry
    if (err.statusCode === 403) {
      invalidateSession(url);
      session = await getSession(url, true);
      const retryHeaders = {
        'User-Agent': session.userAgent,
        Cookie: session.cookieHeader,
        Referer: new URL(url).origin + '/',
        ...options.headers,
      };
      return await getHtml(url, { ...options, headers: retryHeaders });
    }
    throw err;
  }
}

module.exports.getHtmlCf = getHtmlCf;
