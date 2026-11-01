const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

class ApkomikSource extends BaseSource {
  constructor() {
    super('apkomik', 'Apkomik');
    this.baseUrl = 'https://01.apkomik.com';
    this.icon = 'https://01.apkomik.com/wp-content/uploads/2024/02/logo.png';

    // Genres cache (id + name + slug)
    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  getSupportedSorts() {
    return [
      { id: 'latest', name: 'Terbaru' },
      { id: 'newest', name: 'Terbaru Ditambahkan' },
      { id: 'popular', name: 'Populer' },
      { id: 'az', name: 'A-Z' },
      { id: 'za', name: 'Z-A' },
    ];
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /** Strip Photon/CDN resize params from cover URLs. */
  _cleanCoverUrl(url) {
    if (!url) return null;
    return url.replace(/[?&](resize|fit|w|h|width|height)=[^&]*/gi, '').replace(/[?&]$/, '');
  }

  /** Extract manga slug from a detail page URL. */
  _slugFromDetailUrl(href) {
    if (!href) return null;
    const match = href.match(/\/manga\/([^/]+)\/?$/);
    return match ? match[1] : null;
  }

  /**
   * Parse manga cards from .listupd .bsx elements.
   * Cards link to detail pages and include type, status, latestChapter, rating.
   */
  _parseCardList($) {
    const items = [];
    const seen = new Set();

    $('div.listupd .bsx').each((_, el) => {
      const $el = $(el);
      const a = $el.find('a').first();
      const href = a.attr('href') || '';
      const slug = this._slugFromDetailUrl(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const title = $el.find('.tt').text().trim() || a.attr('title') || '';
      const rawCover = $el.find('.limit img.ts-post-image, .limit img').first().attr('src') || '';
      const cover = this._cleanCoverUrl(rawCover);

      // apkomik uses span.type (not span.typename like komikindo)
      const type = $el.find('span.type').text().trim().toLowerCase() || null;
      const statusRaw = $el.find('span.status').text().trim().toLowerCase();
      const status = statusRaw || 'ongoing';
      const latestChText = $el.find('.epxs').text().trim();
      const latestChMatch = latestChText.match(/Chapter\s+([0-9.]+)/i);
      const latestChapter = latestChMatch ? latestChMatch[1] : latestChText || null;
      const ratingRaw = $el.find('.numscore').text().trim();
      const rating = ratingRaw && !isNaN(parseFloat(ratingRaw)) ? parseFloat(ratingRaw) : null;

      items.push({ title: title.trim(), slug, cover, type, status, latestChapter, rating });
    });

    return items;
  }

  /**
   * Parse pagination — apkomik uses a single "Next" link (no numbered pages).
   * Returns { hasNextPage, maxPage: null }.
   */
  _parsePagination($) {
    const hasNextPage = $('div.hpage a.r').length > 0;
    return { hasNextPage, maxPage: null };
  }

  /** Fetch a listing page and parse cards + pagination. */
  async _fetchListing(url, pageNum) {
    const html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { hasNextPage, maxPage } = this._parsePagination($);
    return { data, hasNextPage, maxPage };
  }

  /** Resolve order string to Apkomik's order param value. */
  _resolveOrder(raw) {
    const map = {
      update: 'update', latest_update: 'update', latest: 'latest',
      newest: 'latest', popular: 'popular', title: 'title',
      az: 'title', titlereverse: 'titlereverse', za: 'titlereverse',
    };
    return map[String(raw || '').toLowerCase()] || 'update';
  }

  // ─── Public endpoints ────────────────────────────────────────────────────────

  async getLatest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/manga/?order=update&page=${pageNum}`;
    const { data, hasNextPage, maxPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getNewest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/manga/?order=latest&page=${pageNum}`;
    const { data, hasNextPage, maxPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getPopular(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/manga/?order=popular&page=${pageNum}`;
    const { data, hasNextPage, maxPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getAz(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/manga/?order=title&page=${pageNum}`;
    const { data, hasNextPage, maxPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getZa(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/manga/?order=titlereverse&page=${pageNum}`;
    const { data, hasNextPage, maxPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const order = this._resolveOrder(options.order || options.sort || 'update');
    const status = String(options.status || '').toLowerCase();
    const type = String(options.type || '').toLowerCase();

    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (type) params.set('type', type);
    params.set('order', order);
    params.set('page', pageNum);

    const url = `${this.baseUrl}/manga/?${params.toString()}`;
    const { data, hasNextPage, maxPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

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
    const { hasNextPage, maxPage } = this._parsePagination($);
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
   * Get genre catalog from /manga/ filter form.
   * Returns [{ name, slug, id }]. Cached 24h.
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

    $('input[name="genre[]"]').each((_, el) => {
      const id = $(el).val();
      if (!id || seen.has(id)) return;
      seen.add(id);
      const label =
        $(`label[for="${$(el).attr('id')}"]`).text().trim() ||
        $(el).next('label').text().trim() ||
        $(el).closest('li').text().trim();
      if (!label) return;
      const slug = label.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      genres.push({ name: label, slug, id });
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

    const order = this._resolveOrder(options.order || options.sort || 'update');
    const genres = await this.getGenres();

    // Support comma-separated genres
    const keys = cleanGenre.split(',').map((g) => g.trim()).filter(Boolean);
    const found = keys.map((key) => {
      const match = genres.find(
        (g) => g.slug === key || g.name.toLowerCase() === key || g.id === key
      );
      if (!match) throw createNotFound(`Genre '${key}' tidak ditemukan di Apkomik`, 'NOT_FOUND');
      return match;
    });

    const genreParams = found.map((g) => `genre%5B%5D=${g.id}`).join('&');
    const url = `${this.baseUrl}/manga/?${genreParams}&order=${order}&page=${pageNum}`;
    const html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { hasNextPage, maxPage } = this._parsePagination($);

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

    const order = this._resolveOrder(options.order || options.sort || 'update');
    const url = `${this.baseUrl}/manga/?type=${encodeURIComponent(cleanType)}&order=${order}&page=${pageNum}`;
    const { data, hasNextPage, maxPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, type: cleanType, page: pageNum, maxPage, hasNextPage, data };
  }

  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    const url = `${this.baseUrl}/manga/${cleanSlug}/`;
    let html;
    try {
      html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    } catch (err) {
      if (err.statusCode === 404) {
        throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di Apkomik`, 'NOT_FOUND');
      }
      throw err;
    }

    const $ = cheerio.load(html);

    // Title
    const title = $('div.infox h1.entry-title[itemprop="name"]').text().trim() || cleanSlug;

    // Alt title
    const altTitle =
      $('div.infox div.wd-full')
        .filter((_, el) => $(el).find('b').text().toLowerCase().includes('alternative'))
        .find('span')
        .text()
        .trim() || null;

    // Cover
    const rawCover = $('div.thumbook div.thumb img').attr('src') || '';
    const cover = this._cleanCoverUrl(rawCover);

    // Synopsis
    const synopsis =
      $('div.infox div.entry-content-single[itemprop="description"] p').first().text().trim() ||
      $('div.infox div.entry-content-single[itemprop="description"]').text().trim() ||
      $('meta[property="og:description"]').attr('content') ||
      null;

    // Status & Type from div.tsinfo .imptdt
    let status = 'ongoing';
    let type = null;
    $('div.tsinfo .imptdt').each((_, el) => {
      const text = $(el).text().trim();
      if (text.toLowerCase().startsWith('status')) {
        status = $(el).find('i').text().trim().toLowerCase() || 'ongoing';
      } else if (text.toLowerCase().startsWith('type')) {
        type = $(el).find('a').text().trim().toLowerCase() || null;
      }
    });

    // Author / Year from div.flex-wrap div.fmed
    let author = null;
    let year = null;
    $('div.flex-wrap div.fmed').each((_, el) => {
      const label = $(el).find('b').text().trim().toLowerCase();
      const value = $(el).find('span').text().trim();
      if (!value || value === '-') return;
      if (label === 'author') author = value;
      else if (label === 'released') {
        const m = value.match(/\d{4}/);
        if (m) year = m[0];
      }
    });

    // Rating — from aggregateRating block on detail page
    const ratingRaw =
      $('[itemprop="ratingValue"]').attr('content') ||
      $('[itemprop="ratingValue"]').text().trim();
    const rating = ratingRaw && !isNaN(parseFloat(ratingRaw)) ? parseFloat(ratingRaw) : null;

    // Genres — from span.mgen a[rel="tag"], with slug from href
    const genres = [];
    $('div.infox span.mgen a[rel="tag"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const match = href.match(/\/genres\/([^/]+)\/?$/);
      const genreSlug = match ? match[1] : $(el).text().trim().toLowerCase().replace(/\s+/g, '-');
      genres.push({ name: $(el).text().trim(), slug: genreSlug });
    });

    // Chapter list — #chapterlist > ul > li[data-num] (no clstyle class)
    const chapters = [];
    $('#chapterlist > ul > li[data-num]').each((_, el) => {
      const a = $(el).find('.eph-num a');
      const href = a.attr('href') || '';
      const chNumText = $(el).find('.chapternum').text().trim();
      const chDate = $(el).find('.chapterdate').text().trim() || null;
      const chNum = parseFloat($(el).attr('data-num'));
      if (!href) return;

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
          const relSlug = this._slugFromDetailUrl(href);
          if (!relSlug) return;
          const relTitle = $(card).find('.tt').text().trim();
          const rawRelCover = $(card).find('.limit img').first().attr('src') || '';
          const relCover = this._cleanCoverUrl(rawRelCover);
          const relType = $(card).find('span.type').text().trim().toLowerCase() || null;
          const relRatingRaw = $(card).find('.numscore').text().trim();
          const relRating = relRatingRaw && !isNaN(parseFloat(relRatingRaw)) ? parseFloat(relRatingRaw) : null;
          related.push({ title: relTitle, slug: relSlug, cover: relCover, type: relType, rating: relRating });
        });
      }
    });

