const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

class LumosSource extends BaseSource {
  constructor() {
    super('lumos', 'LumosKomik');
    this.baseUrl = 'https://03.lumosgg.com';
    this.icon = 'https://lms.imgsvr.my.id/file/site-icon/JIvDoypQPySSuG.webp';

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

  /** Decode Base64 synopsis (same as Kotlin parser). */
  _decodeBase64(encoded) {
    if (!encoded) return null;
    try {
      const padded = encoded.trim().replace(/-/g, '+').replace(/_/g, '/');
      const rem = padded.length % 4;
      const padded2 = rem ? padded + '='.repeat(4 - rem) : padded;
      return Buffer.from(padded2, 'base64').toString('utf-8').trim() || null;
    } catch {
      return null;
    }
  }

  /** Parse relative Indonesian date string → ISO date string (YYYY-MM-DD). */
  _parseRelativeDate(dateStr) {
    if (!dateStr) return null;
    const str = dateStr.toLowerCase().replace(/\d+\s+/g, (m) => m); // keep number
    const numMatch = str.match(/\d+/);
    const num = numMatch ? parseInt(numMatch[0], 10) : 1;
    const now = new Date();

    if (str.includes('detik')) now.setSeconds(now.getSeconds() - num);
    else if (str.includes('menit')) now.setMinutes(now.getMinutes() - num);
    else if (str.includes('jam')) now.setHours(now.getHours() - num);
    else if (str.includes('hari') || str.includes('kemarin')) now.setDate(now.getDate() - (str.includes('kemarin') ? 1 : num));
    else if (str.includes('minggu')) now.setDate(now.getDate() - num * 7);
    else if (str.includes('bulan')) now.setMonth(now.getMonth() - num);
    else if (str.includes('tahun')) now.setFullYear(now.getFullYear() - num);
    else return null;

    return now.toISOString().split('T')[0];
  }

  /** Parse manga cards from browse/search page. */
  _parseCardList($) {
    const items = [];
    const seen = new Set();

    // Filter out honeypot links (as noted in Kotlin parser)
    $('a[href^="/comic/"]:has(img:not([src*="flagcdn"]))').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (href.includes('honeypot')) return;
      const slug = this._slugFromComicUrl(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const img = $(el).find('img').first();
      const title = img.attr('alt')?.trim() || $(el).text().trim();
      if (!title) return;

      const cover = img.attr('src') || null;

      // Status and latestChapter are in the sibling div.p-3 of the cover link
      const cardWrapper = $(el).parent();
      const infoDiv = cardWrapper.find('div.p-3, div[class*="p-3"]').first();
      const statusEl = infoDiv.find('span.capitalize').first();
      const statusRaw = statusEl.text().trim().toLowerCase();
      const status = statusRaw || null;
      const chapterText = infoDiv.find('span.font-medium').first().text().trim();
      const chNumMatch = chapterText.match(/(\d+)/);
      const latestChapter = chNumMatch ? chNumMatch[1] : null;

      items.push({ title, slug, cover, status, latestChapter });
    });

    return items;
  }

