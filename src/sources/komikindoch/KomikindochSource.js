const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

class KomikindochSource extends BaseSource {
  constructor() {
    super('komikindoch', 'KomikIndo');
    this.baseUrl = 'https://komikindo.ch';
    this.icon = `${this.baseUrl}/favicon.ico`;

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

  _slugFromKomikUrl(href) {
    if (!href) return null;
    const match = href.match(/\/komik\/([^/]+)\/?$/);
    return match ? match[1] : null;
  }

  _resolveOrder(raw) {
    const map = {
      latest: 'update', update: 'update',
      newest: 'latest',
      popular: 'popular',
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
    return { maxPage: maxPage > currentPage ? maxPage : null, hasNextPage };
  }

  _parseCardList($) {
    const items = [];
    const seen = new Set();

    $('.animepost').each((_, el) => {
      const a = $(el).find('a').first();
      const href = a.attr('href') || '';
      const slug = this._slugFromKomikUrl(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const title = $(el).find('.animposx .tt h4, .bigors .tt h4, .tt h4').first().text().trim() ||
                    a.attr('title')?.replace(/^Komik\s*/i, '').trim() || '';
      if (!title) return;

      const cover = $(el).find('img').first().attr('src') || null;

      // Type from span.typeflag class e.g. "typeflag Manhwa"
      const typeFlagClass = $(el).find('span[class*="typeflag"]').attr('class') || '';
      const typeMatch = typeFlagClass.match(/typeflag\s+(\S+)/i);
      const type = typeMatch ? typeMatch[1].toLowerCase() : null;

      // Status from span.status
      const statusRaw = $(el).find('.status').text().trim().toLowerCase();
      const status = statusRaw || null;

      // Latest chapter
      const chText = $(el).find('.epxs').text().trim();
      const chMatch = chText.match(/Chapter\s+([0-9.]+)/i);
      const latestChapter = chMatch ? chMatch[1] : chText || null;

      // Rating from .rating i
      const ratingRaw = $(el).find('.rating i').text().trim();
      const rating = ratingRaw && !isNaN(parseFloat(ratingRaw)) ? parseFloat(ratingRaw) : null;

      items.push({ title: title.trim(), slug, cover, type, status, latestChapter, rating });
    });

    return items;
  }

  _buildListUrl(order, pageNum, extra = '') {
    const base = `${this.baseUrl}/daftar-manga/`;
    const pagePart = pageNum > 1 ? `page/${pageNum}/` : '';
    // Extra params come before the order, base always has status/type/format/title empty
    return `${base}${pagePart}?${extra ? extra + '&' : ''}status=&type=&format=&order=${order}&title=`;
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
    const base = `${this.baseUrl}/daftar-manga/`;
    const pagePart = pageNum > 1 ? `page/${pageNum}/` : '';

    // Build params explicitly
    const params = new URLSearchParams();
    if (options.status) params.set('status', String(options.status));
    if (options.type) params.set('type', String(options.type));
    if (options.format) params.set('format', String(options.format));
    params.set('order', order);
    if (options.q || options.title) params.set('title', options.q || options.title || '');
    else params.set('title', '');

    // tema/demografis arrays
    if (options.tema) {
      const temas = Array.isArray(options.tema) ? options.tema : String(options.tema).split(',').map(t => t.trim());
      temas.filter(Boolean).forEach(t => params.append('tema[]', t));
    }
    if (options.demografis) {
      const demogs = Array.isArray(options.demografis) ? options.demografis : String(options.demografis).split(',').map(d => d.trim());
      demogs.filter(Boolean).forEach(d => params.append('demografis[]', d));
    }
    if (options.genre) {
      const genres = Array.isArray(options.genre) ? options.genre : String(options.genre).split(',').map(g => g.trim());
      genres.filter(Boolean).forEach(g => params.append('genre[]', g));
    }

    const url = `${base}${pagePart}?${params.toString()}`;
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

  async _fetchFilterOptions() {
    const html = await getHtml(`${this.baseUrl}/daftar-manga/?order=update`, {
      headers: { Referer: `${this.baseUrl}/` },
    });
    const $ = cheerio.load(html);
    return $;
  }

  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) {
      return this._cachedGenres;
    }
    const $ = await this._fetchFilterOptions();
    const genres = [];
    const seen = new Set();

    $('input[name="genre[]"]').each((_, el) => {
      const slug = $(el).val()?.trim();
      if (!slug || seen.has(slug)) return;
      seen.add(slug);
      const label = $(`label[for="${$(el).attr('id')}"]`).text().trim() ||
                    $(el).closest('li').text().trim();
      if (!label) return;
      genres.push({ name: label, slug });
    });

    genres.sort((a, b) => a.name.localeCompare(b.name, 'id'));
    this._cachedGenres = genres;
    this._cachedGenresExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
    return genres;
  }

  async getTema() {
    const $ = await this._fetchFilterOptions();
    const items = [];
    const seen = new Set();
    $('input[name="tema[]"]').each((_, el) => {
      const slug = $(el).val()?.trim();
      if (!slug || seen.has(slug)) return;
      seen.add(slug);
      const label = $(`label[for="${$(el).attr('id')}"]`).text().trim() ||
                    $(el).closest('li').text().trim();
      if (!label) return;
      items.push({ name: label, slug });
    });
    return items.sort((a, b) => a.name.localeCompare(b.name, 'id'));
  }

  async getDemografis() {
    const $ = await this._fetchFilterOptions();
    const items = [];
    const seen = new Set();
    $('input[name="demografis[]"]').each((_, el) => {
      const slug = $(el).val()?.trim();
      if (!slug || seen.has(slug)) return;
      seen.add(slug);
      const label = $(`label[for="${$(el).attr('id')}"]`).text().trim() ||
                    $(el).closest('li').text().trim();
      if (!label) return;
      items.push({ name: label, slug });
    });
    return items.sort((a, b) => a.name.localeCompare(b.name, 'id'));
  }

  async getByGenre(genre, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanGenre = String(genre || '').trim().toLowerCase();
    if (!cleanGenre) throw createBadRequest("Parameter 'genre' wajib diisi", 'INVALID_PARAMETER');

    const order = this._resolveOrder(options.order || options.sort || 'update');
    const genres = await this.getGenres();

    // KomikIndo.ch hanya support single genre filter
    const key = cleanGenre.split(',')[0].trim();
    const found = genres.find((g) => g.slug === key || g.name.toLowerCase() === key);
    if (!found) throw createNotFound(`Genre '${key}' tidak ditemukan di KomikIndo`, 'NOT_FOUND');

    const url = this._buildListUrl(order, pageNum, `genre%5B%5D=${encodeURIComponent(found.slug)}`);
    const html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
    return { source: this.name, genre: found.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getTypes() {
    return ['manga', 'manhwa', 'manhua'];
  }

  async getByType(type, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanType = String(type || '').trim().toLowerCase();
    if (!cleanType) throw createBadRequest("Parameter 'type' wajib diisi", 'INVALID_PARAMETER');
    const order = this._resolveOrder(options.order || options.sort || 'update');
    const url = this._buildListUrl(order, pageNum, `type=${encodeURIComponent(cleanType)}`);
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, type: cleanType, page: pageNum, maxPage, hasNextPage, data };
  }

  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    const url = `${this.baseUrl}/komik/${cleanSlug}/`;
    let html;
    try {
      html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di KomikIndo`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    const title = $('h1.entry-title, h1').first().text()
      .replace(/^Komik\s*/i, '').trim() || cleanSlug;

    const altTitle = $('span.alternative').text().trim() || null;

    // Cover — direct src
    const cover = $('.thumb img, .kh-left img').first().attr('src') || null;

    // AltTitle, Status, Type, Author from .spe spans
    let altTitleFromSpe = null, status = null, type = null, author = null, year = null;
    $('.spe span').each((_, el) => {
      const raw = $(el).text();
      const label = raw.split('\n')[0]?.trim().toLowerCase() || '';
      const value = raw.replace(/^[^\n]+\n/, '').replace(/\s+/g, ' ').trim();
      if (label.startsWith('judul alternatif')) altTitleFromSpe = value || null;
      else if (label.startsWith('status')) {
        if (raw.toLowerCase().includes('berjalan') || raw.toLowerCase().includes('ongoing')) status = 'ongoing';
        else if (raw.toLowerCase().includes('tamat') || raw.toLowerCase().includes('completed')) status = 'completed';
        else if (raw.toLowerCase().includes('hiatus')) status = 'hiatus';
      } else if (label.startsWith('jenis komik') || label.startsWith('type')) {
        type = value?.toLowerCase() || null;
      } else if (label.startsWith('pengarang') || label.startsWith('author')) {
        author = value || null;
      } else if (label.startsWith('terbitan') || label.startsWith('released')) {
        const m = value?.match(/\d{4}/);
        if (m) year = m[0];
      }
    });

    // Use altTitle from spe if span.alternative is empty
    const finalAltTitle = altTitle || altTitleFromSpe || null;

    // Synopsis — ambil langsung, bersihkan whitespace
    const synopsis = $('div.entry-content-single').text().replace(/\s+/g, ' ').trim() || null;

    // Rating
    const ratingRaw = $('[itemprop="ratingValue"]').attr('content') ||
                      $('[itemprop="ratingValue"]').text().trim();
    const rating = ratingRaw && !isNaN(parseFloat(ratingRaw)) ? parseFloat(ratingRaw) : null;

    // Genres — extract slug from /genres/{slug}/
    const genres = [];
    const seenGenres = new Set();
    $('.genre-info a, .seriestugenre a, .mgen a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const match = href.match(/\/genres?\/([^/]+)\/?$/);
      const genreSlug = match ? match[1] : null;
      const name = $(el).text().trim();
      if (!name || seenGenres.has(name)) return;
      seenGenres.add(name);
      genres.push({ name, slug: genreSlug || name.toLowerCase().replace(/\s+/g, '-') });
    });

    // Chapter list
    const chapters = [];
    $('#chapter_list li, #chapterlist li, .eplister li').each((_, el) => {
      const a = $(el).find('a').first();
      const href = a.attr('href') || '';
      if (!href) return;
      const chTitle = $(el).find('.chapternum, span').first().text().trim().replace(/\s+/g, ' ');
      const date = $(el).find('.chapterdate, .dt a, .dt').first().text().trim() || null;
      chapters.push({
        title: chTitle,
        slug: href,
        endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(href)}`,
        date,
      });
    });

