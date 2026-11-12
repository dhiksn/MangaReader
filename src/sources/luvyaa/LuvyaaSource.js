const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

class LuvyaaSource extends BaseSource {
  constructor() {
    super('luvyaa', 'Luvyaa');
    this.baseUrl = 'https://v5.luvyaa.co';
    this.icon = `https://v5.luvyaa.co/wp-content/uploads/2025/08/cropped-Icon-web-2-32x32.png`;

    // Genres cache
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

  // ─── Private helpers ────────────────────────────────────────────────────────

  _slugFromUrl(href) {
    if (!href) return null;
    return href.replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '') || null;
  }

  _resolveOrder(raw) {
    const map = {
      latest: 'update',
      update: 'update',
      latest_update: 'update',
      newest: 'latest',
      new: 'latest',
      added: 'latest',
      popular: 'popular',
      popularity: 'popular',
      az: 'title',
      title: 'title',
      za: 'titlereverse',
      titlereverse: 'titlereverse',
    };
    return map[String(raw || '').toLowerCase()] || 'update';
  }

  _parsePagination($, currentPage) {
    let maxPage = currentPage;
    $('.pagination a.page-numbers').each((_, el) => {
      const n = parseInt($(el).text().trim(), 10);
      if (!isNaN(n) && n > maxPage) maxPage = n;
    });
    const hasNextPage = $('.pagination a.next.page-numbers').length > 0;
    return { maxPage: maxPage > currentPage ? maxPage : null, hasNextPage };
  }

