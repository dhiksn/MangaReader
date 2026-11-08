const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

class MihentaiSource extends BaseSource {
  constructor() {
    super('mihentai', 'MiHentai');
    this.baseUrl = 'https://mihentai.net';
    this.icon = `https://i0.wp.com/mihentai.net/wp-content/uploads/2024/08/Komik-Hentai.png`;

    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  getSupportedSorts() {
    return [
      { id: 'latest', name: 'Terbaru' },
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
      update: 'update',
      latest_update: 'update',
      latest: 'latest',
      newest: 'latest',
      popular: 'popular',
      title: 'title',
      az: 'title',
      titlereverse: 'titlereverse',
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

    $('.bsx').each((_, el) => {
      const a = $(el).find('a').first();
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
      const ratingRaw = $(el).find('.numscore').text().trim();
      const rating = ratingRaw && !isNaN(parseFloat(ratingRaw)) ? parseFloat(ratingRaw) : null;

      items.push({ title: title.trim(), slug, cover, latestChapter, rating });
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
    if (options.type) params.set('type', String(options.type).toLowerCase());
    if (options.genre) {
      const genres = await this.getGenres();
      const keys = String(options.genre).split(',').map((g) => g.trim().toLowerCase()).filter(Boolean);
      for (const key of keys) {
        const match = genres.find((g) => g.slug === key || g.name.toLowerCase() === key || g.id === key);
        if (match) {
          params.append('genre[]', match.id);
        }
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

    // Genre filter checkboxes
    $('input[name="genre[]"]').each((_, el) => {
      const id = $(el).attr('id') || '';
      const numId = $(el).val()?.trim();
      if (!numId || seen.has(numId)) return;
      seen.add(numId);
      const label = $(`label[for="${id}"]`).text().trim() ||
                    $(el).next('label').text().trim() ||
                    $(el).closest('li').text().trim();
      if (!label) return;
      const slug = label.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      genres.push({ name: label, slug, id: numId });
    });

    // Fallback: genre links from sidebar
    if (genres.length === 0) {
      $('a[href*="/genres/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const match = href.match(/\/genres\/([^/]+)\/?$/);
        if (!match) return;
        const slug = match[1];
        if (seen.has(slug)) return;
        seen.add(slug);
        const name = $(el).text().trim();
        if (name) genres.push({ name, slug });
      });
    }

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
      if (!match) throw createNotFound(`Genre '${key}' tidak ditemukan di MiHentai`, 'NOT_FOUND');
      return match;
    });

    const genreParams = found.map((g) => `genre%5B%5D=${g.id}`).join('&');
    const url = `${this.baseUrl}/manga/?${genreParams}&order=${order}&page=${pageNum}`;
    const html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
    return { source: this.name, genre: found.map((g) => g.name).join(', '), page: pageNum, maxPage, hasNextPage, data };
  }

  async getTypes() {
    return ['manga', 'manhwa'];
  }

  async getByType(type, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanType = String(type || '').trim().toLowerCase();
    if (!cleanType) throw createBadRequest("Parameter 'type' wajib diisi", 'INVALID_PARAMETER');
    const order = this._resolveOrder(options.order || options.sort || 'update');
    const url = `${this.baseUrl}/manga/?type=${encodeURIComponent(cleanType)}&order=${order}&page=${pageNum}`;
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
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di MiHentai`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    const title = $('h1.entry-title, h1').first().text().trim() || cleanSlug;

    const cover = $('div.thumb img, .postbody img').first().attr('src') || null;

    // Synopsis
    const synopsis = $('div.entry-content.entry-content-single p').first().text().trim() ||
                     $('div.entry-content.entry-content-single').text().trim() || null;

    // Status & Type from .imptdt or table.infotable
    let status = null, type = null, author = null;
    $('.imptdt').each((_, el) => {
      const text = $(el).text().trim();
      if (/^status/i.test(text)) status = $(el).find('i, a').text().trim().toLowerCase() || text.replace(/^status\s*/i,'').trim().toLowerCase();
      else if (/^type/i.test(text)) type = $(el).find('a').text().trim().toLowerCase() || null;
    });
    $('table.infotable tr').each((_, el) => {
      const label = $(el).find('td').first().text().trim().toLowerCase();
      const value = $(el).find('td').last().text().trim();
      if (label === 'status') status = value.toLowerCase();
      else if (label === 'type') type = value.toLowerCase();
      else if (label === 'author') author = value;
    });

    // Genres only from .mgen a[rel="tag"] (post-specific, not sidebar)
    const genres = [];
    const seenGenres = new Set();
    $('.mgen a[rel="tag"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const match = href.match(/\/genres\/([^/]+)\/?$/);
      const genreSlug = match ? match[1] : null;
      const name = $(el).text().trim();
      if (!name || !genreSlug || seenGenres.has(genreSlug)) return;
      seenGenres.add(genreSlug);
      genres.push({ name, slug: genreSlug });
    });

    // Rating
    const ratingRaw = $('div.rating .num[itemprop="ratingValue"]').attr('content') ||
                      $('div.rating .num[itemprop="ratingValue"]').text().trim();
    const rating = ratingRaw && !isNaN(parseFloat(ratingRaw)) ? parseFloat(ratingRaw) : null;

    // Chapter list — single chapter at root URL (like PixHentai)
    const chapters = [];
    $('#chapterlist ul li, .eplister li').each((_, el) => {
      const a = $(el).find('.eph-num a, a').first();
      const href = a.attr('href') || '';
      if (!href) return;
      const chTitle = $(el).find('.chapternum').text().trim() || a.text().trim().split('\n')[0].trim();
      const date = $(el).find('.chapterdate').text().trim() || null;
      const numMatch = href.match(/chapter-([0-9.]+)/i);
      chapters.push({
        title: chTitle,
        slug: href,
        endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(href)}`,
        date,
      });
    });

