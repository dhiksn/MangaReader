const BaseSource = require('../BaseSource');
const { getJson } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');
const { formatRelativeTime } = require('../../utils/date');

class SoulScansSource extends BaseSource {
  constructor() {
    super('soulscans', 'SoulScans');
    this.baseUrl = 'https://v1.soulscans.asia';
    this.apiBase = 'https://v1.soulscans.asia/api';
    this.icon = `https://img.soulscans.asia/api/uploads/site-branding/favicon-1783217076495-izt4sc.png`;

    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  getSupportedSorts() {
    return [
      { id: 'latest', name: 'Terbaru Update' },
      { id: 'newest', name: 'Terbaru Ditambahkan' },
      { id: 'popular', name: 'Populer' },
      { id: 'rating', name: 'Rating' },
      { id: 'az', name: 'A-Z' },
      { id: 'za', name: 'Z-A' },
    ];
  }

  get _headers() {
    return { Referer: `${this.baseUrl}/`, Origin: this.baseUrl };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  _resolveSort(raw) {
    const map = {
      latest: 'latest', update: 'latest',
      popular: 'views', popularity: 'views',
      newest: 'new',
      rating: 'rate',
      az: 'az', title: 'az',
      za: 'za',
    };
    return map[String(raw || '').toLowerCase()] || 'latest';
  }

  _parseState(raw) {
    switch ((raw || '').toUpperCase()) {
      case 'ONGOING': return 'ongoing';
      case 'COMPLETED': return 'completed';
      case 'HIATUS': return 'hiatus';
      case 'CANCELLED': return 'cancelled';
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
      const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(arr)) return arr.filter(Boolean).join('; ');
      return null;
    } catch { return typeof raw === 'string' && raw.length ? raw : null; }
  }

  _formatDate(iso) {
    if (!iso) return null;
    try { return formatRelativeTime(iso); } catch { return iso.split('T')[0]; }
  }

  _cleanCoverUrl(url) {
    if (!url) return null;
    // Fix relative/localhost URLs from API
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      return `https://img.soulscans.asia${path}`;
    }
    if (url.startsWith('/api/')) {
      return `https://img.soulscans.asia${url}`;
    }
    return url;
  }

  _mapListItem(item) {
    const latestChRaw = item.series_latest_chapter_number || item.comic_latest_chapter_number || null;
    const latestCh = latestChRaw
      ? (parseFloat(latestChRaw) % 1 === 0 ? String(parseInt(latestChRaw, 10)) : String(parseFloat(latestChRaw)))
      : null;
    return {
      title: item.title || item.slug,
      slug: item.slug,
      cover: this._cleanCoverUrl(item.poster_image_url),
      type: (item.comic_subtype || item.comic_type)?.toLowerCase() || null,
      status: this._parseState(item.comic_status),
      latestChapter: latestCh,
    };
  }

