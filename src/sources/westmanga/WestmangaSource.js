const BaseSource = require('../BaseSource');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');
const { formatPagination } = require('../../utils/responseHelper');
const { formatRelativeTime } = require('../../utils/date');

/**
 * WestManga Source for manga-api.
 * Website: https://v1.westmanga.my/
 * Upstream API: https://v1.westmanga.my/api/
 *
 * Implements token-based visit authorization (X-WM-Visit) and standard
 * query parameters (orderBy, country, genre[], type=Comic).
 */
class WestmangaSource extends BaseSource {
  constructor() {
    super('westmanga', 'WestManga');
    this.domain = 'v1.westmanga.my';
    this.baseUrl = `https://${this.domain}`;
    this.apiBase = `${this.baseUrl}/api`;
    this.icon = 'https://v1.westmanga.my/apple-touch-icon.png';
    this.pageSize = 20;

    // Visit token caching
    this._visitToken = null;
    this._tokenExpiresAt = 0;

    // Genres cache (24 hours)
    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;

    // Manga details / chapters cache
    this._mangaCache = new Map();
  }

  /**
   * Supported sorts for WestManga.
   */
  getSupportedSorts() {
    return [
      { id: 'latest', name: 'Terbaru' },
      { id: 'popular', name: 'Populer' },
      { id: 'newest', name: 'Diperbarui' },
      { id: 'az', name: 'A-Z' },
      { id: 'za', name: 'Z-A' },
    ];
  }

  /**
   * Map sort identifier to WestManga's upstream `orderBy` enum.
   * Enum values: 'Update', 'Popular', 'Added', 'Az', 'Za', 'Default'
   * @param {Object} [options]
   * @returns {{ orderBy: string, sortId: string }}
   * @private
   */
  _normalizeOrder(options = {}) {
    const rawSort = String(options.orderBy || options.sort || options.orderby || options.order || 'latest')
      .toLowerCase()
      .trim();

    if (rawSort === 'popular' || rawSort === 'popularity' || rawSort === 'views') {
      return { orderBy: 'Popular', sortId: 'popular' };
    }
    if (rawSort === 'newest' || rawSort === 'added' || rawSort === 'created_at') {
      return { orderBy: 'Added', sortId: 'newest' };
    }
    if (rawSort === 'az' || rawSort === 'a-z' || rawSort === 'title') {
      return { orderBy: 'Az', sortId: 'az' };
    }
    if (rawSort === 'za' || rawSort === 'z-a') {
      return { orderBy: 'Za', sortId: 'za' };
    }
    return { orderBy: 'Update', sortId: 'latest' };
  }

