const BaseSource = require('../BaseSource');
const { getJson } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');
const { formatRelativeTime } = require('../../utils/date');

class AinzSource extends BaseSource {
  constructor() {
    super('ainz', 'AinzScans');
    this.baseUrl = 'https://v3.ainzscans01.com';
    this.apiBase = 'https://api.ainzscans01.com';
    this.icon = 'https://api.ainzscans01.com/api/uploads/site-branding/favicon-1773679687168-jsyhcr.png';

    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  getSupportedSorts() {
    return [
      { id: 'latest', name: 'Terbaru' },
      { id: 'newest', name: 'Diperbarui' },
      { id: 'popular', name: 'Populer' },
      { id: 'az', name: 'A-Z' },
      { id: 'za', name: 'Z-A' },
    ];
  }

  get _headers() {
    return {
      Referer: `${this.baseUrl}/`,
      Origin: this.baseUrl,
    };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  _resolveSort(raw) {
    const map = {
      latest: 'new', update: 'new',
      popular: 'views', popularity: 'views',
      newest: 'latest', new: 'new',
      az: 'az', title: 'az', alphabetical: 'az',
      za: 'za',
      rating: 'rating',
    };
    return map[String(raw || '').toLowerCase()] || 'new';
  }

  _parseState(raw) {
    switch ((raw || '').toUpperCase()) {
      case 'ONGOING': return 'ongoing';
      case 'COMPLETED': return 'completed';
      case 'HIATUS': return 'hiatus';
      default: return null;
    }
  }

  _parseRating(raw) {
    const n = parseFloat(raw);
    return !isNaN(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  }

  _parseAltTitles(raw) {
    if (!raw) return null;
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter(Boolean).join('; ') : null;
    } catch { return null; }
  }

  _formatDate(iso) {
    if (!iso) return null;
    try { return formatRelativeTime(iso); } catch { return iso.split('T')[0]; }
  }

  _mapListItem(item) {
    return {
      title: item.title || item.slug,
      slug: item.slug,
      cover: item.poster_image_url || null,
      type: (item.comic_subtype || item.comic_type)?.toLowerCase() || null,
      status: this._parseState(item.comic_status),
      rating: this._parseRating(item.rating_average),
      author: item.author_name || null,
    };
  }

  async _fetchList(params) {
    const url = new URL(`${this.apiBase}/api/search`);
    url.searchParams.set('type', 'COMIC');
    url.searchParams.set('limit', '30');
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v); });
    const json = await getJson(url.toString(), { headers: this._headers });
    const data = json.data || [];
    const total = json.total || 0;
    const page = parseInt(params.page || 1, 10);
    const limit = 30;
    const hasNextPage = page * limit < total;
    const maxPage = total > 0 ? Math.ceil(total / limit) : null;
    return { data: data.map((m) => this._mapListItem(m)), hasNextPage, maxPage };
  }

  // ─── Public endpoints ────────────────────────────────────────────────────────

  async getLatest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage, maxPage } = await this._fetchList({ page: pageNum, sort: 'new', order: 'desc' });
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getPopular(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage, maxPage } = await this._fetchList({ page: pageNum, sort: 'views', order: 'desc' });
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getNewest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage, maxPage } = await this._fetchList({ page: pageNum, sort: 'latest', order: 'desc' });
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getAz(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage, maxPage } = await this._fetchList({ page: pageNum, sort: 'az', order: 'asc' });
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getZa(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage, maxPage } = await this._fetchList({ page: pageNum, sort: 'za', order: 'desc' });
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const sort = this._resolveSort(options.sort || options.order || 'new');
    const params = { page: pageNum, sort, order: 'desc' };
    if (options.status) params.status = String(options.status).toUpperCase();
    if (options.type) params.comic_type = String(options.type).toUpperCase();
    if (options.q || options.query) params.q = options.q || options.query;
    if (options.genre) {
      const genres = await this.getGenres();
      const key = String(options.genre).split(',')[0].trim().toLowerCase();
      const found = genres.find((g) => g.slug === key || g.name.toLowerCase() === key);
      if (found) params.genre = found.slug;
    }
    const { data, hasNextPage, maxPage } = await this._fetchList(params);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async search(query, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage, maxPage } = await this._fetchList({
      page: pageNum, sort: 'new', order: 'desc',
      q: String(query || '').trim(),
    });
    return { source: this.name, query: String(query || '').trim(), page: pageNum, maxPage, hasNextPage, data };
  }

  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) {
      return this._cachedGenres;
    }
    const json = await getJson(`${this.apiBase}/api/genres`, { headers: this._headers });
    const genres = (Array.isArray(json) ? json : [])
      .filter((g) => g.name && g.slug)
      .map((g) => ({ name: g.name, slug: g.slug }))
      .sort((a, b) => a.name.localeCompare(b.name, 'id'));
    this._cachedGenres = genres;
    this._cachedGenresExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
    return genres;
  }

  async getByGenre(genre, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanGenre = String(genre || '').trim().toLowerCase();
    if (!cleanGenre) throw createBadRequest("Parameter 'genre' wajib diisi", 'INVALID_PARAMETER');

    const sort = this._resolveSort(options.sort || options.order || 'new');
    const genres = await this.getGenres();

    // Support comma-separated (first genre only — API supports single genre)
    const key = cleanGenre.split(',')[0].trim();
    const found = genres.find((g) => g.slug === key || g.name.toLowerCase() === key);
    if (!found) throw createNotFound(`Genre '${genre}' tidak ditemukan di AinzScans`, 'NOT_FOUND');

    const { data, hasNextPage, maxPage } = await this._fetchList({
      page: pageNum, sort, order: 'desc', genre: found.slug,
    });
    return { source: this.name, genre: found.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getTypes() {
    return ['manga', 'manhwa', 'manhua'];
  }

  async getByType(type, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanType = String(type || '').trim().toUpperCase();
    if (!cleanType) throw createBadRequest("Parameter 'type' wajib diisi", 'INVALID_PARAMETER');
    const sort = this._resolveSort(options.sort || options.order || 'new');
    const { data, hasNextPage, maxPage } = await this._fetchList({
      page: pageNum, sort, order: 'desc', comic_type: cleanType,
    });
    return { source: this.name, type: cleanType.toLowerCase(), page: pageNum, maxPage, hasNextPage, data };
  }

  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/').pop();
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    let json;
    try {
      json = await getJson(`${this.apiBase}/api/series/comic/${cleanSlug}`, { headers: this._headers });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di AinzScans`, 'NOT_FOUND');
      throw err;
    }

    const title = json.title || cleanSlug;
    const altTitle = this._parseAltTitles(json.alternative_titles);
    const cover = json.poster_image_url || null;
    const synopsis = json.synopsis || null;
    const status = this._parseState(json.comic_status);
    const type = (json.comic_subtype || json.comic_type)?.toLowerCase() || null;
    const rating = this._parseRating(json.rating_average);
    const author = json.author_name || null;

    // Genres
    const genres = (json.genres || [])
      .filter((g) => g.slug && g.name)
      .map((g) => ({ name: g.name, slug: g.slug }));

    // Chapters — units array, newest first after reverse
    const rawUnits = json.units || [];
    const chapters = rawUnits.map((ch) => {
      const chNum = ch.number || ch.sort_number || '';
      const chNumClean = parseFloat(chNum) % 1 === 0 ? String(parseInt(chNum, 10)) : String(parseFloat(chNum));
      const chTitle = ch.title || `Chapter ${chNumClean}`;
      const date = this._formatDate(ch.created_at);
      // Use numeric ID from slug field or id for chapter URL
      // Web uses numeric ID: /comic/{slug}/chapter/{numericId}
      const chId = ch.slug || ch.id; // slug is like "chapter-337", id is UUID
      return {
        title: chTitle,
        slug: chId,
        chapterId: ch.id, // UUID for API
        endpoint: `/api/sources/${this.name}/chapter/${cleanSlug}/${encodeURIComponent(chId)}`,
        date,
      };
    }).reverse(); // newest first

    // Related — from recommendations endpoint
    let related = [];
    try {
      let recJson;
      try {
        recJson = await getJson(
          `${this.apiBase}/api/recommendations/series/comic/${cleanSlug}?limit=12`,
          { headers: this._headers }
        );
      } catch (_) {
        recJson = await getJson(
          `${this.baseUrl}/api/recommendations/series/comic/${cleanSlug}?limit=12`,
          { headers: this._headers }
        );
      }
      const recData = Array.isArray(recJson)
        ? recJson
        : (recJson.data || recJson.recommendations || []);
      related = recData.map((m) => ({
        title: m.title || m.slug,
        slug: m.slug,
        cover: m.poster_image_url || null,
        type: (m.comic_subtype || m.comic_type)?.toLowerCase() || null,
        rating: this._parseRating(m.rating_average),
      })).filter((m) => m.slug);
    } catch (_) {}

    return {
      source: this.name,
      title,
      altTitle: altTitle || null,
      cover,
      synopsis,
      status,
      type,
      author: author || null,
      rating,
      genres,
      totalChapters: chapters.length,
      chapters,
      similar: related,
      related,
    };
  }

  async getPages(slug, chapterSlug) {
    const mangaSlug = String(slug || '').trim();
    let chSlug = String(chapterSlug || '').trim();
    if (!mangaSlug || !chSlug) throw createBadRequest("Parameter 'slug' dan 'chapter' wajib diisi", 'INVALID_PARAMETER');

    // If chSlug is just a number or chapter-N, resolve actual chapter slug/id from detail
    const isNumber = /^[0-9.]+$/.test(chSlug);
    const isChapterText = /^chapter-[0-9.]+$/i.test(chSlug);

    if (isNumber || isChapterText) {
      const details = await this.getDetails(mangaSlug);
      const chNum = parseFloat(chSlug.replace(/^chapter-/i, ''));
      const target = details.chapters.find((ch) => {
        const m = ch.title.match(/Chapter\s+([0-9.]+)/i);
        return m && parseFloat(m[1]) === chNum;
      });
      if (!target) throw createNotFound(`Chapter '${chSlug}' tidak ditemukan untuk manga '${mangaSlug}'`, 'NOT_FOUND');
      chSlug = target.slug; // e.g. "chapter-337" or numeric id
    }

    let json;
    try {
      json = await getJson(
        `${this.apiBase}/api/series/comic/${mangaSlug}/chapter/${chSlug}`,
        { headers: this._headers }
      );
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Chapter tidak ditemukan di AinzScans`, 'NOT_FOUND');
      throw err;
    }

    const chapterObj = json.chapter || json;
    const pagesArray = chapterObj.pages || [];
    if (!pagesArray.length) throw createBadGateway('Tidak ada gambar untuk chapter ini', 'UPSTREAM_ERROR');

    const pages = pagesArray.map((p, index) => {
      const imgUrl = p.image_url || p.url || '';
      // cdnkuma.my.id has SSL issues — use directUrl without proxy
      const isCdnKuma = imgUrl.includes('cdnkuma');
      return {
        page: p.page_number || index + 1,
        url: imgUrl,
        directUrl: imgUrl,
        proxyUrl: isCdnKuma
          ? imgUrl  // serve directly, SSL issue on their end
          : `/api/proxy/image?url=${encodeURIComponent(imgUrl)}&referer=${encodeURIComponent(`${this.baseUrl}/`)}`,
      };
    });

    // Title from series info
    const seriesTitle = json.series?.title || mangaSlug;
    const chNum = chapterObj.number || chSlug;
    const chNumFormatted = parseFloat(chNum) % 1 === 0 ? String(parseInt(chNum, 10)) : String(parseFloat(chNum));
    const pageTitle = `${seriesTitle} Chapter ${chNumFormatted}`;

    return {
      source: this.name,
      title: pageTitle,
      totalPages: pages.length,
      pages,
    };
  }
}

module.exports = AinzSource;