    // Related — from .widget_senction.relatedpost .serieslist ul li
    const related = [];
    $('.widget_senction.relatedpost .serieslist ul li, .widget-post.miripmanga .serieslist ul li').each((_, el) => {
      const a = $(el).find('a.series').first();
      const href = a.attr('href') || '';
      const relSlug = this._slugFromKomikUrl(href);
      const relTitle = $(el).find('h3, .leftseries h4, h4').first().text().trim().replace(/^Komik\s*/i, '');
      if (!relSlug || !relTitle) return;
      const relCover = $(el).find('img').first().attr('src') || null;
      related.push({ title: relTitle, slug: relSlug, cover: relCover });
    });

    return {
      source: this.name,
      title,
      altTitle: finalAltTitle,
      cover,
      synopsis,
      status,
      type,
      author: author ? author.replace(/\s+/g, ' ').trim() : null,
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
    } else if (String(chapter || '').trim().startsWith('http')) {
      chapterUrl = String(chapter || '').trim();
    } else {
      // Resolve chapter URL from detail page
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
      if (err.statusCode === 404) throw createNotFound(`Chapter tidak ditemukan di KomikIndo`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    // Images from div.img-landmine img (same as Kotlin parser)
    // URL from onError attr: "this.onerror=null;this.src='URL'" or from src
    const pages = [];
    const seenUrls = new Set();

    $('div.img-landmine img').each((_, el) => {
      // Try onError attribute first (fallback URL, usually higher quality)
      const onError = $(el).attr('onError') || $(el).attr('onerror') || '';
      const onErrorMatch = onError.match(/src\s*=\s*['"]([^'"]+)['"]/);
      const src = $(el).attr('src') || '';

      const imgUrl = (onErrorMatch?.[1] || src || '').trim();
      if (!imgUrl || imgUrl.startsWith('data:') || seenUrls.has(imgUrl)) return;
      seenUrls.add(imgUrl);

      pages.push({
        page: pages.length + 1,
        url: imgUrl,
        directUrl: imgUrl,
        proxyUrl: `/api/proxy/image?url=${encodeURIComponent(imgUrl)}&referer=${encodeURIComponent(`${this.baseUrl}/`)}`,
      });
    });

    if (!pages.length) throw createBadGateway('Gagal menemukan gambar chapter dari KomikIndo', 'UPSTREAM_ERROR');

    const pageTitle = $('title').text()
      .replace(/\s*[-–|]\s*KomikIndo.*$/i, '')
      .replace(/\s*Bahasa Indonesia\s*/gi, '')
      .trim();

    return {
      source: this.name,
      title: pageTitle,
      totalPages: pages.length,
      pages,
    };
  }
}

module.exports = KomikindochSource;
