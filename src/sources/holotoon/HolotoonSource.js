const crypto = require('crypto');
const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

// Holotoon blocks Chrome UA on reader pages — use Firefox UA
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0';

class HolotoonSource extends BaseSource {
  constructor() {
    super('holotoon', 'Holotoon');
    this.baseUrl = 'https://holodek.run';
    this.icon = 'https://holodek.run/icons/icon-144x144.png';

    // Auth session cache
    this._authCookies = null;
    this._authExpiresAt = 0;

    // Age consent cookie cache
    this._ageCookie = null;
    this._ageCookieExpiresAt = 0;

    // Reader pass token cache
    this._passToken = null;

    // Genres cache
    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  getSupportedSorts() {
    return [
      { id: 'latest', name: 'Terbaru' },
      { id: 'popular', name: 'Populer' },
      { id: 'rating', name: 'Rating' },
      { id: 'az', name: 'A-Z' },
    ];
  }

  // ─── Authentication ─────────────────────────────────────────────────────────

  async login() {
    // 1. Direct session cookie from .env
    const envCookie = process.env.HOLOTOON_COOKIE || process.env.HOLOTOON_SESSION_TOKEN;
    if (envCookie && envCookie.trim()) {
      let cookieVal = envCookie.trim();
      if (!cookieVal.includes('=')) {
        cookieVal = `__Secure-better-auth.session_token=${cookieVal}; better-auth.session_token=${cookieVal}`;
      }
      this._authCookies = cookieVal;
      this._authExpiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 hari
      console.log('[Holotoon] Menggunakan session cookie dari .env');
      return this._authCookies;
    }

    const emailOrUser = process.env.HOLOTOON_EMAIL || process.env.HOLOTOON_USERNAME;
    const password = process.env.HOLOTOON_PASSWORD;

    if (!emailOrUser || !password) {
      return null;
    }

    const isEmail = emailOrUser.includes('@');
    const endpoint = isEmail ? '/api/auth/sign-in/email' : '/api/auth/sign-in/username';
    const payload = isEmail
      ? { email: emailOrUser.trim().toLowerCase(), password, rememberMe: true }
      : { username: emailOrUser.trim().toLowerCase(), password, rememberMe: true };

    try {
      const res = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Referer: `${this.baseUrl}/`,
          Origin: this.baseUrl,
          'User-Agent': FIREFOX_UA,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || data.error) {
        if (data.code === 'turnstile_missing_token' || data.code === 'turnstile_rejected') {
          console.warn('[Holotoon] Login otomatis dicegat oleh Cloudflare Turnstile. Silakan login sekali di browser (https://holodek.run), lalu salin cookie "better-auth.session_token" ke HOLOTOON_COOKIE di file .env.');
        } else {
          console.warn('[Holotoon Login Gagal]:', data.error || data.message || `HTTP ${res.status}`);
        }
        return null;
      }

      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      const cookies = setCookies.map((c) => c.split(';')[0].trim()).join('; ');
      if (cookies) {
        this._authCookies = cookies;
        this._authExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
        console.log('[Holotoon] Login berhasil sebagai:', emailOrUser);
        return this._authCookies;
      }
    } catch (err) {
      console.warn('[Holotoon Login Exception]:', err.message);
    }
    return null;
  }

  async _ensureAuth() {
    if (!this._authCookies || Date.now() > this._authExpiresAt) {
      await this.login();
    }
    return this._authCookies;
  }

  // ─── PoW & Guard Helpers ───────────────────────────────────────────────────

  _solvePoWChallenge(seed, difficulty, maxIterations = 4000000) {
    const requiredZeroBytes = Math.floor(difficulty / 8);
    const remainingBits = difficulty % 8;
    const mask = remainingBits > 0 ? (0xFF << (8 - remainingBits)) & 0xFF : 0;

    for (let n = 0; n < maxIterations; n++) {
      const hash = crypto.createHash('sha256').update(seed + n).digest();
      let valid = true;
      for (let j = 0; j < requiredZeroBytes; j++) {
        if (hash[j] !== 0) {
          valid = false;
          break;
        }
      }
      if (valid && remainingBits > 0) {
        if ((hash[requiredZeroBytes] & mask) !== 0) valid = false;
      }
      if (valid) return String(n);
    }
    throw new Error(`PoW challenge solve timeout for difficulty ${difficulty}`);
  }

