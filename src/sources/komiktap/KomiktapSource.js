const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');
const { formatPagination } = require('../../utils/responseHelper');

/**
 * KomikTap Scraper Source for manga-api.
 * Website: https://komiktap.info/
 * Engine: WordPress + MangaReader Theme (same architecture as Kotatsu Redo KomikTapParser).
 */
class KomiktapSource extends BaseSource {
  constructor() {
    super('komiktap', 'KomikTap');
    this.domain = 'komiktap.info';
    this.baseUrl = `https://${this.domain}`;
    this.icon = `https://komiktap.info/wp-content/uploads/2020/09/cropped-LOGOa-32x32.png`;
    this.pageSize = 50;
    this.searchPageSize = 20;

    // Genres cache in memory (24h)
    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;

    // Cache for manga chapters to speed up chapter lookups
    this._mangaCache = new Map();
  }

  /**
   * Supported sorts for KomikTap.
   * Matches the radio order options in KomikTap's MangaReader theme filters.
   */
  getSupportedSorts() {
    return [
      { id: 'latest', name: 'Terbaru' },
      { id: 'newest', name: 'Diperbarui' },
      { id: 'popular', name: 'Populer' },
      { id: 'az', name: 'A-Z' },
      { id: 'za', name: 'Z-A' },
    ];
  }

  /**
   * Normalize sort options to KomikTap's URL query parameter.
   * @param {Object} [options]
   * @returns {{ orderParam: string, sortId: string }}
   * @private
   */
  _normalizeOrder(options = {}) {
    const rawSort = String(options.sort || options.orderby || options.order || 'latest')
      .toLowerCase()
      .trim();

    if (rawSort === 'popular' || rawSort === 'popularity') {
      return { orderParam: 'popular', sortId: 'popular' };
    }
    if (rawSort === 'newest' || rawSort === 'latest' || rawSort === 'updated') {
      return { orderParam: 'update', sortId: 'newest' };
    }
    if (rawSort === 'az' || rawSort === 'a-z' || rawSort === 'title') {
      return { orderParam: 'title', sortId: 'az' };
    }
    if (rawSort === 'za' || rawSort === 'z-a' || rawSort === 'titlereverse') {
      return { orderParam: 'titlereverse', sortId: 'za' };
    }
    // Default: latest released (order=latest)
    return { orderParam: 'latest', sortId: 'update' };
  }

  /**
   * Parse manga cards from KomikTap list HTML (.listupd .bs, .listupd .bsx).
   * @param {string} html
   * @returns {Array<Object>}
   * @private
   */
  _parseMangaList(html) {
    const $ = cheerio.load(html);
    const items = [];
    const seenSlugs = new Set();

    $('.listupd .bs, .listupd .bsx').each((_, el) => {
      const $el = $(el);
      const a = $el.find('a').first();
      const href = a.attr('href') || '';
      if (!href) return;

      const slugMatch = href.match(/\/manga\/([^/]+)/);
      const slug = slugMatch ? slugMatch[1] : '';
      if (!slug || seenSlugs.has(slug)) return;
      seenSlugs.add(slug);

      const title =
        $el.find('.tt').text().trim() ||
        a.attr('title') ||
        $el.find('h4').text().trim() ||
        slug;

      const imgEl = $el.find('img.ts-post-image, img.wp-post-image, img').first();
      let cover = imgEl.attr('src') || imgEl.attr('data-src') || imgEl.attr('data-lazy-src') || '';
      if (cover) {
        // Remove thumbnail dimension suffixes to retrieve the original high-resolution cover
        cover = cover.replace(/-\d+x\d+(\.[a-zA-Z0-9]+)$/, '$1');
      }

      // Type identification
      let type = 'manga';
      const typeSpan = $el.find('span[class*="type"], span.type');
      const typeClass = (typeSpan.attr('class') || '').toLowerCase();
      const typeText = typeSpan.text().trim().toLowerCase();
      if (typeClass.includes('manhwa') || typeText.includes('manhwa')) {
        type = 'manhwa';
      } else if (typeClass.includes('manhua') || typeText.includes('manhua')) {
        type = 'manhua';
      } else if (typeClass.includes('comic') || typeText.includes('comic')) {
        type = 'comic';
      } else if (typeClass.includes('novel') || typeText.includes('novel')) {
        type = 'novel';
      }

      // Latest Chapter
      let latestChapter = null;
      const chapterText = $el.find('.epxs, .chapter').first().text().trim();
      if (chapterText) {
        const match = chapterText.match(/Chapter\s+([0-9.]+)/i);
        latestChapter = match ? match[1] : chapterText.replace(/.*?Chapter\s*/i, '').trim();
      }

      // Rating
      let rating = null;
      const ratingText = $el.find('.numscore, .rating').first().text().trim();
      if (ratingText && !isNaN(parseFloat(ratingText))) {
        rating = parseFloat(ratingText);
      }

      // Status
      let status = null;
      const statusText = $el.find('.status, .bt .status').text().trim().toLowerCase();
      if (statusText.includes('completed') || statusText.includes('tamat')) {
        status = 'completed';
      } else if (statusText.includes('ongoing') || statusText.includes('berjalan')) {
        status = 'ongoing';
      } else if (statusText.includes('hiatus')) {
        status = 'hiatus';
      }

      items.push({
        title,
        slug,
        cover: cover || null,
        type,
        latestChapter: latestChapter || null,
        updatedAt: null,
        status,
        rating,
      });
    });

    return items;
  }

