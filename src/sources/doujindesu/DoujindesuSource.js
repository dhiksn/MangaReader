const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');
const { formatPagination } = require('../../utils/responseHelper');
const { formatRelativeTime } = require('../../utils/date');

class DoujindesuSource extends BaseSource {
  constructor() {
    super('doujindesu', 'DoujinDesu');
    this.domain = 'doujin.desu.xxx';
    this.baseUrl = `https://${this.domain}`;
    this.secret = 'dfdf72051dbfdc7d76889ebd31324e74';
    this.pageSize = 24;

    // Genres cache in memory (24h)
    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  /**
   * Generate encryption/decryption key based on hourly time step.
   * Matches DoujinDesu's key generation algorithm.
   * @private
   */
  _generateKey(step) {
    const input = `doujindesu-scrapers-cannot-read-this-super-secret-salt-2026-v2_${step}`;
    let n = 0;
    for (let i = 0; i < input.length; i++) {
      n = ((n << 5) - n + input.charCodeAt(i)) | 0;
    }
    let seed = n === 0 ? 123456789n : BigInt(Math.abs(n));
    let key = '';
    for (let i = 0; i < 32; i++) {
      seed = (seed * 1664525n + 1013904223n) & 0xFFFFFFFFn;
      const charCode = 33 + Number(seed % 93n);
      key += String.fromCharCode(charCode);
    }
    return key;
  }

  /**
   * Decrypt encrypted hex response payload with hourly step tolerances.
   * @private
   */
  _decrypt(encHex) {
    if (!encHex || typeof encHex !== 'string') {
      throw new Error('Invalid encrypted response payload');
    }

    const timeStep = 3600000;
    const now = Date.now();
    const currentStep = BigInt(Math.floor(now / timeStep));
    let lastError = null;

    for (const offset of [0n, -1n, 1n]) {
      const step = currentStep + offset;
      const key = this._generateKey(step);
      try {
        const encBytes = Buffer.from(encHex, 'hex');
        const decBytes = Buffer.alloc(encBytes.length);
        let c = 42;
        for (let i = 0; i < encBytes.length; i++) {
          const p = encBytes[i];
          const f = key.charCodeAt(i % key.length);
          const k = (p ^ f ^ (i * 13) ^ c) & 0xFF;
          decBytes[i] = k;
          c = (c + p) % 256;
        }
        const decoded = decBytes.toString('utf8');
        const unescaped = decodeURIComponent(decoded.replace(/\+/g, '%20'));
        return JSON.parse(unescaped);
      } catch (e) {
        lastError = e;
      }
    }

    throw lastError || new Error('Gagal mendekripsi respons DoujinDesu');
  }

  /**
   * Fetch and decrypt JSON from DoujinDesu API.
   * @private
   */
  async _fetchApi(path, queryParams = {}, options = {}) {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined && value !== null && value !== '') {
        if (Array.isArray(value)) {
          for (const item of value) {
            url.searchParams.append(key, item);
          }
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }

    let response;
    try {
      response = await fetch(url.toString(), {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `${this.baseUrl}/`,
          'X-App-Secret': this.secret,
          Accept: 'application/json, text/plain, */*',
        },
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw createBadGateway(
          'Target DoujinDesu gagal diakses (waktu tunggu habis setelah 15s)',
          'UPSTREAM_TIMEOUT'
        );
      }
      throw createBadGateway(
        `Target DoujinDesu gagal diakses: ${err.message || 'Koneksi terputus'}`,
        'UPSTREAM_ERROR'
      );
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw createNotFound('Data tidak ditemukan pada server DoujinDesu', 'NOT_FOUND');
      }
      throw createBadGateway(
        `Server DoujinDesu mengembalikan error HTTP ${response.status}`,
        'UPSTREAM_ERROR'
      );
    }

    const json = await response.json();
    let rawData = json;
    if (json && json._enc_resp_) {
      rawData = this._decrypt(json._enc_resp_);
    }

    if (options.withMeta) {
      const totalHeader = response.headers.get('x-total-count');
      const total = totalHeader ? Number(totalHeader) || null : null;
      return { data: rawData, total };
    }

    return rawData;
  }

  /**
   * Transform page URL to ensure canonical storage path.
   * @private
   */
  _transformPageUrl(page) {
    if (typeof page !== 'string') return page;
    if (page.includes('/uploads/') && !page.includes('/storage/uploads/')) {
      return page.replace('/uploads/', '/storage/uploads/');
    }
    if (page.includes('/upload/') && !page.includes('/storage/upload/')) {
      return page.replace('/upload/', '/storage/upload/');
    }
    return page;
  }