  async _ensureAgeConsent(targetUrl) {
    if (this._ageCookie && Date.now() < this._ageCookieExpiresAt) {
      return this._ageCookie;
    }

    try {
      const form = new URLSearchParams();
      form.append('redirect', targetUrl || '/');
      const res = await fetch(`${this.baseUrl}/api/age-consent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: targetUrl || `${this.baseUrl}/`,
          Origin: this.baseUrl,
          'User-Agent': FIREFOX_UA,
        },
        body: form.toString(),
        redirect: 'manual',
      });

      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      const ageCookie = setCookies.find((c) => c.includes('holo_age_ok'));
      if (ageCookie) {
        this._ageCookie = ageCookie.split(';')[0].trim();
        this._ageCookieExpiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 jam
      }
    } catch (err) {
      console.warn('[Holotoon AgeConsent Error]:', err.message);
    }
    return this._ageCookie;
  }

  async _buildCookies(extraCookies = []) {
    const cookies = [];
    const auth = await this._ensureAuth();
    if (auth) cookies.push(auth);
    if (this._ageCookie) cookies.push(this._ageCookie);
    for (const c of extraCookies) {
      if (c && !cookies.includes(c)) cookies.push(c);
    }
    return cookies.join('; ');
  }

  /**
   * Fetch URL with automatic Reader-Guard PoW solver and Age-Gate handling.
   */
  async _fetchWithGuard(url, options = {}) {
    await this._ensureAgeConsent(url);

    let cookieHeader = await this._buildCookies();
    const headers = {
      'User-Agent': FIREFOX_UA,
      Referer: options.referer || `${this.baseUrl}/`,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...options.headers,
    };
    if (cookieHeader) headers['Cookie'] = cookieHeader;

    let res = await fetch(url, { headers });
    let html = await res.text();

    // 1. Check for Reader-Guard ("Memverifikasi browser")
    if (html.includes('/api/reader-guard/release')) {
      try {
        const guardGet = await fetch(`${this.baseUrl}/api/reader-guard/release`, {
          headers: {
            Referer: url,
            Origin: this.baseUrl,
            'User-Agent': FIREFOX_UA,
            Cookie: cookieHeader,
          },
        });
        const guardData = await guardGet.json();
        if (guardData && guardData.challenge) {
          const nonce = this._solvePoWChallenge(guardData.challenge.seed, guardData.challenge.difficulty);
          await fetch(`${this.baseUrl}/api/reader-guard/release`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Referer: url,
              Origin: this.baseUrl,
              'User-Agent': FIREFOX_UA,
              Cookie: cookieHeader,
            },
            body: JSON.stringify({ challenge: guardData.challenge, nonce }),
          });
        }
        // Refetch after release
        res = await fetch(url, { headers });
        html = await res.text();
      } catch (err) {
        console.warn('[Holotoon ReaderGuard Solve Error]:', err.message);
      }
    }

    // 2. Check for Age-Consent ("Konten 18+")
    if (html.includes('Konten 18+') && html.includes('/api/age-consent')) {
      await this._ensureAgeConsent(url);
      cookieHeader = await this._buildCookies();
      if (cookieHeader) headers['Cookie'] = cookieHeader;
      res = await fetch(url, { headers });
      html = await res.text();
    }

    return html;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  _slugFromComicUrl(href) {
    if (!href) return null;
    const match = href.match(/\/comic\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  _resolveSort(raw) {
    const map = {
      latest: 'latest', update: 'latest', newest: 'latest',
      popular: 'popular', popularity: 'popular',
      rating: 'rating',
      az: 'az', title: 'az', alphabetical: 'az',
    };
    return map[String(raw || '').toLowerCase()] || 'latest';
  }

  /** Decode Base64 synopsis. */
  _decodeBase64(encoded) {
    if (!encoded) return null;
    try {
      const padded = encoded.trim().replace(/-/g, '+').replace(/_/g, '/');
      const rem = padded.length % 4;
      const p = rem ? padded + '='.repeat(4 - rem) : padded;
      return Buffer.from(p, 'base64').toString('utf-8').trim() || null;
    } catch {
      return null;
    }
  }

  /** Parse manga cards from browse/search page. */
  _parseCardList($) {
    const items = [];
    const seen = new Set();

    let elements = $('#browse-grid-view a[href^="/comic/"], #browse-list-view a[href^="/comic/"]');
    if (elements.length === 0) {
      elements = $('a[href^="/comic/"]').filter((_, el) => {
        const rel = $(el).attr('rel') || '';
        const tab = $(el).attr('tabindex') || '';
        const href = $(el).attr('href') || '';
        return !rel.includes('nofollow') && tab !== '-1' && !href.includes('honeypot');
      });
    }

    elements.each((_, el) => {
      const href = $(el).attr('href') || '';
      const slug = this._slugFromComicUrl(href);
      if (!slug || slug.includes('honeypot') || seen.has(slug)) return;
      seen.add(slug);

      const title = $(el).find('h3').first().text().trim() || $(el).text().trim();
      if (!title) return;

      const imgEl = $(el).find('img').first();
      const dataSrc = imgEl.attr('data-src') || imgEl.attr('data-lazy-src');
      const src = imgEl.attr('src');
      let finalCover = null;
      if (dataSrc && !dataSrc.startsWith('data:') && !dataSrc.includes('placeholder')) {
        finalCover = dataSrc;
      } else if (src && !src.startsWith('data:') && !src.includes('placeholder')) {
        finalCover = src;
      }

      const type = $(el).find('span.top-2.left-2, span.absolute').first().text().trim().toLowerCase() || null;
      const status = $(el).find('span.top-2.right-2').text().trim().toLowerCase() ||
        $(el).find('span').map((_, s) => $(s).text().trim().toLowerCase()).get().find((s) => ['ongoing','completed','hiatus','dropped'].includes(s)) || null;

      const latestChapter = $(el).find('div.flex span.text-primary-400, span:contains("Chapter")').first().text().trim() || null;
      const date = $(el).find('div.flex span.text-surface-500').last().text().trim() || null;

      items.push({ title, slug, cover: finalCover, type, status, latestChapter, date });
    });

    return items;
  }

  /** Parse pagination — Holotoon only has next/prev, no numbered links. */
  _parsePagination($, currentPage) {
    const hasNextPage = $('a[href*="page="]:contains("Selanjutnya"), a[href*="page="]:contains("Next")').length > 0;
    // Try to get maxPage from numbered links if any
    let maxPage = null;
    $('a[href*="page="]').each((_, el) => {
      const m = ($(el).attr('href') || '').match(/page=(\d+)/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!isNaN(n) && (maxPage === null || n > maxPage)) maxPage = n;
      }
    });
    return { hasNextPage, maxPage };
  }

  async _fetchListing(url, pageNum) {
    const html = await this._fetchWithGuard(url, { referer: `${this.baseUrl}/` });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { hasNextPage, maxPage } = this._parsePagination($, pageNum);
    return { data, hasNextPage, maxPage };
  }

  // ─── Public endpoints ────────────────────────────────────────────────────────

  async getLatest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/browse?q=&sort=latest&media=comic&page=${pageNum}`;
    const { data, hasNextPage, maxPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getPopular(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/browse?sort=popular&media=comic&page=${pageNum}`;
    const { data, hasNextPage, maxPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getRating(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/browse?q=&sort=rating&media=comic&page=${pageNum}`;
    const { data, hasNextPage, maxPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getAz(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/browse?sort=az&media=comic&page=${pageNum}`;
    const { data, hasNextPage, maxPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const sort = this._resolveSort(options.sort || options.order || 'latest');
    const params = new URLSearchParams({ sort, page: pageNum });
    if (options.status) params.set('status', String(options.status).toLowerCase());
    if (options.genre) params.set('genre', String(options.genre).toLowerCase());
    if (options.q || options.query) params.set('q', options.q || options.query);
    const url = `${this.baseUrl}/browse?${params.toString()}`;
    const { data, hasNextPage, maxPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async search(query, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/browse?sort=latest&media=comic&q=${encodeURIComponent(String(query || '').trim())}&page=${pageNum}`;
    const html = await this._fetchWithGuard(url, { referer: `${this.baseUrl}/` });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { hasNextPage, maxPage } = this._parsePagination($, pageNum);
    return { source: this.name, query: String(query || '').trim(), page: pageNum, maxPage, hasNextPage, data };
  }

  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) {
      return this._cachedGenres;
    }

    const html = await this._fetchWithGuard(`${this.baseUrl}/browse`, { referer: `${this.baseUrl}/` });
    const $ = cheerio.load(html);
    const genres = [];
    const seen = new Set();

    $('select[name="genre"] option').each((_, el) => {
      const slug = $(el).val()?.trim();
      if (!slug) return;
      if (seen.has(slug)) return;
      seen.add(slug);
      const name = $(el).text().trim();
      if (!name) return;
      genres.push({ name, slug, id: slug });
    });

    genres.sort((a, b) => a.name.localeCompare(b.name, 'id'));
    this._cachedGenres = genres;
    this._cachedGenresExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
    return genres;
  }

  async getByGenre(genre, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanGenre = String(genre || '').trim().toLowerCase();
    if (!cleanGenre) throw createBadRequest("Parameter 'genre' wajib diisi", 'INVALID_PARAMETER');

    const sort = this._resolveSort(options.sort || options.order || 'latest');
    const genres = await this.getGenres();

    // Support comma-separated — Holotoon only supports single genre per request
    const key = cleanGenre.split(',')[0].trim();
    const found = genres.find((g) => g.slug === key || g.name.toLowerCase() === key);
    if (!found) throw createNotFound(`Genre '${genre}' tidak ditemukan di Holotoon`, 'NOT_FOUND');

    const url = `${this.baseUrl}/browse?sort=${sort}&genre=${found.slug}&media=comic&page=${pageNum}`;
    const html = await this._fetchWithGuard(url, { referer: `${this.baseUrl}/` });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { hasNextPage, maxPage } = this._parsePagination($, pageNum);

    return { source: this.name, genre: found.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getByType(type, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanType = String(type || '').trim().toLowerCase();
    if (!cleanType) throw createBadRequest("Parameter 'type' wajib diisi", 'INVALID_PARAMETER');
    const sort = this._resolveSort(options.sort || options.order || 'latest');
    const url = `${this.baseUrl}/browse?q=&sort=${sort}&media=comic&type=${encodeURIComponent(cleanType)}&status=&genre=&nsfw=&team=&page=${pageNum}`;
    const { data, hasNextPage, maxPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, type: cleanType, page: pageNum, maxPage, hasNextPage, data };
  }

  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    const url = `${this.baseUrl}/comic/${cleanSlug}`;
    let html;
    try {
      html = await this._fetchWithGuard(url, { referer: `${this.baseUrl}/` });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di Holotoon`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    // Clean out honeypot elements
    $('[style*="display:none"], [style*="top:-9999px"], [style*="clip:"], [class*="honeypot"], a[href*="honeypot"]').remove();

    const title = $('h1').first().text().trim() || cleanSlug;

    // Cover
    let cover = null;
    const coverCandidates = $('img[src*="/covers/"], img[data-src*="/covers/"], div[class*="aspect-"] img, main img, article img');
    coverCandidates.each((_, el) => {
      if (cover) return;
      const src = $(el).attr('data-src') || $(el).attr('src') || '';
      const fullSrc = src.startsWith('http') ? src : (src ? `${this.baseUrl}${src}` : '');
      if (fullSrc && !fullSrc.includes('site-logo') && !fullSrc.includes('placeholder') && !fullSrc.includes('reactions') && !fullSrc.includes('avatars')) {
        cover = fullSrc;
      }
    });
    if (!cover) {
      const og = $('meta[property="og:image"]').attr('content');
      if (og && !og.includes('site-logo') && !og.includes('placeholder')) {
        cover = og.startsWith('http') ? og : `${this.baseUrl}${og}`;
      }
    }

    // Synopsis — Base64 in data-sr attribute
    const dataSr = $('[data-sr]').attr('data-sr');
    const synopsis = this._decodeBase64(dataSr) ||
                     $('div.prose').text().trim() ||
                     $('meta[name="description"]').attr('content') ||
                     null;

    // Status
    let status = null;
    $('span.capitalize, span[class*=status]').each((_, el) => {
      const t = $(el).text().trim().toLowerCase();
      if (['ongoing', 'completed', 'hiatus', 'dropped'].includes(t)) {
        status = t === 'dropped' ? 'abandoned' : t;
      }
    });

    // Rating
    const ratingRaw = $('span.text-yellow-400').first().text().trim();
    const rating = ratingRaw && !isNaN(parseFloat(ratingRaw)) ? parseFloat(ratingRaw) : null;

    // Genres
    const genres = [];
    const seenGenres = new Set();
    $('a[href*="genre="]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/genre=([^&]+)/);
      const genreSlug = m ? decodeURIComponent(m[1]) : null;
      const name = $(el).text().trim();
      if (!name || !genreSlug || seenGenres.has(genreSlug)) return;
      seenGenres.add(genreSlug);
      genres.push({ name, slug: genreSlug });
    });

    // Author & Artist
    let author = null;
    $('span, div, p').each((_, el) => {
      if (author) return;
      const t = $(el).text().trim();
      if (/^(?:Author|Penulis):/i.test(t)) {
        const clean = t.replace(/^(?:Author|Penulis):\s*/i, '').trim();
        const firstPart = clean.split(/(?:Artist|Year|Views|Uploaded by):/i)[0]?.trim();
        if (firstPart && !firstPart.includes('\n') && firstPart.length < 50) {
          author = firstPart;
        }
      }
    });
    if (author) {
      author = author.replace(/^(?:Author|Penulis):\s*/i, '').trim();
    }

    // Year
    let year = null;
    $('span, div').each((_, el) => {
      if (year) return;
      const t = $(el).text().trim();
      if (/^Year:/i.test(t)) {
        const m = t.match(/\b(19\d\d|20\d\d)\b/);
        if (m) year = m[1];
      }
    });

    // Chapters
    const chapters = [];
    const seenHrefs = new Set();

    $(`a[href*="/read/${cleanSlug}/"]`).each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!href || seenHrefs.has(href)) return;
      if ($(el).text().trim() === 'Start Reading') return; // skip start reading button
      seenHrefs.add(href);

      const chLabel = $(el).find('div').first().find('span').first().text().trim() ||
                      $(el).find('span.font-semibold, span[class*=font-weight]').first().text().trim() ||
                      $(el).text().trim().split('\n')[0].trim();
      const date = $(el).find('span.min-w-0.break-words, span[class*=x2a5d3a]').last().text().trim() ||
                   $(el).find('span[style*="tabular-nums"]').last().text().trim() || null;

      chapters.push({
        title: chLabel,
        slug: `${this.baseUrl}${href}`,
        endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(`${this.baseUrl}${href}`)}`,
        date: date && !/^\d+$/.test(date) ? date : null,
      });
    });

    // Fallback if none found with cleanSlug
    if (chapters.length === 0) {
      $('a[href^="/read/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (!href || seenHrefs.has(href) || $(el).text().trim() === 'Start Reading') return;
        seenHrefs.add(href);

        const chLabel = $(el).find('span.font-semibold').text().trim() || $(el).text().trim();
        const date = $(el).find('span[class*=tabular]').last().text().trim() || null;
        chapters.push({
          title: chLabel,
          slug: `${this.baseUrl}${href}`,
          endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(`${this.baseUrl}${href}`)}`,
          date,
        });
      });
    }

    // Sort chapters by chapter number descending (newest first)
    chapters.sort((a, b) => {
      const numA = parseFloat((a.slug.match(/chapter-([0-9.]+)/) || [])[1] || '0');
      const numB = parseFloat((b.slug.match(/chapter-([0-9.]+)/) || [])[1] || '0');
      return numB - numA;
    });

    return {
      source: this.name,
      title,
      cover,
      synopsis,
      status,
      author: author || null,
      year: year || null,
      rating,
      genres,
      totalChapters: chapters.length,
      chapters,
    };
  }

  async getPages(slug, chapter) {
    const rawSlug = String(slug || '').trim();
    if (!rawSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    const chapterUrl = rawSlug.startsWith('http') ? rawSlug
      : `${this.baseUrl}/read/${rawSlug}/chapter-${String(chapter || '').replace(/^chapter-?/i, '')}`;

    let html;
    try {
      html = await this._fetchWithGuard(chapterUrl, { referer: `${this.baseUrl}/` });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Chapter tidak ditemukan di Holotoon`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);
    const pages = [];
    const seenUrls = new Set();
    const SKIP_PATTERNS = ['/chapter-header/', '/chapter-footer/', '/covers/', '/reactions/', '/avatars/', '/shop/', '/site-logo/'];

    // 1. Try to extract chapterId for encrypted/protected token loader
    const chapterIdMatch = html.match(/data-chapter-id="([^"]+)"/);
    const chapterId = chapterIdMatch ? chapterIdMatch[1] : null;

    if (chapterId) {
      try {
        const cookieHeader = await this._buildCookies();
        const reqBody = { chapterId };
        if (this._passToken) {
          reqBody.passToken = this._passToken;
        }

        const tokReq = await fetch(`${this.baseUrl}/api/reader/page-tokens`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Referer: chapterUrl,
            Origin: this.baseUrl,
            'User-Agent': FIREFOX_UA,
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          },
          body: JSON.stringify(reqBody),
        });

        const tokData = await tokReq.json().catch(() => ({}));

        let pageTokens = tokData.pageTokens;
        if (tokData.passToken) {
          this._passToken = tokData.passToken;
        }

        // If challenged with PoW:
        if (!pageTokens && tokData.challenge) {
          const c = tokData.challenge;
          const nonce = this._solvePoWChallenge(c.seed, c.difficulty);
          const tokSolve = await fetch(`${this.baseUrl}/api/reader/page-tokens`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Referer: chapterUrl,
              Origin: this.baseUrl,
              'User-Agent': FIREFOX_UA,
              ...(cookieHeader ? { Cookie: cookieHeader } : {}),
            },
            body: JSON.stringify({
              chapterId,
              challenge: c,
              nonce,
            }),
          });
          const solveData = await tokSolve.json().catch(() => ({}));
          if (solveData.passToken) {
            this._passToken = solveData.passToken;
          }
          pageTokens = solveData.pageTokens;
        }

        if (pageTokens && typeof pageTokens === 'object') {
          const keys = Object.keys(pageTokens).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
          for (const k of keys) {
            const item = pageTokens[k];
            const src = item?.url?.trim();
            if (src && !seenUrls.has(src)) {
              seenUrls.add(src);
              pages.push({
                page: pages.length + 1,
                url: src,
                directUrl: src,
                proxyUrl: `/api/proxy/image?url=${encodeURIComponent(src)}&referer=${encodeURIComponent(`${this.baseUrl}/`)}`,
              });
            }
          }
        }
      } catch (err) {
        console.warn('[Holotoon PageTokens Resolver Warning]:', err.message);
      }
    }