  /**
   * Parse pagination metadata from KomikTap HTML.
   * Supports both .hpage (MangaReader theme catalog) and .pagination (search / taxonomy archives).
   * @param {import('cheerio').Root} $
   * @param {number} currentPage
   * @param {number} itemsCount
   * @returns {{ page: number, maxPage?: number, hasNextPage: boolean }}
   * @private
   */
  _parsePagination($, currentPage, itemsCount) {
    let hasNextPage = false;
    let maxPage = undefined;

    // 1. Check .pagination (present on search results and genre archives)
    const paginationEl = $('.pagination').first();
    if (paginationEl.length > 0) {
      const nextLink = paginationEl.find('a.next, a:contains("Berikutnya"), a:contains("Next")');
      if (nextLink.length > 0) {
        hasNextPage = true;
      }

      let maxPageFound = 1;
      paginationEl.find('a.page-numbers, span.page-numbers').each((_, el) => {
        const text = $(el).text().trim();
        const num = parseInt(text, 10);
        if (!isNaN(num) && num > maxPageFound) {
          maxPageFound = num;
        }
      });
      if (maxPageFound > 1) {
        maxPage = maxPageFound;
      }
    } else {
      // 2. Check .hpage (present on /manga/ catalog)
      const hpageEl = $('.hpage').first();
      if (hpageEl.length > 0) {
        const nextLink = hpageEl.find('a.r, a:contains("Next")');
        if (nextLink.length > 0) {
          hasNextPage = true;
        } else {
          hasNextPage = false;
        }
      } else {
        // Fallback based on item count
        hasNextPage = itemsCount >= 20;
      }
    }

    return {
      page: currentPage,
      ...(maxPage ? { maxPage } : {}),
      hasNextPage,
    };
  }

  /**
   * Get latest manga list (order=update).
   * @param {number} page
   * @param {Object} [options]
   */
  async getLatest(page = 1, options = {}) {
    const pageNum = Math.max(1, Number(page) || 1);
    const url = `${this.baseUrl}/manga/?page=${pageNum}&order=update`;

    const html = await getHtml(url, {
      headers: {
        Referer: `${this.baseUrl}/`,
      },
    });

    const items = this._parseMangaList(html);
    const $ = cheerio.load(html);
    const pagination = this._parsePagination($, pageNum, items.length);

    return {
      source: this.name,
      sort: 'latest',
      data: items,
      pagination,
    };
  }

