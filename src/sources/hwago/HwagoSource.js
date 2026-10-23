const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml } = require('../../utils/httpClient');
const { createNotFound, createBadRequest } = require('../../utils/errors');
const { formatPagination } = require('../../utils/responseHelper');

class HwagoSource extends BaseSource {
  constructor() {
    super('hwago', 'Hwago');
    this.domain = '02.hwago.xyz';
    this.baseUrl = `https://${this.domain}`;
    this.icon = 'https://02.hwago.xyz/icons/icon-192x192.png';

    // Genres cache in memory (24h)
    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  /**
   * Parse manga list items from .htg-card elements on browse page.
   * @private
   */
  _parseMangaList($) {
    const items = [];

    $('.htg-card').each((_, el) => {
      const $el = $(el);
      const link = $el.find('a[href^="/comic/"]').first();
      const href = link.attr('href') || '';
      const slug = href.replace(/^\/comic\//, '').replace(/\/$/, '');
      if (!slug) return;

      const rawTitle = $el.find('h3').text().trim();
      const title = rawTitle || slug.replace(/-/g, ' ');
      const img = $el.find('img').first();
      const cover = img.attr('data-src') || img.attr('src') || null;
      const status = $el.find('span.capitalize').text().trim().toLowerCase() || null;

      // Extract latest chapter number from span.font-medium
      const chText = $el.find('span.font-medium').text().trim();
      const chMatch = chText.match(/\d+(\.\d+)?/);
      const latestChapter = chMatch ? chMatch[0] : null;

      items.push({
        title,
        slug,
        cover,
        status,
        latestChapter,
      });
    });

    return items;
  }

  /**
   * Extract pagination metadata from browse page.
   * @private
   */
  _extractPagination($, currentPage) {
    const pageNum = Math.max(1, parseInt(currentPage, 10) || 1);

    // Get maxPage from jump input
    let maxPage = parseInt($('input[data-page-jump]').attr('max'), 10) || null;

    if (!maxPage) {
      // Fallback: look for largest number in pagination links
      $('a[href*="page="]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const match = href.match(/page=(\d+)/);
        if (match) {
          const p = parseInt(match[1], 10);
          if (!maxPage || p > maxPage) maxPage = p;
        }
      });
    }

    const hasNext = maxPage ? pageNum < maxPage : $('a[aria-label="Selanjutnya"]').length > 0;
    const hasPrev = pageNum > 1;

    // Single page result -> omit pagination
    if (!hasPrev && !hasNext && (!maxPage || maxPage <= 1)) {
      return null;
    }

    return {
      page: pageNum,
      ...(maxPage ? { maxPage } : {}),
      nextPage: hasNext ? pageNum + 1 : null,
      prevPage: hasPrev ? pageNum - 1 : null,
    };
  }

  /**
   * Get manga list by specific sort option: 'latest', 'popular', 'rating', 'az'.
   * @param {string} [sort='latest'] Sort type
   * @param {number} [page=1] Page number
   */
  async getBySort(sort = 'latest', page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const validSorts = ['latest', 'popular', 'rating', 'az'];
    const cleanSort = validSorts.includes(String(sort).toLowerCase()) ? String(sort).toLowerCase() : 'latest';

    const url = `${this.baseUrl}/browse?page=${pageNum}&sort=${cleanSort}`;
    const html = await getHtml(url);
    const $ = cheerio.load(html);

    const data = this._parseMangaList($);
    const pagination = this._extractPagination($, pageNum);
    const maxPage = pagination?.maxPage || null;

    if (pageNum > 1 && ((maxPage && pageNum > maxPage) || data.length === 0)) {
      throw createNotFound(
        `Halaman ${pageNum} tidak ditemukan${maxPage ? ` (maksimal halaman ${maxPage})` : ''}`,
        'NOT_FOUND'
      );
    }

    return {
      source: this.name,
      sort: cleanSort,
      data,
      pagination,
      maxPage,
      page: pageNum,
      hasNextPage: pagination ? Boolean(pagination.nextPage) : false,
    };
  }

  /**
   * Get popular manga list from https://02.hwago.xyz/browse?sort=popular
   * @param {number} [page=1] Page number
   * @param {Object} [options={}] Options
   */
  async getPopular(page = 1, options = {}) {
    return this.getBySort(options.sort || 'popular', page);
  }

  /**
   * Get latest updated manga list from https://02.hwago.xyz/browse?sort=latest
   * @param {number} [page=1] Page number
   * @param {Object} [options={}] Options
   */
  async getLatest(page = 1, options = {}) {
    return this.getBySort(options.sort || 'latest', page);
  }

  /**
   * Get top rated manga list from https://02.hwago.xyz/browse?sort=rating
   * @param {number} [page=1] Page number
   */
  async getRating(page = 1) {
    return this.getBySort('rating', page);
  }

  /**
   * Get alphabetical A-Z manga list from https://02.hwago.xyz/browse?sort=az
   * @param {number} [page=1] Page number
   */
  async getAz(page = 1) {
    return this.getBySort('az', page);
  }

  /**
   * Get manga catalog/directory list from https://02.hwago.xyz/browse
   * Supports query options: sort (latest|popular|rating|az), status, genre, type
   * @param {number} [page=1] Page number
   * @param {Object} [options={}] Filter options
   */
  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const params = new URLSearchParams();
    params.set('page', pageNum);

    const sort = options.sort || options.sortBy || options.order;
    if (sort) {
      params.set('sort', String(sort).toLowerCase());
    }

    const status = options.status;
    if (status) {
      params.set('status', String(status).toLowerCase());
    }

    const type = options.type || options.tipe;
    if (type) {
      params.set('type', String(type).toLowerCase());
    }

    const genre = options.genre;
    if (genre) {
      params.set('genre', String(genre).toLowerCase());
    }

    const url = `${this.baseUrl}/browse?${params.toString()}`;
    const html = await getHtml(url);
    const $ = cheerio.load(html);

    const data = this._parseMangaList($);
    const pagination = this._extractPagination($, pageNum);
    const maxPage = pagination?.maxPage || null;

    if (pageNum > 1 && ((maxPage && pageNum > maxPage) || data.length === 0)) {
      throw createNotFound(
        `Halaman ${pageNum} tidak ditemukan${maxPage ? ` (maksimal halaman ${maxPage})` : ''}`,
        'NOT_FOUND'
      );
    }

    return {
      source: this.name,
      from: 'https://02.hwago.xyz/browse',
      ...(sort ? { sort: String(sort).toLowerCase() } : {}),
      ...(status ? { status: String(status).toLowerCase() } : {}),
      ...(type ? { type: String(type).toLowerCase() } : {}),
      ...(genre ? { genre: String(genre).toLowerCase() } : {}),
      data,
      pagination,
      maxPage,
      page: pageNum,
      hasNextPage: pagination ? Boolean(pagination.nextPage) : false,
    };
  }