    // Related from .bixbox with "Related Series" heading
    const related = [];
    $('.bixbox').each((_, el) => {
      const heading = $(el).find('h2, h3').first().text().trim().toLowerCase();
      if (!heading.includes('related')) return;
      $(el).find('.bsx').each((__, card) => {
        const a = $(card).find('a').first();
        const href = a.attr('href') || '';
        const relSlug = this._slugFromUrl(href);
        const relTitle = a.attr('title') || $(card).find('.tt').text().trim();
        if (!relSlug || !relTitle) return;
        const rawCover = $(card).find('img').first().attr('src') || '';
        const relCover = rawCover.replace(/-\d+x\d+(\.[a-zA-Z0-9]+)$/, '$1') || null;
        related.push({ title: relTitle, slug: relSlug, cover: relCover });
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
      rating,
      genres,
      totalChapters: chapters.length,
      chapters,
      similar: related,
      related,
    };
  }

  async getPages(slug, chapter) {
    const rawSlug = String(slug || '').trim();
    if (!rawSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    let chapterUrl;
    if (rawSlug.startsWith('http')) {
      // Full URL from chapter list
      chapterUrl = rawSlug;
    } else {
      const chNum = String(chapter || '').replace(/^chapter-?/i, '').trim();
      if (chNum && chNum !== '1') {
        // Multi-chapter: /{slug}-chapter-{num}/
        chapterUrl = `${this.baseUrl}/${rawSlug}-chapter-${chNum}/`;
      } else {
        // Single chapter or chapter 1: resolve from detail page
        try {
          const details = await this.getDetails(rawSlug);
          chapterUrl = details.chapters[0]?.slug || `${this.baseUrl}/${rawSlug}/`;
        } catch {
          chapterUrl = `${this.baseUrl}/${rawSlug}/`;
        }
      }
    }

    let html;
    try {
      html = await getHtml(chapterUrl, { headers: { Referer: `${this.baseUrl}/` } });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Chapter tidak ditemukan di MiHentai`, 'NOT_FOUND');
      throw err;
    }

    const match = html.match(/ts_reader\.run\s*\(\s*(\{[\s\S]*?\})\s*\)\s*;/);
    if (!match) throw createBadGateway('Gagal menemukan data gambar chapter dari MiHentai', 'UPSTREAM_ERROR');

    let tsData;
    try {
      tsData = JSON.parse(match[1]);
    } catch (err) {
      throw createBadGateway(`Gagal memproses data gambar dari MiHentai: ${err.message}`, 'UPSTREAM_ERROR');
    }

    const images = tsData.sources?.[0]?.images || [];
    if (!images.length) throw createBadGateway('Tidak ada gambar untuk chapter ini', 'UPSTREAM_ERROR');

    const pages = images.map((imgUrl, index) => ({
      page: index + 1,
      url: imgUrl,
      directUrl: imgUrl,
      proxyUrl: `/api/proxy/image?url=${encodeURIComponent(imgUrl)}&referer=${encodeURIComponent(`${this.baseUrl}/`)}`,
    }));

    const $ = cheerio.load(html);
    const pageTitle = $('title').text().replace(/\s*[-–|]\s*MiHentai.*$/i, '').trim();

    return {
      source: this.name,
      title: pageTitle,
      totalPages: pages.length,
      pages,
    };
  }
}

module.exports = MihentaiSource;