  /**
   * Map DoujinDesu API manga item into standardized card object.
   * @private
   */
  _mapMangaItem(item) {
    const rawUpdatedAt = item.updated_at || item.created_at;
    const updatedAt = rawUpdatedAt ? formatRelativeTime(rawUpdatedAt) : null;

    let cover = item.cover_url || null;
    if (cover && !cover.startsWith('http')) {
      cover = `${this.baseUrl}${cover.startsWith('/') ? '' : '/'}${cover}`;
    }

    let latestChapter = null;
    if (item.chapters && item.chapters.length > 0 && item.chapters[0].chapter_number !== undefined) {
      latestChapter = String(item.chapters[0].chapter_number);
    } else if (item.chapter_count !== undefined && item.chapter_count !== null) {
      latestChapter = String(item.chapter_count);
    } else if (item._count?.chapters !== undefined) {
      latestChapter = String(item._count.chapters);
    }

    return {
      title: item.title?.trim(),
      slug: item.slug,
      cover,
      type: item.type || null,
      status: item.status || null,
      rating: typeof item.rating === 'number' ? item.rating : null,
      latestChapter,
      genres: Array.isArray(item.manga_genres)
        ? item.manga_genres
            .map((g) => {
              const genreObj = g?.genres || g;
              const name = genreObj?.name ? String(genreObj.name).trim() : null;
              const slug = genreObj?.slug ? String(genreObj.slug).trim() : null;
              if (!name) return null;
              return {
                name,
                slug: slug || name.toLowerCase().replace(/[\s\-_()]+/g, '-'),
              };
            })
            .filter(Boolean)
        : [],
      updatedAt,
    };
  }

  /**
   * Clean description HTML and remove download batch / spam text.
   * @private
   */
  _cleanDescription(rawDesc) {
    if (!rawDesc || typeof rawDesc !== 'string' || rawDesc === 'null') return null;

    const $ = cheerio.load(rawDesc);
    let fullText = $('body').text().trim();
    if (!fullText) fullText = rawDesc.replace(/<[^>]+>/g, '').trim();

    const cutoffRegex = /download\s+(batch|volume)/i;
    const cutoffMatch = cutoffRegex.exec(fullText);
    if (cutoffMatch) {
      fullText = fullText.substring(0, cutoffMatch.index);
    }

    return fullText
      .replace(/^sinopsis:\s*/i, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\[url=.*?\]|\[\/url\]/gi, '')
      .trim() || null;
  }

  /**
   * Extract author name from author field or term_list metadata.
   * @private
   */
  _extractAuthor(detail) {
    if (detail.author && detail.author !== 'null' && typeof detail.author === 'string') {
      return detail.author.trim();
    }
    if (detail.term_list && typeof detail.term_list === 'string') {
      const match = detail.term_list.match(/([^|:]+):author:[^|]+/);
      if (match && match[1] && match[1].toLowerCase() !== 'n/a') {
        return match[1].trim();
      }
    }
    return null;
  }

  /**
   * Get popular manga list from DoujinDesu.
   * @param {number} [page=1] Page number
   */
  async getPopular(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const offset = (pageNum - 1) * this.pageSize;

    const rawList = await this._fetchApi('/api/manga', {
      limit: this.pageSize,
      offset,
      sort: 'rating',
    });

    const data = Array.isArray(rawList) ? rawList.map((item) => this._mapMangaItem(item)) : [];
    if (pageNum > 1 && data.length === 0) {
      throw createNotFound(`Halaman ${pageNum} tidak ditemukan`, 'NOT_FOUND');
    }

    const hasNextPage = data.length === this.pageSize;
    const pagination = formatPagination({
      page: pageNum,
      hasNextPage,
    });

    return {
      source: this.name,
      data,
      pagination,
      page: pageNum,
      hasNextPage,
    };
  }

  /**
   * Get latest updated manga list from DoujinDesu.
   * Sourced from https://doujin.desu.xxx/explore?sort=latest_chapter.
   * @param {number} [page=1] Page number
   */
  async getLatest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const offset = (pageNum - 1) * this.pageSize;

    const { data: rawList, total } = await this._fetchApi(
      '/api/manga',
      {
        sort: 'latest_chapter',
        limit: this.pageSize,
        offset,
      },
      { withMeta: true }
    );

