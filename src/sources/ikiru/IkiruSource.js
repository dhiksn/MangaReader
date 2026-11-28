const BaseSource = require('../BaseSource');
const { getJson } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

class IkiruSource extends BaseSource {
  constructor() {
    super('ikiru', 'Ikiru');
    this.baseUrl = 'https://v1.ikiru.wtf';
    this.apiBase = `${this.baseUrl}/api/v1`;
    this.icon = `${this.baseUrl}/favicon.ico`;

    // Genres cache
    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  getSupportedSorts() {
    return [
      { id: 'latest', name: 'Terbaru' },
      { id: 'popular', name: 'Populer' },
      { id: 'newest', name: 'Diperbarui' },
      { id: 'rating', name: 'Rating' },
      { id: 'az', name: 'A-Z' },
    ];
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  get _headers() {
    return {
      Referer: `${this.baseUrl}/`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    };
  }

  _resolveSort(raw) {
    const map = {
      latest: 'update',
      update: 'update',
      updated: 'update',
      popular: 'popular',
      popularity: 'popular',
      views: 'popular',
      newest: 'added',
      added: 'added',
      new: 'added',
      rating: 'rating',
      score: 'rating',
      az: 'title',
      title: 'title',
      alphabetical: 'title',
    };
    return map[String(raw || '').toLowerCase()] || 'update';
  }

  /** Format ISO date string to relative Indonesian time (e.g. "baru saja", "2 jam lalu"). */
  _formatDate(dateStr) {
    if (!dateStr) return null;
    try {
      const d = new Date(dateStr);
      const now = Date.now();
      const diff = now - d.getTime();
      const sec = Math.floor(diff / 1000);
      const min = Math.floor(sec / 60);
      const hour = Math.floor(min / 60);
      const day = Math.floor(hour / 24);
      const week = Math.floor(day / 7);
      const month = Math.floor(day / 30);
      const year = Math.floor(day / 365);

      if (sec < 60) return 'baru saja';
      if (min < 60) return `${min} menit lalu`;
      if (hour < 24) return `${hour} jam lalu`;
      if (day < 7) return `${day} hari lalu`;
      if (week < 5) return `${week} minggu lalu`;
      if (month < 12) return `${month} bulan lalu`;
      return `${year} tahun lalu`;
    } catch {
      return null;
    }
  }

  /** Strip HTML tags from description. */
  _stripHtml(html) {
    if (!html) return null;
    return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || null;
  }

  /** Parse rating: score is 0-10, normalize to float with 2 decimals. */
  _parseRating(score) {
    if (!score || score <= 0) return null;
    return Math.round(Number(score) * 100) / 100;
  }

  /** Map manga item from listing API response. */
  _mapListItem(item) {
    const slug = item.slug;
    if (!slug) return null;

    const rating = this._parseRating(item.rating);
    const genres = (item.genreList && Array.isArray(item.genreList))
      ? item.genreList.map((g) => ({ name: g.name, slug: g.slug }))
      : (Array.isArray(item.genres) ? item.genres.map((g) => ({ name: g, slug: String(g).toLowerCase() })) : []);

    const latestChapter = item.latestChapter != null
      ? String(item.latestChapter)
      : (item.chapters?.[0]?.n != null ? String(item.chapters[0].n) : null);

    return {
      title: item.title || slug,
      slug,
      cover: item.coverUrl || item.img || item.thumb || null,
      type: item.type?.toLowerCase() || null,
      status: item.status?.toLowerCase() || null,
      rating,
      latestChapter,
      latestChapterTime: item.latestChapterTime || null,
      genres,
    };
  }

  /** Fetch listing from API. */
  async _fetchListing(params) {
    const url = new URL(`${this.apiBase}/series`);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, v);
      }
    });

    const json = await getJson(url.toString(), { headers: this._headers });
    const series = json?.data || [];
    const pagination = json?.pagination;
    const page = parseInt(params.page || 1, 10);
    const maxPage = pagination?.totalPages || null;
    const hasNextPage = pagination?.hasNextPage !== undefined
      ? Boolean(pagination.hasNextPage)
      : (maxPage ? page < maxPage : false);

    return {
      data: Array.isArray(series) ? series.map((m) => this._mapListItem(m)).filter(Boolean) : [],
      hasNextPage,
      maxPage,
    };
  }

  // ─── Public endpoints ────────────────────────────────────────────────────────

  async getLatest(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage, maxPage } = await this._fetchListing({ page: pageNum, sort: 'update' });
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getPopular(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage, maxPage } = await this._fetchListing({ page: pageNum, sort: 'popular' });
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getNewest(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage, maxPage } = await this._fetchListing({ page: pageNum, sort: 'added' });
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getRating(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage, maxPage } = await this._fetchListing({ page: pageNum, sort: 'rating' });
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getAz(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage, maxPage } = await this._fetchListing({ page: pageNum, sort: 'title' });
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const sort = this._resolveSort(options.sort || options.order || 'update');
    const params = { page: pageNum, sort };
    if (options.status) params.status = String(options.status).toUpperCase();
    if (options.type) params.type = String(options.type).toUpperCase();
    if (options.q || options.query) params.q = options.q || options.query;
    if (options.genre) params.genre = options.genre;
    const { data, hasNextPage, maxPage } = await this._fetchListing(params);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async search(query, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanQ = String(query || '').trim();
    if (!cleanQ) {
      return {
        source: this.name,
        query: '',
        page: pageNum,
        maxPage: 1,
        hasNextPage: false,
        data: [],
      };
    }

    let result = await this._fetchListing({
      page: pageNum,
      q: cleanQ,
      sort: 'popular',
    });

    // If query contains hyphen and returned no results, retry with spaces
    if (result.data.length === 0 && cleanQ.includes('-')) {
      const spaceQ = cleanQ.replace(/-/g, ' ');
      const fallbackResult = await this._fetchListing({
        page: pageNum,
        q: spaceQ,
        sort: 'popular',
      });
      if (fallbackResult.data.length > 0) {
        result = fallbackResult;
      }
    }

    return {
      source: this.name,
      query: cleanQ,
      page: pageNum,
      maxPage: result.maxPage,
      hasNextPage: result.hasNextPage,
      data: result.data,
    };
  }

  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) {
      return this._cachedGenres;
    }

    const json = await getJson(`${this.apiBase}/genres`, { headers: this._headers });
    const allGenres = json?.data || [];

    const genres = allGenres
      .filter((g) => g.id && g.name)
      .map((g) => ({ name: g.name, slug: g.slug || String(g.id), id: g.id }))
      .sort((a, b) => a.name.localeCompare(b.name, 'id'));

    this._cachedGenres = genres;
    this._cachedGenresExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
    return genres;
  }

  async getByGenre(genre, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanGenre = String(genre || '').trim().toLowerCase();
    if (!cleanGenre) throw createBadRequest("Parameter 'genre' wajib diisi", 'INVALID_PARAMETER');

    const sort = this._resolveSort(options.sort || options.order || 'update');
    const genres = await this.getGenres();

    // Support comma-separated
    const keys = cleanGenre.split(',').map((g) => g.trim()).filter(Boolean);
    const found = keys.map((key) => {
      const match = genres.find((g) => g.slug === key || g.name.toLowerCase() === key || String(g.id) === key);
      if (!match) throw createNotFound(`Genre '${key}' tidak ditemukan di Ikiru`, 'NOT_FOUND');
      return match;
    });

    const genreParam = found.map((g) => g.slug).join(',');
    const { data, hasNextPage, maxPage } = await this._fetchListing({
      page: pageNum,
      sort,
      genre: genreParam,
    });

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
    const cleanType = String(type || '').trim().toUpperCase();
    if (!cleanType) throw createBadRequest("Parameter 'type' wajib diisi", 'INVALID_PARAMETER');
    const sort = this._resolveSort(options.sort || options.order || 'update');
    const { data, hasNextPage, maxPage } = await this._fetchListing({
      page: pageNum,
      sort,
      type: cleanType,
    });
    return { source: this.name, type: type.toLowerCase(), page: pageNum, maxPage, hasNextPage, data };
  }

  async getDetails(slug) {
    let cleanSlug = String(slug || '').trim();
    if (cleanSlug.startsWith('http')) {
      try {
        const u = new URL(cleanSlug);
        const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
        cleanSlug = parts[parts.length - 1];
      } catch (_) {}
    }
    cleanSlug = cleanSlug.replace(/^\/+|\/+$/g, '').split('/')[0];
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    let json;
    try {
      json = await getJson(`${this.apiBase}/series/${encodeURIComponent(cleanSlug)}`, { headers: this._headers });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di Ikiru`, 'NOT_FOUND');
      throw err;
    }

    const data = json?.data;
    if (!data || json?.success === false || data.success === false || !data.slug) {
      throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di Ikiru`, 'NOT_FOUND');
    }

    const title = data.title || cleanSlug;
    const cover = data.coverUrl || data.img || data.thumb || null;
    const synopsis = this._stripHtml(data.synopsis) || null;
    const status = data.status ? data.status.toLowerCase() : null;
    const type = data.type ? data.type.toLowerCase() : null;
    const rating = this._parseRating(data.rating);

    // Alt titles
    const altTitles = (data.altTitles || []).filter(Boolean);

    // Genres
    const genres = (data.genreObjects && Array.isArray(data.genreObjects))
      ? data.genreObjects.map((g) => ({ name: g.name, slug: g.slug }))
      : ((data.genres || []).map((g) => ({ name: g, slug: String(g).toLowerCase() })));

    // Author & Artist
    let author = data.author || null;
    let artist = data.artist || null;
    if (!author && Array.isArray(data.creators)) {
      author = data.creators.filter((c) => c.role === 'author').map((c) => c.name).join(', ') || null;
    }
    if (!artist && Array.isArray(data.creators)) {
      artist = data.creators.filter((c) => c.role === 'artist').map((c) => c.name).join(', ') || null;
    }
    const authorsList = [...new Set([author, artist].filter(Boolean))];
    const combinedAuthor = authorsList.length ? authorsList.join(', ') : null;

    // Chapters
    const rawChapters = data.chapters || [];
    const chapters = rawChapters.map((ch) => {
      const num = ch.chapterNumber != null ? String(ch.chapterNumber) : '';
      const chTitle = ch.title || `Chapter ${num}`;
      const date = ch.relativeTime || this._formatDate(ch.publishedAt);
      return {
        title: chTitle,
        slug: `${cleanSlug}/chapter-${num}`,
        endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(`${cleanSlug}/chapter-${num}`)}`,
        date,
      };
    });

    return {
      source: this.name,
      title,
      altTitle: altTitles.length ? altTitles.join('; ') : null,
      cover,
      synopsis,
      status,
      type,
      author: combinedAuthor,
      artist: artist || null,
      rating,
      genres,
      totalChapters: chapters.length,
      chapters,
    };
  }

  async getPages(slug, chapter) {
    const rawSlug = String(slug || '').trim();
    if (!rawSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    let mangaSlug, chapterNumber;
    if (rawSlug.includes('/chapter-')) {
      [mangaSlug, chapterNumber] = rawSlug.split('/chapter-');
    } else if (rawSlug.includes('/chapters/')) {
      [mangaSlug, chapterNumber] = rawSlug.split('/chapters/');
    } else if (rawSlug.includes('/chapter/')) {
      [mangaSlug, chapterNumber] = rawSlug.split('/chapter/');
    } else {
      mangaSlug = rawSlug;
      chapterNumber = String(chapter || '').replace(/^chapter-?/i, '');
    }

    if (!chapterNumber) throw createBadRequest("Nomor chapter wajib diisi", 'INVALID_PARAMETER');

    let json;
    try {
      json = await getJson(
        `${this.apiBase}/series/${encodeURIComponent(mangaSlug)}/chapters/${encodeURIComponent(chapterNumber)}`,
        { headers: this._headers }
      );
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Chapter '${chapterNumber}' tidak ditemukan di Ikiru`, 'NOT_FOUND');
      throw err;
    }

    const data = json?.data;
    if (!data || json?.success === false || data.success === false) {
      throw createNotFound(`Chapter '${chapterNumber}' tidak ditemukan di Ikiru`, 'NOT_FOUND');
    }

    const rawPages = data.pages || [];
    if (rawPages.length === 0) throw createBadGateway('Tidak ada gambar untuk chapter ini', 'UPSTREAM_ERROR');

    // Sort by pageNumber
    const sorted = [...rawPages].sort((a, b) => (a.pageNumber || 0) - (b.pageNumber || 0));

    const pages = sorted.map((media, index) => {
      const imgUrl = media.imageUrl || media.url || media.filePath;
      return {
        page: media.pageNumber || index + 1,
        url: imgUrl,
        directUrl: imgUrl,
        proxyUrl: `/api/proxy/image?url=${encodeURIComponent(imgUrl)}&referer=${encodeURIComponent(`${this.baseUrl}/`)}`,
      };
    });

    const title = data.chapter?.title || `${data.series?.title || mangaSlug} Chapter ${chapterNumber}`;

    return {
      source: this.name,
      title,
      totalPages: pages.length,
      pages,
    };
  }
}

module.exports = IkiruSource;