    return {
      source: this.name,
      title,
      altTitle,
      cover,
      synopsis,
      status,
      type,
      author: author || null,
      artist: null,
      year: year || null,
      rating,
      genres,
      totalChapters: chapters.length,
      chapters,
      related,
    };
  }

  /**
   * Resolve chapter URL by matching chapter number from detail page.
   * Uses parseFloat for exact numeric matching.
   * @private
   */
  async _resolveChapterUrl(mangaSlug, chapterNum) {
    const details = await this.getDetails(mangaSlug);
    const target = details.chapters.find((ch) => {
      const m = ch.title.match(/Chapter\s+([0-9.]+)/i);
      return m && parseFloat(m[1]) === parseFloat(chapterNum);
    });
    if (!target) {
      throw createNotFound(
        `Chapter '${chapterNum}' tidak ditemukan untuk manga '${mangaSlug}'`,
        'NOT_FOUND'
      );
    }
    return target.slug; // full chapter href
  }

  async getPages(slug, chapter, server = 1) {
    const serverIdx = Math.max(0, (parseInt(server, 10) || 1) - 1);
    const rawSlug = String(slug || '').trim();
    const rawChapter = String(chapter || '').trim();
    if (!rawSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    let chapterUrl;

    if (rawSlug.startsWith('http')) {
      // Full URL passed directly (e.g. from chapter list endpoint)
      chapterUrl = rawSlug;
    } else {
      // Resolve from detail page chapter list (apkomik chapter URLs are non-trivial)
      const chNum = rawChapter.replace(/^chapter-?/i, '');
      chapterUrl = await this._resolveChapterUrl(rawSlug, chNum);
    }

    let html;
    try {
      html = await getHtml(chapterUrl, { headers: { Referer: `${this.baseUrl}/` } });
    } catch (err) {
      if (err.statusCode === 404) {
        throw createNotFound(`Chapter tidak ditemukan di Apkomik: ${chapterUrl}`, 'NOT_FOUND');
      }
      throw err;
    }

    // Extract ts_reader.run({...}) JSON from inline <script>
    const match = html.match(/ts_reader\.run\s*\(\s*(\{[\s\S]*?\})\s*\)\s*;/);
    if (!match) {
      throw createBadGateway(
        'Gagal menemukan data gambar chapter dari Apkomik (ts_reader not found)',
        'UPSTREAM_ERROR'
      );
    }

    let tsData;
    try {
      tsData = JSON.parse(match[1]);
    } catch (err) {
      throw createBadGateway(
        `Gagal memproses data gambar chapter dari Apkomik: ${err.message}`,
        'UPSTREAM_ERROR'
      );
    }

    const sources = tsData.sources || [];
    if (sources.length === 0) {
      throw createBadGateway('Tidak ada sumber gambar yang tersedia untuk chapter ini', 'UPSTREAM_ERROR');
    }

    const pickedServer = sources[Math.min(serverIdx, sources.length - 1)];
    const images = pickedServer?.images || [];
    if (images.length === 0) {
      throw createBadGateway('Tidak ada gambar yang tersedia di server ini', 'UPSTREAM_ERROR');
    }

    const pages = images.map((imgUrl, index) => ({
      page: index + 1,
      url: imgUrl,
      directUrl: imgUrl,
      proxyUrl: `/api/proxy/image?url=${encodeURIComponent(imgUrl)}&referer=${encodeURIComponent(`${this.baseUrl}/`)}`,
    }));

    // Title from page <title>
    const $ = cheerio.load(html);
    const pageTitle = $('title').text()
      .replace(/\s*[-–|]\s*APKOMIK\s*/gi, '')
      .replace(/\s*Bahasa Indonesia\s*/gi, '')
      .trim();

    return {
      source: this.name,
      title: pageTitle,
      totalPages: pages.length,
      pages,
    };
  }
}

module.exports = ApkomikSource;
