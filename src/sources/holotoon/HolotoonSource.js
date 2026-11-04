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

    // Holotoon hanya punya 1 grid, langsung parse semua card
    $('a.group[href^="/comic/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const slug = this._slugFromComicUrl(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const title = $(el).find('h3').first().text().trim();
      if (!title) return;

      const imgEl = $(el).find('img').first();
      const cover = imgEl.attr('data-src') ||
                    imgEl.attr('data-lazy-src') ||
                    (imgEl.attr('src')?.startsWith('data:') ? null : imgEl.attr('src')) ||
                    null;

      // Type: span.absolute top-2 left-2
      const type = $(el).find('span.absolute').filter((_, s) => {
        const cls = $(s).attr('class') || '';
        return cls.includes('top-2') && cls.includes('left-2');
      }).text().trim().toLowerCase() || null;

      // Status: span.absolute top-2 right-2
      const statusRaw = $(el).find('span.absolute').filter((_, s) => {
        const cls = $(s).attr('class') || '';
        return cls.includes('top-2') && cls.includes('right-2');
      }).text().trim().toLowerCase();
      const status = statusRaw || null;

      // Latest chapter: first span in .flex.items-center.justify-between (left side)
      const chText = $(el).find('div.flex span').first().text().trim().replace(/\u00a0/g, '').trim();
      const latestChapter = chText || null;

      // Date: span.text-surface-500
      const date = $(el).find('span.text-surface-500').text().trim() || null;

      items.push({ title, slug, cover, type, status, latestChapter, date });
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
    const html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
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
    const html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { hasNextPage, maxPage } = this._parsePagination($, pageNum);
    return { source: this.name, query: String(query || '').trim(), page: pageNum, maxPage, hasNextPage, data };
  }

  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) {
      return this._cachedGenres;
    }

    const html = await getHtml(`${this.baseUrl}/browse`, { headers: { Referer: `${this.baseUrl}/` } });
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
    const html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
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
      html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di Holotoon`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    const title = $('h1').first().text().trim() || cleanSlug;

    // Cover
    const cover = $('img[src*="/covers/"]').first().attr('src') || null;

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

    // Author & Artist — dari span "Author: <span>name</span>"
    let author = null;
    $('span').each((_, el) => {
      const text = $(el).clone().children().remove().end().text().trim();
      if (/^Author:/i.test(text)) {
        author = $(el).find('span').first().text().trim() || null;
        return false; // break
      }
    });

    // Chapters — a[href^="/read/"][data-chapter], newest first in HTML → reverse
    const chapters = [];
    $('a[href^="/read/"][data-chapter]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!href) return;

      const dataChapter = $(el).attr('data-chapter') || '';
      const chLabel = $(el).find('span.font-semibold').text().trim();
      const chSub = $(el).find('span.truncate').text().trim().replace(/^—\s*/, '').trim();
      const chTitle = chLabel && chSub ? `${chLabel} - ${chSub}` : chLabel || chSub || `Chapter ${dataChapter.split(' ')[0]}`;
      const date = $(el).find('span[class*=tabular]').last().text().trim() || null;

      chapters.push({
        title: chTitle,
        slug: `${this.baseUrl}${href}`,
        endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(`${this.baseUrl}${href}`)}`,
        date,
      });
    });

    return {
      source: this.name,
      title,
      cover,
      synopsis,
      status,
      author: author || null,
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
      // Holotoon chapter reader requires Firefox UA
      html = await getHtml(chapterUrl, {
        headers: {
          Referer: `${this.baseUrl}/`,
          'User-Agent': FIREFOX_UA,
        },
      });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Chapter tidak ditemukan di Holotoon`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);
    const pages = [];
    const seenUrls = new Set();

    // Images: div#reader-pages img OR main img[src*="/image/"]
    // Filter out UI images (covers, avatars, headers, etc.)
    const SKIP_PATTERNS = ['/chapter-header/', '/chapter-footer/', '/covers/', '/reactions/', '/avatars/', '/shop/', '/site-logo/'];

    $('div#reader-pages img, main img[src*="/image/"]').each((_, img) => {
      const src = $(img).attr('src')?.trim() || '';
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

    if (pages.length === 0) {
      throw createBadGateway('Gagal menemukan gambar chapter dari Holotoon', 'UPSTREAM_ERROR');
    }

    const pageTitle = $('title').text()
      .replace(/\s*[-–|]\s*Holotoon.*$/i, '')
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
