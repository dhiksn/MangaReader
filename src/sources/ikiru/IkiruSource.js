const BaseSource = require('../BaseSource');
const { getJson } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

class IkiruSource extends BaseSource {
  constructor() {
    super('ikiru', 'Ikiru');
    this.baseUrl = 'https://09.ikiru.wtf';
    this.apiBase = `${this.baseUrl}/api`;
    this.icon = `${this.baseUrl}/favicon.ico`;

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
      { id: 'za', name: 'Z-A' },
    ];
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  get _headers() {
    return { Referer: `${this.baseUrl}/` };
  }

  _resolveSort(raw) {
    const map = {
      latest: { sortBy: 'updated', sort: 'desc' },
      update: { sortBy: 'updated', sort: 'desc' },
      popular: { sortBy: 'popular', sort: 'desc' },
      popularity: { sortBy: 'popular', sort: 'desc' },
      rating: { sortBy: 'rating', sort: 'desc' },
      az: { sortBy: 'title', sort: 'asc' },
      title: { sortBy: 'title', sort: 'asc' },
      alphabetical: { sortBy: 'title', sort: 'asc' },
      za: { sortBy: 'title', sort: 'desc' },
    };
    return map[String(raw || '').toLowerCase()] || { sortBy: 'updated', sort: 'desc' };
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
    return Math.round(score * 100) / 100;
  }

  /** Map manga item from listing API response. */
  _mapListItem(item) {
    const slug = item.slug;
    if (!slug) return null;

    const rating = this._parseRating(item.metadata?.score);
    const genres = (item.metadata?.genre || []).map((g) => ({ name: g.name, slug: g.slug }));
    const latestChapter = item.chapter?.[0]?.number != null
      ? String(item.chapter[0].number)
      : null;

    return {
      title: item.title || slug,
      slug,
      cover: item.featuredImage || null,
      type: item.type?.toLowerCase() || null,
      rating,
      latestChapter,
      genres,
    };
  }