    const data = Array.isArray(rawList) ? rawList.map((item) => this._mapMangaItem(item)) : [];
    const maxPage = total ? Math.ceil(total / this.pageSize) : null;

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
      from: `${this.baseUrl}/explore?sort=latest_chapter`,
      data,
      pagination,
      page: pageNum,
      maxPage,
      hasNextPage,
    };
  }

  /**
   * Get top rated manga list from DoujinDesu.
   * Sourced from https://doujin.desu.xxx/explore?sort=rating.
   * @param {number} [page=1] Page number
   */
  async getRating(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const offset = (pageNum - 1) * this.pageSize;

    const { data: rawList, total } = await this._fetchApi(
      '/api/manga',
      {
        limit: this.pageSize,
        offset,
        sort: 'rating',
      },
      { withMeta: true }
    );

    const data = Array.isArray(rawList) ? rawList.map((item) => this._mapMangaItem(item)) : [];
    const maxPage = total ? Math.ceil(total / this.pageSize) : null;

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
      from: `${this.baseUrl}/explore?sort=rating`,
      data,
      pagination,
      page: pageNum,
      maxPage,
      hasNextPage,
    };
  }

  /**
   * Get alphabetical A-Z manga list from DoujinDesu.
   * Sourced from https://doujin.desu.xxx/explore?sort=title_asc.
   * @param {number} [page=1] Page number
   */
  async getAz(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const offset = (pageNum - 1) * this.pageSize;

    const { data: rawList, total } = await this._fetchApi(
      '/api/manga',
      {
        limit: this.pageSize,
        offset,
        sort: 'title_asc',
      },
      { withMeta: true }
    );

    const data = Array.isArray(rawList) ? rawList.map((item) => this._mapMangaItem(item)) : [];
    const maxPage = total ? Math.ceil(total / this.pageSize) : null;

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
      sort: 'az',
      from: `${this.baseUrl}/explore?sort=title_asc`,
      data,
      pagination,
      page: pageNum,
      maxPage,
      hasNextPage,
    };
  }

  /**
   * Search manga in DoujinDesu.
   * Sourced from https://doujin.desu.xxx/explore?search=:query.
   * @param {string} query Search keyword
   * @param {number} [page=1] Page number
   */
  async search(query, page = 1) {
    const rawQuery = String(query || '').trim();
    if (!rawQuery) {
      throw createBadRequest('Parameter query "q" wajib diisi', 'INVALID_PARAMETER');
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const offset = (pageNum - 1) * this.pageSize;

    const { data: rawList, total } = await this._fetchApi(
      '/api/manga',
      {
        search: rawQuery,
        limit: this.pageSize,
        offset,
      },
      { withMeta: true }
    );

    const data = Array.isArray(rawList) ? rawList.map((item) => this._mapMangaItem(item)) : [];
    const maxPage = total ? Math.ceil(total / this.pageSize) : null;

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
      from: `${this.baseUrl}/explore?search=${encodeURIComponent(rawQuery)}`,
      query: rawQuery,
      data,
      pagination,
      page: pageNum,
      maxPage,
      hasNextPage,
    };
  }

  /**
   * Get list of all available genres from DoujinDesu.
   */
  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) {
      return this._cachedGenres;
    }

    const rawTerms = await this._fetchApi('/api/terms', { taxonomy: 'genre' });
    const genres = [];

    if (Array.isArray(rawTerms)) {
      for (const item of rawTerms) {
        if (item && item.slug && item.name) {
          genres.push({
            name: item.name.trim(),
            slug: item.slug.trim(),
          });
        }
      }
    }

    genres.sort((a, b) => a.name.localeCompare(b.name));
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
   * Get manga list filtered by genre from DoujinDesu.
   * Matches the website's genre browser (https://doujin.desu.xxx/genres/:genre).
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

    // Call DoujinDesu taxonomy endpoint as used on doujin.desu.xxx/genres/:slug
    let res;
    try {
      res = await this._fetchApi(`/api/taxonomy/genres/${encodeURIComponent(targetSlug)}`, {
        page: pageNum,
        sort: 'latest',
        limit: this.pageSize,
      });
    } catch (err) {
      if (err.statusCode === 404 || err.message?.includes('tidak ditemukan')) {
        throw createNotFound(`Genre '${rawGenre}' tidak ditemukan`, 'NOT_FOUND');
      }
      throw err;
    }

    const rawList = res?.mangaList || (Array.isArray(res) ? res : []);
    const data = rawList.map((item) => this._mapMangaItem(item));

    const totalPages = res?.pagination?.totalPages || null;
    if (pageNum > 1 && ((totalPages && pageNum > totalPages) || data.length === 0)) {
      throw createNotFound(
        `Halaman ${pageNum} tidak ditemukan untuk genre '${rawGenre}'${
          totalPages ? ` (maksimal halaman ${totalPages})` : ''
        }`,
        'NOT_FOUND'
      );
    }

    const hasNextPage = totalPages ? pageNum < totalPages : data.length === this.pageSize;
    const pagination = formatPagination({
      page: pageNum,
      maxPage: totalPages,
      hasNextPage,
    });

    return {
      source: this.name,
      genre: res?.term?.name || targetSlug,
      from: `${this.baseUrl}/genres/${targetSlug}`,
      data,
      pagination,
      page: pageNum,
      maxPage: totalPages,
      hasNextPage,
    };
  }

  /**
   * Get list of supported comic types for DoujinDesu.
   */
  async getTypes() {
    return ['manga', 'manhwa', 'doujinshi'];
  }

  /**
   * Get manga list filtered by type ('manga', 'manhwa', 'doujinshi').
   * - 'doujinshi' / 'manga' maps to https://doujin.desu.xxx/doujin (gabungan doujinshi & manga)
   * - 'manhwa' maps to https://doujin.desu.xxx/manhwa
   * @param {string} type Comic type
   * @param {number} [page=1] Page number
   */
  async getByType(type, page = 1) {
    const cleanType = String(type || '').trim().toLowerCase();
    const validTypes = await this.getTypes();
    if (!validTypes.includes(cleanType)) {
      throw createBadRequest(
        `Tipe '${cleanType}' tidak valid. Pilihan tersedia: ${validTypes.join(', ')}`,
        'INVALID_PARAMETER'
      );
    }

    const isDoujinOrManga = cleanType === 'doujinshi' || cleanType === 'manga';
    const typeParam = isDoujinOrManga ? 'doujinshi,manga' : cleanType;
    const fromUrl = isDoujinOrManga ? `${this.baseUrl}/doujin` : `${this.baseUrl}/${cleanType}`;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const offset = (pageNum - 1) * this.pageSize;

    const { data: rawList, total } = await this._fetchApi(
      '/api/manga',
      {
        type: typeParam,
        sort: 'latest_chapter',
        limit: this.pageSize,
        offset,
      },
      { withMeta: true }
    );

    const data = Array.isArray(rawList) ? rawList.map((item) => this._mapMangaItem(item)) : [];
    const maxPage = total ? Math.ceil(total / this.pageSize) : null;

    if (pageNum > 1 && ((maxPage && pageNum > maxPage) || data.length === 0)) {
      throw createNotFound(
        `Halaman ${pageNum} tidak ditemukan untuk tipe '${cleanType}'${
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
      type: cleanType,
      from: fromUrl,
      data,
      pagination,
      page: pageNum,
      maxPage,
      hasNextPage,
    };
  }

  /**
   * Get complete manga details, synopsis, chapters, and similar comics from DoujinDesu.
   * @param {string} slug Manga slug (e.g. 'shitataru-kano-haha')
   */
  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    if (!cleanSlug) {
      throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');
    }

    let detail;
    try {
      detail = await this._fetchApi(`/api/manga/${encodeURIComponent(cleanSlug)}`);
    } catch (err) {
      if (err.statusCode === 404 || err.message?.includes('tidak ditemukan')) {
        throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan`, 'NOT_FOUND');
      }
      throw err;
    }

    if (!detail || !detail.title) {
      throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan`, 'NOT_FOUND');
    }

    const title = detail.title;
    const altTitle = detail.alt_titles
      ? detail.alt_titles
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean)
          .join(' | ')
      : null;

    let cover = detail.cover_url || null;
    if (cover && !cover.startsWith('http')) {
      cover = `${this.baseUrl}${cover.startsWith('/') ? '' : '/'}${cover}`;
    }

    const synopsis = this._cleanDescription(detail.description);
    const author = this._extractAuthor(detail);
    const status = detail.status || null;
    const type = detail.type || null;
    const rating = typeof detail.rating === 'number' ? detail.rating : null;

    const genres = Array.isArray(detail.manga_genres)
      ? detail.manga_genres
          .map((g) => {
            const genreObj = g?.genres || g;
            const name = genreObj?.name ? String(genreObj.name).trim() : null;
            const slug = genreObj?.slug ? String(genreObj.slug).trim() : null;
            if (!name) return null;
            return {
              name,
              slug: slug || name.toLowerCase().replace(/[\s\-_()]+/g, '-'),
            };
          })
          .filter(Boolean)
      : [];

    const rawChapters = Array.isArray(detail.chapters) ? detail.chapters : [];
    const chapters = rawChapters.map((ch) => {
      const chNum = ch.chapter_number !== undefined ? ch.chapter_number : null;
      const chTitle = ch.title || (chNum !== null ? `Chapter ${chNum}` : 'Chapter 1');
      const slugVal = chNum !== null ? String(chNum) : ch.id;

      const rawDate = ch.created_at || null;
      let cleanDate = null;
      if (rawDate) {
        const d = new Date(rawDate);
        const months = [
          'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
          'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
        ];
        cleanDate = `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
      }

      return {
        // internal only — used by getPages for chapter matching
        id: ch.id,
        slug: slugVal,
        chapterNumber: chNum,
        // public fields
        title: chTitle,
        createdAt: cleanDate,
      };
    });

    // Fetch similar comics based on primary genre, positioned at the bottom of data
    const similar = [];
    try {
      const primaryGenreSlug = detail.manga_genres?.[0]?.genres?.slug;
      const queryParams = { limit: 6 };
      if (primaryGenreSlug) {
        queryParams['genres[]'] = primaryGenreSlug;
      } else if (type) {
        queryParams.type = type;
      } else {
        queryParams.sort = 'rating';
      }

      const similarRaw = await this._fetchApi('/api/manga', queryParams);
      if (Array.isArray(similarRaw)) {
        for (const sim of similarRaw) {
          if (sim.slug !== cleanSlug && similar.length < 5) {
            let simCover = sim.cover_url || null;
            if (simCover && !simCover.startsWith('http')) {
              simCover = `${this.baseUrl}${simCover.startsWith('/') ? '' : '/'}${simCover}`;
            }
            similar.push({
              title: sim.title,
              slug: sim.slug,
              cover: simCover,
              type: sim.type || null,
              rating: typeof sim.rating === 'number' ? sim.rating : null,
            });
          }
        }
      }
    } catch (_) {}

    return {
      source: this.name,
      title,
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
   * Get chapter image pages from DoujinDesu.
   * @param {string} slug Manga slug (e.g. 'shitataru-kano-haha')
   * @param {string|number} chapter Chapter number or slug/uuid
   * @param {string} [cdn='cdn1'] CDN identifier (unused for DoujinDesu)
   */
  async getPages(slug, chapter, cdn = 'cdn1') {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    const rawChapter = String(chapter || '').trim();
    if (!cleanSlug || !rawChapter) {
      throw createBadRequest("Parameter 'slug' dan 'chapter' wajib diisi", 'INVALID_PARAMETER');
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let chId = null;
    let chTitle = null;

    if (uuidRegex.test(rawChapter)) {
      chId = rawChapter;
    } else {
      const details = await this.getDetails(cleanSlug);
      const cleanChParam = rawChapter.replace(/^chapter-?/i, '').toLowerCase();

      const matchedChapter = details.chapters.find((ch) => {
        const chNumStr = ch.chapterNumber !== null ? String(ch.chapterNumber) : '';
        return (
          ch.id === rawChapter ||
          ch.slug === rawChapter ||
          ch.slug === cleanChParam ||
          chNumStr === cleanChParam ||
          ch.title.toLowerCase() === rawChapter.toLowerCase() ||
          ch.title.toLowerCase().includes(`chapter ${cleanChParam}`)
        );
      });

      if (!matchedChapter) {
        throw createNotFound(
          `Chapter '${rawChapter}' tidak ditemukan pada manga '${cleanSlug}'`,
          'NOT_FOUND'
        );
      }

      chId = matchedChapter.id;
      chTitle = matchedChapter.title;
    }

    const chData = await this._fetchApi(`/api/chapters/${chId}`);
    if (!chData) {
      throw createNotFound(`Data chapter '${rawChapter}' tidak ditemukan`, 'NOT_FOUND');
    }

    let contentUrls = Array.isArray(chData.content_urls) ? chData.content_urls : [];
    if (contentUrls.length === 0 && chData.signed_content_urls) {
      try {
        const parsed =
          typeof chData.signed_content_urls === 'string'
            ? JSON.parse(chData.signed_content_urls)
            : chData.signed_content_urls;
        if (Array.isArray(parsed)) contentUrls = parsed;
      } catch (_) {}
    }

    if (contentUrls.length === 0) {
      throw createNotFound(
        `Gambar untuk chapter '${rawChapter}' tidak ditemukan atau target chapter belum tersedia`,
        'NOT_FOUND'
      );
    }

    const pages = contentUrls.map((rawUrl, idx) => {
      const pageUrl = this._transformPageUrl(rawUrl);
      return {
        page: idx + 1,
        url: pageUrl,
        proxyUrl: `/api/proxy/image?url=${encodeURIComponent(pageUrl)}`,
      };
    });

    return {
      source: this.name,
      title: chTitle || chData.title || `Chapter ${rawChapter}`,
      totalPages: pages.length,
      pages,
    };
  }
}

module.exports = DoujindesuSource;
