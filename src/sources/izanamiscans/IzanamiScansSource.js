const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

class IzanamiScansSource extends BaseSource {
  constructor() {
    super('izanamiscans', 'IzanamiScans');
    this.baseUrl = 'https://izanamiscans.my.id';
    this.icon = `${this.baseUrl}/favicon.ico`;

    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  getSupportedSorts() {
    return [
      { id: 'latest',  name: 'Terbaru Update' },
      { id: 'popular', name: 'Populer' },
      { id: 'newest',  name: 'Terbaru Ditambahkan' },
      { id: 'az',      name: 'A-Z' },
    ];
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  _slugFromUrl(href) {
    if (!href) return null;
    const m = href.match(/\/manga\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  _resolveOrder(raw) {
    const map = {
      latest: 'update', update: 'update',
      popular: 'popular',
      newest: 'latest',
      az: 'title',
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

      // Type from span with class like "type Manhwa"
      const typeEl = $(el).find('span[class*="type"]').first();
      const type = typeEl.text().trim().toLowerCase() || null;

      // Status
      const statusRaw = $(el).find('.status').text().trim().toLowerCase();
      const status = statusRaw || null;

      // Latest chapter
      const chText = $(el).find('.epxs').text().trim();
      const chMatch = chText.match(/Chapter\s+([0-9.]+)/i);
      const latestChapter = chMatch ? chMatch[1] : chText || null;

      // Rating
      const ratingRaw = $(el).find('.numscore').text().trim();
      const rating = ratingRaw && !isNaN(parseFloat(ratingRaw))
        ? Math.round(parseFloat(ratingRaw) * 100) / 100
        : null;

      items.push({ title, slug, cover, type, status, latestChapter, rating });
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

  // ─── Endpoints ───────────────────────────────────────────────────────────────

  async getLatest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = pageNum === 1
      ? `${this.baseUrl}/manga/?order=update`
      : `${this.baseUrl}/manga/page/${pageNum}/?order=update`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getPopular(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = pageNum === 1
      ? `${this.baseUrl}/manga/?order=popular`
      : `${this.baseUrl}/manga/page/${pageNum}/?order=popular`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getNewest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = pageNum === 1
      ? `${this.baseUrl}/manga/?order=latest`
      : `${this.baseUrl}/manga/page/${pageNum}/?order=latest`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getAz(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = pageNum === 1
      ? `${this.baseUrl}/manga/?order=title`
      : `${this.baseUrl}/manga/page/${pageNum}/?order=title`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getList(page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const order = this._resolveOrder(options.order || options.sort || 'update');
    const params = new URLSearchParams({ order });
    if (options.status) params.set('status', String(options.status).toLowerCase());
    if (options.type) params.set('type', String(options.type).toLowerCase());
    const base = pageNum === 1
      ? `${this.baseUrl}/manga/`
      : `${this.baseUrl}/manga/page/${pageNum}/`;
    const url = `${base}?${params.toString()}`;
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

    $('input[name="genre[]"]').each((_, el) => {
      const id = $(el).attr('id') || '';
      const numId = $(el).val()?.trim();
      if (!numId || seen.has(numId)) return;
      seen.add(numId);
      // Label text may be duplicated (e.g. "ActionAction") — dedupe by taking first half
      const rawLabel = $(`label[for="${id}"]`).text().trim() ||
                       $(el).next('label').text().trim() ||
                       $(el).closest('li').text().trim();
      const half = rawLabel.length % 2 === 0
        ? rawLabel.slice(0, rawLabel.length / 2)
        : rawLabel;
      // Verify it's truly doubled
      const label = rawLabel === half + half ? half : rawLabel;
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
      const match = allGenres.find(
        (g) => g.slug === key || g.name.toLowerCase() === key || g.id === key
      );
      if (!match) throw createNotFound(`Genre '${key}' tidak ditemukan di IzanamiScans`, 'NOT_FOUND');
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
    const base = pageNum === 1
      ? `${this.baseUrl}/manga/`
      : `${this.baseUrl}/manga/page/${pageNum}/`;
    const url = `${base}?type=${encodeURIComponent(cleanType)}&order=${order}`;
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
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di IzanamiScans`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    const title = $('h1.entry-title, h1').first().text().trim() || cleanSlug;
    // Alt title: .wd-full containing "Judul Alternatif"
    let altTitle = null;
    $('.wd-full').each((_, el) => {
      if ($(el).find('b').text().trim().toLowerCase().includes('alternatif')) {
        altTitle = $(el).find('span').text().trim() || null;
        return false;
      }
    });
    const cover = $('.thumb img, .thumbook img').first().attr('src') || null;

    // Synopsis
    const synopsis = $('div.entry-content.entry-content-single p').first().text().trim() ||
                     $('[itemprop="description"] p').first().text().trim() || null;

    // Status & type from .imptdt
    let status = null, type = null;
    $('.imptdt').each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      const lower = text.toLowerCase();
      if (lower.startsWith('status')) {
        const val = text.replace(/^status\s*/i, '').trim().toLowerCase();
        if (val.includes('ongoing') || val.includes('berjalan')) status = 'ongoing';
        else if (val.includes('completed') || val.includes('tamat')) status = 'completed';
        else if (val.includes('hiatus')) status = 'hiatus';
        else status = val;
      } else if (lower.startsWith('tipe') || lower.startsWith('type')) {
        type = text.replace(/^(tipe|type)\s*/i, '').trim().toLowerCase();
      }
    });

    // Author, year from .fmed
    let author = null, year = null;
    const fmedItems = [];
    $('.fmed b, .fmed span').each((_, el) => {
      fmedItems.push($(el).text().trim());
    });
    for (let i = 0; i < fmedItems.length - 1; i++) {
      const key = fmedItems[i].toLowerCase();
      const val = fmedItems[i + 1];
      if ((key.includes('penulis') || key.includes('author')) && val && !['dirilis','artist','serialisasi','diposting'].some(k => val.toLowerCase().includes(k))) {
        author = val; i++;
      } else if (key.includes('dirilis') || key.includes('released')) {
        const m = val.match(/\d{4}/);
        if (m) { year = m[0]; i++; }
      }
    }

    // Rating
    const ratingRaw = $('[itemprop="ratingValue"]').attr('content') ||
                      $('[itemprop="ratingValue"]').text().trim() ||
                      $('.num').text().trim();
    const rating = ratingRaw && !isNaN(parseFloat(ratingRaw))
      ? Math.round(parseFloat(ratingRaw) * 100) / 100
      : null;

    // Genres
    const genres = [];
    const seenG = new Set();
    $('.mgen a, .seriestugenre a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/\/genres?\/([^/?#]+)/);
      const genreSlug = m ? m[1] : null;
      const name = $(el).text().trim();
      if (!name || seenG.has(name)) return;
      seenG.add(name);
      genres.push({ name, slug: genreSlug || name.toLowerCase().replace(/\s+/g, '-') });
    });

    // Chapters
    const chapters = [];
    $('#chapterlist ul li, .eplister li').each((_, el) => {
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

    // Related
    const related = [];
    const seenR = new Set();
    $('.bixbox').each((_, box) => {
      const heading = $(box).find('h2, h3').text().toLowerCase();
      if (!heading.includes('terkait') && !heading.includes('related') && !heading.includes('rekomendasi') && !heading.includes('baca')) return;
      $(box).find('.bsx').each((__, card) => {
        const ca = $(card).find('a').first();
        const chref = ca.attr('href') || '';
        const relSlug = this._slugFromUrl(chref);
        const relTitle = ca.attr('title') || $(card).find('.tt').text().trim();
        if (!relSlug || !relTitle || seenR.has(relSlug)) return;
        seenR.add(relSlug);
        related.push({
          title: relTitle,
          slug: relSlug,
          cover: $(card).find('img').first().attr('src') || null,
        });
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
      author: author || null,
      year: year || null,
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
      // Try to find chapter URL from detail page
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
      html = await getHtml(chapterUrl, { headers: { Referer: `${this.baseUrl}/` } });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound('Chapter tidak ditemukan di IzanamiScans', 'NOT_FOUND');
      throw err;
    }

    const match = html.match(/ts_reader\.run\s*\(\s*(\{[\s\S]*?\})\s*\)\s*;/);
    if (!match) throw createBadGateway('Gagal menemukan data gambar chapter dari IzanamiScans', 'UPSTREAM_ERROR');

    let tsData;
    try { tsData = JSON.parse(match[1]); } catch (err) {
      throw createBadGateway(`Gagal memproses data gambar dari IzanamiScans: ${err.message}`, 'UPSTREAM_ERROR');
    }

    const images = tsData.sources?.[0]?.images || [];
    if (!images.length) throw createBadGateway('Tidak ada gambar untuk chapter ini', 'UPSTREAM_ERROR');

    const $ = cheerio.load(html);
    const pageTitle = $('title').text()
      .replace(/\s*Bahasa Indonesia\s*/gi, '')
      .replace(/\s*[-–|]\s*Izanami\s*Scans.*$/i, '')
      .replace(/^(Komik|Baca)\s+/i, '')
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

module.exports = IzanamiScansSource;
