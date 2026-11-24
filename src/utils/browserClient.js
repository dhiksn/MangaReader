'use strict';

/**
 * Shared headless browser client using puppeteer-extra + stealth plugin.
 * Maintains a single browser instance (singleton) to avoid startup overhead
 * on each request. The browser is launched lazily on first use and kept alive.
 *
 * CF Turnstile handling: after navigation, we wait for the challenge to
 * auto-resolve. Cloudflare "managed" challenges typically auto-solve within
 * a few seconds in a real Chrome context. The solved cf_clearance cookie is
 * persisted in the browser context so subsequent requests to the same domain
 * skip the challenge entirely.
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createBadGateway } = require('./errors');

puppeteer.use(StealthPlugin());

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--no-zygote',
  '--disable-blink-features=AutomationControlled',
  '--window-size=1280,900',
];

let _browser = null;
let _launching = null;

// ─── Browser lifecycle ────────────────────────────────────────────────────────

async function getBrowser() {
  if (_browser && _browser.connected) return _browser;
  if (_launching) return _launching;

  _launching = puppeteer
    .launch({
      headless: 'new',   // Chrome headless new mode — harder to fingerprint
      args: BROWSER_ARGS,
      ignoreHTTPSErrors: true,
      defaultViewport: { width: 1280, height: 900 },
    })
    .then((b) => {
      _browser = b;
      _launching = null;
      b.on('disconnected', () => { _browser = null; });
      return b;
    })
    .catch((err) => {
      _launching = null;
      throw err;
    });

  return _launching;
}

async function newStealthPage(browser, referer) {
  const page = await browser.newPage();
  await page.setUserAgent(DEFAULT_USER_AGENT);
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    ...(referer ? { Referer: referer } : {}),
  });
  return page;
}

// ─── Cloudflare Turnstile handling ───────────────────────────────────────────

/**
 * Detect if the current page is a CF challenge screen.
 */
async function _isCfChallenge(page) {
  return page.evaluate(() => {
    return !!(
      window._cf_chl_opt ||
      document.querySelector('#cf-challenge-running') ||
      document.querySelector('[id^="cf-chl-widget"]') ||
      document.title.includes('Just a moment') ||
      document.title.includes('Tunggu sebentar') ||
      document.title.toLowerCase().includes('verifikasi')
    );
  });
}

/**
 * Wait for Cloudflare challenge to auto-resolve.
 * CF managed challenges typically solve themselves within 5-15s in real Chrome.
 * We poll every 500ms until the challenge page is gone or timeout.
 *
 * @param {import('puppeteer').Page} page
 * @param {number} [timeoutMs=30000]
 */
async function waitForClearance(page, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const isChallenge = await _isCfChallenge(page).catch(() => false);
    if (!isChallenge) return true;
    await new Promise((r) => setTimeout(r, 600));
  }
  // Last check
  const stillChallenge = await _isCfChallenge(page).catch(() => true);
  return !stillChallenge;
}

/**
 * Navigate to a URL and wait through any CF Turnstile challenge.
 * After clearance, waits for an optional selector.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} url
 * @param {object} opts
 * @param {string} [opts.waitForSelector]
 * @param {number} [opts.timeoutMs=45000]
 */
async function gotoWithClearance(page, url, opts = {}) {
  const { waitForSelector, timeoutMs = 45000 } = opts;

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

  // If CF challenge present, wait for auto-resolve
  const isChallenge = await _isCfChallenge(page).catch(() => false);
  if (isChallenge) {
    const cleared = await waitForClearance(page, 30000);
    if (!cleared) {
      throw createBadGateway(
        'Cloudflare Turnstile challenge tidak dapat diselesaikan secara otomatis.',
        'CF_CHALLENGE_FAILED'
      );
    }
    // After CF clears, it navigates to original URL — wait for it
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
  }

  // Wait for content selector if specified
  if (waitForSelector) {
    await page.waitForSelector(waitForSelector, { timeout: 20000 }).catch(() => null);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Navigate to URL, handle CF challenge, return full page HTML.
 */
async function getPageHtml(url, options = {}) {
  const { referer, waitForSelector, timeoutMs = 45000 } = options;

  let browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    throw createBadGateway(
      `Gagal memulai headless browser: ${err.message || 'unknown error'}`,
      'BROWSER_LAUNCH_ERROR'
    );
  }

  const page = await newStealthPage(browser, referer);
  try {
    await gotoWithClearance(page, url, { waitForSelector, timeoutMs });

    if (typeof options.evaluate === 'function') {
      await options.evaluate(page);
    }

    return await page.content();
  } catch (err) {
    if (err.code) throw err; // already wrapped
    throw createBadGateway(
      `Gagal memuat halaman (${url}): ${err.message || 'unknown error'}`,
      'BROWSER_PAGE_ERROR'
    );
  } finally {
    await page.close().catch(() => null);
  }
}

/**
 * Run an arbitrary async function with a fresh stealth page.
 * Page is pre-navigated if `options.url` is given (with CF clearance).
 */
async function withPage(fn, options = {}) {
  let browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    throw createBadGateway(
      `Gagal memulai headless browser: ${err.message || 'unknown error'}`,
      'BROWSER_LAUNCH_ERROR'
    );
  }

  const page = await newStealthPage(browser, options.referer);
  try {
    if (options.url) {
      await gotoWithClearance(page, options.url, {
        waitForSelector: options.waitForSelector,
        timeoutMs: options.timeoutMs || 45000,
      });
    }
    return await fn(page);
  } finally {
    await page.close().catch(() => null);
  }
}

async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => null);
    _browser = null;
  }
}

module.exports = { getBrowser, getPageHtml, withPage, closeBrowser, waitForClearance, gotoWithClearance };
