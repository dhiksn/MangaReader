const BaseSource = require('../BaseSource');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');
const { formatPagination } = require('../../utils/responseHelper');
const { formatRelativeTime } = require('../../utils/date');

class ShinigamiSource extends BaseSource {
  constructor() {
    super('shinigami', 'Shinigami');
    this.domain = 'id.shinigami.asia';
    this.baseUrl = `https://${this.domain}`;
    this.icon = 'https://11.shinigami.asia/favicon.png';
    this.apiDomain = 'api.shngm.io/v1';
    this.cdnDomain = 'storage.shngm.id';
    this.pageSize = 24;

    // In-memory cache for slug <-> manga_id mapping
    this._slugToIdMap = new Map();

    // Genres cache in memory (24h)
    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  /**
   * Slugify title text into readable URL slug.
   * @private
   */
  _slugify(text) {
    if (!text || typeof text !== 'string') return '';
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Send HTTP request to Shinigami upstream API.
   * @private
   */
  async _fetchApi(endpoint, params = {}) {
    const url = new URL(`https://${this.apiDomain}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    const headers = {
      Referer: `${this.baseUrl}/`,
      'Sec-Fetch-Dest': 'empty',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'application/json',
    };

    let res;
    try {
      res = await fetch(url.toString(), {
        headers,
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw createBadGateway('Waktu tunggu koneksi ke server Shinigami habis (timeout 15s)', 'UPSTREAM_TIMEOUT');
      }
      throw createBadGateway(`Gagal terhubung ke Shinigami: ${err.message || 'Koneksi terputus'}`, 'UPSTREAM_ERROR');
    }

    if (!res.ok && res.status !== 404) {
      throw createBadGateway(`Shinigami mengembalikan status HTTP ${res.status}`, 'UPSTREAM_ERROR');
    }

    const json = await res.json().catch(() => null);
    if (!json) {
      throw createBadGateway('Gagal memproses response JSON dari server Shinigami', 'UPSTREAM_ERROR');
    }

    if (res.status === 404 || json.retcode === 404001) {
      throw createNotFound('Data tidak ditemukan di server Shinigami', 'NOT_FOUND');
    }

    if (json.retcode !== 0) {
      throw createBadGateway(`Error dari server Shinigami: ${json.message || 'Unknown error'}`, 'UPSTREAM_ERROR');
    }

    return json;
  }

  /**
   * Map Shinigami API manga item into standardized card object.
   * @private
   */
  _mapMangaItem(item) {
    if (!item) return null;

    const rawUpdatedAt = item.latest_chapter_time || item.updated_at || item.created_at;
    const updatedAt = rawUpdatedAt ? formatRelativeTime(rawUpdatedAt) : null;

    const cover = item.cover_portrait_url || item.cover_image_url || null;

    let latestChapter = null;
    if (item.latest_chapter_number !== undefined && item.latest_chapter_number !== null) {
      latestChapter = `Chapter ${item.latest_chapter_number}`;
    }

    let type = null;
    if (item.taxonomy?.Format && item.taxonomy.Format.length > 0) {
      type = item.taxonomy.Format[0].slug;
    } else if (item.country_id === 'KR') {
      type = 'manhwa';
    } else if (item.country_id === 'CN') {
      type = 'manhua';
    } else if (item.country_id === 'JP') {
      type = 'manga';
    }

    let status = null;
    if (item.status === 1) status = 'ongoing';
    else if (item.status === 2) status = 'completed';
    else if (item.status === 3) status = 'hiatus';

    const genres = Array.isArray(item.taxonomy?.Genre)
      ? item.taxonomy.Genre.map((g) => ({
          name: g.name ? String(g.name).trim() : '',
          slug: g.slug ? String(g.slug).trim() : '',
        })).filter((g) => g.name && g.slug)
      : [];

    const slug = this._slugify(item.title) || item.manga_id || null;
    if (slug && item.manga_id) {
      this._slugToIdMap.set(slug, item.manga_id);
    }

    return {
      title: item.title || null,
      slug,
      cover,
      type,
      status,
      rating: typeof item.user_rate === 'number' ? item.user_rate : null,
      latestChapter,
      genres,
      updatedAt,
    };
  }

  /**
   * Resolve a manga identifier (UUID or title slug) to its Shinigami manga_id.
   * @private
   */
  async _resolveMangaId(slug) {
    if (!slug || typeof slug !== 'string') return null;
    const cleanSlug = slug.trim().toLowerCase();

    // 1. Check in-memory slug-to-ID cache
    if (this._slugToIdMap.has(cleanSlug)) {
      return this._slugToIdMap.get(cleanSlug);
    }

    // 2. If it's already a valid UUID
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanSlug);
    if (isUuid) {
      return cleanSlug;
    }

    // 3. Otherwise, search for the manga title
    const query = cleanSlug.replace(/[\-_]+/g, ' ').trim();
    try {
      const res = await this._fetchApi('/manga/list', {
        page: 1,
        page_size: 10,
        q: query,
      });

      const list = res.data || [];
      if (list.length === 0) return null;

      // Populate cache for all returned items
      for (const m of list) {
        const s = this._slugify(m.title);
        if (s && m.manga_id) {
          this._slugToIdMap.set(s, m.manga_id);
        }
      }

      const match = list.find((m) => this._slugify(m.title) === cleanSlug);
      const chosen = match || list[0];
      if (chosen && chosen.manga_id) {
        const generatedSlug = this._slugify(chosen.title) || cleanSlug;
        this._slugToIdMap.set(generatedSlug, chosen.manga_id);
        return chosen.manga_id;
      }

      return null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Get popular manga list from Shinigami.
   * Sourced from https://id.shinigami.asia/search?sort=popularity.
   * @param {number} [page=1] Page number
   */
  async getPopular(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);

    const res = await this._fetchApi('/manga/list', {
      page: pageNum,
      page_size: this.pageSize,
      sort: 'popularity',
      sort_order: 'desc',
    });

    const rawList = res.data || [];
    const data = rawList.map((item) => this._mapMangaItem(item));
    const totalRecord = res.meta?.total_record || null;
    const maxPage = res.meta?.total_page || (totalRecord ? Math.ceil(totalRecord / this.pageSize) : null);

    if (pageNum > 1 && ((maxPage && pageNum > maxPage) || data.length === 0)) {
      throw createNotFound(
        `Halaman ${pageNum} tidak ditemukan${maxPage ? ` (maksimal halaman ${maxPage})` : ''}`,
        'NOT_FOUND'
      );
    }

    const hasNextPage = maxPage ? pageNum < maxPage : data.length === this.pageSize;
    const pagination = formatPagination({
      page: pageNum,
      maxPage,
      hasNextPage,
    });

    return {
      source: this.name,
      from: `${this.baseUrl}/search?sort=popularity`,
      data,
      pagination,
      page: pageNum,
      maxPage,
      hasNextPage,
    };
  }

  /**
   * Get latest updated manga list from Shinigami.
   * Sourced from https://id.shinigami.asia/search?sort=latest.
   * @param {number} [page=1] Page number
   */
  async getLatest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);

    const res = await this._fetchApi('/manga/list', {
      page: pageNum,
      page_size: this.pageSize,
      sort: 'latest',
      sort_order: 'desc',
    });

    const rawList = res.data || [];
    const data = rawList.map((item) => this._mapMangaItem(item));
    const totalRecord = res.meta?.total_record || null;
    const maxPage = res.meta?.total_page || (totalRecord ? Math.ceil(totalRecord / this.pageSize) : null);

    if (pageNum > 1 && ((maxPage && pageNum > maxPage) || data.length === 0)) {
      throw createNotFound(
        `Halaman ${pageNum} tidak ditemukan${maxPage ? ` (maksimal halaman ${maxPage})` : ''}`,
        'NOT_FOUND'
      );
    }

    const hasNextPage = maxPage ? pageNum < maxPage : data.length === this.pageSize;
    const pagination = formatPagination({
      page: pageNum,
      maxPage,
      hasNextPage,
    });

    return {
      source: this.name,
      from: `${this.baseUrl}/search?sort=latest`,
      data,
      pagination,
      page: pageNum,
      maxPage,
      hasNextPage,
    };
  }

  /**
   * Get top rated manga list from Shinigami.
   * Sourced from https://id.shinigami.asia/search?sort=rating.
   * @param {number} [page=1] Page number
   */
  async getRating(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);

    const res = await this._fetchApi('/manga/list', {
      page: pageNum,
      page_size: this.pageSize,
      sort: 'rating',
      sort_order: 'desc',
    });

    const rawList = res.data || [];
    const data = rawList.map((item) => this._mapMangaItem(item));
    const totalRecord = res.meta?.total_record || null;
    const maxPage = res.meta?.total_page || (totalRecord ? Math.ceil(totalRecord / this.pageSize) : null);

    if (pageNum > 1 && ((maxPage && pageNum > maxPage) || data.length === 0)) {
      throw createNotFound(
        `Halaman ${pageNum} tidak ditemukan${maxPage ? ` (maksimal halaman ${maxPage})` : ''}`,
        'NOT_FOUND'
      );
    }

    const hasNextPage = maxPage ? pageNum < maxPage : data.length === this.pageSize;
    const pagination = formatPagination({
      page: pageNum,
      maxPage,
      hasNextPage,
    });

    return {
      source: this.name,
      sort: 'rating',
      from: `${this.baseUrl}/search?sort=rating`,
      data,
      pagination,
      page: pageNum,
      maxPage,
      hasNextPage,
    };
  }

  /**
   * Search manga in Shinigami.
   * Sourced from https://id.shinigami.asia/search?q=:query.
   * @param {string} query Search keyword
   * @param {number} [page=1] Page number
   */
  async search(query, page = 1) {
    const rawQuery = String(query || '').trim();
    if (!rawQuery) {
      throw createBadRequest('Parameter query "q" wajib diisi', 'INVALID_PARAMETER');
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);

    const res = await this._fetchApi('/manga/list', {
      page: pageNum,
      page_size: this.pageSize,
      q: rawQuery,
    });

    const rawList = res.data || [];
    const data = rawList.map((item) => this._mapMangaItem(item));
    const totalRecord = res.meta?.total_record || null;
    const maxPage = res.meta?.total_page || (totalRecord ? Math.ceil(totalRecord / this.pageSize) : null);

    if (pageNum > 1 && ((maxPage && pageNum > maxPage) || data.length === 0)) {
      throw createNotFound(
        `Halaman ${pageNum} tidak ditemukan untuk pencarian '${rawQuery}'${
          maxPage ? ` (maksimal halaman ${maxPage})` : ''
        }`,
        'NOT_FOUND'
      );
    }

    const hasNextPage = maxPage ? pageNum < maxPage : data.length === this.pageSize;
    const pagination = formatPagination({
      page: pageNum,
      maxPage,
      hasNextPage,
    });

    return {
      source: this.name,
      from: `${this.baseUrl}/search?q=${encodeURIComponent(rawQuery)}`,
      query: rawQuery,
      data,
      pagination,
      page: pageNum,
      maxPage,
      hasNextPage,
    };
  }

  /**
   * Get list of all available genres from Shinigami.
   */
  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) {
      return this._cachedGenres;
    }

    const res = await this._fetchApi('/genre/list');
    const rawList = res.data || [];
    const genres = [];

    for (const item of rawList) {
      if (item && item.slug && item.name) {
        genres.push({
          name: item.name.trim(),
          slug: item.slug.trim(),
        });
      }
    }

    this._cachedGenres = genres;
    this._cachedGenresExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
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
   * Get manga list filtered by genre from Shinigami.
   * Sourced from https://id.shinigami.asia/genre/:genre.
   * @param {string} genre Genre name or slug
   * @param {number} [page=1] Page number
   */
  async getByGenre(genre, page = 1) {
    const rawGenre = String(genre || '').trim();
    if (!rawGenre) {
      throw createBadRequest("Parameter 'genre' wajib diisi", 'INVALID_PARAMETER');
    }

    const targetSlug = await this._resolveGenreSlug(rawGenre);
    const pageNum = Math.max(1, parseInt(page, 10) || 1);

    const res = await this._fetchApi('/manga/list', {
      page: pageNum,
      page_size: this.pageSize,
      genre_include: targetSlug,
      genre_include_mode: 'and',
      sort: 'latest',
      sort_order: 'desc',
    });

    const rawList = res.data || [];
    const data = rawList.map((item) => this._mapMangaItem(item));
    const totalRecord = res.meta?.total_record || null;
    const maxPage = res.meta?.total_page || (totalRecord ? Math.ceil(totalRecord / this.pageSize) : null);

    if (pageNum > 1 && ((maxPage && pageNum > maxPage) || data.length === 0)) {
      throw createNotFound(
        `Halaman ${pageNum} tidak ditemukan untuk genre '${rawGenre}'${
          maxPage ? ` (maksimal halaman ${maxPage})` : ''
        }`,
        'NOT_FOUND'
      );
    }

    const hasNextPage = maxPage ? pageNum < maxPage : data.length === this.pageSize;
    const pagination = formatPagination({
      page: pageNum,
      maxPage,
      hasNextPage,
    });

    return {
      source: this.name,
      genre: targetSlug,
      from: `${this.baseUrl}/genre/${targetSlug}`,
      data,
      pagination,
      page: pageNum,
      maxPage,
      hasNextPage,
    };
  }

  /**
   * Get list of supported comic types for Shinigami.
   */
  async getTypes() {
    return ['manga', 'manhwa', 'manhua'];
  }

  /**
   * Get manga list filtered by type from Shinigami.
   * Sourced from https://id.shinigami.asia/format/:type.
   * @param {string} type Manga type ('manga', 'manhwa', 'manhua')
   * @param {number} [page=1] Page number
   */
  async getByType(type, page = 1) {
    const rawType = String(type || '').trim().toLowerCase();
    const validTypes = await this.getTypes();
    if (!validTypes.includes(rawType)) {
      throw createBadRequest(
        `Tipe komik '${type}' tidak valid. Pilihan: ${validTypes.join(', ')}`,
        'INVALID_PARAMETER'
      );
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);

    const res = await this._fetchApi('/manga/list', {
      page: pageNum,
      page_size: this.pageSize,
      format: rawType,
      sort: 'latest',
      sort_order: 'desc',
    });

    const rawList = res.data || [];
    const data = rawList.map((item) => this._mapMangaItem(item));
    const totalRecord = res.meta?.total_record || null;
    const maxPage = res.meta?.total_page || (totalRecord ? Math.ceil(totalRecord / this.pageSize) : null);

    if (pageNum > 1 && ((maxPage && pageNum > maxPage) || data.length === 0)) {
      throw createNotFound(
        `Halaman ${pageNum} tidak ditemukan untuk tipe '${rawType}'${
          maxPage ? ` (maksimal halaman ${maxPage})` : ''
        }`,
        'NOT_FOUND'
      );
    }

    const hasNextPage = maxPage ? pageNum < maxPage : data.length === this.pageSize;
    const pagination = formatPagination({
      page: pageNum,
      maxPage,
      hasNextPage,
    });

    return {
      source: this.name,
      type: rawType,
      from: `${this.baseUrl}/format/${rawType}`,
      data,
      pagination,
      page: pageNum,
      maxPage,
      hasNextPage,
    };
  }

  /**
   * Get filtered list / directory of manga from Shinigami.
   * @param {number} [page=1] Page number
   * @param {Object} [options={}] Filter options (status, type/format, genre, sort)
   */
  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const params = {
      page: pageNum,
      page_size: this.pageSize,
    };

    if (options.sort) {
      const validSorts = ['latest', 'popularity', 'rating', 'bookmark'];
      if (validSorts.includes(String(options.sort).toLowerCase())) {
        params.sort = String(options.sort).toLowerCase();
        params.sort_order = 'desc';
      }
    } else {
      params.sort = 'latest';
      params.sort_order = 'desc';
    }

    if (options.status) {
      const s = String(options.status).toLowerCase();
      if (['ongoing', 'completed', 'hiatus'].includes(s)) {
        params.status = s;
      }
    }

    const rawType = options.type || options.format;
    if (rawType) {
      const t = String(rawType).toLowerCase();
      if (['manga', 'manhwa', 'manhua'].includes(t)) {
        params.format = t;
      }
    }

    if (options.genre) {
      const gSlug = await this._resolveGenreSlug(String(options.genre));
      params.genre_include = gSlug;
      params.genre_include_mode = 'and';
    }

    const res = await this._fetchApi('/manga/list', params);
    const rawList = res.data || [];
    const data = rawList.map((item) => this._mapMangaItem(item));
    const totalRecord = res.meta?.total_record || null;
    const maxPage = res.meta?.total_page || (totalRecord ? Math.ceil(totalRecord / this.pageSize) : null);

    if (pageNum > 1 && ((maxPage && pageNum > maxPage) || data.length === 0)) {
      throw createNotFound(
        `Halaman ${pageNum} tidak ditemukan${maxPage ? ` (maksimal halaman ${maxPage})` : ''}`,
        'NOT_FOUND'
      );
    }

    const hasNextPage = maxPage ? pageNum < maxPage : data.length === this.pageSize;
    const pagination = formatPagination({
      page: pageNum,
      maxPage,
      hasNextPage,
    });

    return {
      source: this.name,
      from: `${this.baseUrl}/search`,
      ...(options.sort ? { sort: options.sort } : {}),
      ...(options.status ? { status: options.status } : {}),
      ...(rawType ? { type: rawType } : {}),
      ...(options.genre ? { genre: options.genre } : {}),
      data,
      pagination,
      page: pageNum,
      maxPage,
      hasNextPage,
    };
  }

  /**
   * Get complete manga details, synopsis, chapters, and similar comics from Shinigami.
   * @param {string} slug Manga UUID or title slug (e.g. 'd3b05787-4c8e-42bb-ba9a-6b2fafd92f3c' or 'nano-machine')
   */
  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    if (!cleanSlug) {
      throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');
    }

    const mangaId = await this._resolveMangaId(cleanSlug);
    if (!mangaId) {
      throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan`, 'NOT_FOUND');
    }

    let res;
    try {
      res = await this._fetchApi(`/manga/detail/${mangaId}`);
    } catch (err) {
      if (err.statusCode === 404 || err.message?.includes('tidak ditemukan')) {
        throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan`, 'NOT_FOUND');
      }
      throw err;
    }

    const detail = res.data;
    if (!detail || !detail.title) {
      throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan`, 'NOT_FOUND');
    }

    const title = detail.title;
    const altTitle = detail.alternative_title || null;
    const cover = detail.cover_portrait_url || detail.cover_image_url || null;
    const synopsis = detail.description ? detail.description.trim() : null;

    let author = null;
    if (Array.isArray(detail.taxonomy?.Author) && detail.taxonomy.Author.length > 0) {
      author = detail.taxonomy.Author.map((a) => a.name).filter(Boolean).join(', ');
    }

    let status = null;
    if (detail.status === 1) status = 'ongoing';
    else if (detail.status === 2) status = 'completed';
    else if (detail.status === 3) status = 'hiatus';

    let type = null;
    if (detail.taxonomy?.Format && detail.taxonomy.Format.length > 0) {
      type = detail.taxonomy.Format[0].slug;
    } else if (detail.country_id === 'KR') {
      type = 'manhwa';
    } else if (detail.country_id === 'CN') {
      type = 'manhua';
    } else if (detail.country_id === 'JP') {
      type = 'manga';
    }

    const rating = typeof detail.user_rate === 'number' ? detail.user_rate : null;

    const genres = Array.isArray(detail.taxonomy?.Genre)
      ? detail.taxonomy.Genre.map((g) => ({
          name: g.name ? String(g.name).trim() : '',
          slug: g.slug ? String(g.slug).trim() : '',
        })).filter((g) => g.name && g.slug)
      : [];

    // Fetch chapters list
    let rawChapters = [];
    try {
      const chRes = await this._fetchApi(`/chapter/${mangaId}/list`, {
        page: 1,
        page_size: 9999,
        sort_by: 'chapter_number',
        sort_order: 'desc',
      });
      rawChapters = Array.isArray(chRes.data) ? chRes.data : [];
    } catch (_) {}

    const chapters = rawChapters.map((ch) => {
      const chNum = ch.chapter_number !== undefined && ch.chapter_number !== null ? ch.chapter_number : null;
      const chTitle = ch.chapter_title
        ? `Chapter ${chNum !== null ? chNum : ''} - ${ch.chapter_title}`.trim()
        : chNum !== null
        ? `Chapter ${chNum}`
        : 'Chapter 1';
      const slugVal = chNum !== null ? String(chNum) : ch.chapter_id;

      let cleanDate = null;
      if (ch.release_date) {
        const d = new Date(ch.release_date);
        if (!isNaN(d.getTime())) {
          const months = [
            'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
            'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
          ];
          cleanDate = `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
        }
      }

      return {
        id: ch.chapter_id,
        slug: slugVal,
        chapterNumber: chNum,
        title: chTitle,
        createdAt: cleanDate,
      };
    });

    // Fetch similar comics based on primary genre or format
    const similar = [];
    try {
      const primaryGenreSlug = detail.taxonomy?.Genre?.[0]?.slug;
      const queryParams = {
        page: 1,
        page_size: 6,
        sort: 'popularity',
        sort_order: 'desc',
      };
      if (primaryGenreSlug) {
        queryParams.genre_include = primaryGenreSlug;
        queryParams.genre_include_mode = 'and';
      } else if (type) {
        queryParams.format = type;
      }

      const similarRaw = await this._fetchApi('/manga/list', queryParams);
      const simList = Array.isArray(similarRaw.data) ? similarRaw.data : [];
      for (const sim of simList) {
        if (sim.manga_id !== mangaId && similar.length < 5) {
          let simType = null;
          if (sim.taxonomy?.Format && sim.taxonomy.Format.length > 0) {
            simType = sim.taxonomy.Format[0].slug;
          } else if (sim.country_id === 'KR') {
            simType = 'manhwa';
          } else if (sim.country_id === 'CN') {
            simType = 'manhua';
          }

          const simSlug = this._slugify(sim.title) || sim.manga_id;
          similar.push({
            title: sim.title,
            slug: simSlug,
            cover: sim.cover_portrait_url || sim.cover_image_url || null,
            type: simType,
            rating: typeof sim.user_rate === 'number' ? sim.user_rate : null,
          });
        }
      }
    } catch (_) {}

    const itemSlug = this._slugify(title) || cleanSlug;
    if (itemSlug && mangaId) {
      this._slugToIdMap.set(itemSlug, mangaId);
    }

    return {
      source: this.name,
      title,
      slug: itemSlug,
      altTitle,
      cover,
      synopsis,
      author,
      status,
      type,
      rating,
      genres,
      totalChapters: chapters.length,
      chapters,
      similar,
    };
  }

  /**
   * Get chapter image pages from Shinigami.
   * @param {string} slug Manga UUID or slug (e.g. 'nano-machine' or 'd3b05787-4c8e-42bb-ba9a-6b2fafd92f3c')
   * @param {string|number} chapter Chapter number or UUID
   * @param {string} [cdn='cdn1'] CDN identifier (unused for Shinigami)
   */
  async getPages(slug, chapter, cdn = 'cdn1') {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    const rawChapter = String(chapter || '').trim();
    if (!cleanSlug || !rawChapter) {
      throw createBadRequest("Parameter 'slug' dan 'chapter' wajib diisi", 'INVALID_PARAMETER');
    }

    const mangaId = await this._resolveMangaId(cleanSlug);
    if (!mangaId) {
      throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan`, 'NOT_FOUND');
    }

    // Fetch chapters list to find target chapter_id
    const chRes = await this._fetchApi(`/chapter/${mangaId}/list`, {
      page: 1,
      page_size: 9999,
      sort_by: 'chapter_number',
      sort_order: 'desc',
    });

    const rawChapters = Array.isArray(chRes.data) ? chRes.data : [];
    const cleanChapterInput = rawChapter.toLowerCase().replace(/^chapter-?/i, '');

    const targetChapter = rawChapters.find((ch) => {
      if (ch.chapter_id === rawChapter) return true;
      if (String(ch.chapter_number) === rawChapter) return true;
      if (String(ch.chapter_number) === cleanChapterInput) return true;
      if (ch.chapter_title && ch.chapter_title.toLowerCase() === rawChapter.toLowerCase()) return true;
      return false;
    });

    if (!targetChapter) {
      throw createNotFound(`Chapter '${rawChapter}' tidak ditemukan untuk manga '${cleanSlug}'`, 'NOT_FOUND');
    }

    const detailRes = await this._fetchApi(`/chapter/detail/${targetChapter.chapter_id}`);
    const chapterData = detailRes.data?.chapter;
    if (!chapterData || !Array.isArray(chapterData.data)) {
      throw createBadGateway('Data halaman chapter dari Shinigami tidak lengkap', 'UPSTREAM_ERROR');
    }

    const basePath = chapterData.path.endsWith('/') ? chapterData.path : `${chapterData.path}/`;
    const pages = chapterData.data.map((imgFile, index) => {
      const cleanImgFile = imgFile.startsWith('/') ? imgFile.slice(1) : imgFile;
      const imageUrl = `https://${this.cdnDomain}${basePath}${cleanImgFile}`;
      return {
        page: index + 1,
        url: imageUrl,
        proxyUrl: `/api/proxy/image?url=${encodeURIComponent(imageUrl)}`,
      };
    });

    const mangaTitle = cleanSlug
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
    const chapterNum = targetChapter.chapter_number !== undefined ? String(targetChapter.chapter_number) : rawChapter;

    return {
      source: this.name,
      title: `${mangaTitle} Chapter ${chapterNum}`,
      totalPages: pages.length,
      pages,
    };
  }

  /**
   * Get supported sort options for Shinigami.
   * Shinigami supports latest, popular, rating, and bookmark (favorites) via /manga/list.
   * Shinigami does NOT have alphabetical /az endpoint.
   */
  getSupportedSorts() {
    return [
      { id: 'latest', name: 'Terbaru' },
      { id: 'popular', name: 'Populer' },
      { id: 'rating', name: 'Rating' },
      { id: 'bookmark', name: 'Terfavorit' },
    ];
  }
}

module.exports = ShinigamiSource;