  /**
   * Get popular manga list (order=popular).
   * @param {number} page
   * @param {Object} [options]
   */
  async getPopular(page = 1, options = {}) {
    const pageNum = Math.max(1, Number(page) || 1);
    const url = `${this.baseUrl}/manga/?page=${pageNum}&order=popular`;

    const html = await getHtml(url, {
      headers: {
        Referer: `${this.baseUrl}/`,
      },
    });

    const items = this._parseMangaList(html);
    const $ = cheerio.load(html);
    const pagination = this._parsePagination($, pageNum, items.length);

    return {
      source: this.name,
      sort: 'popular',
      orderby: 'popular',
      data: items,
      pagination,
    };
  }

  /**
   * Get newest updated manga list (order=latest).
   * @param {number} page
   * @param {Object} [options]
   */
  async getNewest(page = 1, options = {}) {
    const pageNum = Math.max(1, Number(page) || 1);
    const url = `${this.baseUrl}/manga/?page=${pageNum}&order=latest`;

    const html = await getHtml(url, {
      headers: {
        Referer: `${this.baseUrl}/`,
      },
    });

    const items = this._parseMangaList(html);
    const $ = cheerio.load(html);
    const pagination = this._parsePagination($, pageNum, items.length);

    return {
      source: this.name,
      sort: 'newest',
      orderby: 'update',
      data: items,
      pagination,
    };
  }

  /**
   * Get alphabetical A-Z manga list (order=title).
   * @param {number} page
   */
  async getAz(page = 1) {
    const pageNum = Math.max(1, Number(page) || 1);
    const url = `${this.baseUrl}/manga/?page=${pageNum}&order=title`;

    const html = await getHtml(url, {
      headers: {
        Referer: `${this.baseUrl}/`,
      },
    });

    const items = this._parseMangaList(html);
    const $ = cheerio.load(html);
    const pagination = this._parsePagination($, pageNum, items.length);

    return {
      source: this.name,
      sort: 'az',
      orderby: 'title',
      order: 'asc',
      data: items,
      pagination,
    };
  }

  /**
   * Get alphabetical Z-A manga list (order=titlereverse).
   * @param {number} page
   */
  async getZa(page = 1) {
    const pageNum = Math.max(1, Number(page) || 1);
    const url = `${this.baseUrl}/manga/?page=${pageNum}&order=titlereverse`;

    const html = await getHtml(url, {
      headers: {
        Referer: `${this.baseUrl}/`,
      },
    });

    const items = this._parseMangaList(html);
    const $ = cheerio.load(html);
    const pagination = this._parsePagination($, pageNum, items.length);

    return {
      source: this.name,
      sort: 'za',
      orderby: 'title',
      order: 'desc',
      data: items,
      pagination,
    };
  }

  /**
   * Search manga by keyword query.
   * @param {string} query
   * @param {number} page
   */
  async search(query, page = 1) {
    const cleanQuery = String(query || '').trim();
    if (!cleanQuery) {
      throw createBadRequest("Parameter pencarian 'q' tidak boleh kosong", 'INVALID_PARAMETER');
    }

    const pageNum = Math.max(1, Number(page) || 1);
    const url =
      pageNum > 1
        ? `${this.baseUrl}/page/${pageNum}/?s=${encodeURIComponent(cleanQuery)}`
        : `${this.baseUrl}/?s=${encodeURIComponent(cleanQuery)}`;

    const html = await getHtml(url, {
      headers: {
        Referer: `${this.baseUrl}/`,
      },
    });

    const items = this._parseMangaList(html);
    const $ = cheerio.load(html);
    const pagination = this._parsePagination($, pageNum, items.length);

    return {
      source: this.name,
      query: cleanQuery,
      data: items,
      pagination,
    };
  }

  /**
   * Split and flatten genre input (string with comma/plus or array of strings) into individual tokens.
   * @param {string|Array<string>} input
   * @returns {Array<string>}
   * @private
   */
  _parseGenreTokens(input) {
    if (!input) return [];
    const list = Array.isArray(input) ? input : [input];
    const tokens = [];

    for (const item of list) {
      if (!item) continue;
      const parts = String(item).split(/[,+]/);
      for (const p of parts) {
        const trimmed = p.trim();
        if (trimmed && !tokens.includes(trimmed)) {
          tokens.push(trimmed);
        }
      }
    }
    return tokens;
  }

