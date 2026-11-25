'use strict';

const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');
const { formatPagination } = require('../../utils/responseHelper');
const { getSession, invalidateSession } = require('../../utils/cfSession');

class SxkomikSource extends BaseSource {
  constructor() {
    super('sxkomik', 'SXKomik');
    this.baseUrl = 'https://www.sxkomik.art';
    this.icon = `https://www.sxkomik.art/icon-192x192.png`;
  }

  getSupportedSorts() {
    return [
      { id: 'update',  name: 'Terbaru' },
      { id: 'popular', name: 'Populer' },
      { id: 'az',      name: 'A-Z' },
      { id: 'za',      name: 'Z-A' },
      { id: 'rating',  name: 'Rating' },
    ];
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  _resolveSort(raw) {
    const map = {
      update:       'update',
      latest:       'update',
      popular:      'popular',
      az:           'title',
      title:        'title',
      za:           'titlereverse',
      titlereverse: 'titlereverse',
      rating:       'rating',
    };
    return map[String(raw || '').toLowerCase()] || 'update';
  }

  /**
   * Fetch with CF clearance session injected.
   * Retries once on 403 with fresh session.
   * @private
   */
  async _fetch(url, opts = {}) {
    const session = await getSession(this.baseUrl);
    const headers = {
      'User-Agent': session.userAgent,
      'Cookie': session.cookieHeader,
      'Referer': `${this.baseUrl}/`,
      'Accept': opts.accept || 'text/html,*/*',
      'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
      ...opts.headers,
    };

    let r;
    try {
      r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    } catch (err) {
      throw createBadGateway(`Gagal terhubung ke SXKomik: ${err.message}`, 'UPSTREAM_ERROR');
    }

    if (r.status === 403) {
      // Refresh session once and retry
      invalidateSession(this.baseUrl);
      const newSession = await getSession(this.baseUrl, true);
      headers['User-Agent'] = newSession.userAgent;
      headers['Cookie'] = newSession.cookieHeader;
      try {
        r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      } catch (err) {
        throw createBadGateway(`Gagal terhubung ke SXKomik: ${err.message}`, 'UPSTREAM_ERROR');
      }
    }

    if (!r.ok && r.status !== 404) {
      throw createBadGateway(`SXKomik mengembalikan HTTP ${r.status}`, 'UPSTREAM_ERROR');
    }
    if (r.status === 404) {
      throw createNotFound('Data tidak ditemukan di SXKomik', 'NOT_FOUND');
    }

    return r;
  }

  /**
   * Fetch JSON from /api/* endpoint.
   * @private
   */
  async _fetchApi(path) {
    const r = await this._fetch(`${this.baseUrl}${path}`, { accept: 'application/json' });
    const json = await r.json().catch(() => null);
    if (!json) throw createBadGateway('Gagal memproses JSON dari SXKomik', 'UPSTREAM_ERROR');
    return json;
  }

  /**
   * Map komik item from /api/all to standardized card.
   * @private
   */
  _mapItem(item) {
    if (!item) return null;
    const chMatch = String(item.chapter || '').match(/Chapter\s+([0-9.]+)/i);
    return {
      title: item.title || null,
      slug: item.endpoint || null,
      cover: item.thumbnail || null,
      type: item.type ? item.type.toLowerCase() : null,
      rating: item.rating ? parseFloat(item.rating) : null,
      latestChapter: chMatch ? chMatch[1] : (item.chapter || null),
    };
  }

  async _fetchList(params) {
    // For title/titlereverse sort, the API requires genre=0 to return results
    const sort = params.sort || 'update';
    const needsGenreZero = (sort === 'title' || sort === 'titlereverse') && !params.genre;

    const qs = new URLSearchParams({
      status: '',
      genre:  needsGenreZero ? '0' : '',
      type:   '',
      ...params,
    }).toString();
    const data = await this._fetchApi(`/api/all?${qs}`);
    return {
      data: (data.komiks || []).map(i => this._mapItem(i)).filter(Boolean),
      hasNextPage: data.nextPage === true,
    };
  }

  // ─── Endpoints ───────────────────────────────────────────────────────────────

  async getLatest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage } = await this._fetchList({ sort: 'update', page: pageNum });
    if (pageNum > 1 && data.length === 0) throw createNotFound(`Halaman ${pageNum} tidak ditemukan`, 'NOT_FOUND');
    return { source: this.name, page: pageNum, hasNextPage, data,
      pagination: formatPagination({ page: pageNum, maxPage: null, hasNextPage }) };
  }

  async getPopular(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage } = await this._fetchList({ sort: 'popular', page: pageNum });
    if (pageNum > 1 && data.length === 0) throw createNotFound(`Halaman ${pageNum} tidak ditemukan`, 'NOT_FOUND');
    return { source: this.name, page: pageNum, hasNextPage, data,
      pagination: formatPagination({ page: pageNum, maxPage: null, hasNextPage }) };
  }

  async getAz(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage } = await this._fetchList({ sort: 'title', page: pageNum });
    if (pageNum > 1 && data.length === 0) throw createNotFound(`Halaman ${pageNum} tidak ditemukan`, 'NOT_FOUND');
    return { source: this.name, sort: 'az', page: pageNum, hasNextPage, data,
      pagination: formatPagination({ page: pageNum, maxPage: null, hasNextPage }) };
  }

  async getZa(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage } = await this._fetchList({ sort: 'titlereverse', page: pageNum });
    if (pageNum > 1 && data.length === 0) throw createNotFound(`Halaman ${pageNum} tidak ditemukan`, 'NOT_FOUND');
    return { source: this.name, sort: 'za', page: pageNum, hasNextPage, data,
      pagination: formatPagination({ page: pageNum, maxPage: null, hasNextPage }) };
  }

  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const sort = this._resolveSort(options.sort || options.order || 'update');
    const params = { sort, page: pageNum };
    if (options.status) params.status = String(options.status).toLowerCase();
    if (options.type) params.type = String(options.type).toLowerCase();
    if (options.genre) params.genre = String(options.genre).toLowerCase();
    const { data, hasNextPage } = await this._fetchList(params);
    if (pageNum > 1 && data.length === 0) throw createNotFound(`Halaman ${pageNum} tidak ditemukan`, 'NOT_FOUND');
    return {
      source: this.name, page: pageNum, hasNextPage,
      ...(options.sort ? { sort } : {}),
      ...(options.status ? { status: options.status } : {}),
      ...(options.type ? { type: options.type } : {}),
      ...(options.genre ? { genre: options.genre } : {}),
      data,
      pagination: formatPagination({ page: pageNum, maxPage: null, hasNextPage }),
    };
  }

  async search(query, page = 1) {
    const rawQuery = String(query || '').trim();
    if (!rawQuery) throw createBadRequest('Parameter query wajib diisi', 'INVALID_PARAMETER');
    const pageNum = Math.max(1, parseInt(page, 10) || 1);

    // /search?q= uses RSC streaming — fetch with RSC:1 header to get component payload
    const session = await getSession(this.baseUrl);
    const pageParam = pageNum > 1 ? `&page=${pageNum}` : '';
    let r;
    try {
      r = await fetch(`${this.baseUrl}/search?q=${encodeURIComponent(rawQuery)}${pageParam}`, {
        headers: {
          'User-Agent': session.userAgent,
          'Cookie': session.cookieHeader,
          'Referer': `${this.baseUrl}/`,
          'Accept': 'text/x-component',
          'RSC': '1',
        },
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      throw createBadGateway(`Gagal terhubung ke SXKomik: ${err.message}`, 'UPSTREAM_ERROR');
    }

    if (!r.ok) throw createBadGateway(`SXKomik mengembalikan HTTP ${r.status}`, 'UPSTREAM_ERROR');

    const rsc = await r.text();

    // Extract manga slugs from RSC href attributes, filter out nav links
    const NAV_SLUGS = new Set(['dmca', 'privacy-policy', 'contact-us', 'bookmark', 'all', 'search', 'history']);
    const hrefMatches = [...rsc.matchAll(/"href":"\/([a-z0-9][a-z0-9-]{3,})"/g)];
    const slugs = [...new Set(
      hrefMatches.map(m => m[1]).filter(s => !NAV_SLUGS.has(s) && !s.includes('/'))
    )];

    // For each slug, extract title and thumbnail from nearby RSC context
    const data = [];
    for (const slug of slugs) {
      const idx = rsc.indexOf(`"href":"/${slug}"`);
      if (idx < 0) continue;
      const context = rsc.substring(idx, idx + 2000);

      const titleMatch = context.match(/"alt":"([^"]+)"/);
      const srcMatch = context.match(/"src":"(https?:\/\/[^"]+)"/);
      const ratingMatch = context.match(/"rating":"([^"]+)"/);
      const typeMatch = context.match(/"type":"(Manga|Manhwa|Manhua|manga|manhwa|manhua)"/);
      const chapterMatch = context.match(/"chapter":"([^"]+)"/);

      const title = titleMatch?.[1];
      if (!title || title === 'Not found image' || title.includes('SXKomik')) continue;

      const chStr = chapterMatch?.[1] || '';
      const chNumMatch = chStr.match(/Chapter\s+([0-9.]+)/i);

      data.push({
        title,
        slug,
        cover: srcMatch?.[1] || null,
        type: typeMatch?.[1]?.toLowerCase() || null,
        rating: ratingMatch?.[1] ? parseFloat(ratingMatch[1]) : null,
        latestChapter: chNumMatch ? chNumMatch[1] : (chStr || null),
      });
    }

    const hasNextPage = data.length >= 20;

    return {
      source: this.name,
      query: rawQuery,
      page: pageNum,
      hasNextPage,
      data,
      pagination: formatPagination({ page: pageNum, maxPage: null, hasNextPage }),
    };
  }

  async getByGenre(genre, page = 1, options = {}) {
    const cleanGenre = String(genre || '').trim().toLowerCase();
    if (!cleanGenre) throw createBadRequest("Parameter 'genre' wajib diisi", 'INVALID_PARAMETER');
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const sort = this._resolveSort(options.sort || 'update');
    const { data, hasNextPage } = await this._fetchList({ genre: cleanGenre, sort, page: pageNum });
    if (pageNum > 1 && data.length === 0) {
      throw createNotFound(`Halaman ${pageNum} tidak ditemukan untuk genre '${cleanGenre}'`, 'NOT_FOUND');
    }
    return { source: this.name, genre: cleanGenre, page: pageNum, hasNextPage, data,
      pagination: formatPagination({ page: pageNum, maxPage: null, hasNextPage }) };
  }

  async getByType(type, page = 1, options = {}) {
    const cleanType = String(type || '').trim().toLowerCase();
    if (!cleanType) throw createBadRequest("Parameter 'type' wajib diisi", 'INVALID_PARAMETER');
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const sort = this._resolveSort(options.sort || 'update');
    const { data, hasNextPage } = await this._fetchList({ type: cleanType, sort, page: pageNum });
    if (pageNum > 1 && data.length === 0) {
      throw createNotFound(`Halaman ${pageNum} tidak ditemukan untuk tipe '${cleanType}'`, 'NOT_FOUND');
    }
    return { source: this.name, type: cleanType, page: pageNum, hasNextPage, data,
      pagination: formatPagination({ page: pageNum, maxPage: null, hasNextPage }) };
  }

  async getTypes() {
    return ['manga', 'manhwa', 'manhua'];
  }

  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    const r = await this._fetch(`${this.baseUrl}/${cleanSlug}`);
    const html = await r.text();
    const $ = cheerio.load(html);

    const title = $('h1').first().text().trim() || cleanSlug;

    // altTitle — small text below h1
    const altTitle = $('h1').first().next('div').text().trim() || null;

    // Cover — img[alt="title"]
    const cover = $('img[alt="title"]').first().attr('src') ||
                  $('img[alt="title"]').first().attr('srcset')?.split(' ')[0] || null;

    // Synopsis — in .Sinopsis p
    const synopsis = $('.Sinopsis p').first().text().trim() ||
                     $('[class*="Sinopsis"] p').first().text().trim() || null;

    // Meta — from .flex.justify-between pairs, skip empty keys
    let status = null, type = null, author = null, rating = null;
    let totalChapters = null;
    $('div.flex.justify-between').each((_, el) => {
      const spans = $(el).find('span');
      if (spans.length < 2) return;
      const key = $(spans[0]).text().trim().toLowerCase();
      const val = $(spans[1]).text().trim();
      if (!key || !val) return;
      switch (key) {
        case 'status': {
          const v = val.toLowerCase();
          if (v.includes('ongoing')) status = 'ongoing';
          else if (v.includes('completed')) status = 'completed';
          else if (v.includes('hiatus')) status = 'hiatus';
          else status = v;
          break;
        }
        case 'type': type = val.toLowerCase(); break;
        case 'author': if (val !== '-') author = val; break;
        case 'total chapter': totalChapters = parseInt(val, 10) || null; break;
      }
    });

    // Rating — the first numeric span near the star icon (text-sm font-semibold pr-3)
    $('span.text-sm.font-semibold').each((_, el) => {
      if (rating !== null) return;
      const text = $(el).text().trim();
      const val = parseFloat(text);
      if (!isNaN(val) && val >= 1 && val <= 10 && text.includes('.')) {
        rating = val;
      }
    });

    // Genres — links with /genre/ in href
    const genres = [];
    const seenG = new Set();
    $('a[href*="/genre/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/\/genre\/([^/?#]+)/);
      if (!m) return;
      const gSlug = m[1];
      const name = $(el).text().trim();
      if (!name || seenG.has(gSlug)) return;
      seenG.add(gSlug);
      genres.push({ name, slug: gSlug });
    });

    // Chapters — from li > a[href*="/read/"] (chapter list items)
    // Skip the two "Chapter awal / Chapter baru" shortcut buttons
    const chapters = [];
    const seenCh = new Set();
    $('li a[href*="/read/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!href || seenCh.has(href)) return;

      const chMatch = href.match(/-chapter-([0-9.]+)\/?$/);
      if (!chMatch) return;
      const chNum = chMatch[1];
      // chapterSlug = everything after /read/
      const chSlug = href.replace(/^\/read\//, '').replace(/\/$/, '');

      seenCh.add(href);
      chapters.push({
        title: `Chapter ${chNum}`,
        slug: chSlug,
        chapterNumber: parseFloat(chNum),
        endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(chSlug)}`,
        date: null,
      });
    });

    // Sort chapters descending by number
    chapters.sort((a, b) => b.chapterNumber - a.chapterNumber);

    return {
      source: this.name,
      title,
      altTitle: altTitle || null,
      cover,
      synopsis,
      status,
      type,
      author,
      rating,
      genres,
      totalChapters: totalChapters || chapters.length,
      chapters,
    };
  }

  async getPages(slug, chapter) {
    const rawSlug = String(slug || '').trim();
    if (!rawSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    let chapterSlug;
    if (rawSlug.includes('-chapter-')) {
      // Full chapterSlug passed directly
      chapterSlug = rawSlug;
    } else {
      const chNum = String(chapter || '').replace(/^chapter-?/i, '').trim();
      if (!chNum) throw createBadRequest("Parameter 'chapter' wajib diisi", 'INVALID_PARAMETER');
      chapterSlug = `${rawSlug}-chapter-${chNum}`;
    }

    // Fetch via RSC endpoint — header RSC:1 returns server component payload with images
    const session = await getSession(this.baseUrl);
    let r;
    try {
      r = await fetch(`${this.baseUrl}/read/${chapterSlug}`, {
        headers: {
          'User-Agent': session.userAgent,
          'Cookie': session.cookieHeader,
          'Referer': `${this.baseUrl}/`,
          'Accept': 'text/x-component',
          'RSC': '1',
        },
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      throw createBadGateway(`Gagal terhubung ke SXKomik: ${err.message}`, 'UPSTREAM_ERROR');
    }

    if (r.status === 404) throw createNotFound(`Chapter '${chapterSlug}' tidak ditemukan di SXKomik`, 'NOT_FOUND');
    if (!r.ok) throw createBadGateway(`SXKomik mengembalikan HTTP ${r.status}`, 'UPSTREAM_ERROR');

    const rscText = await r.text();

    // Extract unique image URLs from RSC payload
    const imgMatches = [...rscText.matchAll(/https?:\/\/[^\s"'\\,]+\.(?:jpg|webp|png)/g)];
    const seen = new Set();
    const images = [];
    for (const m of imgMatches) {
      const url = m[0];
      if (!seen.has(url) && !url.includes('logo') && !url.includes('favicon')) {
        seen.add(url);
        images.push(url);
      }
    }

    if (!images.length) {
      throw createBadGateway('Tidak ada gambar untuk chapter ini di SXKomik', 'UPSTREAM_ERROR');
    }

    // Build title from chapterSlug
    const titleFromSlug = chapterSlug
      .replace(/-chapter-(\d+)$/, ' Chapter $1')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();

    return {
      source: this.name,
      title: titleFromSlug,
      totalPages: images.length,
      pages: images.map((imgUrl, index) => ({
        page: index + 1,
        url: imgUrl,
        directUrl: imgUrl,
        proxyUrl: `/api/proxy/image?url=${encodeURIComponent(imgUrl)}&referer=${encodeURIComponent(`${this.baseUrl}/`)}`,
      })),
    };
  }
}

module.exports = SxkomikSource;