  _parseCardList($) {
    const items = [];
    const seen = new Set();

    $('.bs').each((_, el) => {
      const a = $(el).find('.bsx a').first();
      const href = a.attr('href') || '';
      const slug = this._slugFromUrl(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const title = a.attr('title') || $(el).find('.tt').text().trim();
      if (!title) return;

      const cover = $(el).find('img.ts-post-image, img').first().attr('src') || null;

      const latestChText = $(el).find('.epxs').text().trim();
      const latestChMatch = latestChText.match(/Chapter\s+([0-9.]+)/i);
      const latestChapter = latestChMatch ? latestChMatch[1] : latestChText || null;

      // Type from class: "type Manhwa" → extract second class
      const typeClass = $(el).find('[class*="type "]').attr('class') || '';
      const typeMatch = typeClass.match(/\btype\s+(\S+)/i);
      const type = typeMatch ? typeMatch[1].toLowerCase() : null;

      const ratingRaw = $(el).find('.numscore').text().trim();
      const rating = ratingRaw && !isNaN(parseFloat(ratingRaw)) ? parseFloat(ratingRaw) : null;

      items.push({ title: title.trim(), slug, cover, type, latestChapter, rating });
    });

    return items;
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
    const url = `${this.baseUrl}/manga/?order=update&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getNewest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/manga/?status=&type=&order=latest&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getPopular(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/manga/?order=popular&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getAz(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/manga/?order=title&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getZa(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/manga/?order=titlereverse&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const order = this._resolveOrder(options.order || options.sort || 'update');
    const params = new URLSearchParams({ order, page: pageNum });
    if (options.status) params.set('status', String(options.status).toLowerCase());
    if (String(options.type || '').trim().toLowerCase() === 'pornhwa') {
      params.append('genre[]', '50');
      params.set('type', '');
    } else if (options.type) {
      params.set('type', String(options.type).toLowerCase());
    }
    if (options.genre) {
      const genres = await this.getGenres();
      const keys = String(options.genre).split(',').map((g) => g.trim().toLowerCase()).filter(Boolean);
      for (const key of keys) {
        const match = genres.find((g) => g.slug === key || g.name.toLowerCase() === key || g.id === key);
        if (match) params.append('genre[]', match.id);
      }
    }
    const url = `${this.baseUrl}/manga/?${params.toString()}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async search(query, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const q = encodeURIComponent(String(query || '').trim());
    const url = pageNum === 1
      ? `${this.baseUrl}/?s=${q}`
      : `${this.baseUrl}/page/${pageNum}/?s=${q}`;
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

    const html = await getHtml(`${this.baseUrl}/manga/?order=update`, {
      headers: { Referer: `${this.baseUrl}/` },
    });
    const $ = cheerio.load(html);
    const genres = [];
    const seen = new Set();

    // Dari filter form: input[name="genre[]"] + label sibling
    $('input[name="genre[]"]').each((_, el) => {
      const id = $(el).attr('id') || '';
      const val = $(el).val() || '';
      const label = $(`label[for="${id}"]`).text().trim() ||
                    $(el).next('label').text().trim() ||
                    $(el).closest('li').text().trim();
      if (!label) return;
      const slug = label.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      if (seen.has(slug)) return;
      seen.add(slug);
      genres.push({ name: label, slug, id: val });
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
      const match = genres.find((g) => g.slug === key || g.name.toLowerCase() === key || g.id === key);
      if (!match) throw createNotFound(`Genre '${key}' tidak ditemukan di Luvyaa`, 'NOT_FOUND');
      return match;
    });

    // Selalu pakai /manga/?genre[]=ID agar order dan filter lain bisa diterapkan
    const genreParams = found.map((g) => `genre%5B%5D=${g.id}`).join('&');
    const status = options.status ? `&status=${encodeURIComponent(String(options.status).toLowerCase())}` : '';
    const type = options.type ? `&type=${encodeURIComponent(String(options.type).toLowerCase())}` : '';
    const url = `${this.baseUrl}/manga/?${genreParams}&order=${order}${status}${type}&page=${pageNum}`;

    const html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
    return {
      source: this.name,
      genre: found.map((g) => g.name).join(', '),
      page: pageNum,
      maxPage,
      hasNextPage,
      data,
    };
  }

  async getTypes() {
    return ['manga', 'manhwa', 'manhua', 'pornhwa'];
  }

  async getByType(type, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanType = String(type || '').trim().toLowerCase();
    if (!cleanType) throw createBadRequest("Parameter 'type' wajib diisi", 'INVALID_PARAMETER');
    const order = this._resolveOrder(options.order || options.sort || 'update');
    const url = cleanType === 'pornhwa'
      ? `${this.baseUrl}/manga/?genre%5B%5D=50&type=&order=${order}&page=${pageNum}`
      : `${this.baseUrl}/manga/?type=${encodeURIComponent(cleanType)}&order=${order}&page=${pageNum}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, type: cleanType, page: pageNum, maxPage, hasNextPage, data };
  }

  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    const url = `${this.baseUrl}/${cleanSlug}/`;
    let html;
    try {
      html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di Luvyaa`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    const title = $('h1.entry-title').text().trim() || cleanSlug;
    const altTitle = $('span.alternative').text().trim() || null;
    const cover = $('.thumb img, .kh-left img').first().attr('src') || null;

    // Synopsis — join all paragraphs
    const synParts = [];
    $('.entry-content.entry-content-single p').each((_, el) => {
      const t = $(el).text().trim();
      if (t) synParts.push(t);
    });
    const synopsis = synParts.join(' ').trim() || null;

    const status = $('.kh-status .status-text').text().trim().toLowerCase() || null;
    const ratingRaw = $('meta[itemprop="ratingValue"]').attr('content') ||
                      $('.kh-stat-item.rating-score span').first().text().trim();
    const rating = ratingRaw && !isNaN(parseFloat(ratingRaw)) ? parseFloat(ratingRaw) : null;

    // Meta fields — iterate .meta-item
    let type = null, year = null, author = null, artist = null;
    $('.meta-item').each((_, el) => {
      const label = $(el).find('.meta-label').text().trim().toLowerCase();
      const value = $(el).find('.meta-pill').first().text().trim();
      if (!value) return;
      if (label === 'type') type = value.toLowerCase();
      else if (label === 'released') { const m = value.match(/\d{4}/); if (m) year = m[0]; }
      else if (label === 'author') author = value;
      else if (label === 'artist') artist = value;
    });

    // Genres
    const genres = [];
    const seenGenres = new Set();
    $('.meta-tags.mgen a.meta-pill').each((_, el) => {
      const name = $(el).text().trim();
      const href = $(el).attr('href') || '';
      const match = href.match(/\/genres\/([^/]+)\/?$/);
      const genreSlug = match ? match[1] : name.toLowerCase().replace(/\s+/g, '-');
      if (!name || seenGenres.has(genreSlug)) return;
      seenGenres.add(genreSlug);
      genres.push({ name, slug: genreSlug });
    });

    // Chapter list
    const chapters = [];
    $('#chapterlist ul li').each((_, el) => {
      const a = $(el).find('a').first();
      const href = a.attr('href') || '';
      if (!href) return;
      const chTitle = $(el).find('.chapternum').text().trim();
      const date = $(el).find('.chapterdate').text().trim() || null;
      // Extract chapter number from URL: ...chapter-{num}/
      const numMatch = href.match(/chapter-([0-9.]+)\/?$/);
      const chNum = numMatch ? numMatch[1] : null;
      chapters.push({
        title: chTitle || `Chapter ${chNum}`,
        slug: href,
        endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(href)}`,
        date,
      });
    });

    // Related series
    const related = [];
    $('.bixbox.related-series-box .mr-related-card .bsx').each((_, el) => {
      const a = $(el).find('a').first();
      const href = a.attr('href') || '';
      const relSlug = this._slugFromUrl(href);
      if (!relSlug) return;
      const relTitle = a.attr('title') || $(el).find('.tt').text().trim();
      const relCover = $(el).find('img').first().attr('src') || null;
      const typeClass = $(el).find('[class*="type "]').attr('class') || '';
      const typeMatch = typeClass.match(/\btype\s+(\S+)/i);
      const relType = typeMatch ? typeMatch[1].toLowerCase() : null;
      if (relTitle) related.push({ title: relTitle, slug: relSlug, cover: relCover, type: relType });
    });

    return {
      source: this.name,
      title,
      altTitle,
      cover,
      synopsis,
      status,
      type,
      author: author || null,
      artist: artist || null,
      year: year || null,
      rating,
      genres,
      totalChapters: chapters.length,
      chapters,
      related,
    };
  }

  async getPages(slug, chapter, server = 1) {
    const serverIdx = Math.max(0, (parseInt(server, 10) || 1) - 1);
    const rawSlug = String(slug || '').trim();
    if (!rawSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    // slug can be full URL or manga-slug + chapter number
    let chapterUrl;
    if (rawSlug.startsWith('http')) {
      chapterUrl = rawSlug;
    } else {
      const chNum = String(chapter || '').replace(/^chapter-?/i, '');
      chapterUrl = `${this.baseUrl}/${rawSlug}-chapter-${chNum}/`;
    }

    let html;
    try {
      html = await getHtml(chapterUrl, { headers: { Referer: `${this.baseUrl}/` } });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Chapter tidak ditemukan di Luvyaa`, 'NOT_FOUND');
      throw err;
    }

    // Extract ts_reader.run({...}) JSON
    const match = html.match(/ts_reader\.run\s*\(\s*(\{[\s\S]*?\})\s*\)\s*;/);
    if (!match) throw createBadGateway('Gagal menemukan data gambar chapter dari Luvyaa (ts_reader not found)', 'UPSTREAM_ERROR');

    let tsData;
    try {
      tsData = JSON.parse(match[1]);
    } catch (err) {
      throw createBadGateway(`Gagal memproses data gambar chapter dari Luvyaa: ${err.message}`, 'UPSTREAM_ERROR');
    }

    const sources = tsData.sources || [];
    if (sources.length === 0) throw createBadGateway('Tidak ada sumber gambar', 'UPSTREAM_ERROR');

    const pickedServer = sources[Math.min(serverIdx, sources.length - 1)];
    const images = pickedServer?.images || [];
    if (images.length === 0) throw createBadGateway('Tidak ada gambar di server ini', 'UPSTREAM_ERROR');

    const pages = images.map((imgUrl, index) => ({
      page: index + 1,
      url: imgUrl,
      directUrl: imgUrl,
      proxyUrl: `/api/proxy/image?url=${encodeURIComponent(imgUrl)}&referer=${encodeURIComponent(`${this.baseUrl}/`)}`,
    }));

    // Clean title from page <title>
    const $ = cheerio.load(html);
    const pageTitle = $('title').text()
      .replace(/\s*[-–|]\s*Luvyaa.*$/i, '')
      .replace(/\s*[-–|]\s*v5\..*/i, '')
      .trim();

    return {
      source: this.name,
      title: pageTitle,
      totalPages: pages.length,
      pages,
    };
  }
}

module.exports = LuvyaaSource;