  /**
   * Search manga by keyword from https://02.hwago.xyz/browse?q=:query
   * @param {string} query Search query
   * @param {number} [page=1] Page number
   */
  async search(query, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/browse?page=${pageNum}&q=${encodeURIComponent(query)}`;
    const html = await getHtml(url);
    const $ = cheerio.load(html);

    const data = this._parseMangaList($);
    const pagination = this._extractPagination($, pageNum);
    const maxPage = pagination?.maxPage || null;

    if (pageNum > 1 && ((maxPage && pageNum > maxPage) || data.length === 0)) {
      throw createNotFound(
        `Halaman ${pageNum} tidak ditemukan untuk pencarian '${query}'${maxPage ? ` (maksimal halaman ${maxPage})` : ''}`,
        'NOT_FOUND'
      );
    }

    return {
      source: this.name,
      query,
      data,
      pagination,
      maxPage,
      page: pageNum,
      hasNextPage: pagination ? Boolean(pagination.nextPage) : false,
    };
  }

  /**
   * Get list of all available genres in Hwago.
   */
  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) {
      return this._cachedGenres;
    }

    const html = await getHtml(`${this.baseUrl}/browse`);
    const $ = cheerio.load(html);
    const genres = [];

    $('.bf-genre-cb').each((_, el) => {
      const val = $(el).attr('value');
      if (!val) return;
      const slug = val.trim().toLowerCase();
      const rawName = $(el).closest('label').attr('data-bf-genre-name') || $(el).parent().text().trim() || slug;
      const name = rawName
        .split(/[\s-]+/)
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(' ');

      if (!genres.some((g) => g.slug === slug)) {
        genres.push({ name, slug });
      }
    });

    this._cachedGenres = genres;
    this._cachedGenresExpiresAt = Date.now() + 24 * 60 * 60 * 1000; // cache for 24 hours
    return genres;
  }

  /**
   * Resolve genre input to valid slug.
   * @private
   */
  async _resolveGenreSlug(inputGenre) {
    if (!inputGenre || typeof inputGenre !== 'string') return inputGenre;
    const raw = inputGenre.trim().toLowerCase();
    const cleanNoSpecial = raw.replace(/[\s\-_()]+/g, '');

    try {
      const genres = await this.getGenres();
      const match = genres.find((g) => {
        const gNameClean = g.name.toLowerCase().replace(/[\s\-_()]+/g, '');
        const gSlugClean = g.slug.toLowerCase().replace(/[\s\-_()]+/g, '');
        return (
          g.slug === raw ||
          g.name.toLowerCase() === raw ||
          gSlugClean === cleanNoSpecial ||
          gNameClean === cleanNoSpecial
        );
      });
      if (match) return match.slug;
    } catch (_) {}

    return raw;
  }

  /**
   * Get manga list filtered by genre from https://02.hwago.xyz/browse?genre=:genre
   * @param {string} genre Genre name or slug (e.g. 'action', 'romance', 'adult')
   * @param {number} [page=1] Page number
   */
  async getByGenre(genre, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const rawGenre = String(genre || '').trim();
    if (!rawGenre) {
      throw createBadRequest("Parameter 'genre' wajib diisi", 'INVALID_PARAMETER');
    }

    const targetSlug = await this._resolveGenreSlug(rawGenre);
    const url = `${this.baseUrl}/browse?page=${pageNum}&genre=${encodeURIComponent(targetSlug)}`;
    const html = await getHtml(url);
    const $ = cheerio.load(html);

    const data = this._parseMangaList($);
    const pagination = this._extractPagination($, pageNum);
    const maxPage = pagination?.maxPage || null;

    if (pageNum > 1 && ((maxPage && pageNum > maxPage) || data.length === 0)) {
      throw createNotFound(
        `Halaman ${pageNum} tidak ditemukan untuk genre '${rawGenre}'${maxPage ? ` (maksimal halaman ${maxPage})` : ''}`,
        'NOT_FOUND'
      );
    }

    return {
      source: this.name,
      genre: targetSlug,
      data,
      pagination,
      maxPage,
      page: pageNum,
      hasNextPage: pagination ? Boolean(pagination.nextPage) : false,
    };
  }

  /**
   * Get list of supported comic types for Hwago.
   */
  async getTypes() {
    return ['manga', 'manhwa', 'manhua'];
  }

  /**
   * Get manga list filtered by type ('manga', 'manhwa', 'manhua') from https://02.hwago.xyz/browse?type=:type
   * @param {string} type Comic type ('manga', 'manhwa', 'manhua')
   * @param {number} [page=1] Page number
   */
  async getByType(type, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanType = String(type || '').trim().toLowerCase();
    const validTypes = await this.getTypes();
    if (!validTypes.includes(cleanType)) {
      throw createBadRequest(
        `Tipe '${cleanType}' tidak valid. Pilihan tersedia: ${validTypes.join(', ')}`,
        'INVALID_PARAMETER'
      );
    }

    const url = `${this.baseUrl}/browse?page=${pageNum}&type=${encodeURIComponent(cleanType)}`;
    const html = await getHtml(url);
    const $ = cheerio.load(html);

    const data = this._parseMangaList($);
    const pagination = this._extractPagination($, pageNum);
    const maxPage = pagination?.maxPage || null;

    if (pageNum > 1 && ((maxPage && pageNum > maxPage) || data.length === 0)) {
      throw createNotFound(
        `Halaman ${pageNum} tidak ditemukan untuk tipe '${cleanType}'${maxPage ? ` (maksimal halaman ${maxPage})` : ''}`,
        'NOT_FOUND'
      );
    }

    return {
      source: this.name,
      type: cleanType,
      data,
      pagination,
      maxPage,
      page: pageNum,
      hasNextPage: pagination ? Boolean(pagination.nextPage) : false,
    };
  }

  /**
   * Get complete manga details, synopsis, chapters, and similar comics from https://02.hwago.xyz/comic/:slug
   * @param {string} slug Manga slug (e.g. 'lust', 'love-zero')
   */
  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    if (!cleanSlug) {
      throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');
    }

    const url = `${this.baseUrl}/comic/${cleanSlug}`;
    const html = await getHtml(url);
    const $ = cheerio.load(html);

    const title = $('h1').text().trim();
    if (!title) {
      throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan`, 'NOT_FOUND');
    }

    const altTitle = $('p.text-surface-400.mb-4').text().trim() || null;
    const cover = $('img[src*="cover"]').attr('src') || $('img.object-contain').attr('src') || null;
    const status = $('span.text-green-400, span.capitalize').first().text().trim().toLowerCase() || null;
    const type = $('span.text-base.font-bold.text-primary-400').text().trim().toLowerCase() || 'manhwa';

    // Decode base64 synopsis if available in data-sr
    let synopsis = null;
    const synContainer = $('[data-synopsis-id-cls]');
    const synId = synContainer.attr('data-synopsis-id-cls');
    if (synId) {
      const el = $('#' + synId);
      const sr = el.attr('data-sr');
      if (sr) {
        try {
          synopsis = Buffer.from(sr, 'base64').toString('utf8').trim();
        } catch (_) {}
      }
      if (!synopsis) {
        synopsis = el.text().trim() || null;
      }
    }

    // Extract metadata (Author, Artist, Year, Views)
    let author = null;
    let artist = null;
    let year = null;
    let views = null;

    $('div.bg-surface-800\\/50').each((_, el) => {
      const label = $(el).find('span.text-surface-500').text().trim().toLowerCase();
      const val = $(el).find('span.text-surface-100').text().trim();
      if (!val) return;
      if (label.includes('author') || label.includes('penulis') || label.includes('komikus')) author = val;
      else if (label.includes('artist') || label.includes('artis')) artist = val;
      else if (label.includes('year') || label.includes('tahun')) year = val;
      else if (label.includes('views') || label.includes('dilihat')) views = val;
    });

    // Extract genres
    const genres = [];
    $('a[href*="/browse?genre="]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const gSlug = href.split('genre=')[1]?.split('&')[0];
      const gName = $(a).text().trim();
      if (gSlug && !genres.some((g) => g.slug === gSlug)) {
        genres.push({ name: gName, slug: gSlug });
      }
    });

    // Extract chapters
    const chapters = [];
    $('[data-chapter]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const chMatch = href.match(/\/read\/[^/]+\/([^/]+)/);
      const chapterSlug = chMatch ? chMatch[1] : '';
      const rawChNum = $(a).attr('data-chapter') || '';
      const chNum = rawChNum.trim() || chapterSlug.replace(/^chapter-/, '');

      const spans = $(a).find('span');
      const chTitle = spans.first().text().trim() || `Chapter ${chNum}`;
      const updatedAt = spans.last().text().trim() || null;

      chapters.push({
        title: chTitle,
        slug: chapterSlug,
        updatedAt: updatedAt !== chTitle ? updatedAt : null,
      });
    });

    // Extract similar comics (Related Series) placed at the bottom
    const similar = [];
    const relatedSection = $('h2:contains("Related Series")').closest('section');
    relatedSection.find('a[href*="/comic/"]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const match = href.match(/\/comic\/([^/]+)/);
      const sSlug = match ? match[1] : '';
      if (!sSlug || similar.some((s) => s.slug === sSlug)) return;

      const sTitle = $(a).find('h3').text().trim() || $(a).text().trim();
      const sCover = $(a).find('img').attr('src') || $(a).find('img').attr('data-src') || null;
      const typeText = $(a).text().toLowerCase();
      const sType = typeText.includes('manhwa') ? 'manhwa' : typeText.includes('manhua') ? 'manhua' : 'manga';

      similar.push({
        title: sTitle,
        slug: sSlug,
        cover: sCover,
        type: sType,
      });
    });

    return {
      source: this.name,
      title,
      altTitle,
      cover,
      synopsis,
      author,
      artist,
      status,
      type,
      year,
      views,
      genres,
      totalChapters: chapters.length,
      chapters,
      similar,
    };
  }

  /**
   * Get chapter image pages from https://02.hwago.xyz/read/:slug/:chapter
   * @param {string} slug Manga slug (e.g. 'lust')
   * @param {string|number} chapter Chapter number or slug (e.g. '19' or 'chapter-19')
   */
  async getPages(slug, chapter) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    const rawChapter = String(chapter || '').trim();
    if (!cleanSlug || !rawChapter) {
      throw createBadRequest("Parameter 'slug' dan 'chapter' wajib diisi", 'INVALID_PARAMETER');
    }

    const chapterSlug = rawChapter.startsWith('chapter-') ? rawChapter : `chapter-${rawChapter}`;
    const url = `${this.baseUrl}/read/${cleanSlug}/${chapterSlug}`;
    const html = await getHtml(url);
    const $ = cheerio.load(html);

    const pages = [];
    let pageIndex = 1;

    $('#reader-pages img').each((_, img) => {
      let src = $(img).attr('data-src') || $(img).attr('src') || '';
      if (!src) return;

      // Filter out header, footer, and ad banner images
      if (src.includes('chapter-header') || src.includes('chapter-footer') || src.startsWith('/api/image/p/')) {
        return;
      }

      if (src.startsWith('/')) {
        src = `${this.baseUrl}${src}`;
      }

      pages.push({
        page: pageIndex++,
        url: src,
        proxyUrl: `/api/proxy/image?url=${encodeURIComponent(src)}`,
      });
    });

    if (pages.length === 0) {
      throw createNotFound(
        `Gambar untuk chapter '${chapterSlug}' tidak ditemukan atau target chapter belum tersedia`,
        'NOT_FOUND'
      );
    }

    const chNum = chapterSlug.replace(/^chapter-/, '');
    const mangaTitle = cleanSlug
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

    return {
      source: this.name,
      title: `${mangaTitle} Chapter ${chNum}`,
      totalPages: pages.length,
      pages,
    };
  }
}

module.exports = HwagoSource;