  /**
   * Browser headers required to satisfy upstream Cloudflare & Caddy rules.
   * @private
   */
  _getBrowserHeaders(extraHeaders = {}) {
    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Referer: `${this.baseUrl}/`,
      Origin: this.baseUrl,
      Accept: 'application/json, text/plain, */*',
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      ...extraHeaders,
    };
  }

  /**
   * Acquire or refresh the `X-WM-Visit` token required for API requests.
   * @param {boolean} [forceRefresh=false]
   * @returns {Promise<string>}
   * @private
   */
  async _getVisitToken(forceRefresh = false) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (!forceRefresh && this._visitToken && nowSec < this._tokenExpiresAt - 60) {
      return this._visitToken;
    }

    // Attempt 1: Extract token from initial SSR HTML
    try {
      const htmlRes = await fetch(`${this.baseUrl}/`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (htmlRes.ok) {
        const html = await htmlRes.text();
        const tokenMatch =
          html.match(/token\\?",\\?"(v1\.[^\\"]+)/) ||
          html.match(/"token"\s*:\s*"(v1\.[^"]+)"/) ||
          html.match(/"token"\s*,\s*"(v1\.[^"]+)"/);

        if (tokenMatch) {
          this._visitToken = tokenMatch[1];
          const expMatch = html.match(/expiresAt\\?",([0-9]+)/) || html.match(/"expires_at"\s*:\s*([0-9]+)/);
          this._tokenExpiresAt = expMatch ? parseInt(expMatch[1], 10) : nowSec + 1800;
          return this._visitToken;
        }
      }
    } catch (_) {}

    // Attempt 2: Direct call to /api/visit-token
    try {
      const tokenRes = await fetch(`${this.apiBase}/visit-token`, {
        headers: this._getBrowserHeaders({ Accept: 'application/json' }),
        signal: AbortSignal.timeout(8000),
      });

      if (tokenRes.ok) {
        const tokenJson = await tokenRes.json();
        if (tokenJson && tokenJson.token) {
          this._visitToken = tokenJson.token;
          this._tokenExpiresAt = Number(tokenJson.expires_at) || nowSec + 1800;
          return this._visitToken;
        }
      }
    } catch (err) {
      console.warn('[WestManga] Visit token fetch warning:', err.message);
    }

    if (this._visitToken) {
      return this._visitToken;
    }

    throw createBadGateway(
      'Gagal mendapatkan visit token dari WestManga. Upstream mungkin sedang menerapkan proteksi Cloudflare.',
      'UPSTREAM_AUTH_ERROR'
    );
  }

  /**
   * Internal HTTP requester with automatic X-WM-Visit token handling and retry on 403.
   * @private
   */
  async _fetchApi(path, { query = {}, retryOn403 = true } = {}) {
    const token = await this._getVisitToken();

    const url = new URL(`${this.apiBase}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, item);
        }
      } else {
        url.searchParams.set(key, value);
      }
    }

    const headers = this._getBrowserHeaders({
      'X-WM-Visit': token,
    });

    let res;
    try {
      res = await fetch(url.toString(), {
        headers,
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw createBadGateway('Waktu tunggu koneksi ke WestManga habis (15s)', 'UPSTREAM_TIMEOUT');
      }
      throw createBadGateway(`Gagal menghubungi server WestManga: ${err.message}`, 'UPSTREAM_ERROR');
    }

    // If upstream returns 403 with visit error, refresh token and retry once
    if (res.status === 403 && retryOn403) {
      this._visitToken = null;
      this._tokenExpiresAt = 0;
      return this._fetchApi(path, { query, retryOn403: false });
    }

    if (res.status === 404) {
      throw createNotFound(`Data tidak ditemukan di WestManga (${path})`, 'NOT_FOUND');
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw createBadGateway(
        `Server WestManga mengembalikan status ${res.status}: ${errText.substring(0, 100)}`,
        'UPSTREAM_ERROR'
      );
    }

    try {
      return await res.json();
    } catch (err) {
      throw createBadGateway('Format respon dari WestManga tidak valid (bukan JSON)', 'INVALID_RESPONSE');
    }
  }

  /**
   * Map upstream comic item to standard manga API format.
   * @param {Object} item Upstream comic object
   * @returns {Object}
   * @private
   */
  _formatMangaItem(item) {
    if (!item) return null;

    let cover = item.cover || null;
    if (cover && cover.startsWith('/')) {
      cover = `${this.baseUrl}${cover}`;
    }

    // Country ID: JP -> manga, KR -> manhwa, CN -> manhua
    let type = 'manga';
    const country = String(item.country_id || item.country || '').toUpperCase();
    if (country === 'KR') {
      type = 'manhwa';
    } else if (country === 'CN') {
      type = 'manhua';
    } else if (item.content_type && item.content_type.toLowerCase() === 'novel') {
      type = 'novel';
    }

    const latest = item.lastChapters?.[0];
    const latestChapter = latest?.number ? `Chapter ${latest.number}` : null;
    const chapterSlug = latest?.slug || null;

    let updatedAt = null;
    if (latest?.updated_at) {
      if (typeof latest.updated_at === 'object' && latest.updated_at.formatted) {
        updatedAt = latest.updated_at.formatted;
      } else if (typeof latest.updated_at === 'object' && latest.updated_at.time) {
        updatedAt = formatRelativeTime(latest.updated_at.time * 1000);
      } else if (typeof latest.updated_at === 'number') {
        updatedAt = formatRelativeTime(latest.updated_at * 1000);
      } else {
        updatedAt = String(latest.updated_at);
      }
    }

    return {
      title: item.title,
      slug: item.slug,
      cover,
      rating: typeof item.rating === 'number' ? item.rating : item.rating ? parseFloat(item.rating) : null,
      status: this._normalizeStatus(item.status),
      type,
      latestChapter,
      chapterSlug,
      updatedAt,
    };
  }

  /**
   * Normalize status string ('ongoing', 'completed', 'hiatus').
   * @private
   */
  _normalizeStatus(rawStatus) {
    if (!rawStatus) return 'ongoing';
    const s = String(rawStatus).toLowerCase();
    if (['completed', 'tamat', 'finished', 'end'].includes(s)) return 'completed';
    if (['hiatus', 'paused', 'istirahat'].includes(s)) return 'hiatus';
    return 'ongoing';
  }

  /**
   * Get popular manga list (sorted by total views).
   * @param {number} page Page number (1-indexed)
   * @param {Object} [options]
   */
  async getPopular(page = 1, options = {}) {
    return this.getList(page, { ...options, orderBy: 'Popular' });
  }

  /**
   * Get latest updated manga list.
   * @param {number} page Page number (1-indexed)
   * @param {string} [category]
   */
  async getLatest(page = 1, category = 'all') {
    return this.getList(page, { orderBy: 'Update' });
  }

  /**
   * Get newly added manga list.
   * @param {number} page
   * @param {Object} [options]
   */
  async getNewest(page = 1, options = {}) {
    return this.getList(page, { ...options, orderBy: 'Added' });
  }

  /**
   * Get alphabetical A-Z manga list.
   * @param {number} page
   * @param {Object} [options]
   */
  async getAz(page = 1, options = {}) {
    return this.getList(page, { ...options, orderBy: 'Az' });
  }

  /**
   * Get alphabetical Z-A manga list.
   * @param {number} page
   * @param {Object} [options]
   */
  async getZa(page = 1, options = {}) {
    return this.getList(page, { ...options, orderBy: 'Za' });
  }

  /**
   * Search manga by title/query.
   * @param {string} query Search text
   * @param {number} page Page number (1-indexed)
   */
  async search(query, page = 1) {
    const cleanQuery = String(query || '').trim();
    if (!cleanQuery) {
      throw createBadRequest("Parameter query 'q' wajib diisi", 'INVALID_PARAMETER');
    }

    const pageNum = parseInt(page, 10) || 1;
    const json = await this._fetchApi('/contents', {
      query: {
        page: pageNum,
        per_page: this.pageSize,
        type: 'Comic',
        q: cleanQuery,
      },
    });

    const rawList = json.data || [];
    const paginator = json.paginator || {};
    const maxPage = paginator.last_page || 1;
    const total = paginator.total || rawList.length;

    const data = rawList.map((item) => this._formatMangaItem(item)).filter(Boolean);

    return {
      source: this.name,
      query: cleanQuery,
      total,
      data,
      pagination: formatPagination({
        page: pageNum,
        maxPage,
        hasNextPage: pageNum < maxPage,
      }),
      maxPage,
      page: pageNum,
      hasNextPage: pageNum < maxPage,
    };
  }

  /**
   * Fetch all genres from WestManga.
   * @returns {Promise<Array<{id: number, name: string, slug: string}>>}
   */
  async getGenres() {
    const now = Date.now();
    if (this._cachedGenres && now < this._cachedGenresExpiresAt) {
      return this._cachedGenres;
    }

    const json = await this._fetchApi('/contents/genres');
    const rawList = json.data || [];

    const genres = rawList.map((g) => ({
      id: g.id,
      name: g.name,
      slug: g.slug || String(g.id),
    }));

    this._cachedGenres = genres;
    this._cachedGenresExpiresAt = now + 24 * 60 * 60 * 1000;
    return genres;
  }

  /**
   * Get manga list filtered by genre.
   * Accepts genre slug, genre name, or genre ID.
   * @param {string|number} genre
   * @param {number} page
   * @param {Object} [options]
   */
  async getByGenre(genre, page = 1, options = {}) {
    const rawGenre = String(genre || '').trim();
    if (!rawGenre) {
      throw createBadRequest("Parameter 'genre' wajib diisi", 'INVALID_PARAMETER');
    }

    const genreTokens = rawGenre
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const genres = await this.getGenres();
    const resolvedIds = [];

    for (const token of genreTokens) {
      let gId = parseInt(token, 10);
      if (isNaN(gId)) {
        const matched = genres.find(
          (g) =>
            g.slug.toLowerCase() === token.toLowerCase() ||
            g.name.toLowerCase() === token.toLowerCase()
        );
        if (matched) gId = matched.id;
      }
      if (gId && !resolvedIds.includes(gId)) {
        resolvedIds.push(gId);
      }
    }

    if (resolvedIds.length === 0) {
      throw createNotFound(`Genre '${rawGenre}' tidak ditemukan di WestManga`, 'NOT_FOUND');
    }

    const { orderBy, sortId } = this._normalizeOrder(options);
    const pageNum = parseInt(page, 10) || 1;

    const json = await this._fetchApi('/contents', {
      query: {
        page: pageNum,
        per_page: this.pageSize,
        type: 'Comic',
        'genre[]': resolvedIds,
        orderBy,
      },
    });

    const rawList = json.data || [];
    const paginator = json.paginator || {};
    const maxPage = paginator.last_page || 1;
    const total = paginator.total || rawList.length;

    const data = rawList.map((item) => this._formatMangaItem(item)).filter(Boolean);

    return {
      source: this.name,
      genre: rawGenre,
      genreIds: resolvedIds,
      sort: sortId,
      total,
      data,
      pagination: formatPagination({
        page: pageNum,
        maxPage,
        hasNextPage: pageNum < maxPage,
      }),
      maxPage,
      page: pageNum,
      hasNextPage: pageNum < maxPage,
    };
  }

  /**
   * Get available types.
   */
  async getTypes() {
    return ['manga', 'manhwa', 'manhua'];
  }

  /**
   * Get manga list filtered by type ('manga', 'manhwa', 'manhua').
   * @param {string} type
   * @param {number} page
   * @param {Object} [options]
   */
  async getByType(type, page = 1, options = {}) {
    const rawType = String(type || '').toLowerCase().trim();
    let country = 'JP';
    if (rawType === 'manhwa') {
      country = 'KR';
    } else if (rawType === 'manhua') {
      country = 'CN';
    } else if (rawType === 'manga') {
      country = 'JP';
    } else {
      throw createBadRequest(
        `Tipe '${type}' tidak valid. Pilihan tersedia: manga, manhwa, manhua`,
        'INVALID_PARAMETER'
      );
    }

    const { orderBy, sortId } = this._normalizeOrder(options);
    const pageNum = parseInt(page, 10) || 1;

    const json = await this._fetchApi('/contents', {
      query: {
        page: pageNum,
        per_page: this.pageSize,
        type: 'Comic',
        country,
        orderBy,
      },
    });

    const rawList = json.data || [];
    const paginator = json.paginator || {};
    const maxPage = paginator.last_page || 1;
    const total = paginator.total || rawList.length;

    const data = rawList.map((item) => this._formatMangaItem(item)).filter(Boolean);

    return {
      source: this.name,
      type: rawType,
      country,
      sort: sortId,
      total,
      data,
      pagination: formatPagination({
        page: pageNum,
        maxPage,
        hasNextPage: pageNum < maxPage,
      }),
      maxPage,
      page: pageNum,
      hasNextPage: pageNum < maxPage,
    };
  }

  /**
   * General list / catalog / directory endpoint.
   * Supports options:
   * - `sort` / `orderBy`: 'latest', 'popular', 'newest', 'az', 'za'
   * - `status`: 'ongoing', 'completed', 'hiatus'
   * - `country`: 'JP', 'KR', 'CN'
   * - `genre`: genre ID or slug
   * @param {number} page
   * @param {Object} [options]
   */
  async getList(page = 1, options = {}) {
    const pageNum = parseInt(page, 10) || 1;
    const { orderBy, sortId } = this._normalizeOrder(options);

    const queryParams = {
      page: pageNum,
      per_page: this.pageSize,
      type: options.type ? String(options.type) : 'Comic',
      orderBy,
    };

    // Status filter
    if (options.status) {
      const s = String(options.status).toLowerCase().trim();
      if (['ongoing', 'berjalan', 'masih lanjut', 'lanjut'].includes(s)) queryParams.status = 'Ongoing';
      else if (['completed', 'finished', 'tamat', 'selesai'].includes(s)) queryParams.status = 'Completed';
      else if (['hiatus', 'istirahat', 'jeda'].includes(s)) queryParams.status = 'Hiatus';
    }

    // Country filter
    if (options.country) {
      const c = String(options.country).toUpperCase();
      if (['JP', 'KR', 'CN'].includes(c)) queryParams.country = c;
    } else if (options.type) {
      const t = String(options.type).toLowerCase();
      if (t === 'manga') queryParams.country = 'JP';
      else if (t === 'manhwa') queryParams.country = 'KR';
      else if (t === 'manhua') queryParams.country = 'CN';
    }

    // Genre filter (supports single, comma-separated e.g. "action,romance", or array)
    const rawGenres = options.genres || options.genre;
    if (rawGenres) {
      const genreTokens = (Array.isArray(rawGenres) ? rawGenres : String(rawGenres).split(','))
        .map((t) => String(t).trim())
        .filter(Boolean);

      if (genreTokens.length > 0) {
        const allGenres = await this.getGenres();
        const resolvedIds = [];

        for (const token of genreTokens) {
          let gId = parseInt(token, 10);
          if (isNaN(gId)) {
            const matched = allGenres.find(
              (g) =>
                g.slug.toLowerCase() === token.toLowerCase() ||
                g.name.toLowerCase() === token.toLowerCase()
            );
            if (matched) gId = matched.id;
          }
          if (gId && !resolvedIds.includes(gId)) {
            resolvedIds.push(gId);
          }
        }

        if (resolvedIds.length > 0) {
          queryParams['genre[]'] = resolvedIds;
        }
      }
    }

    const json = await this._fetchApi('/contents', { query: queryParams });
    const rawList = json.data || [];
    const paginator = json.paginator || {};
    const maxPage = paginator.last_page || 1;
    const total = paginator.total || rawList.length;

    const data = rawList.map((item) => this._formatMangaItem(item)).filter(Boolean);

    return {
      source: this.name,
      sort: sortId,
      total,
      data,
      pagination: formatPagination({
        page: pageNum,
        maxPage,
        hasNextPage: pageNum < maxPage,
      }),
      maxPage,
      page: pageNum,
      hasNextPage: pageNum < maxPage,
    };
  }

  /**
   * Get detailed manga information and chapters list.
   * @param {string} slug
   */
  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    if (!cleanSlug) {
      throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');
    }

    const json = await this._fetchApi(`/comic/${cleanSlug}`);
    const data = json.data;
    if (!data) {
      throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di WestManga`, 'NOT_FOUND');
    }

    let cover = data.cover || null;
    if (cover && cover.startsWith('/')) {
      cover = `${this.baseUrl}${cover}`;
    }

    // Type identification
    let type = 'manga';
    const country = String(data.country_id || data.country || '').toUpperCase();
    if (country === 'KR') {
      type = 'manhwa';
    } else if (country === 'CN') {
      type = 'manhua';
    } else if (data.content_type && data.content_type.toLowerCase() === 'novel') {
      type = 'novel';
    }

    // Genres
    const genres = (data.genres || []).map((g) => ({
      name: g.name,
      slug: g.slug || String(g.id),
      id: g.id,
    }));

    // Synopsis cleanup (strip html tags if any)
    let synopsis = data.sinopsis ? data.sinopsis.replace(/<[^>]+>/g, '').trim() : null;

    // Chapters
    const chapters = (data.chapters || []).map((ch) => {
      const chNum = ch.number ? parseFloat(ch.number) : null;
      let date = null;
      if (ch.updated_at) {
        if (typeof ch.updated_at === 'object' && ch.updated_at.formatted) {
          date = ch.updated_at.formatted;
        } else if (typeof ch.updated_at === 'object' && ch.updated_at.time) {
          date = formatRelativeTime(ch.updated_at.time * 1000);
        } else if (typeof ch.updated_at === 'number') {
          date = formatRelativeTime(ch.updated_at * 1000);
        } else {
          date = String(ch.updated_at);
        }
      }

      return {
        id: ch.slug,
        rawSlug: ch.slug,
        slug: ch.number !== undefined && ch.number !== null ? String(ch.number) : ch.slug,
        chapterNumber: chNum,
        title: ch.number ? `Chapter ${ch.number}` : ch.slug,
        createdAt: date,
        url: `${this.baseUrl}/c/${ch.slug}`,
      };
    });

    // Cache chapters for rapid lookup in getPages
    this._mangaCache.set(cleanSlug, {
      title: data.title,
      chapters,
      cachedAt: Date.now(),
    });

    return {
      source: this.name,
      title: data.title,
      slug: cleanSlug,
      altTitle: data.alternative_name || null,
      cover,
      synopsis,
      status: this._normalizeStatus(data.status),
      type,
      author: data.author || null,
      rating: typeof data.rating === 'number' ? data.rating : data.rating ? parseFloat(data.rating) : null,
      genres,
      totalChapters: chapters.length,
      chapters,
    };
  }

  /**
   * Get list of image pages for a specific chapter.
   * @param {string} slug Manga slug identifier
   * @param {string|number} chapter Chapter identifier / number / slug
   * @param {string} [cdn] Optional CDN server (unused for WestManga)
   */
  async getPages(slug, chapter, cdn = null) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    const rawChapter = String(chapter || '').trim();
    if (!cleanSlug || !rawChapter) {
      throw createBadRequest("Parameter 'slug' dan 'chapter' wajib diisi", 'INVALID_PARAMETER');
    }

    let targetChapterSlug = null;
    let chapterTitle = null;
    let mangaTitle = null;

    // 1. Look up cached chapters
    const cached = this._mangaCache.get(cleanSlug);
    let chapters = cached?.chapters;
    mangaTitle = cached?.title;

    if (!chapters) {
      try {
        const details = await this.getDetails(cleanSlug);
        chapters = details.chapters || [];
        mangaTitle = details.title;
      } catch (_) {
        chapters = [];
      }
    }

    // Match chapter from chapters list
    const cleanChNum = parseFloat(rawChapter.replace(/^chapter-?/i, ''));
    const matched = chapters.find((ch) => {
      if (ch.rawSlug === rawChapter || ch.id === rawChapter || ch.slug === rawChapter) return true;
      if (ch.slug === `chapter-${rawChapter}` || `chapter-${ch.slug}` === rawChapter) return true;
      if (!isNaN(cleanChNum) && ch.chapterNumber === cleanChNum) return true;
      if (ch.rawSlug && (ch.rawSlug.endsWith(`-chapter-${rawChapter}`) || ch.rawSlug.endsWith(`-chapter-${cleanChNum}`))) return true;
      if (ch.rawSlug && ch.rawSlug.includes(`-chapter-${rawChapter}-`)) return true;
      return false;
    });

    if (matched) {
      targetChapterSlug = matched.rawSlug;
      chapterTitle = matched.title;
    } else {
      // Fallback: use rawChapter directly if it looks like a chapter slug
      targetChapterSlug = rawChapter;
    }

    const json = await this._fetchApi(`/v/${targetChapterSlug}`);
    const rawImages = json.data?.images || json.images || [];

    if (!Array.isArray(rawImages) || rawImages.length === 0) {
      throw createBadGateway(
        `Gagal menemukan halaman gambar untuk chapter '${rawChapter}' di WestManga`,
        'UPSTREAM_ERROR'
      );
    }

    const pages = rawImages.map((imgUrl, index) => {
      let fullUrl = String(imgUrl).trim();
      if (fullUrl.startsWith('/')) {
        fullUrl = `${this.baseUrl}${fullUrl}`;
      }
      return {
        page: index + 1,
        url: fullUrl,
        directUrl: fullUrl,
        proxyUrl: `/api/proxy/image?url=${encodeURIComponent(fullUrl)}`,
      };
    });

    const cleanChapterTitle = chapterTitle || `Chapter ${rawChapter}`;
    const fullTitle = mangaTitle
      ? cleanChapterTitle.toLowerCase().includes(mangaTitle.toLowerCase())
        ? cleanChapterTitle
        : `${mangaTitle} ${cleanChapterTitle}`
      : cleanChapterTitle;

    return {
      source: this.name,
      title: fullTitle,
      totalPages: pages.length,
      pages,
    };
  }
}

module.exports = WestmangaSource;
