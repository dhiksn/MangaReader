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
    ...options.headers,
  };

  let response;
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw createBadGateway(
        `Target website gagal diakses (waktu tunggu habis setelah ${timeoutMs / 1000}s)`,
        'UPSTREAM_TIMEOUT'
      );
    }
    throw createBadGateway(
      `Target website gagal diakses: ${err.message || 'Koneksi terputus'}`,
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
