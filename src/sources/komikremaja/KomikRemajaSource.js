const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

class KomikRemajaSource extends BaseSource {
  constructor() {
    super('komikremaja', 'KomikRemaja');
    this.baseUrl = 'https://komikremaja.art';
    this.icon = `https://i2.wp.com/komikremaja.art/wp-content/uploads/2025/09/cropped-1-32x32.png`;

    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  getSupportedSorts() {
    return [
      { id: 'latest',  name: 'Terbaru' },
      { id: 'popular', name: 'Populer' },
      { id: 'newest',  name: 'Diperbarui' },
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
    const m = href.match(/\/komik\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  _resolveOrder(raw) {
    const map = {
      latest: 'update', update: 'update',
      popular: 'popular',
      newest: 'latest',
      az: 'title',
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

      // Type from "typename Manhwa" class
      const typeClass = $(el).find('span[class*="typename"]').attr('class') || '';
      const typeMatch = typeClass.match(/\btypename\s+(\S+)/i);
      const type = typeMatch ? typeMatch[1].toLowerCase() : null;

      const statusRaw = $(el).find('.status').text().trim().toLowerCase();
      const status = statusRaw || null;

      const chText = $(el).find('.epxs').text().trim();
      const chMatch = chText.match(/Chapter\s+([0-9.]+)/i);
      const latestChapter = chMatch ? chMatch[1] : chText || null;

      const ratingRaw = $(el).find('.numscore').text().trim();
      const rating = ratingRaw && !isNaN(parseFloat(ratingRaw))
        ? Math.round(parseFloat(ratingRaw) * 100) / 100 : null;

      items.push({ title, slug, cover, type, status, latestChapter, rating });
    });

    return items;
  }

  async _fetchListing(url, pageNum) {
    const html = await getHtml(url, { headers: this._headers() });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
    return { data, maxPage, hasNextPage };
  }

  _listUrl(pageNum, order, extra = '') {
    const base = pageNum === 1
      ? `${this.baseUrl}/komik/`
      : `${this.baseUrl}/komik/page/${pageNum}/`;
    return `${base}?order=${order}${extra}`;
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

  async getNewest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, maxPage, hasNextPage } = await this._fetchListing(this._listUrl(pageNum, 'latest'), pageNum);
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
    const html = await getHtml(`${this.baseUrl}/komik/?order=update`, { headers: this._headers() });
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
      if (!match) throw createNotFound(`Genre '${key}' tidak ditemukan di KomikRemaja`, 'NOT_FOUND');
      return match;
    });
    const genreParams = found.map((g) => `genre%5B%5D=${g.id}`).join('&');
    const base = pageNum === 1
      ? `${this.baseUrl}/komik/`
      : `${this.baseUrl}/komik/page/${pageNum}/`;
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

    const url = `${this.baseUrl}/komik/${cleanSlug}/`;
    let html;
    try {
      html = await getHtml(url, { headers: this._headers() });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di KomikRemaja`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    const title = $('h1.entry-title, h1').first().text().trim() || cleanSlug;

    // Alt title from infotable "Alternative" row
    let altTitle = null;
    // Also check .seriestualt
    const altEl = $('.seriestualt').text().trim();
    if (altEl) altTitle = altEl;

    const cover = $('.thumb img, .thumbook img').first().attr('src') || null;

    const synopsis = $('div.entry-content.entry-content-single p').first().text().trim() ||
                     $('[itemprop="description"] p').first().text().trim() || null;

    // Metadata from infotable
    let status = null, type = null, author = null;
    $('.infotable tr').each((_, el) => {
      const tds = $(el).find('td');
      if (tds.length < 2) return;
      const key = $(tds[0]).text().trim().toLowerCase();
      const val = $(tds[1]).text().trim();
      if (!val || val === '-') return;
      if (key === 'alternative' && !altTitle) altTitle = val;
      else if (key === 'status') {
        const v = val.toLowerCase();
        if (v.includes('ongoing') || v.includes('berjalan')) status = 'ongoing';
        else if (v.includes('completed') || v.includes('tamat')) status = 'completed';
        else if (v.includes('hiatus')) status = 'hiatus';
        else status = v;
      } else if (key === 'type' || key === 'tipe') {
        type = val.toLowerCase();
      } else if (key === 'author' || key === 'penulis') {
        author = val;
      }
    });

    const ratingRaw = $('[itemprop="ratingValue"]').attr('content') ||
                      $('[itemprop="ratingValue"]').text().trim() ||
                      $('.num').text().trim();
    const rating = ratingRaw && !isNaN(parseFloat(ratingRaw))
      ? Math.round(parseFloat(ratingRaw) * 100) / 100 : null;

    // Genres
    const genres = [];
    const seenG = new Set();
    $('.mgen a, .seriestugenre a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/\/genres?\/([^/?#]+)/);
      const name = $(el).text().trim();
      if (!name || seenG.has(name)) return;
      seenG.add(name);
      genres.push({ name, slug: m ? m[1] : name.toLowerCase().replace(/\s+/g, '-') });
    });

    // Chapters
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

    // Related from .bixbox "Related Series"
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
        const relTypeClass = $(card).find('span[class*="typename"]').attr('class') || '';
        const relTypeMatch = relTypeClass.match(/\btypename\s+(\S+)/i);
        related.push({
          title: relTitle,
          slug: relSlug,
          cover: $(card).find('img').first().attr('src') || null,
          type: relTypeMatch ? relTypeMatch[1].toLowerCase() : null,
          rating: (() => {
            const r = $(card).find('.numscore').text().trim();
            return r && !isNaN(parseFloat(r)) ? Math.round(parseFloat(r) * 100) / 100 : null;
          })(),
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
      if (err.statusCode === 404) throw createNotFound('Chapter tidak ditemukan di KomikRemaja', 'NOT_FOUND');
      throw err;
    }

    const match = html.match(/ts_reader\.run\s*\(\s*(\{[\s\S]*?"sources"\s*:[\s\S]*?\][\s\S]*?\})\s*\)/);
    if (!match) throw createBadGateway('Gagal menemukan data gambar chapter dari KomikRemaja', 'UPSTREAM_ERROR');

    let tsData;
    try {
      // ts_reader may contain JS literals (!0/!1) — convert to valid JSON
      const cleaned = match[1]
        .replace(/!0/g, 'true')
        .replace(/!1/g, 'false');
      tsData = JSON.parse(cleaned);
    } catch (err) {
      throw createBadGateway(`Gagal memproses data gambar: ${err.message}`, 'UPSTREAM_ERROR');
    }

    const images = tsData.sources?.[0]?.images || [];
    if (!images.length) throw createBadGateway('Tidak ada gambar untuk chapter ini', 'UPSTREAM_ERROR');

    const $ = cheerio.load(html);
    const pageTitle = $('title').text()
      .replace(/\s*[-–|]\s*KomikRemaja.*$/i, '')
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

module.exports = KomikRemajaSource;