  /** Parse pagination maxPage from numbered links. */
  _parsePagination($, currentPage) {
    let maxPage = currentPage;
    $('a[href*="page="]').each((_, el) => {
      const n = parseInt($(el).text().trim(), 10);
      if (!isNaN(n) && n > maxPage) maxPage = n;
    });
    // Also check last numbered page from href
    $('a[href*="page="]').each((_, el) => {
      const m = ($(el).attr('href') || '').match(/page=(\d+)/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!isNaN(n) && n > maxPage) maxPage = n;
      }
    });
    const hasNextPage = maxPage > currentPage;
    return { maxPage: maxPage > currentPage ? maxPage : null, hasNextPage };
  }

  async _fetchListing(url, pageNum) {
    const html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
    return { data, maxPage, hasNextPage };
  }

  // ─── Public endpoints ────────────────────────────────────────────────────────

  async getLatest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/browse?sort=latest&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getPopular(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/browse?sort=popular&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getRating(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/browse?sort=rating&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getAz(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/browse?sort=az&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const sort = this._resolveSort(options.sort || options.order || 'latest');
    const params = new URLSearchParams({ sort, page: pageNum });
    if (options.status) params.set('status', String(options.status).toLowerCase());
    if (options.type) params.set('type', String(options.type).toLowerCase());
    if (options.q || options.query) params.set('q', options.q || options.query);
    const url = `${this.baseUrl}/browse?${params.toString()}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async search(query, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/browse?q=${encodeURIComponent(String(query || '').trim())}&page=${pageNum}`;
    const html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
    return {
      source: this.name,
      query: String(query || '').trim(),
      page: pageNum,
      maxPage,
      hasNextPage,
      data,
    };
  }

  /**
   * Get genres from /browse filter form.
   * Genre key = slug value (e.g. "action"), name = display label.
   * Cached 24h.
   */
  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) {
      return this._cachedGenres;
    }

    const html = await getHtml(`${this.baseUrl}/browse`, {
      headers: { Referer: `${this.baseUrl}/` },
    });
    const $ = cheerio.load(html);
    const genres = [];
    const seen = new Set();

    $('label[data-bf-genre-name] input.bf-genre-cb[value]').each((_, el) => {
      const slug = $(el).val()?.trim();
      if (!slug || seen.has(slug)) return;
      seen.add(slug);
      const name =
        $(el).parent().find('span.truncate').text().trim() ||
        $(el).closest('label').text().trim();
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

    // Support comma-separated genres
    const keys = cleanGenre.split(',').map((g) => g.trim()).filter(Boolean);
    const found = keys.map((key) => {
      const match = genres.find(
        (g) => g.slug === key || g.name.toLowerCase() === key || g.id === key
      );
      if (!match) throw createNotFound(`Genre '${key}' tidak ditemukan di LumosKomik`, 'NOT_FOUND');
      return match;
    });

    // Lumos uses ?genre=action,romance (comma-separated)
    const genreParam = found.map((g) => g.slug).join(',');
    const url = `${this.baseUrl}/browse?genre=${encodeURIComponent(genreParam)}&sort=${sort}&page=${pageNum}`;
    const html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);

    return {
      source: this.name,
      genre: found.map((g) => g.name).join(', '),
      page: pageNum,
      maxPage,
      hasNextPage,
      data,
    };
  }

  async getTypes() {
    return ['manga', 'manhwa', 'manhua'];
  }

  async getByType(type, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanType = String(type || '').trim().toLowerCase();
    if (!cleanType) throw createBadRequest("Parameter 'type' wajib diisi", 'INVALID_PARAMETER');
    const sort = this._resolveSort(options.sort || options.order || 'latest');
    const url = `${this.baseUrl}/browse?type=${cleanType}&sort=${sort}&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
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
      if (err.statusCode === 404) {
        throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di LumosKomik`, 'NOT_FOUND');
      }
      throw err;
    }

    const $ = cheerio.load(html);

    // Title
    const title = $('h1').first().text().trim() || cleanSlug;

    // Cover
    const cover =
      $('img[src*="/cover"]').first().attr('src') ||
      $('aside img').first().attr('src') ||
      null;

    // Synopsis — Base64 encoded in data-sr, fallback to p.text-sm
    const dataSr = $('div[data-sr]').attr('data-sr');
    const synopsis = this._decodeBase64(dataSr) ||
                     $('p.text-sm').first().text().trim() ||
                     null;

    // Genres from a[href*="genre="]
    const genres = [];
    const seenGenres = new Set();
    $('a[href*="genre="]').each((_, el) => {
      const name = $(el).text().trim();
      const href = $(el).attr('href') || '';
      const genreMatch = href.match(/genre=([^&]+)/);
      const genreSlug = genreMatch ? decodeURIComponent(genreMatch[1]) : name.toLowerCase().replace(/\s+/g, '-');
      if (!name || seenGenres.has(genreSlug)) return;
      seenGenres.add(genreSlug);
      genres.push({ name, slug: genreSlug });
    });

    // Status — scan main text for known keywords
    const mainText = $('main').text();
    let status = 'ongoing';
    if (/completed|tamat/i.test(mainText)) status = 'completed';
    else if (/hiatus/i.test(mainText)) status = 'hiatus';
    else if (/ongoing|berjalan/i.test(mainText)) status = 'ongoing';

    // Type — check body text for type keywords
    let type = null;
    if (/\bmanhua\b/i.test(mainText)) type = 'manhua';
    else if (/\bmanhwa\b/i.test(mainText)) type = 'manhwa';
    else if (/\bmanga\b/i.test(mainText)) type = 'manga';

    // Chapter list — a[href*="/read/"][data-chapter], newest first in HTML
    const chapters = [];
    $('a[href*="/read/"][data-chapter]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (href.includes('honeypot')) return;

      const chTitle = $(el).find('span').first().text().trim() || `Chapter ${$(el).attr('data-chapter')}`;
      const chNum = $(el).attr('data-chapter')?.trim() || '';
      // Date: span.tabular-nums — strip leading "0" or noise
      const rawDate = $(el).find('span.tabular-nums, span[class*="tabular-nums"]').text().trim()
        .replace(/^\d+\s+/, ''); // strip leading number
      const date = this._parseRelativeDate(rawDate);

      chapters.push({
        title: chTitle,
        slug: `${this.baseUrl}${href}`,
        endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(`${this.baseUrl}${href}`)}`,
        date: date || rawDate || null,
      });
    });

    return {
      source: this.name,
      title,
      cover,
      synopsis,
      status,
      type,
      genres,
      totalChapters: chapters.length,
      chapters,
    };
  }

  async getPages(slug, chapter, server = 1) {
    const rawSlug = String(slug || '').trim();
    const rawChapter = String(chapter || '').trim();
    if (!rawSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    let chapterUrl;

    if (rawSlug.startsWith('http')) {
      chapterUrl = rawSlug;
    } else {
      // Construct: /read/{slug}/chapter-{N}
      const chNum = rawChapter.replace(/^chapter-?/i, '');
      chapterUrl = `${this.baseUrl}/read/${rawSlug}/chapter-${chNum}`;
    }

    let html;
    try {
      html = await getHtml(chapterUrl, { headers: { Referer: `${this.baseUrl}/` } });
    } catch (err) {
      if (err.statusCode === 404) {
        throw createNotFound(`Chapter tidak ditemukan di LumosKomik: ${chapterUrl}`, 'NOT_FOUND');
      }
      throw err;
    }

    const $ = cheerio.load(html);
    const pages = [];
    const seenUrls = new Set();

    // Images: img[src*="file/comic"] or img[src*="imgsvr"], filter out /api/image/p/
    $('img[src*="file/comic"], img[src*="imgsvr"]').each((_, img) => {
      const src = $(img).attr('src')?.trim() || '';
      if (!src || src.includes('/api/image/p/') || seenUrls.has(src)) return;
      seenUrls.add(src);
      pages.push({
        page: pages.length + 1,
        url: src,
        directUrl: src,
        proxyUrl: `/api/proxy/image?url=${encodeURIComponent(src)}&referer=${encodeURIComponent(`${this.baseUrl}/`)}`,
      });
    });

    if (pages.length === 0) {
      throw createBadGateway('Gagal menemukan gambar chapter dari LumosKomik', 'UPSTREAM_ERROR');
    }

    // Title from page <title>
    const pageTitle = $('title').text()
      .replace(/\s*[-–|]\s*LumosKomik.*$/i, '')
      .replace(/\s*[-–|]\s*Lumos.*$/i, '')
      .trim();

    return {
      source: this.name,
      title: pageTitle,
      totalPages: pages.length,
      pages,
    };
  }
}

module.exports = LumosSource;