  /**
   * Resolve genre tokens (IDs, slugs, or names) to official KomikTap genre objects with IDs.
   * @param {Array<string>} tokens
   * @returns {Promise<Array<{id: string, name: string, slug: string}>>}
   * @private
   */
  async _resolveGenres(tokens) {
    const allGenres = await this.getGenres();
    const resolved = [];
    const seenIds = new Set();

    for (const token of tokens) {
      const clean = token.trim();
      if (!clean) continue;
      const lower = clean.toLowerCase();
      const slugified = lower.replace(/\s+/g, '-');
      const normalizedAlpha = lower.replace(/[^a-z0-9]/g, '');

      // 1. Direct ID match
      let matched = allGenres.find((g) => g.id === clean);

      // 2. Slug match
      if (!matched) {
        matched = allGenres.find(
          (g) => g.slug.toLowerCase() === lower || g.slug.toLowerCase() === slugified
        );
      }

      // 3. Name match
      if (!matched) {
        matched = allGenres.find((g) => g.name.toLowerCase() === lower);
      }

      // 4. Normalized alphanumeric match (e.g. 'bigass' vs 'big-ass')
      if (!matched) {
        matched = allGenres.find(
          (g) =>
            g.slug.toLowerCase().replace(/[^a-z0-9]/g, '') === normalizedAlpha ||
            g.name.toLowerCase().replace(/[^a-z0-9]/g, '') === normalizedAlpha
        );
      }

      if (matched) {
        if (!seenIds.has(matched.id)) {
          seenIds.add(matched.id);
          resolved.push({
            id: matched.id,
            name: matched.name,
            slug: matched.slug,
          });
        }
      } else {
        // Fallback: use token directly if not in list
        const fallbackId = clean;
        if (!seenIds.has(fallbackId)) {
          seenIds.add(fallbackId);
          resolved.push({
            id: fallbackId,
            name: clean,
            slug: slugified || fallbackId,
          });
        }
      }
    }

    return resolved;
  }

