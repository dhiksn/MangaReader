const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

const PAGE_SIZE = 21;

class KomikApkSource extends BaseSource {
  constructor() {
    super('komikapk', 'KomikAPK');
    this.baseUrl = 'https://komikapk.app';
    this.icon = `${this.baseUrl}/favicon.ico`;

    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  getSupportedSorts() {
    return [
      { id: 'latest',    name: 'Terbaru' },
      { id: 'popular',   name: 'Popular' },
      { id: 'popular18', name: 'Popular18'}
    ];
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  _headers() {
    return { Referer: `${this.baseUrl}/` };
  }

  /**
   * Resolve relative href to absolute slug like "/komik/slug"
   * Handles both "../../../../komik/slug" and "./komik/slug"
   */
  _resolveHref(href, pageUrl) {
    if (!href) return null;
    try {
      const abs = new URL(href, pageUrl);
      return abs.pathname; // "/komik/slug"
    } catch (_) {
      return null;
    }
  }

  _slugFromPath(path) {
    if (!path) return null;
    const m = path.match(/\/komik\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  _parseCardList($, pageUrl) {
    const items = [];
    const seen = new Set();

    $('a[href*="komik/"]').each((_, el) => {
      const rawHref = $(el).attr('href') || '';
      const path = this._resolveHref(rawHref, pageUrl);
      if (!path) return;

      const segs = path.replace(/^\//, '').split('/').filter(Boolean);
      if (segs.length !== 2 || segs[0] !== 'komik') return;

      const slug = segs[1];
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const title = $(el).find('div.font-semibold, div.line-clamp-2').first().text().trim();
      if (!title) return;

      const cover = $(el).find('img').first().attr('src') || null;

      // Type badge: div.absolute top-0 right-0
      const type = $(el).find('div.absolute').filter((_, d) => {
        const cls = $(d).attr('class') || '';
        return cls.includes('top-0') && cls.includes('right-0');
      }).first().text().trim().toLowerCase() || null;

      // All badge texts for status and chapter detection
      const badges = $(el).find('div.absolute').map((_, d) => $(d).text().trim().toLowerCase()).get();

      // Status: check for known status words
      const statusRaw = badges.find((t) => ['ongoing', 'completed', 'hiatus', 'dropped', 'tamat', 'berjalan'].includes(t));
      const status = statusRaw || null;

      // Latest chapter from badge text containing "Ch."
      const chBadge = badges.find((t) => /ch\.\s*\d+/i.test(t));
      const latestChapter = chBadge ? chBadge.replace(/ch\.\s*/i, '') : null;

      items.push({ title, slug, cover, type, status, latestChapter });
    });

    return items;
  }

  async _fetchListing(url, pageNum) {
    const html = await getHtml(url, { headers: this._headers() });
    const $ = cheerio.load(html);
    const data = this._parseCardList($, url);

    // Pagination: check if there's a next page link
    const nextPageUrl = `${url.replace(/\/\d+$/, '')}/${pageNum + 1}`;
    const hasNextPage = data.length >= PAGE_SIZE;
    const maxPage = hasNextPage ? pageNum + 1 : pageNum;

    return { data, hasNextPage, maxPage };
  }

  // ─── Endpoints ───────────────────────────────────────────────────────────────

  async getLatest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/pustaka/semua/semua/terbaru/${pageNum}`;
    const { data, hasNextPage, maxPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getPopular(page = 1) {
    // Trending page — all items loaded at once, paginate client-side
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/trending`;
    const html = await getHtml(url, { headers: this._headers() });
    const $ = cheerio.load(html);
    const allItems = this._parseCardList($, url);
    const start = (pageNum - 1) * PAGE_SIZE;
    const data = allItems.slice(start, start + PAGE_SIZE);
    const hasNextPage = start + PAGE_SIZE < allItems.length;
    const maxPage = Math.ceil(allItems.length / PAGE_SIZE) || pageNum;
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getPopular18(page = 1) {
    // Adult trending — /trending?periode=jam&adult=true
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/trending?periode=jam&adult=true`;
    const html = await getHtml(url, { headers: this._headers() });
    const $ = cheerio.load(html);
    const allItems = this._parseCardList($, url);
    const start = (pageNum - 1) * PAGE_SIZE;
    const data = allItems.slice(start, start + PAGE_SIZE);
    const hasNextPage = start + PAGE_SIZE < allItems.length;
    const maxPage = Math.ceil(allItems.length / PAGE_SIZE) || pageNum;
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const sort = String(options.order || options.sort || '').toLowerCase();
    if (sort === 'popular') return this.getPopular(pageNum);

    // Build URL: /pustaka/{type}/{tag}/terbaru/{page}
    const typeMap = { manga: 'manga', manhwa: 'manhwa', manhua: 'manhua', hentai: 'semua' };
    const typeSegment = typeMap[options.type?.toLowerCase()] || 'semua';
    const tagSegment = options.genre || 'semua';
    const adult = options.type?.toLowerCase() === 'hentai' ? '?include_adult=true' : '';
    const url = `${this.baseUrl}/pustaka/${typeSegment}/${tagSegment}/terbaru/${pageNum}${adult}`;
    const { data, hasNextPage, maxPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async search(query, page = 1) {
    const q = String(query || '').trim();
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    // Search returns all results at once — paginate client-side
    const url = `${this.baseUrl}/pencarian?q=${encodeURIComponent(q)}&is-adult=on`;
    const html = await getHtml(url, { headers: this._headers() });
    const $ = cheerio.load(html);
    const allItems = this._parseCardList($, url);
    const start = (pageNum - 1) * PAGE_SIZE;
    const data = allItems.slice(start, start + PAGE_SIZE);
    const hasNextPage = start + PAGE_SIZE < allItems.length;
    return {
      source: this.name,
      query: q,
      page: pageNum,
      maxPage: Math.ceil(allItems.length / PAGE_SIZE) || pageNum,
      hasNextPage,
      data,
    };
  }

  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) return this._cachedGenres;
    const url = `${this.baseUrl}/pustaka/semua/semua/terbaru/1`;
    const html = await getHtml(url, { headers: this._headers() });
    const $ = cheerio.load(html);

    const genres = [];
    const seen = new Set();

    $('a[href*="/pustaka/semua/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const path = this._resolveHref(href, url);
      if (!path) return;
      // /pustaka/semua/{slug}/terbaru/1
      const m = path.match(/\/pustaka\/semua\/([^/?#/]+)\/terbaru/);
      if (!m) return;
      const slug = m[1];
      if (!slug || slug === 'semua' || seen.has(slug)) return;
      seen.add(slug);
      const name = $(el).text().trim() || slug.replace(/-/g, ' ');
      if (!name) return;
      genres.push({ name, slug });
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

    const allGenres = await this.getGenres();
    const keys = cleanGenre.split(',')[0].trim(); // single genre only
    const found = allGenres.find((g) => g.slug === keys || g.name.toLowerCase() === keys);
    if (!found) throw createNotFound(`Genre '${genre}' tidak ditemukan di KomikAPK`, 'NOT_FOUND');

    const ADULT_SLUGS = new Set(['adult', 'hentai', 'smut', 'mature', '18+', 'ecchi']);
    const isAdult = ADULT_SLUGS.has(found.slug);
    const adultSuffix = isAdult ? '?include_adult=true' : '';
    const url = `${this.baseUrl}/pustaka/semua/${found.slug}/terbaru/${pageNum}${adultSuffix}`;
    const { data, hasNextPage, maxPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, genre: found.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getTypes() {
    return ['manga', 'manhwa', 'manhua'];
  }

  async getByType(type, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanType = String(type || '').trim().toLowerCase();
    if (!cleanType) throw createBadRequest("Parameter 'type' wajib diisi", 'INVALID_PARAMETER');
    const typeMap = { manga: 'manga', manhwa: 'manhwa', manhua: 'manhua' };
    const typeSegment = typeMap[cleanType] || 'semua';
    const url = `${this.baseUrl}/pustaka/${typeSegment}/semua/terbaru/${pageNum}`;
    const { data, hasNextPage, maxPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, type: cleanType, page: pageNum, maxPage, hasNextPage, data };
  }

  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/').pop();
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    const url = `${this.baseUrl}/komik/${cleanSlug}`;
    let html;
    try {
      html = await getHtml(url, { headers: this._headers() });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di KomikAPK`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    const title = $('h1').first().text().trim() || cleanSlug;

    const cover = $('figure img[src*=-cover/], figure img').first().attr('src') || null;

    // Description
    const description = $('div.font-display.mt-5.text-center').first().text().trim() || null;

    // Author from description: "dibuat oleh komikus bernama X ini bercerita"
    let author = null;
    if (description) {
      const m = description.match(/dibuat oleh komikus bernama\s+(.+?)\s+ini bercerita/i);
      if (m) author = m[1].trim();
    }

    // Genres from /pustaka/semua/ links
    const genres = [];
    const seenG = new Set();
    $('a[href*="/pustaka/semua/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const path = this._resolveHref(href, url);
      if (!path) return;
      const m = path.match(/\/pustaka\/semua\/([^/?#/]+)\/terbaru/);
      if (!m) return;
      const gSlug = m[1];
      if (!gSlug || gSlug === 'semua' || seenG.has(gSlug)) return;
      seenG.add(gSlug);
      const name = $(el).text().trim() || gSlug.replace(/-/g, ' ');
      genres.push({ name, slug: gSlug });
    });

    // Chapters from div.join-vertical a[href*=/komik/]
    const chapters = [];
    const seenCh = new Set();
    $('div.join-vertical a[href*="komik/"]').each((_, el) => {
      const rawHref = $(el).attr('href') || '';
      const path = this._resolveHref(rawHref, url);
      if (!path || seenCh.has(path)) return;
      seenCh.add(path);

      const absUrl = `${this.baseUrl}${path}`;
      const chTitle = $(el).text().trim() || path.split('/').pop();
      const chNumMatch = chTitle.match(/(\d+(?:\.\d+)?)/);
      chapters.push({
        title: chTitle,
        slug: absUrl,
        endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(absUrl)}`,
        number: chNumMatch ? parseFloat(chNumMatch[1]) : null,
      });
    });

    // Reverse to oldest-first
    chapters.reverse();

    // Related — fetch weekly trending (non-adult), take 6, exclude current
    const related = [];
    try {
      const trendUrl = `${this.baseUrl}/trending?periode=minggu&adult=false`;
      const trendHtml = await getHtml(trendUrl, { headers: this._headers() });
      const t$ = cheerio.load(trendHtml);
      const trendItems = this._parseCardList(t$, trendUrl);
      for (const item of trendItems) {
        if (item.slug === cleanSlug) continue;
        related.push({ title: item.title, slug: item.slug, cover: item.cover, type: item.type, latestChapter: item.latestChapter });
        if (related.length >= 6) break;
      }
    } catch (_) {}

    return {
      source: this.name,
      title,
      cover,
      synopsis: description,
      author: author || null,
      genres,
      totalChapters: chapters.length,
      chapters,
      related,
    };
  }

  async getPages(slug, chapter) {
    const rawSlug = String(slug || '').trim();
    if (!rawSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    const chapterUrl = rawSlug.startsWith('http') ? rawSlug
      : `${this.baseUrl}/komik/${rawSlug}/kmapk/${String(chapter || '').replace(/^chapter-?/i, '')}`;

    let html;
    try {
      html = await getHtml(chapterUrl, { headers: this._headers() });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound('Chapter tidak ditemukan di KomikAPK', 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);
    const images = [];
    const seenUrls = new Set();
    const SKIP = ['/loading.gif', '/cover_global.png', '/komikapk2-cover/', '-cover/'];

    $('section img[src*=-chapter/], section img[src]').each((_, el) => {
      const src = $(el).attr('src')?.trim() || '';
      if (!src || seenUrls.has(src)) return;
      if (SKIP.some((s) => src.endsWith(s))) return;
      seenUrls.add(src);
      const absUrl = src.startsWith('http') ? src : `${this.baseUrl}${src}`;
      images.push(absUrl);
    });

    if (!images.length) throw createBadGateway('Tidak ada gambar untuk chapter ini di KomikAPK', 'UPSTREAM_ERROR');

    const pageTitle = $('title').text()
      .replace(/\s*[-–|]\s*KomikAPK.*$/i, '')
      .replace(/^(Baca|Read)\s+/i, '')
      .trim();

    return {
      source: this.name,
      title: pageTitle,
      totalPages: images.length,
      pages: images.map((url, index) => ({
        page: index + 1,
        url,
        directUrl: url,
        proxyUrl: `/api/proxy/image?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(`${this.baseUrl}/`)}`,
      })),
    };
  }
}

module.exports = KomikApkSource;
