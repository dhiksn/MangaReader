const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

class MaidSource extends BaseSource {
  constructor() {
    super('maid', 'Maid');
    this.baseUrl = 'https://www.maid.my.id';
    this.icon = `https://www.maid.my.id/wp-content/uploads/2019/05/cropped-LogoMaid-32x32.png`;

    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  // ─── Auth ────────────────────────────────────────────────────────────────────
  // Maid uses WordPress post password for some chapters — not supported via scraping.
  // Chapters protected by post password will return a clear error message.

  getSupportedSorts() {
    return [
      { id: 'latest', name: 'Terbaru' },
      { id: 'newest', name: 'Diperbarui' },
      { id: 'popular', name: 'Populer' },
      { id: 'az', name: 'A-Z' },
      { id: 'za', name: 'Z-A' },
    ];
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  _slugFromUrl(href) {
    if (!href) return null;
    const match = href.match(/\/manga\/([^/]+)\/?$/);
    return match ? match[1] : null;
  }

  _resolveOrder(raw) {
    const map = {
      latest: 'update', update: 'update',
      newest: 'latest',
      popular: 'popular',
      az: 'title', title: 'title',
      za: 'titlereverse',
    };
    return map[String(raw || '').toLowerCase()] || 'update';
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

    $('a[href*="/manga/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const slug = this._slugFromUrl(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const title = $(el).attr('title') || $(el).find('.title').text().trim();
      if (!title) return;

      // Cover — data-lazy-src (lazy loaded)
      const rawCover = $(el).find('img').first().attr('data-lazy-src') ||
                       $(el).find('img').first().attr('src') || '';
      const cover = rawCover.startsWith('data:') ? null : (rawCover || null);

      const card = $(el).closest('.flexbox2-content');
      const typeRaw = card.find('.type').text().trim();
      const type = typeRaw.toLowerCase() || null;

      const ratingText = card.find('.score').text().trim().replace(/[^\d.]/g, '');
      const rating = ratingText && !isNaN(parseFloat(ratingText)) ? parseFloat(ratingText) : null;

      const seasonText = card.find('.season').text().trim();
      const chMatch = seasonText.match(/(\d+[.\d]*)/);
      const latestChapter = chMatch ? chMatch[1] : null;

      items.push({ title: title.trim(), slug, cover, type, rating, latestChapter });
    });

    return items;
  }

  _buildListUrl(order, pageNum, extra = '') {
    const base = `${this.baseUrl}/advanced-search/`;
    const pagePart = pageNum > 1 ? `page/${pageNum}/` : '';
    return `${base}${pagePart}?order=${order}${extra}`;
  }

  async _fetchListing(url, pageNum) {
    const html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
    return { data, maxPage, hasNextPage };
  }

  // ─── Public endpoints ────────────────────────────────────────────────────────

  async getLatest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = this._buildListUrl('update', pageNum);
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getNewest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = this._buildListUrl('latest', pageNum);
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getPopular(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = this._buildListUrl('popular', pageNum);
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getAz(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = this._buildListUrl('title', pageNum);
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getZa(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = this._buildListUrl('titlereverse', pageNum);
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const order = this._resolveOrder(options.order || options.sort || 'update');
    let extra = '';
    if (options.status) extra += `&status=${encodeURIComponent(String(options.status).toLowerCase())}`;
    if (options.type) extra += `&type=${encodeURIComponent(String(options.type).toLowerCase())}`;
    const url = this._buildListUrl(order, pageNum, extra);
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async search(query, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const q = encodeURIComponent(String(query || '').trim());
    const order = this._resolveOrder(options.order || options.sort || 'update');
    const url = this._buildListUrl(order, pageNum, `&title=${q}`);
    const html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
    return { source: this.name, query: String(query || '').trim(), page: pageNum, maxPage, hasNextPage, data };
  }

  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) {
      return this._cachedGenres;
    }

    const html = await getHtml(`${this.baseUrl}/advanced-search/`, {
      headers: { Referer: `${this.baseUrl}/` },
    });
    const $ = cheerio.load(html);
    const genres = [];
    const seen = new Set();

    $('input[name="genre[]"]').each((_, el) => {
      const id = $(el).attr('id') || '';
      const slug = $(el).val()?.trim();
      if (!slug || seen.has(slug)) return;
      seen.add(slug);
      const label = $(`label[for="${id}"]`).text().trim() ||
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

    const order = this._resolveOrder(options.order || options.sort || 'update');
    const genres = await this.getGenres();

    const keys = cleanGenre.split(',').map((g) => g.trim()).filter(Boolean);
    const found = keys.map((key) => {
      const match = genres.find((g) => g.slug === key || g.name.toLowerCase() === key);
      if (!match) throw createNotFound(`Genre '${key}' tidak ditemukan di Maid`, 'NOT_FOUND');
      return match;
    });

    const genreParams = found.map((g) => `genre%5B%5D=${encodeURIComponent(g.slug)}`).join('&');
    const url = this._buildListUrl(order, pageNum, `&${genreParams}`);
    const html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
    return { source: this.name, genre: found.map((g) => g.name).join(', '), page: pageNum, maxPage, hasNextPage, data };
  }

  async getTypes() {
    return ['manga', 'manhwa', 'manhua', 'doujin'];
  }

  async getByType(type, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanType = String(type || '').trim().toLowerCase();
    if (!cleanType) throw createBadRequest("Parameter 'type' wajib diisi", 'INVALID_PARAMETER');
    const order = this._resolveOrder(options.order || options.sort || 'update');
    const url = this._buildListUrl(order, pageNum, `&type=${encodeURIComponent(cleanType)}`);
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, type: cleanType, page: pageNum, maxPage, hasNextPage, data };
  }

  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    const url = `${this.baseUrl}/manga/${cleanSlug}/`;
    let html;
    try {
      html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di Maid`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    const title = $('h1, h2.series-title, .series-title h2').first().text().trim() || cleanSlug;

    // Cover — data-lazy-src
    const rawCover = $('.series-thumb img').first().attr('data-lazy-src') ||
                     $('.series-thumb img').first().attr('src') || '';
    const cover = rawCover.startsWith('data:') ? null : (rawCover || null);

    // Synopsis
    const synopsis = $('.series-synops').text().trim() || null;

    // Status & Type
    const typeClass = $('.series-infoz .type').attr('class') || '';
    const typeMatch = typeClass.match(/\btype\s+(\S+)/i);
    const type = typeMatch ? typeMatch[1].toLowerCase() : null;
    const status = $('.series-infoz .status').text().trim().toLowerCase() || null;

    // Meta from .series-infolist li
    let year = null, author = null;
    $('.series-infolist li').each((_, el) => {
      const text = $(el).text().trim();
      if (/^Published/i.test(text)) {
        const m = text.match(/\d{4}/);
        if (m) year = m[0];
      } else if (/^Author/i.test(text)) {
        author = text.replace(/^Author/i, '').trim() || null;
      }
    });

    // Genres
    const genres = [];
    const seenGenres = new Set();
    $('.series-genres a[href*="/genres/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const match = href.match(/\/genres\/([^/]+)\/?$/);
      const genreSlug = match ? match[1] : null;
      const name = $(el).text().trim();
      if (!name || !genreSlug || seenGenres.has(genreSlug)) return;
      seenGenres.add(genreSlug);
      genres.push({ name, slug: genreSlug });
    });

    // Chapters from .series-chapterlist .flexch a
    const chapters = [];
    $('.series-chapterlist .flexch').each((_, el) => {
      const a = $(el).find('.flexch-infoz a').first();
      const href = a.attr('href') || '';
      if (!href) return;
      const fullTitle = a.attr('title') || '';
      const chTitle = a.find('span').first().contents().filter((__, n) => n.type === 'text').text().trim() ||
                      fullTitle.replace(/Bahasa Indonesia/gi, '').trim();
      const date = a.find('.date').text().trim() || null;
      chapters.push({
        title: chTitle || fullTitle,
        slug: href,
        endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(href)}`,
        date,
      });
    });

