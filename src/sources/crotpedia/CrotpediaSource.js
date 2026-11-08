const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

class CrotpediaSource extends BaseSource {
  constructor() {
    super('crotpedia', 'CrotPedia');
    this.baseUrl = 'https://crotpedia.net';
    this.icon = `https://crotpedia.net/wp-content/uploads/2023/03/cropped-Favicon-32x32.png`;

    // Auth session cache
    this._authCookies = null;
    this._authExpiresAt = 0;

    // Genres cache
    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  getSupportedSorts() {
    return [
      { id: 'latest', name: 'Terbaru' },
      { id: 'newest', name: 'Diperbarui' },
      { id: 'popular', name: 'Populer' },
      { id: 'rating', name: 'Rating'},
      { id: 'az', name: 'A-Z' },
      { id: 'za', name: 'Z-A' },
    ];
  }

  // ─── Auth ────────────────────────────────────────────────────────────────────

  async login() {
    const email = process.env.CROTPEDIA_EMAIL;
    const password = process.env.CROTPEDIA_PASSWORD;

    if (!email || !password) {
      throw new Error(
        'Untuk mengakses CrotPedia, harap atur CROTPEDIA_EMAIL dan CROTPEDIA_PASSWORD di file .env'
      );
    }

    try {
      const fd = new URLSearchParams();
      fd.append('log', email);
      fd.append('pwd', password);
      fd.append('rememberme', 'forever');
      fd.append('wp-submit', 'Log In');
      fd.append('redirect_to', `${this.baseUrl}/`);
      fd.append('testcookie', '1');

      const res = await fetch(`${this.baseUrl}/wp-login.php`, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Referer': `${this.baseUrl}/wp-login.php`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': 'wordpress_test_cookie=WP+Cookie+check',
        },
        body: fd.toString(),
        redirect: 'manual',
      });

      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      const authCookies = setCookies
        .map((c) => c.split(';')[0].trim())
        .filter((c) => c.includes('wordpress_logged_in') || c.includes('wordpress_sec'));

      if (authCookies.length === 0) {
        throw new Error('Login gagal — periksa email/password CROTPEDIA di .env');
      }

      this._authCookies = authCookies.join('; ');
      this._authExpiresAt = Date.now() + 12 * 60 * 60 * 1000; // 12 jam
      console.log('[CrotPedia] Login berhasil sebagai:', email);
      return this._authCookies;
    } catch (err) {
      console.error('[CrotPedia Login Error]:', err.message);
      throw err;
    }
  }

  async _ensureAuth() {
    if (!this._authCookies || Date.now() > this._authExpiresAt) {
      await this.login();
    }
    return this._authCookies;
  }

  get _baseHeaders() {
    return { Referer: `${this.baseUrl}/`, 'User-Agent': UA };
  }

  async _authHeaders() {
    const cookies = await this._ensureAuth();
    return { ...this._baseHeaders, Cookie: cookies };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  _slugFromUrl(href) {
    if (!href) return null;
    const match = href.match(/\/baca\/series\/([^/]+)\/?$/);
    return match ? match[1] : null;
  }

  _parsePagination($, currentPage) {
    let maxPage = currentPage;
    $('a.page-numbers').each((_, el) => {
      const n = parseInt($(el).text().trim(), 10);
      if (!isNaN(n) && n > maxPage) maxPage = n;
    });
    const hasNextPage = $('a.next.page-numbers').length > 0;
    return { maxPage: maxPage > currentPage ? maxPage : null, hasNextPage };
  }

  _parseCardList($) {
    const items = [];
    const seen = new Set();

    $('a[href*="/baca/series/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const slug = this._slugFromUrl(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const title = $(el).attr('title') || $(el).find('.flexbox2-title span').first().text().trim();
      if (!title) return;

      const cover = $(el).find('img').first().attr('src') || null;

      // Type from .flexbox2-side .type
      const card = $(el).closest('.flexbox2-content');
      const typeRaw = card.find('.type').text().trim();
      const type = typeRaw.toLowerCase() || null;

      // Rating from .score
      const ratingText = card.find('.score').text().trim().replace(/[^\d.]/g, '');
      const rating = ratingText && !isNaN(parseFloat(ratingText)) ? parseFloat(ratingText) : null;

      // Latest chapter from .season
      const seasonText = card.find('.season').text().trim();
      const chMatch = seasonText.match(/(\d+)/);
      const latestChapter = chMatch ? chMatch[1] : null;

      // Genres from .genres a
      const genres = [];
      const seenG = new Set();
      card.find('.genres a[href*="/baca/genre/"]').each((__, a) => {
        const href = $(a).attr('href') || '';
        const gMatch = href.match(/\/baca\/genre\/([^/]+)\/?$/);
        const gSlug = gMatch ? gMatch[1] : null;
        const gName = $(a).text().trim();
        if (gName && gSlug && !seenG.has(gSlug)) {
          seenG.add(gSlug);
          genres.push({ name: gName, slug: gSlug });
        }
      });

      items.push({ title: title.trim(), slug, cover, type, rating, latestChapter, genres });
    });

    return items;
  }

  async _fetchListing(url, pageNum) {
    const html = await getHtml(url, { headers: this._baseHeaders });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
    return { data, maxPage, hasNextPage };
  }

  // ─── Public endpoints ────────────────────────────────────────────────────────

  async getLatest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const base = `${this.baseUrl}/advanced-search/`;
    const url = pageNum === 1
      ? `${base}?order=update`
      : `${base}page/${pageNum}/?order=update`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getNewest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const base = `${this.baseUrl}/advanced-search/`;
    const url = pageNum === 1
      ? `${base}?order=latest`
      : `${base}page/${pageNum}/?order=latest`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getPopular(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const base = `${this.baseUrl}/advanced-search/`;
    const url = pageNum === 1
      ? `${base}?order=popular`
      : `${base}page/${pageNum}/?order=popular`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getRating(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const base = `${this.baseUrl}/advanced-search/`;
    const url = pageNum === 1
      ? `${base}?order=rating`
      : `${base}page/${pageNum}/?order=rating`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getAz(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const base = `${this.baseUrl}/advanced-search/`;
    const url = pageNum === 1
      ? `${base}?order=title`
      : `${base}page/${pageNum}/?order=title`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getZa(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const base = `${this.baseUrl}/advanced-search/`;
    const url = pageNum === 1
      ? `${base}?order=titlereverse`
      : `${base}page/${pageNum}/?order=titlereverse`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const orderMap = { latest: 'update', update: 'update', newest: 'latest', popular: 'popular', rating: 'rating', az: 'title', title: 'title', za: 'titlereverse' };
    const order = orderMap[String(options.order || options.sort || 'update').toLowerCase()] || 'update';
    const params = new URLSearchParams({ order });
    if (options.status) params.set('status', String(options.status).toLowerCase());
    if (options.type) params.set('type', String(options.type));
    if (options.q || options.title) params.set('title', options.q || options.title);
    if (options.genre) {
      const genres = await this.getGenres();
      const keys = String(options.genre).split(',').map((g) => g.trim().toLowerCase()).filter(Boolean);
      for (const key of keys) {
        const match = genres.find((g) => g.slug === key || g.name.toLowerCase() === key);
        if (match) {
          params.append('genre[]', match.slug);
        }
      }
    }
    const base = `${this.baseUrl}/advanced-search/`;
    const url = pageNum === 1
      ? `${base}?${params.toString()}`
      : `${base}page/${pageNum}/?${params.toString()}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async search(query, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);

    const orderMap = {
      latest: 'update',
      update: 'update',
      newest: 'latest',
      popular: 'popular',
      rating: 'rating',
      az: 'title',
      title: 'title',
      za: 'titlereverse',
    };

    const requestedOrder = String(
      options.order || options.sort || 'update'
    ).toLowerCase();

    const order = orderMap[requestedOrder] || 'update';

    const params = new URLSearchParams({
      title: String(query || '').trim(),
      order,
    });

    const base = `${this.baseUrl}/advanced-search/`;

    const url = pageNum === 1
      ? `${base}?${params.toString()}`
      : `${base}page/${pageNum}/?${params.toString()}`;

    const html = await getHtml(url, {
      headers: this._baseHeaders,
    });

    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);

    return {
      source: this.name,
      query: String(query || '').trim(),
      order: requestedOrder,
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

    const html = await getHtml(`${this.baseUrl}/advanced-search/`, { headers: this._baseHeaders });
    const $ = cheerio.load(html);
    const genres = [];
    const seen = new Set();

    $('input[name="genre[]"]').each((_, el) => {
      const slug = $(el).val()?.trim();
      if (!slug || seen.has(slug)) return;
      seen.add(slug);
      const label = $(`label[for="${$(el).attr('id')}"]`).text().trim() ||
                    $(el).next('label').text().trim() ||
                    $(el).closest('li').text().trim();
      if (!label) return;
      genres.push({ name: label, slug });
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

    const orderMap = { latest: 'update', update: 'update', newest: 'latest', popular: 'popular', rating: 'rating', az: 'title', za: 'titlereverse' };
    const order = orderMap[String(options.order || options.sort || 'update').toLowerCase()] || 'update';

    const genres = await this.getGenres();
    const keys = cleanGenre.split(',').map((g) => g.trim()).filter(Boolean);
    const found = keys.map((key) => {
      const match = genres.find((g) => g.slug === key || g.name.toLowerCase() === key);
      if (!match) throw createNotFound(`Genre '${key}' tidak ditemukan di CrotPedia`, 'NOT_FOUND');
      return match;
    });

    const genreParams = found.map((g) => `genre[]=${encodeURIComponent(g.slug)}`).join('&');
    const base = `${this.baseUrl}/advanced-search/`;
    const url = pageNum === 1
      ? `${base}?${genreParams}&order=${order}`
      : `${base}page/${pageNum}/?${genreParams}&order=${order}`;

    const html = await getHtml(url, { headers: this._baseHeaders });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
    return { source: this.name, genre: found.map((g) => g.name).join(', '), page: pageNum, maxPage, hasNextPage, data };
  }

  async getTypes() {
    return ['manga', 'manhwa', 'doujinshi'];
  }

  async getByType(type, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanType = String(type || '').trim();
    if (!cleanType) throw createBadRequest("Parameter 'type' wajib diisi", 'INVALID_PARAMETER');
    const orderMap = { latest: 'update', update: 'update', newest: 'latest', popular: 'popular', rating: 'rating', az: 'title', za: 'titlereverse'};
    const order = orderMap[String(options.order || options.sort || 'update').toLowerCase()] || 'update';
    const base = `${this.baseUrl}/advanced-search/`;
    const url = pageNum === 1
      ? `${base}?type=${encodeURIComponent(cleanType)}&order=${order}`
      : `${base}page/${pageNum}/?type=${encodeURIComponent(cleanType)}&order=${order}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, type: cleanType.toLowerCase(), page: pageNum, maxPage, hasNextPage, data };
  }

  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    const url = `${this.baseUrl}/baca/series/${cleanSlug}/`;
    let html;
    try {
      html = await getHtml(url, { headers: this._baseHeaders });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di CrotPedia`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    // Title = h2 dalam .series-titlex, altTitle Jepang = span dalam .series-titlex, altTitle Inggris dari infolist
    const title = $('.series-titlex h2, .series-title h2').first().text().trim() ||
                  $('h2').first().text().trim() || cleanSlug;

    const japaneseAlt = $('.series-titlex span, .series-title span').first().text().trim() || null;
    let englishAlt = null;
    $('.series-infolist li').each((_, el) => {
      if ($(el).find('b').text().trim().toLowerCase() === 'alternative') {
        englishAlt = $(el).find('span').text().trim() || null;
      }
    });
    // Gabungkan altTitle: Inggris dulu, lalu Jepang
    const altParts = [englishAlt, japaneseAlt].filter(Boolean);
    const altTitle = altParts.length ? altParts.join(' / ') : null;

    // Cover
    const cover = $('.series-thumb img').first().attr('src') ||
                  $('.series-cover img').first().attr('src') || null;

    // Type & Status from .series-infoz
    const typeClass = $('.series-infoz .type').attr('class') || '';
    const typeMatch = typeClass.match(/\btype\s+(\S+)/i);
    const type = typeMatch ? typeMatch[1].toLowerCase() : null;
    const status = $('.series-infoz .status').text().trim().toLowerCase() || null;

    // Meta from .series-infolist li
    let year = null, author = null;
    $('.series-infolist li').each((_, el) => {
      const label = $(el).find('b').text().trim().toLowerCase();
      const value = $(el).find('span').text().trim() || $(el).clone().find('b').remove().end().text().trim();
      if (!value) return;
      if (label === 'published') { const m = value.match(/\d{4}/); if (m) year = m[0]; }
      else if (label === 'author') author = value;
      else if (label === 'published') { const m = value.match(/\d{4}/); if (m) year = m[0]; }
      else if (label === 'author') author = value;
    });

    // Genres from /baca/genre/ links
    const genres = [];
    const seenGenres = new Set();
    $('a[href*="/baca/genre/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const match = href.match(/\/baca\/genre\/([^/]+)\/?$/);
      const genreSlug = match ? match[1] : null;
      const name = $(el).text().trim();
      if (!name || !genreSlug || seenGenres.has(genreSlug)) return;
      seenGenres.add(genreSlug);
      genres.push({ name, slug: genreSlug });
    });

    // Synopsis
    const synopsis = $('.series-synops').text().trim() || null;

    // Chapters from .series-chapterlist .flexch
    const chapters = [];
    $('.series-chapterlist .flexch').each((_, el) => {
      const a = $(el).find('.flexch-infoz a').first();
      const href = a.attr('href') || '';
      if (!href) return;
      const chTitle = a.find('span').first().text().trim() || a.text().trim();
      const date = $(el).find('.date').text().trim() || null;
      const numMatch = href.match(/chapter-(\d+(?:\.\d+)?)-/);
      const chNum = numMatch ? numMatch[1] : null;

      chapters.push({
        title: chTitle.replace(/\s+/g, ' ').trim(),
        slug: href,
        endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(href)}`,
        date,
      });
    });

    // Similar — scrape "Sedang Populer" dari homepage
    let similar = [];
    try {
      const homeHtml = await getHtml(`${this.baseUrl}/`, { headers: this._baseHeaders });
      const $h = cheerio.load(homeHtml);
      const seenSimilar = new Set();
      $h('.popular .flexbox-item a[href*="/baca/series/"]').each((_, el) => {
        const href = $h(el).attr('href') || '';
        const simSlug = href.match(/\/baca\/series\/([^/]+)\/?$/)?.[1];
        if (!simSlug || seenSimilar.has(simSlug)) return;
        seenSimilar.add(simSlug);
        const simTitle = $h(el).find('.flexbox-title').text().trim() || $h(el).attr('title') || '';
        const simCover = $h(el).find('.flexbox-thumb img').first().attr('src') || null;
        if (simTitle) similar.push({ title: simTitle, slug: simSlug, cover: simCover });
      });
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
      year: year || null,
      genres,
      totalChapters: chapters.length,
      chapters,
      similar,
    };
  }

  async getPages(slug, chapter) {
    const rawSlug = String(slug || '').trim();
    if (!rawSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    const chapterUrl = rawSlug.startsWith('http') ? rawSlug
      : `${this.baseUrl}/baca/${rawSlug}-chapter-${String(chapter || '').replace(/^chapter-?/i, '')}-bahasa-indonesia/`;

    // Chapters require login
    const headers = await this._authHeaders();

    let html;
    try {
      html = await getHtml(chapterUrl, { headers });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Chapter tidak ditemukan di CrotPedia`, 'NOT_FOUND');
      throw err;
    }

    // Extract ts_reader.run JSON first
    const tsMatch = html.match(/ts_reader\.run\s*\(\s*(\{[\s\S]*?\})\s*\)\s*;/);
    let images = [];

    if (tsMatch) {
      try {
        const tsData = JSON.parse(tsMatch[1]);
        images = tsData.sources?.[0]?.images || [];
      } catch (_) {}
    }

    // Fallback: extract static img tags from reader.eromanga.cfd or chapter CDN
    if (images.length === 0) {
      const $ = cheerio.load(html);
      const seenUrls = new Set();
      $('img[src]').each((_, el) => {
        const src = $(el).attr('src') || '';
        if (
          (src.includes('reader.eromanga') || src.includes('cdn') || src.includes('/images/')) &&
          !src.includes('crotpedia.net/wp-content') &&
          !src.includes('cover.eromanga') &&
          !seenUrls.has(src)
        ) {
          seenUrls.add(src);
          images.push(src);
        }
      });
    }

    if (!images.length) throw createBadGateway('Tidak ada gambar untuk chapter ini di CrotPedia', 'UPSTREAM_ERROR');

    const pages = images.map((imgUrl, index) => ({
      page: index + 1,
      url: imgUrl,
      directUrl: imgUrl,
      proxyUrl: `/api/proxy/image?url=${encodeURIComponent(imgUrl)}&referer=${encodeURIComponent(`${this.baseUrl}/`)}`,
    }));

    const $ = cheerio.load(html);
    const pageTitle = $('title').text().replace(/\s*[-–|].*$/,'').trim();

    return {
      source: this.name,
      title: pageTitle,
      totalPages: pages.length,
      pages,
    };
  }
}

module.exports = CrotpediaSource;
