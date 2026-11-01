const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml, fetchWithHeaders } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

class KiryuuSource extends BaseSource {
  constructor() {
    super('kiryuu', 'Kiryuu');
    this.domain = 'v7.kiryuu.to';
    this.baseUrl = `https://${this.domain}`;
    this.icon = `${this.baseUrl}/favicon.ico`;
    this.pageSize = 24;

    // Nonce caching
    this._nonce = null;
    this._nonceExpiresAt = 0;

    // Genres cache in memory (24h)
    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;

    // Chapters and mangaId cache for instant chapter lookups
    this._mangaCache = new Map();
  }

  /**
   * Get supported sort options for Kiryuu.
   * Supports: 'latest' (updated), 'popular', 'rating', 'az' (A-Z), 'za' (Z-A).
   * Note: 'bookmarked' is excluded as it requires user login.
   */
  getSupportedSorts() {
    return [
      { id: 'latest', name: 'Terbaru' },
      { id: 'popular', name: 'Populer' },
      { id: 'rating', name: 'Rating' },
      { id: 'az', name: 'A-Z' },
      { id: 'za', name: 'Z-A' },
    ];
  }

  /**
   * Normalize sort/orderby options supported by Kiryuu:
   * 'popular', 'rating', 'updated' (latest), 'az' (A-Z), 'za' (Z-A).
   * @param {Object} [options]
   * @returns {{ orderby: string, order: string }}
   * @private
   */
  _normalizeOrderOptions(options = {}) {
    const rawSort = String(options.orderby || options.sort || 'updated').toLowerCase().trim();
    let orderby = 'updated';
    let order = options.order ? String(options.order).toLowerCase().trim() : 'desc';

    if (rawSort === 'popular' || rawSort === 'popularity') {
      orderby = 'popular';
      if (!options.order) order = 'desc';
    } else if (rawSort === 'rating') {
      orderby = 'rating';
      if (!options.order) order = 'desc';
    } else if (rawSort === 'za' || rawSort === 'z-a') {
      orderby = 'title';
      order = 'desc';
    } else if (rawSort === 'az' || rawSort === 'a-z' || rawSort === 'title' || rawSort === 'alphabetical') {
      orderby = 'title';
      if (!options.order) {
        order = 'asc';
      }
    } else if (rawSort === 'updated' || rawSort === 'latest') {
      orderby = 'updated';
      if (!options.order) order = 'desc';
    }

    return { orderby, order };
  }

