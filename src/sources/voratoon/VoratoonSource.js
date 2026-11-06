const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

class VoratoonSource extends BaseSource {
  constructor() {
    super('voratoon', 'VoraToon');
    this.baseUrl = 'https://v10.voratoon.com';
    this.icon = `${this.baseUrl}/icon.png`;

    // Genres cache
    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  getSupportedSorts() {
    return [
      { id: 'latest', name: 'Terbaru' },
      { id: 'newest', name: 'Diperbarui' },
      { id: 'popular', name: 'Populer' },
      { id: 'rating', name: 'Rating' },
      { id: 'az', name: 'A-Z' },
    ];
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  get _headers() {
    return {
      Referer: `${this.baseUrl}/`,
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    };
  }

  _resolveSort(raw) {
    const map = {
      latest: 'new',
      update: 'new',
      new: 'new',
      newest: 'newseries',
      newseries: 'newseries',
      popular: 'popular',
      popularity: 'popular',
      rating: 'rating',
      az: 'az',
      title: 'az',
      alphabetical: 'az',
    };
    return map[String(raw || '').toLowerCase()] || 'new';
  }

  _cleanCover(rawCover) {
    if (!rawCover) return null;
    let cover = String(rawCover).trim();
    if (cover.includes('/api/cover?src=')) {
      try {
        const u = new URL(cover, this.baseUrl);
        cover = decodeURIComponent(u.searchParams.get('src') || cover);
      } catch (_) {}
    } else if (cover.startsWith('//')) {
      cover = `https:${cover}`;
    } else if (cover.startsWith('/')) {
      cover = `${this.baseUrl}${cover}`;
    }
    return cover || null;
  }

  /** Parse manga cards from browse/search page. */
  _parseCardList($) {
    const items = [];
    const seen = new Set();

    $('article.card').each((_, el) => {
      const a = $(el).find('a.card-title').first();
      const href = a.attr('href') || '';
      const match = href.match(/\/series\/([^/?#]+)/);
      const slug = match ? match[1] : null;
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const title = a.text().trim();
      if (!title) return;

      const rawCover = $(el).find('img.app-image_image__T4dkN').first().attr('src') || '';
      const cover = this._cleanCover(rawCover);

      const latestChapter = $(el).find('.tag-chapters').text().trim().replace(/^Chapter\s*/i, '') || null;
      const status = $(el).find('.tag-status').text().trim().toLowerCase() || null;

      const flagAlt = $(el).find('.comic-type-flag').attr('alt') || '';
      let type = null;
      if (/manhwa/i.test(flagAlt)) type = 'manhwa';
      else if (/manga/i.test(flagAlt)) type = 'manga';
      else if (/manhua/i.test(flagAlt)) type = 'manhua';

      items.push({
        title,
        slug,
        cover,
        type,
        status,
        latestChapter,
      });
    });

    return items;
  }

  /** Parse pagination from browse page. */
  _parsePagination($, currentPage, itemCount = 0) {
    let maxPage = currentPage;
    $('.pagination_pagination__Rwdiw a, .pagination_paginationBlock__rYkJI a').each((_, el) => {
      const text = $(el).text().trim();
      const n = parseInt(text, 10);
      if (!isNaN(n) && n > maxPage) maxPage = n;
    });

    // Also parse from summary: "Halaman 1 dari 358 · 10.727 series"
    const summaryText = $('.pagination_summary__CCMI7').text().trim();
    const sumMatch = summaryText.match(/dari\s*(\d+)/i);
    if (sumMatch) {
      const n = parseInt(sumMatch[1], 10);
      if (!isNaN(n) && n > maxPage) maxPage = n;
    }

    const hasNextPage =
      $('a[aria-label*="berikutnya" i], a[aria-label*="next" i]').length > 0 ||
      (maxPage > currentPage) ||
      itemCount >= 30;

    return { maxPage: maxPage > currentPage ? maxPage : null, hasNextPage };
  }

  async _fetchListing(params) {
    const pageNum = Math.max(1, parseInt(params.page || 1, 10) || 1);
    const searchParams = new URLSearchParams();

    if (params.q) searchParams.set('q', params.q);
    if (params.genre) searchParams.set('genre', params.genre);
    if (params.status) searchParams.set('status', params.status);
    if (params.format) searchParams.set('format', params.format);
    if (params.sort && params.sort !== 'new') searchParams.set('sort', params.sort);
    if (pageNum > 1) searchParams.set('page', String(pageNum));

    const qs = searchParams.toString();
    const url = `${this.baseUrl}/browse${qs ? `?${qs}` : ''}`;

    const html = await getHtml(url, { headers: this._headers });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum, data.length);

    return { data, maxPage, hasNextPage };
  }

  // ─── Public endpoints ────────────────────────────────────────────────────────

  async getLatest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, maxPage, hasNextPage } = await this._fetchListing({ page: pageNum, sort: 'new' });
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getNewest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, maxPage, hasNextPage } = await this._fetchListing({ page: pageNum, sort: 'newseries' });
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getPopular(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, maxPage, hasNextPage } = await this._fetchListing({ page: pageNum, sort: 'popular' });
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getRating(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, maxPage, hasNextPage } = await this._fetchListing({ page: pageNum, sort: 'rating' });
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getAz(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, maxPage, hasNextPage } = await this._fetchListing({ page: pageNum, sort: 'az' });
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const sort = this._resolveSort(options.sort || options.order || 'new');
    const params = { page: pageNum, sort };
    if (options.status) params.status = String(options.status).toLowerCase();
    if (options.type || options.format) params.format = String(options.type || options.format).toLowerCase();
    if (options.genre) params.genre = String(options.genre);
    if (options.q || options.query) params.q = String(options.q || options.query).trim();

    const { data, maxPage, hasNextPage } = await this._fetchListing(params);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async search(query, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanQuery = String(query || '').trim();
    const rawSort = options.sort || options.order;
    const sort = rawSort ? this._resolveSort(rawSort) : null;
    const params = {
      page: pageNum,
      q: cleanQuery,
    };
    if (sort) params.sort = sort;
    if (options.genre) params.genre = String(options.genre);
    if (options.status) params.status = String(options.status).toLowerCase();
    if (options.type || options.format) params.format = String(options.type || options.format).toLowerCase();

    const { data, maxPage, hasNextPage } = await this._fetchListing(params);
    return {
      source: this.name,
      query: cleanQuery,
      ...(sort ? { sort: rawSort || sort } : {}),
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

    try {
      const html = await getHtml(`${this.baseUrl}/browse`, { headers: this._headers });
      const genreMatches = [...html.matchAll(/\\"name\\":\\"([^\\"]+)\\",\\"description\\":\\"[^\\"]*genre/g)].map(
        (m) => m[1]
      );
      const names = [...new Set(genreMatches)].filter(Boolean);

      if (names.length > 0) {
        const genres = names
          .map((name) => ({
            name,
            slug: name.toLowerCase().replace(/[\s\-_]+/g, '-'),
          }))
          .sort((a, b) => a.name.localeCompare(b.name, 'id'));

        this._cachedGenres = genres;
        this._cachedGenresExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
        return genres;
      }
    } catch (_) {}

    // Fallback static genres if extraction from stream fails
    const fallback = [
      'Action', 'Adventure', 'Comedy', 'Cooking', 'Demons', 'Drama', 'Ecchi', 'Fantasy',
      'Game', 'Gender Bender', 'Gore', 'Harem', 'Historical', 'Horror', 'Isekai', 'Josei',
      'Magic', 'Martial Arts', 'Mature', 'Mecha', 'Medical', 'Military', 'Music', 'Mystery',
      'One-Shot', 'Police', 'Psychological', 'Reincarnation', 'Romance', 'School', 'School Life',
      'Sci-Fi', 'Seinen', 'Shoujo', 'Shoujo Ai', 'Shounen', 'Shounen Ai', 'Slice of Life',
      'Sports', 'Super Power', 'Supernatural', 'Thriller', 'Tragedy', 'Vampire', 'Webtoons', 'Yuri',
    ].map((name) => ({
      name,
      slug: name.toLowerCase().replace(/[\s\-_]+/g, '-'),
    }));

    this._cachedGenres = fallback;
    this._cachedGenresExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
    return fallback;
  }

  async getByGenre(genre, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanGenre = String(genre || '').trim().toLowerCase();
    if (!cleanGenre) throw createBadRequest("Parameter 'genre' wajib diisi", 'INVALID_PARAMETER');

    const genres = await this.getGenres();
    const found = genres.find(
      (g) => g.slug === cleanGenre || g.name.toLowerCase() === cleanGenre
    );
    const targetGenre = found ? found.name : genre;

    const sort = this._resolveSort(options.sort || options.order || 'new');
    const { data, maxPage, hasNextPage } = await this._fetchListing({
      page: pageNum,
      genre: targetGenre,
      sort,
    });

    return {
      source: this.name,
      genre: targetGenre,
      page: pageNum,
      maxPage,
      hasNextPage,
      data,
    };
  }

  async getTypes() {
    return ['manhwa', 'manhua', 'manga', 'mangatoon'];
  }

  async getByType(type, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanType = String(type || '').trim().toLowerCase();
    if (!cleanType) throw createBadRequest("Parameter 'type' wajib diisi", 'INVALID_PARAMETER');

    const sort = this._resolveSort(options.sort || options.order || 'new');
    const { data, maxPage, hasNextPage } = await this._fetchListing({
      page: pageNum,
      format: cleanType,
      sort,
    });

    return {
      source: this.name,
      type: cleanType,
      page: pageNum,
      maxPage,
      hasNextPage,
      data,
    };
  }

  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    const url = `${this.baseUrl}/series/${cleanSlug}`;
    let html;
    try {
      html = await getHtml(url, { headers: this._headers });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Series '${cleanSlug}' tidak ditemukan di VoraToon`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    const title = $('h1.series-title').text().trim() || cleanSlug;
    const altTitle = $('p.alternative-title').text().trim() || null;
    const synopsis = $('p.synopsis.synopsis-desktop').first().text().trim() ||
                     $('p.synopsis').first().text().trim() || null;

    const rawCover = $('div.mobile-top-cover img, .left-col img').first().attr('src') || '';
    const cover = this._cleanCover(rawCover);

    let status = $('[class*="series-status_status"]').first().text().trim().toLowerCase() || null;
    if (!status) {
      const statusMatch = html.match(/\\"status\\":\\"([^\\"]+)\\"/);
      if (statusMatch) status = statusMatch[1].toLowerCase();
    }

    let type = null;
    if (altTitle) {
      if (/[\uac00-\ud7a3]/.test(altTitle)) type = 'manhwa';
      else if (/[\u3040-\u30ff]/.test(altTitle)) type = 'manga';
      else if (/[\u4e00-\u9fff]/.test(altTitle)) type = 'manhua';
    }

    // Rating: first .stat-val.yellow = rating value
    const ratingText = $('.stat-val.yellow').first().text().trim();
    const rating = ratingText && !isNaN(parseFloat(ratingText)) ? parseFloat(ratingText) : null;

    let author = null;
    $('.info-list-item').each((_, el) => {
      const label = $(el).find('span').text().trim();
      if (/author/i.test(label)) {
        author = $(el).find('strong').text().trim() || null;
      }
    });

    const genres = [];
    $('.tags-container a.tag').each((_, el) => {
      const name = $(el).text().trim();
      const href = $(el).attr('href') || '';
      const gSlug = href.includes('genre=') ? href.split('genre=')[1] : name;
      if (name) {
        genres.push({
          name,
          slug: decodeURIComponent(gSlug).toLowerCase().replace(/[\s\-_]+/g, '-'),
        });
      }
    });

    const chapters = [];
    $('a.chapter-item').each((_, el) => {
      const href = $(el).attr('href') || '';
      const match = href.match(/\/series\/[^\/]+\/chapter\/([^/?#]+)/);
      const chNum = match ? match[1] : '';
      if (!chNum) return;

      const chSlug = chNum;
      const fullTitle = $(el).find('.chapter-title').text().replace(/\s+/g, ' ').trim() || `Chapter ${chNum}`;
      const date = $(el).find('.chapter-date').text().trim() || null;

      chapters.push({
        slug: chSlug,
        title: fullTitle,
        endpoint: `/api/sources/${this.name}/chapter/${cleanSlug}/${chNum}`,
        date,
      });
    });

    return {
      source: this.name,
      title,
      altTitle,
      cover,
      synopsis,
      status,
      type,
      author,
      rating,
      genres,
      totalChapters: chapters.length,
      chapters,
    };
  }

  async getPages(slug, chapter) {
    const rawSlug = String(slug || '').trim();
    if (!rawSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    let targetSlug, targetChapter;
    if (rawSlug.includes('/chapter/')) {
      [targetSlug, targetChapter] = rawSlug.split('/chapter/');
    } else if (rawSlug.includes('/chapter-')) {
      [targetSlug, targetChapter] = rawSlug.split('/chapter-');
    } else {
      targetSlug = rawSlug;
      targetChapter = String(chapter || '').replace(/^chapter-?/i, '').replace(/^chapter\//i, '');
    }

    if (!targetChapter) throw createBadRequest("Nomor chapter wajib diisi", 'INVALID_PARAMETER');

    const url = `${this.baseUrl}/series/${targetSlug}/chapter/${targetChapter}`;
    let html;
    try {
      html = await getHtml(url, { headers: this._headers });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Chapter '${targetChapter}' tidak ditemukan di VoraToon`, 'NOT_FOUND');
      throw err;
    }

    let images = [];

    // Method 1: extract from Next.js stream payload
    const streamMatch = html.match(/\\"images\\":\s*(\[[^\]]+\])/);
    if (streamMatch) {
      try {
        const raw = streamMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        images = JSON.parse(raw);
      } catch (_) {}
    }

    // Method 2: fallback to unescaped images array
    if (images.length === 0) {
      const plainMatch = html.match(/"images":\s*(\[[^\]]+\])/);
      if (plainMatch) {
        try {
          images = JSON.parse(plainMatch[1]);
        } catch (_) {}
      }
    }

    // Method 3: fallback to cheerio DOM parsing for img tags from cdn
    if (images.length === 0) {
      const $ = cheerio.load(html);
      $('img').each((_, el) => {
        const src = $(el).attr('src') || '';
        if (src.includes('cdn.voratoon.com') || src.includes('/wp-content/img/')) {
          images.push(src);
        }
      });
    }

    images = [...new Set(images.filter(Boolean))];

    if (images.length === 0) {
      throw createBadGateway('Gagal menemukan gambar chapter dari VoraToon', 'UPSTREAM_ERROR');
    }

    const pages = images.map((imgUrl, index) => ({
      page: index + 1,
      url: imgUrl,
      directUrl: imgUrl,
      proxyUrl: `/api/proxy/image?url=${encodeURIComponent(imgUrl)}&referer=${encodeURIComponent(`${this.baseUrl}/`)}`,
    }));

    const $ = cheerio.load(html);
    // Build clean title from manga slug + chapter number
    const mangaTitle = targetSlug
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    return {
      source: this.name,
      title: `${mangaTitle} Chapter ${targetChapter}`,
      totalPages: pages.length,
      pages,
    };
  }
}

module.exports = VoratoonSource;
