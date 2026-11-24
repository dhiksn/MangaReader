const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');
const { formatPagination } = require('../../utils/responseHelper');

class DojingSource extends BaseSource {
  constructor() {
    super('dojing', 'Dojing');
    this.baseUrl = 'https://dojing.net';
    this.icon = `${this.baseUrl}/favicon.ico`;

    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  getSupportedSorts() {
    return [
      { id: 'latest',  name: 'Terbaru' },
      { id: 'popular', name: 'Populer' },
      { id: 'az',      name: 'A-Z' },
      { id: 'za',      name: 'Z-A' },
    ];
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  _headers() {
    return { Referer: `${this.baseUrl}/` };
  }

  _slugFromUrl(href) {
    if (!href) return null;
    const m = href.match(/\/manga\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  _resolveOrder(raw) {
    const map = {
      update:  'update',
      popular: 'popular',
      az:      'title',
      title:   'title',
      za:      'titlereverse',
      titlereverse: 'titlereverse',
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
    if (hasNextPage && maxPage <= currentPage) maxPage = currentPage + 1;
    return { maxPage, hasNextPage };
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

      const cover = $(el).find('img').first().attr('src') || null;

      const statusRaw = $(el).find('.status').text().trim().toLowerCase();
      const status = statusRaw || null;

      const chText = $(el).find('.epxs').text().trim();
      const chMatch = chText.match(/Chapter\s+([0-9.]+)/i);
      const latestChapter = chMatch ? chMatch[1] : chText || null;

      const ratingRaw = $(el).find('.numscore').text().trim();
      const rating = ratingRaw && !isNaN(parseFloat(ratingRaw))
        ? Math.round(parseFloat(ratingRaw) * 100) / 100 : null;

      items.push({ title, slug, cover, status, latestChapter, rating });
    });

    return items;
  }

  _listUrl(pageNum, order, extra = '') {
    const base = pageNum === 1
      ? `${this.baseUrl}/manga/`
      : `${this.baseUrl}/manga/page/${pageNum}/`;
    return `${base}?order=${order}${extra}`;
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
    const { data, maxPage, hasNextPage } = await this._fetchListing(this._listUrl(pageNum, 'update'), pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getPopular(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, maxPage, hasNextPage } = await this._fetchListing(this._listUrl(pageNum, 'popular'), pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getAz(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, maxPage, hasNextPage } = await this._fetchListing(this._listUrl(pageNum, 'title'), pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getZa(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, maxPage, hasNextPage } = await this._fetchListing(this._listUrl(pageNum, 'titlereverse'), pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const order = this._resolveOrder(options.order || options.sort || 'update');
    let extra = '';
    if (options.status) extra += `&status=${encodeURIComponent(options.status)}`;
    if (options.type) extra += `&type=${encodeURIComponent(options.type)}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(this._listUrl(pageNum, order, extra), pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async search(query, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const q = encodeURIComponent(String(query || '').trim());
    const url = pageNum === 1
      ? `${this.baseUrl}/?s=${q}`
      : `${this.baseUrl}/page/${pageNum}/?s=${q}`;
    const html = await getHtml(url, { headers: this._headers() });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
    return { source: this.name, query: String(query || '').trim(), page: pageNum, maxPage, hasNextPage, data };
  }

  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) return this._cachedGenres;

    const html = await getHtml(`${this.baseUrl}/manga/?order=update`, { headers: this._headers() });
    const $ = cheerio.load(html);
    const genres = [];
    const seen = new Set();

    $('input[name="genre[]"]').each((_, el) => {
      const id = $(el).attr('id') || '';
      const numId = $(el).val()?.trim();
      if (!numId || seen.has(numId)) return;
      seen.add(numId);
      const rawLabel = $(`label[for="${id}"]`).text().trim() ||
                       $(el).next('label').text().trim() ||
                       $(el).closest('li').text().trim();
      // Dedupe doubled labels e.g. "ActionAction"
      const half = Math.floor(rawLabel.length / 2);
      const label = rawLabel.slice(0, half) === rawLabel.slice(half) ? rawLabel.slice(0, half) : rawLabel;
      if (!label) return;
      const slug = label.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      genres.push({ name: label, slug, id: numId });
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
    const allGenres = await this.getGenres();
    const keys = cleanGenre.split(',').map((g) => g.trim()).filter(Boolean);
    const found = keys.map((key) => {
      const match = allGenres.find((g) => g.slug === key || g.name.toLowerCase() === key || g.id === key);
      if (!match) throw createNotFound(`Genre '${key}' tidak ditemukan di Dojing`, 'NOT_FOUND');
      return match;
    });

    const genreParams = found.map((g) => `genre%5B%5D=${g.id}`).join('&');
    const base = pageNum === 1
      ? `${this.baseUrl}/manga/`
      : `${this.baseUrl}/manga/page/${pageNum}/`;
    const url = `${base}?${genreParams}&order=${order}`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, genre: found.map((g) => g.name).join(', '), page: pageNum, maxPage, hasNextPage, data };
  }

  async getTypes() {
    return ['manga', 'manhwa', 'manhua'];
  }

  async getByType(type, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanType = String(type || '').trim().toLowerCase();
    if (!cleanType) throw createBadRequest("Parameter 'type' wajib diisi", 'INVALID_PARAMETER');
    const order = this._resolveOrder(options.order || options.sort || 'update');
    const url = this._listUrl(pageNum, order, `&type=${encodeURIComponent(cleanType)}`);
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, type: cleanType, page: pageNum, maxPage, hasNextPage, data };
  }

  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    const url = `${this.baseUrl}/manga/${cleanSlug}/`;
    let html;
    try {
      html = await getHtml(url, { headers: this._headers() });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di Dojing`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    const title = $('h1.entry-title, h1').first().text().trim() || cleanSlug;

    let altTitle = null;
    const altEl = $('.seriestualt').text().trim();
    if (altEl) altTitle = altEl;

    const cover = $('.thumb img, .thumbook img').first().attr('src') || null;

    const synopsis = $('div.entry-content.entry-content-single p').first().text().trim() ||
                     $('[itemprop="description"] p').first().text().trim() || null;

    let status = null, type = null, author = null;
    // dojing.net uses .tsinfo .imptdt with format: "Label <i>Value</i>" or "Label <a>Value</a>"
    $('.tsinfo .imptdt').each((_, el) => {
      const fullText = $(el).text().trim();
      const key = fullText.split(/\s+/)[0].toLowerCase();
      const val = $(el).find('i, a, span[itemprop="name"]').first().text().trim();
      if (!val) return;
      if (key === 'status') {
        const v = val.toLowerCase();
        if (v.includes('ongoing') || v.includes('berjalan')) status = 'ongoing';
        else if (v.includes('completed') || v.includes('tamat')) status = 'completed';
        else if (v.includes('hiatus')) status = 'hiatus';
        else status = v;
      } else if (key === 'type') {
        type = val.toLowerCase();
      } else if (key === 'posted') {
        // "Posted By <author>" — only grab author
        const byIdx = fullText.toLowerCase().indexOf('by');
        if (byIdx !== -1) {
          const potentialAuthor = $(el).find('[itemprop="name"], i').first().text().trim();
          if (potentialAuthor && potentialAuthor.toLowerCase() !== 'dojing') {
            author = potentialAuthor;
          }
        }
      }
    });

    const ratingRaw = $('[itemprop="ratingValue"]').attr('content') ||
                      $('[itemprop="ratingValue"]').text().trim() ||
                      $('.num').text().trim();
    const rating = ratingRaw && !isNaN(parseFloat(ratingRaw))
      ? Math.round(parseFloat(ratingRaw) * 100) / 100 : null;

    const genres = [];
    const seenG = new Set();
    $('.mgen a, .seriestugenre a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/\/genre\/([^/?#]+)/);
      const name = $(el).text().trim();
      if (!name || seenG.has(name)) return;
      seenG.add(name);
      genres.push({ name, slug: m ? m[1] : name.toLowerCase().replace(/\s+/g, '-') });
    });

    const chapters = [];
    $('#chapterlist li, .eplister li').each((_, el) => {
      const a = $(el).find('.eph-num a, a').first();
      const href = a.attr('href') || '';
      if (!href) return;
      const chTitle = $(el).find('.chapternum').text().trim() || a.text().trim();
      const date = $(el).find('.chapterdate').text().trim() || null;
      chapters.push({
        title: chTitle,
        slug: href,
        endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(href)}`,
        date,
      });
    });

    const related = [];
    const seenR = new Set();
    $('.bixbox').each((_, box) => {
      const heading = $(box).find('h2, h3').text().toLowerCase();
      if (!heading.includes('related') && !heading.includes('terkait')) return;
      $(box).find('.bsx').each((__, card) => {
        const ca = $(card).find('a').first();
        const chref = ca.attr('href') || '';
        const relSlug = this._slugFromUrl(chref);
        const relTitle = ca.attr('title') || $(card).find('.tt').text().trim();
        if (!relSlug || !relTitle || seenR.has(relSlug)) return;
        seenR.add(relSlug);
        const relR = $(card).find('.numscore').text().trim();
        related.push({
          title: relTitle,
          slug: relSlug,
          cover: $(card).find('img').first().attr('src') || null,
          rating: relR && !isNaN(parseFloat(relR)) ? Math.round(parseFloat(relR) * 100) / 100 : null,
        });
      });
    });

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
      related,
    };
  }

  async getPages(slug, chapter) {
    const rawSlug = String(slug || '').trim();
    if (!rawSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    // Chapter URL can be a full URL (from slug field in chapters list) or slug+chapter number
    let chapterUrl;
    if (rawSlug.startsWith('http')) {
      chapterUrl = rawSlug;
    } else {
      const chNum = String(chapter || '').replace(/^chapter-?/i, '').trim();
      if (!chNum) throw createBadRequest("Parameter 'chapter' wajib diisi", 'INVALID_PARAMETER');
      // dojing.net chapter URL pattern: /{slug}-chapter-{num}/
      chapterUrl = `${this.baseUrl}/${rawSlug}-chapter-${chNum}/`;
    }

    let html;
    try {
      html = await getHtml(chapterUrl, { headers: this._headers() });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound('Chapter tidak ditemukan di Dojing', 'NOT_FOUND');
      throw err;
    }

    const match = html.match(/ts_reader\.run\s*\(\s*(\{[\s\S]*?"sources"\s*:[\s\S]*?\][\s\S]*?\})\s*\)/);
    if (!match) throw createBadGateway('Gagal menemukan data gambar chapter dari Dojing', 'UPSTREAM_ERROR');

    let tsData;
    try {
      const cleaned = match[1].replace(/!0/g, 'true').replace(/!1/g, 'false');
      tsData = JSON.parse(cleaned);
    } catch (err) {
      throw createBadGateway(`Gagal memproses data gambar: ${err.message}`, 'UPSTREAM_ERROR');
    }

    const images = tsData.sources?.[0]?.images || [];
    if (!images.length) throw createBadGateway('Tidak ada gambar untuk chapter ini di Dojing', 'UPSTREAM_ERROR');

    const $ = cheerio.load(html);
    const pageTitle = $('title').text()
      .replace(/\s*[-–|]\s*Dojing.*$/i, '')
      .replace(/^(Baca|Read)\s+/i, '')
      .trim();

    return {
      source: this.name,
      title: pageTitle,
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

module.exports = DojingSource;