  async _fetchList(params) {
    const url = new URL(`${this.apiBase}/search`);
    url.searchParams.set('type', 'COMIC');
    url.searchParams.set('limit', '30');
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    });
    const json = await getJson(url.toString(), { headers: this._headers });
    const data = json.data || [];
    const total = json.total || 0;
    const page = parseInt(params.page || 1, 10);
    const hasNextPage = page * 30 < total;
    const maxPage = total > 0 ? Math.ceil(total / 30) : null;
    return { data: data.map((m) => this._mapListItem(m)), hasNextPage, maxPage };
  }

  // ─── Public endpoints ────────────────────────────────────────────────────────

  async getLatest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    // Use home-sections API for latest — returns 216 items sorted by latest update
    // Paginate client-side (30 per page)
    const limit = 30;
    const offset = (pageNum - 1) * limit;

    const json = await getJson(
      `https://img.soulscans.asia/api/comic/home-sections?hotLimit=4&popularLimit=16&projectLimit=18&updateLimit=216&sections=latest_comic_updates`,
      { headers: this._headers }
    );
    const allItems = json.latest_comic_updates || [];
    const slice = allItems.slice(offset, offset + limit);
    const maxPage = Math.ceil(allItems.length / limit);
    const hasNextPage = pageNum < maxPage;

    const data = slice.map((item) => {
      const latestChRaw = item.chapters?.[0]?.number || item.chapters?.[0]?.chapter_number || null;
      const latestCh = latestChRaw
        ? (parseFloat(latestChRaw) % 1 === 0 ? String(parseInt(latestChRaw, 10)) : String(parseFloat(latestChRaw)))
        : null;
      return {
        title: item.series_title || item.series_slug,
        slug: item.series_slug,
        cover: this._cleanCoverUrl(item.poster_image_url),
        type: (item.series_comic_type || item.series_comic_subtype)?.toLowerCase() || null,
        status: this._parseState(item.series_status),
        latestChapter: latestCh,
      };
    });

    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getNewest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage, maxPage } = await this._fetchList({ page: pageNum, sort: 'new', order: 'desc' });
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getPopular(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage, maxPage } = await this._fetchList({ page: pageNum, sort: 'views', order: 'desc' });
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getRating(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage, maxPage } = await this._fetchList({ page: pageNum, sort: 'rate', order: 'desc' });
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async _fetchHtmlListing(url, pageNum) {
    const cheerio = require('cheerio');
    const { getHtml } = require('../../utils/httpClient');
    const html = await getHtml(url, { headers: this._headers });
    const $ = cheerio.load(html);
    const items = [];
    const seen = new Set();

    $('article[class*="comic-card"]').each((_, el) => {
      // First link = cover (contains status/rating text), second link = title
      const allLinks = $(el).find('a[href*="/comic/"]');
      const firstLink = allLinks.eq(0);
      const href = firstLink.attr('href') || '';
      const slugMatch = href.match(/\/comic\/([^/]+)\/?$/);
      const slug = slugMatch ? slugMatch[1] : null;
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      // Title link = the <a> that has non-status text (not containing "Ongoing/Completed/Hiatus/0.0")
      let titleLink = null;
      allLinks.each((__, a) => {
        const t = $(a).text().trim();
        if (t && !t.match(/ongoing|completed|hiatus|cancelled|\*\s*[\d.]+/i)) {
          titleLink = $(a);
          return false; // break
        }
      });
      const title = titleLink ? titleLink.text().trim() : slug;
      if (!title) return;

      // Cover — get from API using slug (lazy loaded in HTML)
      const cover = this._cleanCoverUrl(
        $(el).find('img[src]:not([src^="data:"])').first().attr('src') ||
        $(el).find('img[data-src]').first().attr('data-src') || ''
      ) || null;

      // Type from span title attribute e.g. "Manga (Jepang)", "Manhwa (Korea)"
      const typeSpan = $(el).find('span[title], span[aria-label]').filter((__, s) => {
        const t = ($(s).attr('title') || $(s).attr('aria-label') || '').toLowerCase();
        return t.includes('manga') || t.includes('manhwa') || t.includes('manhua');
      }).first();
      const typeRaw = (typeSpan.attr('title') || typeSpan.attr('aria-label') || '').split(/[\s(]/)[0].toLowerCase();
      const type = typeRaw || null;

      // Status from cover link text e.g. "Ongoing * 0.0 40"
      const coverLinkText = firstLink.text().trim().toLowerCase();
      let status = null;
      if (coverLinkText.includes('ongoing')) status = 'ongoing';
      else if (coverLinkText.includes('completed')) status = 'completed';
      else if (coverLinkText.includes('hiatus')) status = 'hiatus';
      else if (coverLinkText.includes('cancelled')) status = 'cancelled';
      const divText = $(el).find('div').filter((__, d) => $(d).text().includes('Chapter')).first().text().trim();
      const chMatch = divText.match(/Chapter\s+([0-9.]+)/i);
      const latestChRaw = chMatch ? chMatch[1] : null;
      const latestChapter = latestChRaw
        ? (parseFloat(latestChRaw) % 1 === 0 ? String(parseInt(latestChRaw, 10)) : latestChRaw)
        : null;

      items.push({ title, slug, cover, type, status, latestChapter });
    });

    // Pagination
    let maxPage = pageNum;
    $('a[href*="page="]').each((_, el) => {
      const m = ($(el).attr('href') || '').match(/page=(\d+)/);
      if (m) { const n = parseInt(m[1], 10); if (!isNaN(n) && n > maxPage) maxPage = n; }
    });
    const hasNextPage = maxPage > pageNum;

    return { data: items, maxPage: maxPage > pageNum ? maxPage : null, hasNextPage };
  }

  async getAz(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/allcomic?sort=az&order=desc&page=${pageNum}`;
    const { data, hasNextPage, maxPage } = await this._fetchHtmlListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getZa(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/allcomic?sort=za&order=desc&page=${pageNum}`;
    const { data, hasNextPage, maxPage } = await this._fetchHtmlListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const sort = this._resolveSort(options.sort || options.order || 'latest');
    // Jika latest tanpa filter, arahkan ke getLatest (home-sections) yang datanya real-time update
    if (sort === 'latest' && !options.status && !options.type && !options.genre && !options.q && !options.query) {
      return this.getLatest(pageNum);
    }
    const params = { page: pageNum, sort, order: 'desc' };
    if (options.status) params.status = String(options.status).toUpperCase();
    if (options.type) params.comic_type = String(options.type).toUpperCase();
    if (options.q || options.query) params.q = options.q || options.query;
    const { data, hasNextPage, maxPage } = await this._fetchList(params);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async search(query, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage, maxPage } = await this._fetchList({
      page: pageNum, sort: 'latest', order: 'desc',
      q: String(query || '').trim(),
    });
    return { source: this.name, query: String(query || '').trim(), page: pageNum, maxPage, hasNextPage, data };
  }

  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) {
      return this._cachedGenres;
    }
    const json = await getJson(`${this.apiBase}/genres`, { headers: this._headers });
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

    const sort = this._resolveSort(options.sort || options.order || 'latest');
    const genres = await this.getGenres();
    const key = cleanGenre.split(',')[0].trim();
    const found = genres.find((g) => g.slug === key || g.name.toLowerCase() === key);
    if (!found) throw createNotFound(`Genre '${genre}' tidak ditemukan di SoulScans`, 'NOT_FOUND');

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
    const sort = this._resolveSort(options.sort || options.order || 'latest');
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
      json = await getJson(`${this.apiBase}/series/comic/${cleanSlug}`, { headers: this._headers });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di SoulScans`, 'NOT_FOUND');
      throw err;
    }

    const title = json.title || cleanSlug;
    const altTitle = this._parseAltTitles(json.alternative_titles);
    const cover = this._cleanCoverUrl(json.poster_image_url);
    const synopsis = json.synopsis || null;
    const status = this._parseState(json.comic_status);
    const type = (json.comic_subtype || json.comic_type)?.toLowerCase() || null;
    const rating = this._parseRating(json.rating_average);
    const author = json.author_name || null;

    const genres = (json.genres || [])
      .filter((g) => g.slug && g.name)
      .map((g) => ({ name: g.name, slug: g.slug }));

    const rawUnits = json.units || [];
    const chapters = rawUnits.map((ch) => {
      const chNum = ch.number || ch.sort_number || '';
      const chNumClean = parseFloat(chNum) % 1 === 0 ? String(parseInt(chNum, 10)) : String(parseFloat(chNum));
      const chTitle = ch.title || `Chapter ${chNumClean}`;
      const date = this._formatDate(ch.created_at);
      const chId = ch.slug || ch.id;
      return {
        title: chTitle,
        slug: chId,
        endpoint: `/api/sources/${this.name}/chapter/${cleanSlug}/${encodeURIComponent(chId)}`,
        date,
      };
    }).reverse();

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
    };
  }

  async getPages(slug, chapterSlug) {
    const mangaSlug = String(slug || '').trim();
    let chSlug = String(chapterSlug || '').trim();
    if (!mangaSlug || !chSlug) throw createBadRequest("Parameter 'slug' dan 'chapter' wajib diisi", 'INVALID_PARAMETER');

    // Resolve chapter slug from number if needed
    if (/^[0-9.]+$/.test(chSlug) || /^chapter-[0-9.]+$/i.test(chSlug)) {
      const details = await this.getDetails(mangaSlug);
      const chNum = parseFloat(chSlug.replace(/^chapter-/i, ''));
      const target = details.chapters.find((ch) => {
        const m = ch.title.match(/Chapter\s+([0-9.]+)/i);
        return m && parseFloat(m[1]) === chNum;
      });
      if (!target) throw createNotFound(`Chapter '${chSlug}' tidak ditemukan untuk manga '${mangaSlug}'`, 'NOT_FOUND');
      chSlug = target.slug;
    }

    let json;
    try {
      json = await getJson(
        `${this.apiBase}/series/comic/${mangaSlug}/chapter/${chSlug}`,
        { headers: this._headers }
      );
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Chapter tidak ditemukan di SoulScans`, 'NOT_FOUND');
      throw err;
    }

    const chapterObj = json.chapter || json;
    const pagesArray = chapterObj.pages || [];
    if (!pagesArray.length) throw createBadGateway('Tidak ada gambar untuk chapter ini', 'UPSTREAM_ERROR');

    const pages = pagesArray.map((p, index) => {
      const imgUrl = p.image_url || p.url || '';
      return {
        page: p.page_number || index + 1,
        url: imgUrl,
        directUrl: imgUrl,
        proxyUrl: `/api/proxy/image?url=${encodeURIComponent(imgUrl)}&referer=${encodeURIComponent(`${this.baseUrl}/`)}`,
      };
    });

    const seriesTitle = json.series?.title || mangaSlug;
    const chNum = chapterObj.number || chSlug;
    const chNumFormatted = parseFloat(chNum) % 1 === 0 ? String(parseInt(chNum, 10)) : String(parseFloat(chNum));

    return {
      source: this.name,
      title: `${seriesTitle} Chapter ${chNumFormatted}`,
      totalPages: pages.length,
      pages,
    };
  }
}

module.exports = SoulScansSource;
