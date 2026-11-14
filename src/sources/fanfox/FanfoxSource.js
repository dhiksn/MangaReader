const cheerio = require('cheerio');
const vm = require('vm');
const BaseSource = require('../BaseSource');
const { getHtml } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

const PAGE_SIZE = 18;

class FanfoxSource extends BaseSource {
  constructor() {
    super('fanfox', 'Fanfox');
    this.baseUrl = 'https://newm.fanfox.net';
    this.icon = 'https://newm.fanfox.net/favicon.ico';
  }

  getSupportedSorts() {
    return [
      { id: 'latest',  name: 'Terbaru' },
      { id: 'newest',  name: 'Diperbarui' },
      { id: 'popular', name: 'Populer' },
      { id: 'rating',  name: 'Rating' },
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

  _chapterPathFromUrl(href) {
    // /manga/slug/c001/1.html → return "/manga/slug/c001/1.html"
    if (!href) return null;
    return href.startsWith('http') ? new URL(href).pathname : href;
  }

  /**
   * Unpack the eval(function(p,a,c,k,e,d){...}) packer used by Fanfox
   * and extract the newImgs array from the unpacked code.
   */
  _unpackNewImgs(packedCode) {
    if (!packedCode || typeof packedCode !== 'string') return [];
    const sandbox = { newImgs: null, newImginfos: null, pva: null };
    // Override eval to execute the unpacked code in sandbox
    sandbox.eval = (code) => {
      try { vm.runInNewContext(code, sandbox); } catch (_) {}
    };
    try { vm.runInNewContext(packedCode, sandbox); } catch (_) {}
    return Array.isArray(sandbox.newImgs) ? sandbox.newImgs : [];
  }

  _parseCardList($) {
    const items = [];
    const seen = new Set();

    $('li').filter((_, el) => $(el).find('.manga-list-2-cover').length > 0).each((_, el) => {
      const a = $(el).find('.manga-list-2-cover a').first();
      const href = a.attr('href') || '';
      const slug = this._slugFromUrl(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const title = a.attr('title') || $(el).find('.manga-list-2-title a').text().trim();
      if (!title) return;

      const cover = $(el).find('img.manga-list-2-cover-img').attr('src') || null;
      const ratingRaw = $(el).find('.manga-list-2-tip span').text().trim();
      const rating = ratingRaw && !isNaN(parseFloat(ratingRaw))
        ? Math.round(parseFloat(ratingRaw) * 100) / 100 : null;

      items.push({ title, slug, cover, rating });
    });

    return items;
  }

  async _fetchListing(url, pageNum) {
    const html = await getHtml(url, { headers: this._headers() });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const hasNextPage = data.length >= PAGE_SIZE;
    const maxPage = hasNextPage ? pageNum + 1 : pageNum;
    return { data, hasNextPage, maxPage };
  }

  _buildListUrl(sort, page) {
    const sortMap = {
      latest:  '?latest',
      newest:  '?news',
      popular: '?po',
      rating:  '?rating',
    };
    const qs = sortMap[sort] || '?latest';
    const pageParam = page > 1 ? `&page=${page}` : '';
    return `${this.baseUrl}/directory/${qs}${pageParam}`;
  }

  // ─── Endpoints ───────────────────────────────────────────────────────────────

  async getLatest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage, maxPage } = await this._fetchListing(this._buildListUrl('latest', pageNum), pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getNewest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage, maxPage } = await this._fetchListing(this._buildListUrl('newest', pageNum), pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getPopular(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage, maxPage } = await this._fetchListing(this._buildListUrl('popular', pageNum), pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getRating(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { data, hasNextPage, maxPage } = await this._fetchListing(this._buildListUrl('rating', pageNum), pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async search(query, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const q = encodeURIComponent(String(query || '').trim());
    const pageParam = pageNum > 1 ? `&page=${pageNum}` : '';
    const url = `${this.baseUrl}/search?title=${q}${pageParam}`;
    const html = await getHtml(url, { headers: this._headers() });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const hasNextPage = data.length >= PAGE_SIZE;
    return { source: this.name, query: String(query || '').trim(), page: pageNum, hasNextPage, data };
  }

  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    const url = `${this.baseUrl}/manga/${cleanSlug}/`;
    let html;
    try {
      html = await getHtml(url, { headers: this._headers() });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di Fanfox`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    const title = $('p.detail-top-bar-info-title').first().text().trim() || cleanSlug;
    const cover = $('.detail-top-bar-cover img').first().attr('src') || null;

    // Author
    const authorParts = [];
    $('.detail-author-bar a').each((_, el) => {
      const name = $(el).text().trim();
      if (name) authorParts.push(name);
    });
    const author = authorParts.length ? authorParts.join(', ') : null;

    // Synopsis
    const synopsis = ($('.detail-text-bar p.fullcontent').text().trim() ||
                     $('.detail-text-bar p').first().text().trim())
                     .replace(/\.\.\.more\s*$/i, '').trim() || null;

    // Status — "Ongoing (N)" from tab
    const statusRaw = $('#tab-1').text().trim().toLowerCase();
    let status = null;
    if (statusRaw.includes('ongoing')) status = 'ongoing';
    else if (statusRaw.includes('completed')) status = 'completed';

    // Rating from detail info
    const ratingRaw = $('em.detail-info-right-score-num, .detail-info-right-score em').first().text().trim();
    const rating = ratingRaw && !isNaN(parseFloat(ratingRaw))
      ? Math.round(parseFloat(ratingRaw) * 100) / 100 : null;

    // Genres from detail info
    const genres = [];
    const seenG = new Set();
    $('a[href*="/directory/"]').each((_, el) => {
      const name = $(el).text().trim();
      if (!name || seenG.has(name) || name.length > 30) return;
      seenG.add(name);
      const href = $(el).attr('href') || '';
      const m = href.match(/\/directory\/([^/?#]+)/);
      genres.push({ name, slug: m ? m[1] : name.toLowerCase().replace(/\s+/g, '_') });
    });

    // Chapters from .detail-chapters-list a
    const chapters = [];
    const seenCh = new Set();
    $('.detail-chapters-list a[href*="/manga/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!href || seenCh.has(href)) return;
      seenCh.add(href);
      const chTitle = $(el).attr('title') || $(el).text().trim();
      // Extract chapter number from href: /manga/slug/c001/1.html → 1
      const chNumMatch = href.match(/\/c(\d+)\//);
      const chNum = chNumMatch ? parseInt(chNumMatch[1], 10) : null;
      chapters.push({
        title: chTitle,
        slug: `${this.baseUrl}${href}`,
        endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(this.baseUrl + href)}`,
        number: chNum,
      });
    });
    // Reverse to oldest-first
    chapters.reverse();

    return {
      source: this.name,
      title,
      cover,
      synopsis,
      status,
      author,
      rating,
      genres,
      totalChapters: chapters.length,
      chapters,
    };
  }

  async getPages(slug, chapter) {
    const rawSlug = String(slug || '').trim();
    if (!rawSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    let chapterUrl;
    if (rawSlug.startsWith('http')) {
      // Full URL passed (from endpoint field)
      chapterUrl = rawSlug;
    } else {
      // slug + chapter number → /manga/{slug}/c{NNN}/1.html
      const chNum = String(chapter || '').replace(/^chapter-?/i, '').trim();
      const padded = chNum.padStart(3, '0');
      chapterUrl = `${this.baseUrl}/manga/${rawSlug}/c${padded}/1.html`;
    }

    let html;
    try {
      html = await getHtml(chapterUrl, { headers: this._headers() });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound('Chapter tidak ditemukan di Fanfox', 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    // Extract newImgs from packed script[0]
    const script0 = $('script:not([src])').first().html() || '';
    const rawImgs = this._unpackNewImgs(script0);

    if (!rawImgs.length) throw createBadGateway('Gagal menemukan gambar chapter dari Fanfox', 'UPSTREAM_ERROR');

    // URLs start with // — prepend https:
    const images = rawImgs.map((u) => u.startsWith('//') ? `https:${u}` : u);

    const pageTitle = $('title').text()
      .replace(/\s*[-–|]\s*FanFox.*$/i, '')
      .replace(/^(Read|Baca)\s+/i, '')
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

module.exports = FanfoxSource;