    return {
      source: this.name,
      title,
      cover,
      synopsis,
      status,
      type,
      author: author || null,
      year: year || null,
      genres,
      totalChapters: chapters.length,
      chapters,
    };
  }

  async getPages(slug, chapter, password) {
    const rawSlug = String(slug || '').trim();
    if (!rawSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    let chapterUrl;

    if (rawSlug.startsWith('http')) {
      // Full URL from chapter list endpoint
      chapterUrl = rawSlug;
    } else {
      // Resolve chapter URL from detail page chapter list
      const chNum = String(chapter || '').replace(/^chapter-?/i, '').trim();
      try {
        const details = await this.getDetails(rawSlug);
        const target = details.chapters.find((ch) => {
          const m = ch.title.match(/Chapter\s+([0-9.]+)/i);
          return m && parseFloat(m[1]) === parseFloat(chNum);
        });
        chapterUrl = target?.slug || null;
      } catch (_) {}

      if (!chapterUrl) throw createNotFound(`Chapter '${chapter}' tidak ditemukan untuk manga '${rawSlug}'`, 'NOT_FOUND');
    }

    let html;
    try {
      let fetchHeaders = { Referer: `${this.baseUrl}/` };

      // If password provided, submit it first to get wp-postpass cookie
      if (password) {
        const fd = new URLSearchParams();
        fd.append('post_password', String(password).trim());
        fd.append('redirect_to', chapterUrl);

        const passRes = await fetch(`${this.baseUrl}/wp-login.php?action=postpass`, {
          method: 'POST',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
            'Referer': chapterUrl,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: fd.toString(),
          redirect: 'manual',
        });

        const setCookies = passRes.headers.getSetCookie?.() || [];
        const postpassCookie = setCookies.map((c) => c.split(';')[0]).find((c) => c.includes('wp-postpass'));
        if (postpassCookie) {
          fetchHeaders['Cookie'] = postpassCookie;
        }
      }

      html = await getHtml(chapterUrl, { headers: fetchHeaders });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Chapter tidak ditemukan di Maid`, 'NOT_FOUND');
      throw err;
    }

    // Check if still password protected
    if (html.includes('post-password-form') || html.includes('wp-login.php?action=postpass')) {
      throw createBadGateway(
        password
          ? `Password salah untuk chapter ini`
          : `Chapter ini dilindungi sandi. Tambahkan ?password=SANDI di URL`,
        'UPSTREAM_ERROR'
      );
    }

    // Images are in data-lazy-src (WP Rocket lazy load) or plain img[src] after password unlock
    const SKIP_PATTERNS = ['/wp-content/uploads/2020', '/wp-content/uploads/2019',
                           '/wp-content/uploads/2026/06', '/wp-content/uploads/2026/07/0adgv',
                           'gravatar.com', 'disqus.com', 'histats.com', 'Maid-v2', 'fLvGlt4v',
                           'nasa_avatar', '/wp-content/plugins/', 'cropped-Logo', 'ytimg.com', 'trakteer.id'];

    const $page = cheerio.load(html);
    let images = [];
    const seenUrls = new Set();

    const addImg = (src) => {
      if (!src || src.startsWith('data:') || seenUrls.has(src)) return;
      if (SKIP_PATTERNS.some((p) => src.includes(p))) return;
      seenUrls.add(src);
      images.push(src);
    };

    // Primary: data-lazy-src (WP Rocket lazy load — public chapters)
    $page('img[data-lazy-src]').each((_, el) => addImg($page(el).attr('data-lazy-src') || ''));

    // After password unlock: plain img[src] with imgchest CDN
    if (images.length === 0) {
      $page('img[src]').each((_, el) => addImg($page(el).attr('src') || ''));
    }

    // Fallback: noscript img[src]
    if (images.length === 0) {
      $page('noscript').each((_, el) => {
        const inner = cheerio.load($page(el).html() || '');
        inner('img[src]').each((__, img) => addImg(inner(img).attr('src') || ''));
      });
    }

    if (!images.length) throw createBadGateway('Tidak ada gambar untuk chapter ini di Maid', 'UPSTREAM_ERROR');

    const pages = images.map((imgUrl, index) => ({
      page: index + 1,
      url: imgUrl,
      directUrl: imgUrl,
      proxyUrl: `/api/proxy/image?url=${encodeURIComponent(imgUrl)}&referer=${encodeURIComponent(`${this.baseUrl}/`)}`,
    }));

    const $ = cheerio.load(html);
    const pageTitle = $('title').text()
      .replace(/\s*Bahasa Indonesia\s*/gi, '')
      .replace(/\s*[-–|]\s*Maid.*$/i, '')
      .trim();

    return {
      source: this.name,
      title: pageTitle,
      totalPages: pages.length,
      pages,
    };
  }
}

module.exports = MaidSource;