  /**
   * Get flexible list with custom filters (sort, order, genre, status, type).
   * @param {number} page
   * @param {Object} [options]
   */
  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, Number(page) || 1);
    const { orderParam, sortId } = this._normalizeOrder(options);

    const queryParams = new URLSearchParams();
    queryParams.set('page', String(pageNum));
    queryParams.set('order', orderParam);

    if (options.status) {
      queryParams.set('status', String(options.status).toLowerCase().trim());
    }
    if (options.type) {
      queryParams.set('type', String(options.type).toLowerCase().trim());
    }
    if (options.genre || options.genres) {
      const rawGenres = options.genre || options.genres;
      const tokens = this._parseGenreTokens(rawGenres);
      const resolved = await this._resolveGenres(tokens);
      for (const g of resolved) {
        queryParams.append('genre[]', g.id);
      }
    }

    const url = `${this.baseUrl}/manga/?${queryParams.toString()}`;
    const html = await getHtml(url, {
      headers: {
        Referer: `${this.baseUrl}/`,
      },
    });

    const items = this._parseMangaList(html);
    const $ = cheerio.load(html);
    const pagination = this._parsePagination($, pageNum, items.length);

    return {
      source: this.name,
      sort: sortId,
      orderby: orderParam,
      data: items,
      pagination,
    };
  }

  /**
   * Get all available genres from KomikTap's filter list.
   * Cached in memory for 24 hours.
   */
  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) {
      return this._cachedGenres;
    }

    try {
      const html = await getHtml(`${this.baseUrl}/manga/`, {
        headers: { Referer: `${this.baseUrl}/` },
      });
      const $ = cheerio.load(html);
      const genres = [];
      const seen = new Set();

      $('ul.genrez li').each((_, el) => {
        const name = $(el).text().trim();
        const inputVal = $(el).find('input').val();
        if (!name || !inputVal) return;

        // Clean slug representation from genre name
        const slug = name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');

        if (!seen.has(inputVal)) {
          seen.add(inputVal);
          genres.push({
            name,
            slug: slug || inputVal,
            id: inputVal,
          });
        }
      });

      if (genres.length > 0) {
        this._cachedGenres = genres;
        this._cachedGenresExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
        return genres;
      }
    } catch (_) {}

    // Fallback standard genres if scraping fails
    return [
      { name: 'Action', slug: 'action', id: '107' },
      { name: 'Adult', slug: 'adult', id: '2' },
      { name: 'Drama', slug: 'drama', id: '3' },
      { name: 'Harem', slug: 'harem', id: '6' },
      { name: 'Mature', slug: 'mature', id: '8' },
      { name: 'Romance', slug: 'romance', id: '9' },
      { name: 'Seinen', slug: 'seinen', id: '13' },
    ];
  }

  /**
   * Get manga by genre.
   * Uses KomikTap's genre filter (?genre[]=...) which supports full sorting and pagination.
   * @param {string} genre
   * @param {number} page
   * @param {Object} [options]
   */
  /**
   * Get manga by genre(s).
   * Supports single genre or multi-genre (comma/plus separated or array).
   * Uses KomikTap's genre filter (?genre[]=...) which supports full multi-genre, sorting, and pagination.
   * @param {string|Array<string>} genre
   * @param {number} page
   * @param {Object} [options]
   */
  async getByGenre(genre, page = 1, options = {}) {
    const tokens = this._parseGenreTokens([genre, options.genre, options.genres]);
    if (tokens.length === 0) {
      throw createBadRequest("Parameter 'genre' tidak boleh kosong", 'INVALID_PARAMETER');
    }

    const pageNum = Math.max(1, Number(page) || 1);
    const { orderParam, sortId } = this._normalizeOrder(options);
    const resolved = await this._resolveGenres(tokens);

    const queryParams = new URLSearchParams();
    queryParams.set('page', String(pageNum));
    queryParams.set('order', orderParam);

    if (options.status) {
      queryParams.set('status', String(options.status).toLowerCase().trim());
    }
    if (options.type) {
      queryParams.set('type', String(options.type).toLowerCase().trim());
    }

    for (const g of resolved) {
      queryParams.append('genre[]', g.id);
    }

    const url = `${this.baseUrl}/manga/?${queryParams.toString()}`;
    const html = await getHtml(url, {
      headers: { Referer: `${this.baseUrl}/` },
    });

    const items = this._parseMangaList(html);
    const $ = cheerio.load(html);
    const pagination = this._parsePagination($, pageNum, items.length);

    return {
      source: this.name,
      genre: resolved.map((g) => g.slug).join(','),
      genres: resolved.map((g) => ({ id: g.id, name: g.name, slug: g.slug })),
      sort: sortId,
      orderby: orderParam,
      data: items,
      pagination,
    };
  }

  /**
   * Get supported comic types for KomikTap.
   */
  async getTypes() {
    return ['manga', 'manhwa', 'manhua', 'comic'];
  }

  /**
   * Get manga by type (manga, manhwa, manhua, comic).
   * @param {string} type
   * @param {number} page
   * @param {Object} [options]
   */
  async getByType(type, page = 1, options = {}) {
    const cleanType = String(type || '').toLowerCase().trim();
    if (!cleanType) {
      throw createBadRequest("Parameter 'type' tidak boleh kosong", 'INVALID_PARAMETER');
    }

    const pageNum = Math.max(1, Number(page) || 1);
    const { orderParam, sortId } = this._normalizeOrder(options);

    const queryParams = new URLSearchParams();
    queryParams.set('type', cleanType);
    queryParams.set('page', String(pageNum));
    queryParams.set('order', orderParam);

    if (options.status) {
      queryParams.set('status', String(options.status).toLowerCase().trim());
    }
    if (options.genre || options.genres) {
      const rawGenres = options.genre || options.genres;
      const tokens = this._parseGenreTokens(rawGenres);
      const resolved = await this._resolveGenres(tokens);
      for (const g of resolved) {
        queryParams.append('genre[]', g.id);
      }
    }

    const url = `${this.baseUrl}/manga/?${queryParams.toString()}`;
    const html = await getHtml(url, {
      headers: { Referer: `${this.baseUrl}/` },
    });

    const items = this._parseMangaList(html);
    const $ = cheerio.load(html);
    const pagination = this._parsePagination($, pageNum, items.length);

    return {
      source: this.name,
      type: cleanType,
      sort: sortId,
      orderby: orderParam,
      data: items,
      pagination,
    };
  }

  /**
   * Get full details and chapters of a manga.
   * @param {string} slug
   */
  async getDetails(slug) {
    const cleanSlug = String(slug || '')
      .replace(/^\/+|\/+$/g, '')
      .replace(/^manga\//, '')
      .split('/')[0];

    if (!cleanSlug) {
      throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');
    }

    const url = `${this.baseUrl}/manga/${cleanSlug}/`;
    let html;
    try {
      html = await getHtml(url, {
        headers: { Referer: `${this.baseUrl}/` },
      });
    } catch (err) {
      if (err.statusCode === 404) {
        throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di KomikTap`, 'NOT_FOUND');
      }
      throw err;
    }

    const $ = cheerio.load(html);

    const title =
      $('h1.entry-title').first().text().trim() ||
      $('.entry-title').first().text().trim() ||
      $('h1').first().text().trim() ||
      cleanSlug;

    // Alternative Title
    const altTitleText = $('.spe span:contains("Alternative"), .desktop-titles, .seriestualt')
      .first()
      .text()
      .trim();
    const altTitle = altTitleText
      ? altTitleText.replace(/Alternative\s*:\s*/i, '').trim()
      : null;

    // Cover Image
    let cover =
      $('.thumb img').first().attr('src') ||
      $('.thumb img').first().attr('data-src') ||
      $('img.wp-post-image').first().attr('src') ||
      null;
    if (cover) {
      cover = cover.replace(/-\d+x\d+(\.[a-zA-Z0-9]+)$/, '$1');
    }

    // Synopsis
    let synopsis =
      $('.entry-content[itemprop="description"] p, .entry-content p, .desc')
        .first()
        .text()
        .trim() || null;
    if (!synopsis) {
      synopsis =
        $('.entry-content[itemprop="description"], .entry-content-single, .entry-content, .desc, .sinopsis')
          .first()
          .text()
          .trim() || null;
    }

    // Metadata items (Status, Type, Author, Artist, Released)
    let status = 'ongoing';
    let type = 'manga';
    let released = null;
    let author = null;
    let artist = null;

    $('.tsinfo .imptdt, .infotable tr, .spe span').each((_, el) => {
      const text = $(el).text().trim();
      const lower = text.toLowerCase();

      if (lower.startsWith('status') || lower.includes('status')) {
        const val = text.replace(/status\s*:?/i, '').trim().toLowerCase();
        if (val.includes('completed') || val.includes('tamat')) status = 'completed';
        else if (val.includes('ongoing') || val.includes('berjalan')) status = 'ongoing';
        else if (val.includes('hiatus')) status = 'hiatus';
      } else if (lower.startsWith('type') || lower.includes('tipe')) {
        const val = text.replace(/type|tipe\s*:?/i, '').trim().toLowerCase();
        if (val.includes('manhwa')) type = 'manhwa';
        else if (val.includes('manhua')) type = 'manhua';
        else if (val.includes('comic')) type = 'comic';
        else if (val.includes('novel')) type = 'novel';
      } else if (lower.startsWith('released') || lower.includes('rilis')) {
        released = text.replace(/released|rilis\s*:?/i, '').trim() || null;
      } else if (lower.startsWith('author') || lower.includes('pengarang') || lower.includes('penulis')) {
        author = text.replace(/author|pengarang|penulis\s*:?/i, '').trim() || null;
      } else if (lower.startsWith('artist') || lower.includes('artis')) {
        artist = text.replace(/artist|artis\s*:?/i, '').trim() || null;
      }
    });

    // Rating
    let rating = null;
    const ratingStr = $('.rating .numscore, .rating strong, .numscore').first().text().trim();
    if (ratingStr && !isNaN(parseFloat(ratingStr))) {
      rating = parseFloat(ratingStr);
    }

    // Genres
    const genres = [];
    $('.seriestugenre a, .mgen a, .tax-wrap a').each((_, a) => {
      const gName = $(a).text().trim();
      const gHref = $(a).attr('href') || '';
      const gSlug = gHref.replace(/\/+$/, '').split('/genres/')[1] ||
                    gHref.replace(/\/+$/, '').split('/genre/')[1] ||
                    gName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      if (gName && !genres.some((g) => g.slug === gSlug)) {
        genres.push({ name: gName, slug: gSlug });
      }
    });

    // Chapters list
    const chapters = [];
    $('#chapterlist ul li').each((index, el) => {
      const $li = $(el);
      const a = $li.find('a').first();
      const href = a.attr('href');
      if (!href) return;

      const rawSlug = href.replace(/\/+$/, '').split('/').pop();
      const chNumText = $li.find('.chapternum').text().trim();
      const numMatch = chNumText.match(/Chapter\s+([0-9.]+)/i);
      const chNum = numMatch ? parseFloat(numMatch[1]) : null;

      // Extract a clean chapter slug e.g. "70" or fallback to rawSlug
      const cleanChSlug = chNum !== null && !isNaN(chNum) ? String(chNum) : rawSlug;
      const dateText = $li.find('.chapterdate').text().trim() || null;

      chapters.push({
        id: rawSlug,
        rawSlug,
        slug: cleanChSlug,
        chapterNumber: chNum,
        title: chNumText || `Chapter ${cleanChSlug}`,
        createdAt: dateText,
        url: href.startsWith('http') ? href : `${this.baseUrl}${href.startsWith('/') ? '' : '/'}${href}`,
      });
    });

    // Cache chapters for rapid lookup in getPages
    this._mangaCache.set(cleanSlug, {
      title,
      chapters,
      cachedAt: Date.now(),
    });

    return {
      source: this.name,
      title,
      slug: cleanSlug,
      altTitle,
      cover,
      synopsis,
      status,
      type,
      released,
      author,
      artist,
      rating,
      genres,
      chapters,
    };
  }

  /**
   * Get image pages for a specific chapter.
   * Matches Kotatsu Redo's KomikTapParser extraction logic:
   * 1. ts_reader.run({...}) JSON script
   * 2. data:text/javascript;base64,... encoded script
   * 3. div#readerarea img fallback
   * @param {string} slug Manga slug
   * @param {string|number} chapter Chapter identifier (chapter number or chapter slug)
   */
  async getPages(slug, chapter) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    const rawChapter = String(chapter || '').trim();

    if (!cleanSlug || !rawChapter) {
      throw createBadRequest("Parameter 'slug' dan 'chapter' wajib diisi", 'INVALID_PARAMETER');
    }

    let targetChapterUrl = null;
    let chapterTitle = null;

    // 1. Check memory cache for manga chapters
    let cached = this._mangaCache.get(cleanSlug);
    let chapters = cached?.chapters;
    let mangaTitle = cached?.title;

    if (!chapters || !mangaTitle) {
      const details = await this.getDetails(cleanSlug);
      chapters = details.chapters || [];
      mangaTitle = details.title;
    }

    // 2. Find matching chapter in list
    const cleanChNum = parseFloat(rawChapter.replace(/^chapter-?/i, ''));
    const matched = chapters.find((ch) => {
      if (ch.slug === rawChapter || ch.slug === String(cleanChNum) || ch.rawSlug === rawChapter) return true;
      if (!isNaN(cleanChNum) && ch.chapterNumber === cleanChNum) return true;
      if (ch.rawSlug === `${cleanSlug}-chapter-${rawChapter}` || ch.rawSlug === `${cleanSlug}-chapter-${cleanChNum}`) return true;
      if (ch.url && ch.url.includes(`/${rawChapter}/`)) return true;
      return false;
    });

    if (matched) {
      targetChapterUrl = matched.url;
      chapterTitle = matched.title;
    } else {
      // Direct candidate URLs
      targetChapterUrl = `${this.baseUrl}/${cleanSlug}-chapter-${rawChapter.replace(/^chapter-?/i, '')}/`;
    }

    let html;
    try {
      html = await getHtml(targetChapterUrl, {
        headers: { Referer: `${this.baseUrl}/` },
      });
    } catch (err) {
      if (err.statusCode === 404) {
        throw createNotFound(
          `Chapter '${rawChapter}' untuk manga '${cleanSlug}' tidak ditemukan di KomikTap`,
          'NOT_FOUND'
        );
      }
      throw err;
    }

    const $ = cheerio.load(html);
    const pageH1 = $('h1.entry-title').first().text().trim() || $('h1').first().text().trim();
    let displayTitle = pageH1;
    if (!displayTitle) {
      const cleanChapterTitle = chapterTitle || `Chapter ${rawChapter}`;
      displayTitle = mangaTitle && !cleanChapterTitle.toLowerCase().includes(mangaTitle.toLowerCase())
        ? `${mangaTitle} ${cleanChapterTitle}`
        : cleanChapterTitle;
    } else if (/^\s*chapter\s*[\d.]+\s*$/i.test(displayTitle)) {
      displayTitle = mangaTitle ? `${mangaTitle} ${displayTitle}` : displayTitle;
    }

    let imageUrls = [];

    // Strategy A & B: ts_reader script (plain or base64 data URI)
    $('script').each((_, s) => {
      if (imageUrls.length > 0) return;

      const inlineScript = $(s).html() || '';
      if (inlineScript.includes('ts_reader.run')) {
        const match = inlineScript.match(/ts_reader\.run\((.*?)\);/s);
        if (match) {
          try {
            const data = JSON.parse(match[1]);
            const images = data.sources?.[0]?.images;
            if (Array.isArray(images) && images.length > 0) {
              imageUrls = images;
              return;
            }
          } catch (_) {}
        }
      }

      // Check base64 encoded script tag
      const srcAttr = $(s).attr('src') || '';
      if (srcAttr.startsWith('data:text/javascript;base64,')) {
        try {
          const b64 = srcAttr.replace('data:text/javascript;base64,', '');
          const decoded = Buffer.from(b64, 'base64').toString('utf8');
          if (decoded.includes('ts_reader.run')) {
            const match = decoded.match(/ts_reader\.run\((.*?)\);/s);
            if (match) {
              const data = JSON.parse(match[1]);
              const images = data.sources?.[0]?.images;
              if (Array.isArray(images) && images.length > 0) {
                imageUrls = images;
                return;
              }
            }
          }
        } catch (_) {}
      }
    });

    // Strategy C: Fallback to HTML images in #readerarea
    if (imageUrls.length === 0) {
      $('#readerarea img').each((_, img) => {
        const src =
          $(img).attr('src') ||
          $(img).attr('data-src') ||
          $(img).attr('data-lazy-src');
        if (src && !src.includes('loading.gif') && !src.startsWith('data:image/svg')) {
          imageUrls.push(src);
        }
      });
    }

    // Filter and sanitize images
    const sanitizedImages = imageUrls
      .map((u) => (typeof u === 'string' ? u.trim() : ''))
      .filter((u) => u.startsWith('http://') || u.startsWith('https://'));

    if (sanitizedImages.length === 0) {
      throw createBadGateway(
        `Gagal memuat gambar halaman chapter dari KomikTap (${targetChapterUrl})`,
        'UPSTREAM_ERROR'
      );
    }

    const pages = sanitizedImages.map((imgUrl, index) => {
      const proxyPath = `/api/proxy/image?url=${encodeURIComponent(imgUrl)}`;
      return {
        page: index + 1,
        url: proxyPath,
        directUrl: imgUrl,
        proxyUrl: proxyPath,
      };
    });

    return {
      source: this.name,
      title: displayTitle,
      total: pages.length,
      pages,
    };
  }
}

module.exports = KomiktapSource;