  /**
   * Fetch security nonce required for Kiryuu's admin-ajax search requests.
   * @private
   */
  async _getNonce() {
    if (this._nonce && Date.now() < this._nonceExpiresAt) {
      return this._nonce;
    }

    try {
      const url = `${this.baseUrl}/wp-admin/admin-ajax.php?type=search_form&action=get_nonce`;
      const html = await getHtml(url, {
        headers: {
          Referer: `${this.baseUrl}/`,
        },
      });

      const $ = cheerio.load(html);
      let nonce = $('input[name="search_nonce"]').val();

      if (!nonce) {
        const match =
          html.match(/name=['"]search_nonce['"]\s+value=['"]([^'"]+)['"]/i) ||
          html.match(/value=['"]([a-f0-9]{8,12})['"]/i);
        if (match) {
          nonce = match[1];
        }
      }

      if (!nonce) {
        throw createBadGateway('Gagal mendapatkan security nonce dari server Kiryuu', 'UPSTREAM_ERROR');
      }

      this._nonce = nonce.trim();
      this._nonceExpiresAt = Date.now() + 12 * 60 * 60 * 1000; // 12 hours
      return this._nonce;
    } catch (err) {
      this._nonce = null;
      if (err.statusCode) throw err;
      throw createBadGateway(`Gagal terhubung ke Kiryuu nonce service: ${err.message}`, 'UPSTREAM_ERROR');
    }
  }

  /**
   * Perform advanced search request against Kiryuu's admin-ajax endpoint.
   * @private
   */
  async _advancedSearch({
    page = 1,
    query = '',
    orderby = 'updated',
    order = 'desc',
    genre = [],
    genreExclude = [],
    type = [],
    status = [],
    author = [],
  } = {}) {
    const nonce = await this._getNonce();
    const url = `${this.baseUrl}/wp-admin/admin-ajax.php?action=advanced_search`;

    const genreArr = Array.isArray(genre) ? genre : genre ? [genre] : [];
    const genreExArr = Array.isArray(genreExclude) ? genreExclude : [];
    const typeArr = Array.isArray(type) ? type : type ? [type] : [];
    const statusArr = Array.isArray(status) ? status : status ? [status] : [];
    const authorArr = Array.isArray(author) ? author : [];

    const fd = new URLSearchParams();
    fd.append('action', 'advanced_search');
    fd.append('nonce', nonce);
    fd.append('page', String(page));
    fd.append('order', order);
    fd.append('orderby', orderby);
    fd.append('inclusion', 'OR');
    fd.append('genre', JSON.stringify(genreArr));
    fd.append('exclusion', 'OR');
    fd.append('genre_exclude', JSON.stringify(genreExArr));
    fd.append('author', JSON.stringify(authorArr));
    fd.append('artist', '[]');
    fd.append('project', '0');
    fd.append('type', JSON.stringify(typeArr));
    fd.append('status', JSON.stringify(statusArr));
    if (query && String(query).trim()) {
      fd.append('query', String(query).trim());
    }

    let html;
    try {
      const res = await fetchWithHeaders(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: `${this.baseUrl}/`,
          Origin: this.baseUrl,
        },
        body: fd.toString(),
      });
      html = await res.text();
    } catch (err) {
      // If error might be due to expired nonce, invalidate it
      this._nonce = null;
      throw err;
    }

    const items = this._parseMangaList(html);
    return {
      source: this.name,
      page,
      orderby,
      order,
      hasNextPage: items.length >= this.pageSize,
      data: items,
    };
  }

  /**
   * Parse manga list items from HTML returned by Kiryuu.
   * @private
   */
  _parseMangaList(html) {
    if (!html || typeof html !== 'string') return [];
    const $ = cheerio.load(html);
    const items = [];
    const seenSlugs = new Set();

    let cardElements = $('main div.grid > div');
    if (cardElements.length === 0) {
      cardElements = $('body > div');
    }

    cardElements.each((_, el) => {
      const $el = $(el);
      const mainLink = $el.find('a[href*="/manga/"]').first();
      const href = mainLink.attr('href') || '';
      if (!href || href.includes('/chapter-')) return;

      const slugMatch = href.match(/\/manga\/([^/]+)/);
      const slug = slugMatch ? slugMatch[1] : '';
      if (!slug || seenSlugs.has(slug)) return;
      seenSlugs.add(slug);

      const title =
        $el.find('h1, h2, h3, a.text-base, a.text-white, a.font-medium').first().text().trim() ||
        mainLink.attr('title') ||
        mainLink.text().trim();

      const imgEl = $el.find('img.wp-post-image, img').first();
      let cover = imgEl.attr('src') || imgEl.attr('data-src') || '';
      if (cover) {
        // Strip thumbnail dimensions to get high-resolution original image
        cover = cover.replace(/-\d+x\d+(\.[a-zA-Z0-9]+)$/, '$1');
      }

      // Type identification
      let type = 'manga';
      const typeSvg = $el.find('img[src*="manhwa.svg"], img[alt*="manhwa"]').length;
      const typeManhua = $el.find('img[src*="manhua.svg"], img[alt*="manhua"]').length;
      const typeMangatoon = $el.find('img[src*="mangatoon.svg"], img[alt*="mangatoon"]').length;
      if (typeSvg) type = 'manhwa';
      else if (typeManhua) type = 'manhua';
      else if (typeMangatoon) type = 'mangatoon';

      // Latest chapter
      let latestChapter = null;
      const chapterEl = $el
        .find('a[href*="/chapter-"] p, span:contains("Chapter"), div.font-medium span')
        .first();
      const chapterText = chapterEl.text().trim();
      if (chapterText) {
        const match = chapterText.match(/Chapter\s+([0-9.]+)/i);
        latestChapter = match ? match[1] : chapterText.replace(/.*?Chapter\s*/i, '').trim();
      }

      // Status
      let status = null;
      const statusText = $el
        .find('p:contains("Ongoing"), p:contains("Completed"), p:contains("Hiatus"), span.bg-accent')
        .first()
        .text()
        .trim()
        .toLowerCase();
      if (statusText.includes('ongoing')) status = 'ongoing';
      else if (statusText.includes('completed')) status = 'completed';
      else if (statusText.includes('hiatus')) status = 'hiatus';

      // Rating
      let rating = null;
      const ratingText = $el.find('.numscore, span.text-yellow-400').first().text().trim();
      if (ratingText && !isNaN(parseFloat(ratingText))) {
        rating = parseFloat(ratingText);
      }

      // Updated At
      const timeText = $el.find('time').first().text().trim();
      const updatedAt = timeText || null;

      items.push({
        title,
        slug,
        cover: cover || null,
        type,
        latestChapter: latestChapter || null,
        updatedAt,
        status,
        rating,
      });
    });

    return items;
  }

  /**
   * Get latest / newly updated manga list directly from https://v7.kiryuu.to/latest/
   * @param {number} page
   */
  async getLatest(page = 1) {
    const pageNum = Number(page) || 1;
    const url = `${this.baseUrl}/latest/${pageNum > 1 ? `?the_page=${pageNum}` : ''}`;
    const html = await getHtml(url, {
      headers: {
        Referer: `${this.baseUrl}/`,
      },
    });

    const items = this._parseMangaList(html);
    return {
      source: this.name,
      page: pageNum,
      hasNextPage: items.length >= this.pageSize,
      data: items,
    };
  }

  /**
   * Get popular / trending manga list.
   * @param {number} page
   * @param {Object} [options]
   */
  async getPopular(page = 1, options = {}) {
    return this._advancedSearch({
      page,
      orderby: 'popular',
      order: 'desc',
      ...options,
    });
  }

  /**
   * Get top rated manga list.
   * @param {number} page
   */
  async getRating(page = 1) {
    return this._advancedSearch({
      page,
      orderby: 'rating',
      order: 'desc',
    });
  }

  /**
   * Get alphabetical A-Z manga list (orderby=title, order=asc).
   * @param {number} page
   */
  async getAz(page = 1) {
    return this._advancedSearch({
      page,
      orderby: 'title',
      order: 'asc',
    });
  }

  /**
   * Get alphabetical Z-A manga list (orderby=title, order=desc).
   * @param {number} page
   */
  async getZa(page = 1) {
    return this._advancedSearch({
      page,
      orderby: 'title',
      order: 'desc',
    });
  }

  /**
   * Search manga by query.
   * @param {string} query
   * @param {number} page
   */
  async search(query, page = 1) {
    return this._advancedSearch({
      query,
      page,
      orderby: 'popular',
      order: 'desc',
    });
  }

  /**
   * Get all available genres from Kiryuu's WP REST API sorted alphabetically (A-Z).
   */
  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) {
      return this._cachedGenres;
    }

    try {
      const urlPage1 = `${this.baseUrl}/wp-json/wp/v2/genre?per_page=100&page=1&orderby=name&order=asc`;
      const res1 = await fetchWithHeaders(urlPage1, { json: true });
      const totalPages = parseInt(res1.headers.get('x-wp-totalpages') || '1', 10);
      const dataPage1 = await res1.json();

      let allRaw = Array.isArray(dataPage1) ? [...dataPage1] : [];

      if (totalPages > 1) {
        const remainingPagePromises = [];
        for (let p = 2; p <= totalPages; p++) {
          const pageUrl = `${this.baseUrl}/wp-json/wp/v2/genre?per_page=100&page=${p}&orderby=name&order=asc`;
          remainingPagePromises.push(
            fetchWithHeaders(pageUrl, { json: true })
              .then((r) => r.json())
              .catch(() => [])
          );
        }
        const remainingResults = await Promise.all(remainingPagePromises);
        for (const pageData of remainingResults) {
          if (Array.isArray(pageData)) {
            allRaw.push(...pageData);
          }
        }
      }

      if (allRaw.length > 0) {
        const genres = allRaw
          .filter((g) => g && g.name && g.slug)
          .map((g) => ({
            name: g.name.trim(),
            slug: g.slug.trim(),
          }));

        // Sort alphabetically A-Z
        genres.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

        this._cachedGenres = genres;
        this._cachedGenresExpiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
        return this._cachedGenres;
      }
    } catch (_) {}

    // Fallback if WP API fails
    return [
      { name: 'Action', slug: 'action' },
      { name: 'Adventure', slug: 'adventure' },
      { name: 'Comedy', slug: 'comedy' },
      { name: 'Drama', slug: 'drama' },
      { name: 'Fantasy', slug: 'fantasy' },
      { name: 'Isekai', slug: 'isekai' },
      { name: 'Martial Arts', slug: 'martial-arts' },
      { name: 'Romance', slug: 'romance' },
      { name: 'Sci-Fi', slug: 'sci-fi' },
      { name: 'Shounen', slug: 'shounen' },
    ];
  }

  /**
   * Get manga list filtered by genre slug.
   * Supports orderby/sort: 'updated', 'popular', 'rating', 'title' (except bookmarked).
   * @param {string} genre
   * @param {number} page
   * @param {Object} [options]
   */
  async getByGenre(genre, page = 1, options = {}) {
    const { orderby, order } = this._normalizeOrderOptions(options);
    const genreArr = Array.isArray(genre)
      ? genre
      : String(genre || '')
          .split(/[,+]/)
          .map((s) => s.trim())
          .filter(Boolean);

    return this._advancedSearch({
      ...options,
      genre: genreArr,
      page,
      orderby,
      order,
    });
  }

  /**
   * Get available manga types.
   */
  async getTypes() {
    return ['manga', 'manhwa', 'manhua', 'mangatoon'];
  }

  /**
   * Get manga list filtered by type.
   * Supports orderby/sort: 'updated', 'popular', 'rating', 'title' (except bookmarked).
   * @param {string} type
   * @param {number} page
   * @param {Object} [options]
   */
  async getByType(type, page = 1, options = {}) {
    const { orderby, order } = this._normalizeOrderOptions(options);
    return this._advancedSearch({
      ...options,
      type: [type],
      page,
      orderby,
      order,
    });
  }

  /**
   * Get directory list of manga.
   * @param {number} page
   * @param {Object} [options]
   */
  async getList(page = 1, options = {}) {
    return this._advancedSearch({
      page,
      ...options,
    });
  }

  /**
   * Get detailed manga information and chapter list.
   * @param {string} slug
   */
  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    if (!cleanSlug) {
      throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');
    }

    const url = `${this.baseUrl}/manga/${cleanSlug}/`;
    let html;
    try {
      html = await getHtml(url, {
        headers: { Referer: `${this.baseUrl}/` },
      });
    } catch (err) {
      if (err.statusCode === 404) {
        throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di Kiryuu`, 'NOT_FOUND');
      }
      throw err;
    }

    const $ = cheerio.load(html);
    const title =
      $('h1[itemprop="name"]').text().trim() ||
      $('h1').text().trim() ||
      cleanSlug;

    const altTitle =
      $('h1[itemprop="name"]').next().text().trim() ||
      $('span.text-xs.text-gray-400').first().text().trim() ||
      null;

    let cover = $('div[itemprop="image"] img').attr('src') || $('img.wp-post-image').attr('src') || null;
    if (cover) {
      cover = cover.replace(/-\d+x\d+(\.[a-zA-Z0-9]+)$/, '$1');
    }

    const synopsis = $('div[itemprop="description"]').text().trim() || null;

    let status = 'ongoing';
    let type = 'manga';
    let released = null;
    let rating = null;

    $('div.space-y-2 > .flex').each((_, el) => {
      const $el = $(el);
      const key = $el.find('h4').text().trim().toLowerCase();
      const val = $el.find('p, span').last().text().trim();
      if (!val) return;

      if (key.includes('status')) {
        status = val.toLowerCase().includes('ongoing')
          ? 'ongoing'
          : val.toLowerCase().includes('completed')
          ? 'completed'
          : val.toLowerCase();
      } else if (key.includes('type') || key.includes('tipe')) {
        type = val.toLowerCase();
      } else if (key.includes('posted') || key.includes('released') || key.includes('rilis')) {
        released = val;
      }
    });

    // 1. Try displayed rating in UI (right next to 'Ratings' label)
    const uiRating = $('small:contains("Ratings")').prev('span, div').text().trim();
    if (uiRating && !isNaN(parseFloat(uiRating))) {
      rating = parseFloat(uiRating);
    }

    // 2. Try Schema.org ld+json aggregateRating
    if (rating === null) {
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const json = JSON.parse($(el).text());
          const rVal = json.aggregateRating?.ratingValue;
          if (rVal && !isNaN(parseFloat(rVal))) {
            rating = parseFloat(rVal);
          }
        } catch (_) {}
      });
    }

    // 3. Fallback to itemprop / numscore
    if (rating === null) {
      const ratingAttr =
        $('[itemprop="ratingValue"]').attr('content') ||
        $('meta[itemprop="ratingValue"]').attr('content') ||
        $('[itemprop="ratingValue"]').text().trim() ||
        $('.numscore, span.text-yellow-400').first().text().trim();
      if (ratingAttr && !isNaN(parseFloat(ratingAttr))) {
        rating = parseFloat(ratingAttr);
      }
    }

    const genres = [];
    $('a[itemprop="genre"], a[href*="/genre/"]').each((_, a) => {
      const gName = $(a).text().trim();
      const gHref = $(a).attr('href') || '';
      const gSlug = gHref.replace(/\/+$/, '').split('/genre/')[1] || gName.toLowerCase();
      if (gName && !genres.some((g) => g.slug === gSlug)) {
        genres.push({ name: gName, slug: gSlug });
      }
    });

    // Resolve manga ID for chapter list
    let mangaId = null;
    const hxGet = $('[hx-get*="manga_id="]').attr('hx-get');
    if (hxGet && hxGet.includes('manga_id=')) {
      const m = hxGet.match(/manga_id=([0-9]+)/);
      if (m) mangaId = m[1];
    }
    if (!mangaId) {
      const m = html.match(/manga_id=([0-9]+)/);
      if (m) mangaId = m[1];
    }
    if (!mangaId) {
      const inputVal = $('input#manga_id, [data-manga-id]').val() || $('[data-manga-id]').attr('data-manga-id');
      if (inputVal) mangaId = inputVal.trim();
    }

    // Fetch chapters list
    const chapters = [];
    if (mangaId) {
      const chUrl = `${this.baseUrl}/wp-admin/admin-ajax.php?manga_id=${mangaId}&page=1&action=chapter_list`;
      try {
        const chHtml = await getHtml(chUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'HX-Request': 'true',
            'HX-Target': 'chapter-list',
            'HX-Trigger': 'chapter-list',
            'HX-Current-URL': url,
            Referer: url,
          },
        });

        const $ch = cheerio.load(chHtml);
        $ch('div#chapter-list > div[data-chapter-number], div[data-chapter-number]').each((_, el) => {
          const a = $ch(el).find('a');
          const href = a.attr('href');
          if (!href) return;

          const rawSlug = href.replace(/\/+$/, '').split('/').pop();
          const chNumAttr = $ch(el).attr('data-chapter-number');
          const chNum = chNumAttr ? parseFloat(chNumAttr) : null;

          // Short clean slug (e.g. "3862") instead of "chapter-3862.698726"
          const cleanSlug =
            chNum !== null && !isNaN(chNum)
              ? String(chNum)
              : rawSlug.replace(/^chapter-?/i, '').replace(/\.\d+$/, '') || rawSlug;

          const chTitle = $ch(el).find('div.font-medium span, span').first().text().trim() || `Chapter ${cleanSlug}`;
          const date = $ch(el).find('time').text().trim() || null;

          chapters.push({
            id: rawSlug,
            rawSlug,
            slug: cleanSlug,
            chapterNumber: chNum,
            title: chTitle,
            createdAt: date,
            url: href.startsWith('http') ? href : `${this.baseUrl}${href.startsWith('/') ? '' : '/'}${href}`,
          });
        });
      } catch (_) {}
    }

    // Store in cache for fast chapter lookup
    this._mangaCache.set(cleanSlug, {
      title,
      mangaId,
      chapters,
      cachedAt: Date.now(),
    });

    return {
      source: this.name,
      title,
      slug: cleanSlug,
      altTitle,
      cover,
      synopsis,
      status,
      type,
      released,
      rating,
      genres,
      chapters,
    };
  }

  /**
   * Get list of image pages for a specific chapter.
   * @param {string} slug
   * @param {string|number} chapter
   */
  async getPages(slug, chapter) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    const rawChapter = String(chapter || '').trim();
    if (!cleanSlug || !rawChapter) {
      throw createBadRequest("Parameter 'slug' dan 'chapter' wajib diisi", 'INVALID_PARAMETER');
    }

    let targetChapterUrl = null;
    let chapterTitle = null;

    // 1. Check memory cache for this manga's chapters and title
    const cached = this._mangaCache.get(cleanSlug);
    let chapters = cached?.chapters;
    let mangaTitle = cached?.title;

    if (!chapters || !mangaTitle) {
      // Fetch details to populate chapters and title
      const details = await this.getDetails(cleanSlug);
      chapters = details.chapters || [];
      mangaTitle = details.title;
    }

    // Match chapter from chapters list
    const cleanChNum = parseFloat(rawChapter.replace(/^chapter-?/i, ''));
    const matched = chapters.find((ch) => {
      if (ch.slug === rawChapter || ch.slug === `chapter-${rawChapter}` || `chapter-${ch.slug}` === rawChapter) return true;
      if (ch.chapter && (ch.chapter === rawChapter || ch.chapter === String(cleanChNum))) return true;
      if (ch.rawSlug && (ch.rawSlug === rawChapter || ch.rawSlug === `chapter-${rawChapter}`)) return true;
      if (!isNaN(cleanChNum) && ch.chapterNumber === cleanChNum) return true;
      if (ch.rawSlug && (ch.rawSlug.startsWith(`chapter-${rawChapter}.`) || ch.rawSlug.startsWith(`chapter-${cleanChNum}.`))) return true;
      if (ch.url && (ch.url.includes(`/${rawChapter}/`) || ch.url.includes(`/chapter-${rawChapter}.`) || ch.url.includes(`/chapter-${cleanChNum}.`))) return true;
      return false;
    });

    if (matched) {
      targetChapterUrl = matched.url;
      chapterTitle = matched.title;
    } else {
      // Direct candidate attempt
      targetChapterUrl = `${this.baseUrl}/manga/${cleanSlug}/${rawChapter.startsWith('chapter-') ? rawChapter : `chapter-${rawChapter}`}/`;
    }

    let html;
    try {
      html = await getHtml(targetChapterUrl, {
        headers: { Referer: `${this.baseUrl}/` },
      });
    } catch (err) {
      if (err.statusCode === 404) {
        throw createNotFound(
          `Chapter '${rawChapter}' untuk manga '${cleanSlug}' tidak ditemukan di Kiryuu`,
          'NOT_FOUND'
        );
      }
      throw err;
    }

    const $ = cheerio.load(html);
    const pages = [];
    const seenUrls = new Set();

    // Kiryuu images selector: section[data-image-data] img, fallback #readerarea img
    $('section[data-image-data] img, #readerarea img, main section section > img, .rdcontainer img').each((_, img) => {
      let src =
        $(img).attr('src') ||
        $(img).attr('data-src') ||
        $(img).attr('data-lazy-src') ||
        '';

      if (!src) return;
      src = src.trim();
      if (src.startsWith('//')) {
        src = `https:${src}`;
      } else if (src.startsWith('/')) {
        src = `${this.baseUrl}${src}`;
      }

      // Filter out advertisement, banners, analytics
      if (
        src.includes('promosi') ||
        src.includes('banner') ||
        /\/ads[\/_.-]/i.test(src) ||
        src.includes('googleads') ||
        src.includes('adservice')
      ) {
        return;
      }

      if (seenUrls.has(src)) return;
      seenUrls.add(src);

      pages.push({
        page: pages.length + 1,
        url: src,
        directUrl: src,
        proxyUrl: `/api/proxy/image?url=${encodeURIComponent(src)}`,
      });
    });

    if (pages.length === 0) {
      throw createBadGateway(
        `Gagal menemukan halaman gambar untuk chapter '${rawChapter}'`,
        'UPSTREAM_ERROR'
      );
    }

    const cleanChapterTitle = chapterTitle || `Chapter ${rawChapter}`;
    const fullTitle = mangaTitle
      ? cleanChapterTitle.toLowerCase().includes(mangaTitle.toLowerCase())
        ? cleanChapterTitle
        : `${mangaTitle} ${cleanChapterTitle}`
      : cleanChapterTitle;

    return {
      source: this.name,
      title: fullTitle,
      totalPages: pages.length,
      pages,
    };
  }
}

module.exports = KiryuuSource;