  /** Fetch listing from API. */
  async _fetchListing(params) {
    const url = new URL(`${this.apiBase}/public/library/search`);
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v); });
    const json = await getJson(url.toString(), { headers: this._headers });
    const mangas = json?.data?.mangas || [];
    const page = parseInt(params.page || 1, 10);
    const hasNextPage = mangas.length >= 21;
    return {
      data: mangas.map((m) => this._mapListItem(m)).filter(Boolean),
      hasNextPage,
      maxPage: null, // API doesn't return total pages
    };
  }

  // ─── Public endpoints ────────────────────────────────────────────────────────

  async getLatest(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const sort = String(options.order || options.sort || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const { data, hasNextPage, maxPage } = await this._fetchListing({ page: pageNum, sortBy: 'updated', sort });
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getPopular(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const sort = String(options.order || options.sort || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const { data, hasNextPage, maxPage } = await this._fetchListing({ page: pageNum, sortBy: 'popular', sort });
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getRating(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const sort = String(options.order || options.sort || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const { data, hasNextPage, maxPage } = await this._fetchListing({ page: pageNum, sortBy: 'rating', sort });
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getAz(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const sort = String(options.order || options.sort || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
    const { data, hasNextPage, maxPage } = await this._fetchListing({ page: pageNum, sortBy: 'title', sort });
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getZa(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const sort = String(options.order || options.sort || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const { data, hasNextPage, maxPage } = await this._fetchListing({ page: pageNum, sortBy: 'title', sort });
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { sortBy, sort } = this._resolveSort(options.sort || options.order || 'latest');
    const params = { page: pageNum, sortBy, sort };
    if (options.status) params.status = String(options.status).toUpperCase();
    if (options.type) params.type = String(options.type).toUpperCase();
    if (options.q || options.query) params.query = options.q || options.query;
    const { data, hasNextPage, maxPage } = await this._fetchListing(params);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async search(query, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage, maxPage } = await this._fetchListing({
      page: pageNum,
      query: String(query || '').trim(),
      sortBy: 'popular',
      sort: 'desc',
    });
    return {
      source: this.name,
      query: String(query || '').trim(),
      page: pageNum,
      maxPage,
      hasNextPage,
      data,
    };
  }

  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) {
      return this._cachedGenres;
    }

    const json = await getJson(`${this.apiBase}/user/genres`, { headers: this._headers });
    const allGenres = json?.data?.allGenres || [];

    const genres = allGenres
      .filter((g) => g.id && g.name)
      .map((g) => ({ name: g.name, slug: g.slug || g.id, id: g.id }))
      .sort((a, b) => a.name.localeCompare(b.name, 'id'));

    this._cachedGenres = genres;
    this._cachedGenresExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
    return genres;
  }

  async getByGenre(genre, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanGenre = String(genre || '').trim().toLowerCase();
    if (!cleanGenre) throw createBadRequest("Parameter 'genre' wajib diisi", 'INVALID_PARAMETER');

    const { sortBy, sort } = this._resolveSort(options.sort || options.order || 'latest');
    const genres = await this.getGenres();

    // Support comma-separated; Ikiru API supports multiple genre params
    const keys = cleanGenre.split(',').map((g) => g.trim()).filter(Boolean);
    const found = keys.map((key) => {
      const match = genres.find((g) => g.slug === key || g.name.toLowerCase() === key || g.id === key);
      if (!match) throw createNotFound(`Genre '${key}' tidak ditemukan di Ikiru`, 'NOT_FOUND');
      return match;
    });

    // Build URL with multiple genre params
    const url = new URL(`${this.apiBase}/public/library/search`);
    url.searchParams.set('page', pageNum);
    url.searchParams.set('sortBy', sortBy);
    url.searchParams.set('sort', sort);
    found.forEach((g) => url.searchParams.append('genre', g.id));

    const json = await getJson(url.toString(), { headers: this._headers });
    const mangas = json?.data?.mangas || [];
    const hasNextPage = mangas.length >= 21;

    return {
      source: this.name,
      genre: found.map((g) => g.name).join(', '),
      page: pageNum,
      maxPage: null,
      hasNextPage,
      data: mangas.map((m) => this._mapListItem(m)).filter(Boolean),
    };
  }

  async getTypes() {
    return ['manga', 'manhwa', 'manhua'];
  }

  async getByType(type, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanType = String(type || '').trim().toUpperCase();
    if (!cleanType) throw createBadRequest("Parameter 'type' wajib diisi", 'INVALID_PARAMETER');
    const { sortBy, sort } = this._resolveSort(options.sort || options.order || 'latest');
    const { data, hasNextPage, maxPage } = await this._fetchListing({ page: pageNum, sortBy, sort, type: cleanType });
    return { source: this.name, type: type.toLowerCase(), page: pageNum, maxPage, hasNextPage, data };
  }

  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    let json;
    try {
      json = await getJson(`${this.apiBase}/public/manga/${cleanSlug}`, { headers: this._headers });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di Ikiru`, 'NOT_FOUND');
      throw err;
    }

    const data = json?.data;
    if (!data) throw createBadGateway('Data manga tidak ditemukan dari Ikiru', 'UPSTREAM_ERROR');

    const title = data.title || cleanSlug;
    const cover = data.featuredImage || null;
    const synopsis = this._stripHtml(data.description) || null;
    const status = data.status ? data.status.toLowerCase() : null;
    const type = data.type ? data.type.toLowerCase() : null;
    const rating = this._parseRating(data.metadata?.score);

    // Alt titles
    const altTitles = (data.metadata?.alternateTitles || []).filter(Boolean);

    // Genres
    const genres = (data.metadata?.genre || []).map((g) => ({ name: g.name, slug: g.slug || g.id }));

    // Author & Artist
    const authors = (data.metadata?.author || []).map((a) => a.name).filter(Boolean);
    const artists = (data.metadata?.artist || []).map((a) => a.name).filter(Boolean);
    const allAuthors = [...new Set([...authors, ...artists])];

    // Chapters — from data.chapters.chapters, newest first → reverse for display
    const rawChapters = data.chapters?.chapters || [];
    const chapters = rawChapters.map((ch) => {
      const num = ch.number != null ? String(ch.number) : '';
      const chTitle = ch.title || `Chapter ${num}`;
      const date = this._formatDate(ch.updatedAt || ch.createdAt);
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
      author: allAuthors.length ? allAuthors.join(', ') : null,
      rating,
      genres,
      totalChapters: chapters.length,
      chapters,
    };
  }

  async getPages(slug, chapter) {
    const rawSlug = String(slug || '').trim();
    if (!rawSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    // slug can be "manga-slug/chapter-N" or just the full encoded string
    let mangaSlug, chapterNumber;
    if (rawSlug.includes('/chapter-')) {
      [mangaSlug, chapterNumber] = rawSlug.split('/chapter-');
    } else {
      mangaSlug = rawSlug;
      chapterNumber = String(chapter || '').replace(/^chapter-?/i, '');
    }

    if (!chapterNumber) throw createBadRequest("Nomor chapter wajib diisi", 'INVALID_PARAMETER');

    let json;
    try {
      json = await getJson(
        `${this.apiBase}/public/chapter/${chapterNumber}?mangaSlug=${encodeURIComponent(mangaSlug)}`,
        { headers: this._headers }
      );
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Chapter tidak ditemukan di Ikiru`, 'NOT_FOUND');
      throw err;
    }

    const data = json?.data;
    if (!data) throw createBadGateway('Data chapter tidak ditemukan dari Ikiru', 'UPSTREAM_ERROR');

    const medias = data.medias || [];
    if (medias.length === 0) throw createBadGateway('Tidak ada gambar untuk chapter ini', 'UPSTREAM_ERROR');

    // Sort by pageNumber
    const sorted = [...medias].sort((a, b) => (a.pageNumber || 0) - (b.pageNumber || 0));

    const pages = sorted.map((media, index) => {
      const imgUrl = media.filePath;
      return {
        page: media.pageNumber || index + 1,
        url: imgUrl,
        directUrl: imgUrl,
        proxyUrl: `/api/proxy/image?url=${encodeURIComponent(imgUrl)}&referer=${encodeURIComponent(`${this.baseUrl}/`)}`,
      };
    });

    const title = data.title || `Chapter ${chapterNumber}`;

    return {
      source: this.name,
      title,
      totalPages: pages.length,
      pages,
    };
  }
}

module.exports = IkiruSource;
