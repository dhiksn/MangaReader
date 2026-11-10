const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

// Page size for client-side pagination (all 481 items loaded at once)
const PAGE_SIZE = 20;

class ShiroDoujinSource extends BaseSource {
  constructor() {
    super('shirodoujin', 'ShiroDoujin');
    this.baseUrl = 'https://shirodoujin.com';
    this.icon = `https://shirodoujin.com/wp-content/uploads/2021/10/cropped-20210601_193419-150x150.jpg`;

    // All manga are loaded once and paginated client-side
    this._cachedList = null;
    this._cachedListOrder = null;
    this._cachedListExpiresAt = 0;

    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  getSupportedSorts() {
    return [
      { id: 'latest',  name: 'Terbaru' },
      { id: 'popular', name: 'Populer' },
      { id: 'newest',  name: 'Diperbarui' },
      { id: 'rating',  name: 'Rating' },
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
      latest: 'update', update: 'update',
      popular: 'popular',
      newest: 'latest',
      rating: 'rating',
    };
    return map[String(raw || '').toLowerCase()] || 'update';
  }

  async _fetchAllItems(order) {
    const cacheKey = order;
    if (this._cachedList && this._cachedListOrder === cacheKey && Date.now() < this._cachedListExpiresAt) {
      return this._cachedList;
    }

    const url = `${this.baseUrl}/advanced-search/?order=${order}`;
    const html = await getHtml(url, { headers: this._headers() });
    const $ = cheerio.load(html);

    const items = [];
    const seen = new Set();

    $('[data-result-index]').each((_, el) => {
      const a = $(el).find('a[href*="/series/"]').first();
      const href = a.attr('href') || '';
      const slug = this._slugFromUrl(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const title = $(el).find('.flexbox4-side .title a, .title a').first().text().trim() ||
                    a.attr('title') || '';
      if (!title) return;

      const cover = $(el).find('img').first().attr('src') || null;

      // Type from "type Manhwa" span class
      const typeClass = $(el).find('span[class*="type"]').attr('class') || '';
      const typeMatch = typeClass.match(/\btype\s+(\S+)/i);
      const type = typeMatch ? typeMatch[1].toLowerCase() : null;

      // Latest chapter from card
      const latestChText = $(el).find('ul.chapter li a').first().text().trim();
      const chMatch = latestChText.match(/Chapter\s+([0-9.]+)/i);
      const latestChapter = chMatch ? chMatch[1] : latestChText || null;

      items.push({ title, slug, cover, type, latestChapter });
    });

    this._cachedList = items;
    this._cachedListOrder = cacheKey;
    this._cachedListExpiresAt = Date.now() + 15 * 60 * 1000; // 15 min cache
    return items;
  }

  _paginate(items, page) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const start = (pageNum - 1) * PAGE_SIZE;
    const slice = items.slice(start, start + PAGE_SIZE);
    const maxPage = Math.ceil(items.length / PAGE_SIZE);
    const hasNextPage = pageNum < maxPage;
    return { data: slice, maxPage, hasNextPage, page: pageNum };
  }

  // ─── Endpoints ───────────────────────────────────────────────────────────────

  async getLatest(page = 1) {
    const items = await this._fetchAllItems('update');
    const { data, maxPage, hasNextPage, page: pageNum } = this._paginate(items, page);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getPopular(page = 1) {
    const items = await this._fetchAllItems('popular');
    const { data, maxPage, hasNextPage, page: pageNum } = this._paginate(items, page);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getNewest(page = 1) {
    const items = await this._fetchAllItems('latest');
    const { data, maxPage, hasNextPage, page: pageNum } = this._paginate(items, page);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getRating(page = 1) {
    const items = await this._fetchAllItems('rating');
    const { data, maxPage, hasNextPage, page: pageNum } = this._paginate(items, page);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getList(page = 1, options = {}) {
    const order = this._resolveOrder(options.order || options.sort || 'update');
    const items = await this._fetchAllItems(order);
    const { data, maxPage, hasNextPage, page: pageNum } = this._paginate(items, page);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async search(query, page = 1) {
    // All items in cache — filter client-side
    const q = String(query || '').trim().toLowerCase();
    const items = await this._fetchAllItems('update');
    const filtered = q
      ? items.filter((item) => item.title.toLowerCase().includes(q))
      : items;
    const { data, maxPage, hasNextPage, page: pageNum } = this._paginate(filtered, page);
    return { source: this.name, query: String(query || '').trim(), page: pageNum, maxPage, hasNextPage, data };
  }

  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) return this._cachedGenres;
    const html = await getHtml(`${this.baseUrl}/advanced-search/`, { headers: this._headers() });
    const $ = cheerio.load(html);
    const genres = [];
    const seen = new Set();

    // Genre checkboxes: input[name="genre[]"] + label
    $('input[name="genre[]"]').each((_, el) => {
      const val = $(el).val()?.trim();
      if (!val || seen.has(val)) return;
      seen.add(val);
      // Label is the sibling span text
      const name = $(el).closest('label').find('span').text().trim() ||
                   $(el).next('span').text().trim() ||
                   val;
      if (!name) return;
      const slug = val; // already slugified
      genres.push({ name, slug });
    });

    genres.sort((a, b) => a.name.localeCompare(b.name, 'id'));
    this._cachedGenres = genres;
    this._cachedGenresExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
    return genres;
  }

  async getByGenre(genre, page = 1, options = {}) {
    const cleanGenre = String(genre || '').trim().toLowerCase();
    if (!cleanGenre) throw createBadRequest("Parameter 'genre' wajib diisi", 'INVALID_PARAMETER');

    const order = this._resolveOrder(options.order || options.sort || 'update');
    const allGenres = await this.getGenres();
    const keys = cleanGenre.split(',').map((g) => g.trim()).filter(Boolean);
    const found = keys.map((key) => {
      const match = allGenres.find((g) => g.slug === key || g.name.toLowerCase() === key);
      if (!match) throw createNotFound(`Genre '${key}' tidak ditemukan di ShiroDoujin`, 'NOT_FOUND');
      return match;
    });

    // Fetch with genre filter
    const genreParams = found.map((g) => `genre%5B%5D=${encodeURIComponent(g.slug)}`).join('&');
    const url = `${this.baseUrl}/advanced-search/?order=${order}&${genreParams}`;
    const html = await getHtml(url, { headers: this._headers() });
    const $ = cheerio.load(html);

    const allItems = [];
    const seen = new Set();
    $('[data-result-index]').each((_, el) => {
      const a = $(el).find('a[href*="/series/"]').first();
      const href = a.attr('href') || '';
      const slug = this._slugFromUrl(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);
      const title = $(el).find('.title a').first().text().trim() || a.attr('title') || '';
      if (!title) return;
      const cover = $(el).find('img').first().attr('src') || null;
      const typeClass = $(el).find('span[class*="type"]').attr('class') || '';
      const typeMatch = typeClass.match(/\btype\s+(\S+)/i);
      const latestChText = $(el).find('ul.chapter li a').first().text().trim();
      const chMatch = latestChText.match(/Chapter\s+([0-9.]+)/i);
      allItems.push({
        title, slug, cover,
        type: typeMatch ? typeMatch[1].toLowerCase() : null,
        latestChapter: chMatch ? chMatch[1] : latestChText || null,
      });
    });

    const { data, maxPage, hasNextPage, page: pageNum } = this._paginate(allItems, page);
    return { source: this.name, genre: found.map((g) => g.name).join(', '), page: pageNum, maxPage, hasNextPage, data };
  }

  async getTypes() {
    return ['manhwa', 'doujinshi'];
  }

  async getByType(type, page = 1, options = {}) {
    const cleanType = String(type || '').trim().toLowerCase();
    if (!cleanType) throw createBadRequest("Parameter 'type' wajib diisi", 'INVALID_PARAMETER');
    const order = this._resolveOrder(options.order || options.sort || 'update');
    const typeParam = cleanType === 'doujinshi' ? 'Doujinshi' : cleanType.charAt(0).toUpperCase() + cleanType.slice(1);
    const url = `${this.baseUrl}/advanced-search/?order=${order}&type=${encodeURIComponent(typeParam)}`;
    const html = await getHtml(url, { headers: this._headers() });
    const $ = cheerio.load(html);
    const items = [];
    const seen = new Set();
    $('[data-result-index]').each((_, el) => {
      const a = $(el).find('a[href*="/series/"]').first();
      const href = a.attr('href') || '';
      const slug = this._slugFromUrl(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);
      const title = $(el).find('.title a').first().text().trim() || a.attr('title') || '';
      if (!title) return;
      items.push({
        title, slug,
        cover: $(el).find('img').first().attr('src') || null,
        type: cleanType,
      });
    });
    const { data, maxPage, hasNextPage, page: pageNum } = this._paginate(items, page);
    return { source: this.name, type: cleanType, page: pageNum, maxPage, hasNextPage, data };
  }

  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/').pop();
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    const url = `${this.baseUrl}/series/${cleanSlug}/`;
    let html;
    try {
      html = await getHtml(url, { headers: this._headers() });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di ShiroDoujin`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    const title = $('h1').first().text().trim() || cleanSlug;

    const altTitle = $('div.series-native-title').text().trim() || null;
    const cover = $('.series-cover-card img').first().attr('src') || null;

    const synopsis = $('.series-synopsis p').first().text().trim() || null;

    // Type from span.type, e.g. "type Manhwa"
    const typeClass = $('span[class*="type "]').first().attr('class') || '';
    const typeMatch = typeClass.match(/\btype\s+(\S+)/i);
    const type = typeMatch ? typeMatch[1].toLowerCase() : null;

    // Status from span.status
    const statusRaw = $('span.status').first().attr('class') || $('span.status').first().text().trim();
    let status = null;
    const statusText = $('span.status').first().text().trim().toLowerCase();
    if (statusText.includes('ongoing') || statusRaw.toLowerCase().includes('ongoing')) status = 'ongoing';
    else if (statusText.includes('completed') || statusRaw.toLowerCase().includes('completed')) status = 'completed';
    else if (statusText.includes('hiatus')) status = 'hiatus';

    // Author from .series-meta-item b:contains(Author)
    let author = null;
    $('.series-meta-item').each((_, el) => {
      const label = $(el).find('b').text().trim().toLowerCase();
      const val = $(el).find('span').text().trim();
      if (label.includes('author') && val) { author = val; return false; }
    });

    // Rating from .series-score-card strong
    const ratingRaw = $('.series-score-card strong').first().text().trim();
    const rating = ratingRaw && !isNaN(parseFloat(ratingRaw))
      ? Math.round(parseFloat(ratingRaw) * 100) / 100 : null;

    // Genres from .series-genres a
    const genres = [];
    const seenG = new Set();
    $('.series-genres a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const name = $(el).text().trim().replace(/,\s*$/, '');
      const m = href.match(/\/genre\/([^/?#]+)/);
      const genreSlug = m ? m[1] : name.toLowerCase().replace(/\s+/g, '-');
      if (!name || seenG.has(name)) return;
      seenG.add(name);
      genres.push({ name, slug: genreSlug });
    });

    // Chapters from [data-chapter-list] li
    const chapters = [];
    $('[data-chapter-list] li').each((_, el) => {
      const a = $(el).find('a').first();
      const href = a.attr('href') || '';
      if (!href) return;
      // Title from <strong>
      const chTitle = $(el).find('strong').text().trim() || a.text().trim();
      // Date — get text node from <span>, skip icon
      const spanEl = $(el).find('a span').first();
      const dateText = spanEl.contents().filter((_, n) => n.type === 'text').text().trim() ||
                       spanEl.text().trim().replace(/^[^\w]*/, '') || null;
      chapters.push({
        title: chTitle,
        slug: href,
        endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(href)}`,
        date: dateText || null,
      });
    });
    // Reverse so oldest first
    chapters.reverse();

    // Related — from "Popular" section, rotate all/week every 10min; day skipped (empty on site)
    const related = [];
    try {
      const periods = ['all', 'week'];
      const activePeriod = periods[Math.floor(Date.now() / (10 * 60 * 1000)) % periods.length];
      const popularUrl = activePeriod === 'all'
        ? `${this.baseUrl}/`
        : `${this.baseUrl}/popular/${activePeriod}/`;
      const popularHtml = await getHtml(popularUrl, { headers: this._headers() });
      const p$ = cheerio.load(popularHtml);

      // Fallback to homepage if page returned no items
      const finalP$ = p$('.flexbox-item a.popular-card').length > 0
        ? p$
        : cheerio.load(await getHtml(`${this.baseUrl}/`, { headers: this._headers() }));

      const seenR = new Set();
      finalP$('.flexbox-item a.popular-card').each((_, el) => {
        const href = finalP$(el).attr('href') || '';
        const relSlug = this._slugFromUrl(href);
        if (!relSlug || seenR.has(relSlug)) return;
        seenR.add(relSlug);
        const relTitle = finalP$(el).attr('title') || '';
        if (!relTitle) return;
        const relCover = finalP$(el).find('img').first().attr('src') || null;
        const relRatingMatch = finalP$(el).text().match(/\b(\d+\.\d+)\b/);
        const relRating = relRatingMatch ? Math.round(parseFloat(relRatingMatch[1]) * 100) / 100 : null;
        related.push({ title: relTitle, slug: relSlug, cover: relCover, rating: relRating });
      });
    } catch (_) {}

    return {
      source: this.name,
      title,
      altTitle,
      cover,
      synopsis,
      status,
      type,
      author: author || null,
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
      chapterUrl = rawSlug;
    } else {
      const chNum = String(chapter || '').replace(/^chapter-?/i, '').trim();
      try {
        const details = await this.getDetails(rawSlug);
        const target = details.chapters.find((ch) => {
          const m = ch.title.match(/Chapter\s+([0-9.]+)/i);
          return m && parseFloat(m[1]) === parseFloat(chNum);
        });
        chapterUrl = target?.slug || null;
      } catch (_) {}
      if (!chapterUrl) throw createNotFound(`Chapter '${chapter}' tidak ditemukan untuk '${rawSlug}'`, 'NOT_FOUND');
    }

    let html;
    try {
      html = await getHtml(chapterUrl, { headers: this._headers() });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound('Chapter tidak ditemukan di ShiroDoujin', 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);
    const images = [];
    $('div.reader-area img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (src && !src.includes('data:image')) images.push(src);
    });

    if (!images.length) throw createBadGateway('Tidak ada gambar untuk chapter ini di ShiroDoujin', 'UPSTREAM_ERROR');

    const pageTitle = $('title').text()
      .replace(/\s*[-–|]\s*ShiroDoujin.*$/i, '')
      .replace(/^(Baca|Read)\s+/i, '')
      .trim();

    return {
      source: this.name,
      title: pageTitle,
      totalPages: images.length,
      pages: images.map((url, index) => ({
        page: index + 1,
        url,
        directUrl: url,
        proxyUrl: `/api/proxy/image?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(`${this.baseUrl}/`)}`,
      })),
    };
  }
}

module.exports = ShiroDoujinSource;
