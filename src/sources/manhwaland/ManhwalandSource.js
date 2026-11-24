const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml, getJson } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');
const { formatPagination } = require('../../utils/responseHelper');

class ManhwalandSource extends BaseSource {
  constructor() {
    super('manhwaland', 'ManhwaLand');
    this.baseUrl = 'https://link.manhwaland.land';
    this.icon = `${this.baseUrl}/favicon.ico`;

    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  getSupportedSorts() {
    return [
      { id: 'latest',  name: 'Terbaru' },
      { id: 'newest',  name: 'Diperbarui' },
      { id: 'popular', name: 'Popular' },
      { id: 'az',      name: 'A-Z' },
    ];
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  _headers() {
    return { Referer: `${this.baseUrl}/` };
  }

  _slugFromUrl(href) {
    if (!href) return null;
    const m = href.match(/\/series\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  _resolveOrder(raw) {
    const map = {
      latest:   'modified',
      update:   'modified',
      newest:   'date',
      date:     'date',
      popular:  'views',
      views:    'views',
      az:       'title',
      title:    'title',
    };
    return map[String(raw || '').toLowerCase()] || 'modified';
  }

  _parsePagination($, currentPage) {
    let maxPage = currentPage;
    $('a.page-numbers').each((_, el) => {
      const n = parseInt($(el).text().trim(), 10);
      if (!isNaN(n) && n > maxPage) maxPage = n;
    });
    const hasNextPage = $('a.next.page-numbers').length > 0;
    if (hasNextPage && maxPage <= currentPage) maxPage = currentPage + 1;
    return { maxPage, hasNextPage };
  }

  _parseCardList($) {
    const items = [];
    const seen = new Set();

    $('a.bm-card.series').each((_, el) => {
      const href = $(el).attr('href') || '';
      const slug = this._slugFromUrl(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const title = $(el).find('.bm-card__title').text().trim();
      if (!title) return;

      const cover = $(el).find('img').first().attr('src') || null;

      // Badges: first badge = type (manhwa/manga/manhua), second = latest chapter
      const badges = [];
      $(el).find('.bm-badge').each((_, b) => badges.push($(b).text().trim()));

      // Type from badge class
      const typeBadge = $(el).find('[class*="bm-badge--manhwa"], [class*="bm-badge--manga"], [class*="bm-badge--manhua"]').first();
      const typeClass = typeBadge.attr('class') || '';
      let type = null;
      if (typeClass.includes('manhwa')) type = 'manhwa';
      else if (typeClass.includes('manhua')) type = 'manhua';
      else if (typeClass.includes('manga')) type = 'manga';

      // Latest chapter from small badge top-left (Ch. N)
      const chBadge = $(el).find('.bm-cover__tl').text().trim();
      const chMatch = chBadge.match(/Ch\.\s*([0-9.]+)/i);
      const latestChapter = chMatch ? chMatch[1] : chBadge || null;

      items.push({ title, slug, cover, type, latestChapter });
    });

    return items;
  }

  _listUrl(pageNum, order, extra = '') {
    const base = pageNum === 1
      ? `${this.baseUrl}/series/`
      : `${this.baseUrl}/series/page/${pageNum}/`;
    return `${base}?sort=${order}${extra}`;
  }

  async _fetchListing(url, pageNum) {
    const html = await getHtml(url, { headers: this._headers() });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
    return { data, maxPage, hasNextPage };
  }

  // ─── Endpoints ───────────────────────────────────────────────────────────────

  async getLatest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, maxPage, hasNextPage } = await this._fetchListing(this._listUrl(pageNum, 'modified'), pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getPopular(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, maxPage, hasNextPage } = await this._fetchListing(this._listUrl(pageNum, 'views'), pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getNewest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, maxPage, hasNextPage } = await this._fetchListing(this._listUrl(pageNum, 'date'), pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getAz(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, maxPage, hasNextPage } = await this._fetchListing(this._listUrl(pageNum, 'title'), pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const order = this._resolveOrder(options.order || options.sort || 'modified');
    let extra = '';
    if (options.genre) extra += `&genre=${encodeURIComponent(options.genre)}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(this._listUrl(pageNum, order, extra), pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async search(query, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const q = encodeURIComponent(String(query || '').trim());
    if (!q) throw createBadRequest('Parameter query wajib diisi', 'INVALID_PARAMETER');
    const url = pageNum === 1
      ? `${this.baseUrl}/series/?s=${q}`
      : `${this.baseUrl}/series/page/${pageNum}/?s=${q}`;
    const html = await getHtml(url, { headers: this._headers() });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
    return { source: this.name, query: String(query || '').trim(), page: pageNum, maxPage, hasNextPage, data };
  }

  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) return this._cachedGenres;

    // Genre checkboxes are in the filter form on /series/ page
    const html = await getHtml(`${this.baseUrl}/series/`, { headers: this._headers() });
    const $ = cheerio.load(html);

    const genres = [];
    const seen = new Set();

    $('input[name="genre[]"]').each((_, el) => {
      const slug = $(el).val()?.trim();
      if (!slug || seen.has(slug)) return;
      seen.add(slug);
      const name = $(el).next('span').text().trim() ||
                   $(el).closest('label').find('span').text().trim() ||
                   slug;
      if (!name) return;
      genres.push({ name, slug });
    });

    genres.sort((a, b) => a.name.localeCompare(b.name, 'id'));
    this._cachedGenres = genres;
    this._cachedGenresExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
    return genres;
  }

  async getByGenre(genre, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanGenre = String(genre || '').trim().toLowerCase();
    if (!cleanGenre) throw createBadRequest("Parameter 'genre' wajib diisi", 'INVALID_PARAMETER');

    const order = this._resolveOrder(options.order || options.sort || 'modified');

    // Support multiple genres separated by comma
    const genreSlugs = cleanGenre.split(',').map(g => g.trim()).filter(Boolean);

    const base = pageNum === 1
      ? `${this.baseUrl}/series/`
      : `${this.baseUrl}/series/page/${pageNum}/`;

    const genreParams = genreSlugs.map(g => `genre%5B%5D=${encodeURIComponent(g)}`).join('&');
    const url = `${base}?sort=${order}&${genreParams}`;

    const html = await getHtml(url, { headers: this._headers() }).catch((err) => {
      if (err.statusCode === 404) throw createNotFound(`Genre '${cleanGenre}' tidak ditemukan di ManhwaLand`, 'NOT_FOUND');
      throw err;
    });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
    return { source: this.name, genre: cleanGenre, page: pageNum, maxPage, hasNextPage, data };
  }

  async getTypes() {
    return ['manhwa', 'manga', 'manhua'];
  }

  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    const url = `${this.baseUrl}/series/${cleanSlug}/`;
    let html;
    try {
      html = await getHtml(url, { headers: this._headers() });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di ManhwaLand`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    const title = $('.bm-series__title').first().text().trim() ||
                  $('h1').first().text().trim() || cleanSlug;

    const altTitle = $('.bm-series__alt').first().text().trim() || null;

    const cover = $('.bm-series__cover img').attr('src') || null;

    // Synopsis — strip "Sinopsis" heading
    const synopsisEl = $('.bm-synopsis');
    synopsisEl.find('h2').remove();
    const synopsis = synopsisEl.text().trim() || null;

    // Type and status from badges
    let type = null, status = null;
    $('.bm-series__badges .bm-badge').each((_, el) => {
      const cls = $(el).attr('class') || '';
      const text = $(el).text().trim().toLowerCase();
      if (cls.includes('bm-badge--manhwa')) type = 'manhwa';
      else if (cls.includes('bm-badge--manhua')) type = 'manhua';
      else if (cls.includes('bm-badge--manga')) type = 'manga';
      if (cls.includes('bm-badge--status')) {
        if (cls.includes('ongoing') || text.includes('ongoing')) status = 'ongoing';
        else if (cls.includes('completed') || cls.includes('end') || text.includes('tamat')) status = 'completed';
        else if (cls.includes('hiatus')) status = 'hiatus';
        else status = text || null;
      }
    });

    // Author from meta dl
    let author = null;
    $('dl dt').each((_, el) => {
      const key = $(el).text().trim().toLowerCase();
      if (key === 'penulis' || key === 'author') {
        author = $(el).next('dd').text().trim() || null;
      }
    });

    // Rating from stats dl
    let rating = null;
    $('dl.bm-series__stats dt').each((_, el) => {
      if ($(el).text().trim().toLowerCase() === 'skor') {
        const val = parseFloat($(el).next('dd').text().trim());
        if (!isNaN(val)) rating = val;
      }
    });

    // Genres
    const genres = [];
    const seenG = new Set();
    $('a[href*="/genres/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/\/genres\/([^/?#]+)/);
      if (!m) return;
      const gSlug = m[1];
      const name = $(el).text().trim();
      if (!name || seenG.has(gSlug)) return;
      seenG.add(gSlug);
      genres.push({ name, slug: gSlug });
    });

    // Chapters — from .bm-chitem links in chapter list
    const chapters = [];
    const seenCh = new Set();

    $('a.bm-chitem').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!href || seenCh.has(href)) return;

      const chMatch = href.match(/-chapter-([0-9.]+)\/?$/);
      if (!chMatch) return;
      const chNum = chMatch[1];

      const date = $(el).find('.bm-chitem__time').text().trim() || null;

      seenCh.add(href);
      chapters.push({
        title: `Chapter ${chNum}`,
        slug: href,
        chapterNumber: parseFloat(chNum),
        endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(href)}`,
        date,
      });
    });

    // Sort chapters descending by number
    chapters.sort((a, b) => b.chapterNumber - a.chapterNumber);

    // Related — "Series Serupa" section
    const related = [];
    const seenR = new Set();
    $('h2, h3').each((_, hdr) => {
      const text = $(hdr).text().trim().toLowerCase();
      if (!text.includes('serupa') && !text.includes('related') && !text.includes('similar')) return;
      $(hdr).closest('section, div').find('a.bm-card.series').each((__, card) => {
        const href = $(card).attr('href') || '';
        const relSlug = this._slugFromUrl(href);
        if (!relSlug || seenR.has(relSlug)) return;
        seenR.add(relSlug);

        const relTitle = $(card).find('.bm-card__title').text().trim();
        if (!relTitle) return;

        const relCover = $(card).find('img').first().attr('src') || null;

        const typeClass = $(card).find('[class*="bm-badge--manhwa"], [class*="bm-badge--manga"], [class*="bm-badge--manhua"]').first().attr('class') || '';
        let relType = null;
        if (typeClass.includes('manhwa')) relType = 'manhwa';
        else if (typeClass.includes('manhua')) relType = 'manhua';
        else if (typeClass.includes('manga')) relType = 'manga';

        const chBadge = $(card).find('.bm-cover__tl').text().trim();
        const chMatch = chBadge.match(/Ch\.\s*([0-9.]+)/i);
        const latestChapter = chMatch ? chMatch[1] : null;

        related.push({ title: relTitle, slug: relSlug, cover: relCover, type: relType, latestChapter });
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
      related,
    };
  }

  async getPages(slug, chapter) {
    const rawSlug = String(slug || '').trim();
    if (!rawSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    let chapterUrl;
    if (rawSlug.startsWith('http')) {
      // Full URL passed directly (from slug field in chapters list)
      chapterUrl = rawSlug;
    } else {
      const chNum = String(chapter || '').replace(/^chapter-?/i, '').trim();
      if (!chNum) throw createBadRequest("Parameter 'chapter' wajib diisi", 'INVALID_PARAMETER');
      // URL pattern: /{manga-slug}-chapter-{n}/
      chapterUrl = `${this.baseUrl}/${rawSlug}-chapter-${chNum}/`;
    }

    // Extract chapter slug from URL for WP REST API query
    const chapterSlug = chapterUrl
      .replace(/^https?:\/\/[^/]+\//, '')
      .replace(/\/+$/, '');

    // Fetch chapter images via WP REST API — images are in post content
    let postData;
    try {
      postData = await getJson(
        `${this.baseUrl}/wp-json/wp/v2/posts?slug=${encodeURIComponent(chapterSlug)}&_fields=id,content`,
        { headers: { ...this._headers(), Accept: 'application/json' } }
      );
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound('Chapter tidak ditemukan di ManhwaLand', 'NOT_FOUND');
      throw err;
    }

    if (!Array.isArray(postData) || postData.length === 0) {
      throw createNotFound(`Chapter tidak ditemukan di ManhwaLand`, 'NOT_FOUND');
    }

    const content = postData[0]?.content?.rendered || '';
    const $ = cheerio.load(content);

    const images = [];
    $('img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (src && !src.includes('thumbnail') && src.trim()) {
        images.push(src.trim());
      }
    });

    if (!images.length) {
      throw createBadGateway('Tidak ada gambar untuk chapter ini di ManhwaLand', 'UPSTREAM_ERROR');
    }

    // Build title from slug
    const titleFromSlug = chapterSlug
      .replace(/-chapter-(\d+)$/, ' Chapter $1')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
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

module.exports = ManhwalandSource;