    // 2. Fallback: extract any static images from DOM if page-tokens didn't resolve
    if (pages.length === 0) {
      $('div#reader-pages img, main img[src*="/image/"], img[data-src*="/image/"]').each((_, img) => {
        const src = $(img).attr('src')?.trim() || $(img).attr('data-src')?.trim() || '';
        if (!src || seenUrls.has(src)) return;
        if (SKIP_PATTERNS.some((p) => src.includes(p))) return;
        seenUrls.add(src);
        pages.push({
          page: pages.length + 1,
          url: src,
          directUrl: src,
          proxyUrl: `/api/proxy/image?url=${encodeURIComponent(src)}&referer=${encodeURIComponent(`${this.baseUrl}/`)}`,
        });
      });
    }

    if (pages.length === 0) {
      throw createBadGateway('Gagal menemukan gambar chapter dari Holotoon (Chapter mungkin dilindungi atau terkunci)', 'UPSTREAM_ERROR');
    }

    const pageTitle = $('title').text()
      .replace(/\s*[-–|]\s*HoloToon.*$/i, '')
      .replace(/\s*[-–|]\s*Holodek.*$/i, '')
      .trim();

    return {
      source: this.name,
      title: pageTitle,
      totalPages: pages.length,
      pages,
    };
  }
}

module.exports = HolotoonSource;
