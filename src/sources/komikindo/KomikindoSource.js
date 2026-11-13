const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');
const { formatRelativeTime } = require('../../utils/date');

class KomikindoSource extends BaseSource {
  constructor() {
    super('komikindo', 'Komikindo');
    this.baseUrl = 'https://komikindo.click';
    this.icon = 'https://i3.wp.com/komikindo.click/wp-content/uploads/2023/05/cropped-favicon-1-32x32.png';

    // Genres cache
    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  getSupportedSorts() {
    return [
      { id: 'latest', name: 'Terbaru' },
      { id: 'popular', name: 'Populer' },
      { id: 'az', name: 'A-Z' },
      { id: 'za', name: 'Z-A' },
    ];
  }

  /**
   * Strip Photon/Jetpack CDN wrapper and resize query params from cover URLs.
   * @private
   */
  _cleanCoverUrl(url) {
    if (!url) return null;
    let trimmed = url.trim();
    if (trimmed.startsWith('//')) trimmed = `https:${trimmed}`;
    if (trimmed.startsWith('http://')) trimmed = trimmed.replace('http://', 'https://');
    return trimmed;
  }

  /**
   * Extract manga slug from a detail page URL.
   * @private
   */
  _slugFromDetailUrl(href) {
    if (!href) return null;
    const match = href.match(/\/manga\/([^/]+)\/?$/);
    return match ? match[1] : null;
  }

  /**
   * Parse pagination: returns { maxPage, hasNextPage } from HTML.
   * @private
   */
  _parsePagination($, currentPage) {
    let maxPage = currentPage;
    $('div.pagination a.page-numbers').each((_, el) => {
      const num = parseInt($(el).text().trim(), 10);
      if (!isNaN(num) && num > maxPage) maxPage = num;
    });
    const hasNext = $('div.pagination a.next.page-numbers').length > 0;
    return { maxPage, hasNextPage: hasNext };
  }

  /**
   * Parse manga cards from .listupd .bsx elements (browse/search/genre pages).
   * These cards link to detail pages and include status, type, rating, latest chapter.
   * @private
   */
  _parseCardList($) {
    const items = [];
    const seen = new Set();

    $('div.listupd .bsx').each((_, el) => {
      const $el = $(el);
      const a = $el.find('a').first();
      const href = a.attr('href') || '';

      // Skip chapter links (homepage cards link to chapter pages)
      const slug = this._slugFromDetailUrl(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const title = $el.find('.tt').text().trim() || a.attr('title') || '';
      const rawCover = $el.find('.limit img.ts-post-image, .limit img').first().attr('src') || '';
      const cover = this._cleanCoverUrl(rawCover);
      const type = $el.find('span.typename').text().trim().toLowerCase() || null;
      const statusRaw = $el.find('span.status').text().trim().toLowerCase();
      const status = statusRaw === 'ongoing' ? 'ongoing' : statusRaw === 'completed' ? 'completed' : statusRaw || null;
      const latestChText = $el.find('.epxs').text().trim();
      const latestChMatch = latestChText.match(/Chapter\s+([0-9.]+)/i);
      const latestChapter = latestChMatch ? latestChMatch[1] : latestChText || null;
      const ratingRaw = $el.find('.numscore').text().trim();
      const rating = ratingRaw && !isNaN(parseFloat(ratingRaw)) ? parseFloat(ratingRaw) : null;

      items.push({
        title: title.trim(),
        slug,
        cover,
        type,
        status,
        latestChapter,
        rating,
      });
    });

    return items;
  }

  /**
   * Fetch a manga listing page (browse, latest, popular, by-genre, by-type).
   * @private
   */
  async _fetchListing(url, pageNum) {
    const html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
    return { data, maxPage, hasNextPage };
  }

  /**
   * GET /manga/?status=&type=&order=&page=N
   */
  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const orderMap = { update: 'update', latest: 'update', popular: 'popular', title: 'title', az: 'title', titlereverse: 'titlereverse', za: 'titlereverse' };
    const rawOrder = String(options.order || options.sort || 'update').toLowerCase();
    const order = orderMap[rawOrder] || 'update';
    const status = String(options.status || '').toLowerCase();
    const type = String(options.type || '').toLowerCase();

    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (type) params.set('type', type);
    params.set('order', order);
    params.set('page', pageNum);

    const url = `${this.baseUrl}/manga/?${params.toString()}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return {
      source: this.name,
      page: pageNum,
      maxPage,
      hasNextPage,
      data,
    };
  }

  /**
   * GET /manga/?order=title&page=N  (A-Z)
   */
  async getAz(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/manga/?order=title&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return {
      source: this.name,
      page: pageNum,
      maxPage,
      hasNextPage,
      data,
    };
  }

  /**
   * GET /manga/?order=titlereverse&page=N  (Z-A)
   */
  async getZa(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/manga/?order=titlereverse&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return {
      source: this.name,
      page: pageNum,
      maxPage,
      hasNextPage,
      data,
    };
  }

  /**
   * GET /manga/?order=update&page=N
   */
  async getLatest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/manga/?order=update&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return {
      source: this.name,
      page: pageNum,
      maxPage,
      hasNextPage,
      data,
    };
  }

  /**
   * GET /manga/?order=popular&page=N
   */
  async getPopular(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/manga/?order=popular&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return {
      source: this.name,
      page: pageNum,
      maxPage,
      hasNextPage,
      data,
    };
  }

  /**
   * GET /?s=query&page=N  (WordPress standard search)
   */
  async search(query, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const q = encodeURIComponent(String(query || '').trim());
    const url =
      pageNum === 1
        ? `${this.baseUrl}/?s=${q}`
        : `${this.baseUrl}/page/${pageNum}/?s=${q}`;
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
   * Fetch genres with term IDs from /manga/ filter form.
   * Cached for 24 hours.
   */
  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) {
      return this._cachedGenres;
    }

    const html = await getHtml(`${this.baseUrl}/manga/`, {
      headers: { Referer: `${this.baseUrl}/` },
    });
    const $ = cheerio.load(html);
    const genres = [];
    const seen = new Set();

    // Genre checkboxes: <input name="genre[]" value="ID"> with sibling label text
    $('input[name="genre[]"]').each((_, el) => {
      const id = $(el).val();
      if (!id || seen.has(id)) return;
      seen.add(id);
      // Label is usually next sibling or inside parent li
      const label =
        $(el).next('label').text().trim() ||
        $(el).closest('li').text().trim() ||
        $(el).parent().text().trim();
      if (!label) return;
      const slug = label.toLowerCase().replace(/\s+/g, '-');
      genres.push({ name: label, slug, id });
    });

    genres.sort((a, b) => a.name.localeCompare(b.name, 'id'));
    this._cachedGenres = genres;
    this._cachedGenresExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
    return genres;
  }

  /**
   * GET /manga/?genre[]=<id>&order=update&page=N
   */
  async getByGenre(genre, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanGenre = String(genre || '').trim().toLowerCase();
    if (!cleanGenre) throw createBadRequest("Parameter 'genre' wajib diisi", 'INVALID_PARAMETER');

    const orderMap = { update: 'update', latest: 'update', popular: 'popular', title: 'title', az: 'title', titlereverse: 'titlereverse', za: 'titlereverse' };
    const rawOrder = String(options.order || options.sort || 'update').toLowerCase();
    const order = orderMap[rawOrder] || 'update';

    // Resolve genre ID from cache or fetch fresh
    const genres = await this.getGenres();
    // Support multiple genres separated by comma: "action,adult"
    const genreKeys = cleanGenre.split(',').map((g) => g.trim()).filter(Boolean);
    const foundGenres = genreKeys.map((key) => {
      const match = genres.find(
        (g) => g.slug === key || g.name.toLowerCase() === key || g.id === key
      );
      if (!match) throw createNotFound(`Genre '${key}' tidak ditemukan di Komikindo`, 'NOT_FOUND');
      return match;
    });

    const genreParams = foundGenres.map((g) => `genre%5B%5D=${g.id}`).join('&');
    const url = `${this.baseUrl}/manga/?${genreParams}&order=${order}&page=${pageNum}`;

    let html;
    try {
      html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    } catch (err) {
      throw err;
    }

    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);

    return {
      source: this.name,
      genre: foundGenres.map((g) => g.name).join(', '),
      page: pageNum,
      maxPage,
      hasNextPage,
      data,
    };
  }

  /**
   * GET /manga/?order=title&type=<type>&page=N
   */
  async getByType(type, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanType = String(type || '').trim().toLowerCase();
    if (!cleanType) throw createBadRequest("Parameter 'type' wajib diisi", 'INVALID_PARAMETER');

    const orderMap = { update: 'update', latest: 'update', popular: 'popular', title: 'title', az: 'title', titlereverse: 'titlereverse', za: 'titlereverse' };
    const rawOrder = String(options.order || options.sort || 'update').toLowerCase();
    const order = orderMap[rawOrder] || 'update';

    const url = `${this.baseUrl}/manga/?order=${order}&type=${encodeURIComponent(cleanType)}&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return {
      source: this.name,
      type: cleanType,
      page: pageNum,
      maxPage,
      hasNextPage,
      data,
    };
  }

  /**
   * GET /manga/<slug>/
   */
  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    const url = `${this.baseUrl}/manga/${cleanSlug}/`;
    let html;
    try {
      html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    } catch (err) {
      if (err.statusCode === 404) {
        throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di Komikindo`, 'NOT_FOUND');
      }
      throw err;
    }

    const $ = cheerio.load(html);

    // Title
    const title = $('h1.entry-title[itemprop="name"]').text().trim() || cleanSlug;

    // Cover — strip resize params
    const rawCover = $('div.thumb img').attr('src') || '';
    const cover = this._cleanCoverUrl(rawCover);

    // Synopsis
    const synopsis =
      $('div.entry-content-single[itemprop="description"] p').first().text().trim() ||
      $('div.entry-content-single[itemprop="description"]').text().trim() ||
      $('meta[property="og:description"]').attr('content') ||
      null;

    // Info table — parse by label
    let status = null;
    let type = null;
    let year = null;
    let author = null;
    let artist = null;

    $('table.infotable tbody tr').each((_, row) => {
      const label = $(row).find('td').first().text().trim().toLowerCase();
      const value = $(row).find('td').last().text().trim();
      if (!value || value === '?') return;

      if (label === 'status') {
        status = value.toLowerCase();
      } else if (label === 'type') {
        type = value.toLowerCase();
      } else if (label === 'released') {
        const yearMatch = value.match(/\d{4}/);
        if (yearMatch) year = yearMatch[0];
      } else if (label === 'author') {
        author = value;
      } else if (label === 'artist') {
        artist = value;
      }
    });

    // Rating
    const ratingText =
      $('div.rating .num[itemprop="ratingValue"]').attr('content') ||
      $('div.rating .num[itemprop="ratingValue"]').text().trim();
    const rating = ratingText && !isNaN(parseFloat(ratingText)) ? parseFloat(ratingText) : null;

    // Genres
    const genres = [];
    $('div.seriestugenre a[rel="tag"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const match = href.match(/\/genres\/([^/]+)\/?$/);
      const slug = match ? match[1] : $(el).text().trim().toLowerCase().replace(/\s+/g, '-');
      genres.push({ name: $(el).text().trim(), slug });
    });

    // Chapter list
    const chapters = [];
    $('#chapterlist ul.clstyle > li[data-num]').each((_, el) => {
      const a = $(el).find('.eph-num a');
      const href = a.attr('href') || '';
      const chNumText = $(el).find('.chapternum').text().trim();
      const chDate = $(el).find('.chapterdate').text().trim() || null;
      const chNumMatch = chNumText.match(/Chapter\s+([0-9.]+)/i);
      const chNum = chNumMatch ? chNumMatch[1] : $(el).attr('data-num') || '';

      if (!href || !chNum) return;

      chapters.push({
        title: chNumText || `Chapter ${chNum}`,
        slug: href,
        endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(href)}`,
        date: chDate,
      });
    });

    // Related series
    const related = [];
    $('div.bixbox').each((_, el) => {
      const heading = $(el).find('h2, h3').first().text().trim().toLowerCase();
      if (heading.includes('related')) {
        $(el).find('.bsx').each((__, card) => {
          const a = $(card).find('a').first();
          const href = a.attr('href') || '';
          const slug = this._slugFromDetailUrl(href);
          if (!slug) return;
          const title = $(card).find('.tt').text().trim();
          const rawCover = $(card).find('.limit img').first().attr('src') || '';
          const cover = this._cleanCoverUrl(rawCover);
          const type = $(card).find('span.typename').text().trim().toLowerCase() || null;
          const ratingRaw = $(card).find('.numscore').text().trim();
          const rating = ratingRaw && !isNaN(parseFloat(ratingRaw)) ? parseFloat(ratingRaw) : null;
          related.push({ title, slug, cover, type, rating });
        });
      }
    });

    return {
      source: this.name,
      title,
      cover,
      synopsis,
      status,
      type,
      author: author || null,
      artist: artist || null,
      year: year || null,
      rating,
      genres,
      totalChapters: chapters.length,
      chapters,
      similar: related,
      related,
    };
  }

  /**
   * Resolve chapter URL by fetching manga detail page and matching chapter number.
   * @private
   */
  async _resolveChapterUrl(mangaSlug, chapterNum) {
    const details = await this.getDetails(mangaSlug);
    const target = details.chapters.find((ch) => {
      const num = ch.title.match(/Chapter\s+([0-9.]+)/i);
      return num && parseFloat(num[1]) === parseFloat(chapterNum);
    });
    if (!target) {
      throw createNotFound(`Chapter '${chapterNum}' tidak ditemukan untuk manga '${mangaSlug}'`, 'NOT_FOUND');
    }
    return target.slug; // slug here is full href URL
  }

  /**
   * GET <chapter-url> — extract images from ts_reader.run({...}) inline JSON.
   * @param {string} slug  Manga slug (e.g. 'secret-class') or full chapter URL
   * @param {string|number} chapter  Chapter number
   * @param {number} [server=1]  Server index (1 = sources[0], 2 = sources[1], etc.)
   */
  async getPages(slug, chapter, server = 1) {
    const serverIdx = Math.max(0, (parseInt(server, 10) || 1) - 1);
    const rawSlug = String(slug || '').trim();
    const rawChapter = String(chapter || '').trim();
    if (!rawSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    let chapterUrl;

    // If slug is already a full URL, use directly
    if (rawSlug.startsWith('http')) {
      chapterUrl = rawSlug;
    } else {
      // Always resolve from detail page chapter list — Komikindo uses non-standard
      // chapter URL formats (e.g. chapter-01 not chapter-1, or chapter-118-1 for decimals)
      const chNum = rawChapter.replace(/^chapter-?/i, '');
      chapterUrl = await this._resolveChapterUrl(rawSlug, chNum);
    }

    let html;
    try {
      html = await getHtml(chapterUrl, { headers: { Referer: `${this.baseUrl}/` } });
    } catch (err) {
      if (err.statusCode === 404) {
        throw createNotFound(`Chapter tidak ditemukan di Komikindo: ${chapterUrl}`, 'NOT_FOUND');
      }
      throw err;
    }

    // Extract ts_reader.run({...}) JSON from inline <script>
    const match = html.match(/ts_reader\.run\s*\(\s*(\{[\s\S]*?\})\s*\)\s*;/);
    if (!match) {
      throw createBadGateway('Gagal menemukan data gambar chapter dari Komikindo (ts_reader not found)', 'UPSTREAM_ERROR');
    }

    let tsData;
    try {
      tsData = JSON.parse(match[1]);
    } catch (err) {
      throw createBadGateway(`Gagal memproses data gambar chapter dari Komikindo: ${err.message}`, 'UPSTREAM_ERROR');
    }

    const sources = tsData.sources || [];
    if (sources.length === 0) {
      throw createBadGateway('Tidak ada sumber gambar yang tersedia untuk chapter ini', 'UPSTREAM_ERROR');
    }

    // Pick server (clamp to available sources)
    const pickedServer = sources[Math.min(serverIdx, sources.length - 1)];
    const images = pickedServer?.images || [];

    if (images.length === 0) {
      throw createBadGateway('Tidak ada gambar yang tersedia di server ini', 'UPSTREAM_ERROR');
    }

    const pages = images.map((imgUrl, index) => ({
      page: index + 1,
      url: imgUrl,
      directUrl: imgUrl,
      proxyUrl: `/api/proxy/image?url=${encodeURIComponent(imgUrl)}`,
    }));

    // Build title from page <title> or the chapter URL
    const $ = cheerio.load(html);
    const pageTitle = $('title').text().replace(/\s*[-|].*$/, '').trim();
    const mangaTitle = pageTitle || chapterUrl;

    return {
      source: this.name,
      title: mangaTitle,
      totalPages: pages.length,
      pages,
    };
  }
}

module.exports = KomikindoSource;
