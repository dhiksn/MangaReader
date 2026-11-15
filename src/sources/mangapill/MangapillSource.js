const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

const PAGE_SIZE = 25;

class MangapillSource extends BaseSource {
  constructor() {
    super('mangapill', 'MangaPill');
    this.baseUrl = 'https://mangapill.com';
    this.icon = `${this.baseUrl}/favicon.ico`;
    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }

  getSupportedSorts() {
    return [
      { id: 'latest', name: 'Chapter Terbaru' },
      { id: 'newest', name: 'Manga Terbaru' },
    ];
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  _headers() {
    return { Referer: `${this.baseUrl}/` };
  }

  _slugFromMangaUrl(href) {
    if (!href) return null;
    // /manga/10520/higanjima-48-nichigo → "10520/higanjima-48-nichigo"
    const m = href.match(/\/manga\/(.+)/);
    return m ? m[1].replace(/\/$/, '') : null;
  }

  _parseMangaGrid($, pageUrl) {
    const items = [];
    const seen = new Set();

    // Each card = pair of <a.relative.block> (cover) + <div.flex.flex-col> (info)
    // They share the same parent grid cell
    $('[class*="grid"] > div, [class*="grid"] > a').each((_, el) => {
      // Find cover link
      const coverLink = $(el).is('a') ? $(el) : $(el).find('a.relative').first();
      const href = coverLink.attr('href') || $(el).find('a[href*="/manga/"]').first().attr('href') || '';
      const slug = this._slugFromMangaUrl(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const cover = $(el).find('img[data-src], img[src*="cdn"]').first().attr('data-src') ||
                    $(el).find('img[data-src], img[src*="cdn"]').first().attr('src') || null;

      // Title from sibling div or alt
      const title = $(el).find('div.font-black, div.font-bold').first().text().trim() ||
                    $(el).find('img').first().attr('alt')?.replace(/\.\.\.$/, '').trim() || '';
      if (!title) return;

      // Type badge
      const type = $(el).find('div.bg-card').first().text().trim().toLowerCase() || null;

      items.push({ title, slug, cover, type });
    });

    return items;
  }

  _parseChapterGrid($) {
    const items = [];
    const seen = new Set();

    $('[class*="grid"] > div').each((_, el) => {
      const chLink = $(el).find('a[href*="/chapters/"]').first();
      const chHref = chLink.attr('href') || '';
      if (!chHref || seen.has(chHref)) return;
      seen.add(chHref);

      const mangaLink = $(el).find('a[href*="/manga/"]').first();
      const mangaHref = mangaLink.attr('href') || '';
      const mangaSlug = this._slugFromMangaUrl(mangaHref);

      const cover = $(el).find('img[data-src]').first().attr('data-src') ||
                    $(el).find('img').first().attr('src') || null;

      const mangaTitle = $(el).find('div.line-clamp-2.font-bold, div.font-bold').first().text().trim() ||
                         $(el).find('a[href*="/manga/"] div').first().text().trim() || '';
      const chNum = $(el).find('div.text-lg.font-black, div.mt-3.font-black').first().text().trim() || '';
      const date = $(el).find('time-ago').attr('datetime') ||
                   $(el).find('time-ago').text().trim() || null;

      if (!mangaSlug || !mangaTitle) return;

      items.push({
        title: mangaTitle,
        slug: mangaSlug,
        cover,
        chapterNumber: chNum,
        detailUrl: `/api/sources/${this.name}/manga/${encodeURIComponent(mangaSlug).replace(/%2F/gi, '~')}`,
        date,
      });
    });

    return items;
  }

  _parsePagination($, currentPage) {
    // Mangapill has no visible pagination numbers — detect via ?page= links or count
    const hasNextPage = $('[href*="?page="]').filter((_, el) => {
      const m = $(el).attr('href')?.match(/page=(\d+)/);
      return m && parseInt(m[1]) > currentPage;
    }).length > 0;
    return { hasNextPage, maxPage: hasNextPage ? currentPage + 1 : currentPage };
  }

  // ─── Endpoints ───────────────────────────────────────────────────────────────

  async getLatest(page = 1) {
    // /chapters only has 1 page with ~120 static items — no pagination
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    if (pageNum > 1) {
      throw createNotFound("Sumber 'mangapill' /latest hanya tersedia di halaman 1 (120 item)", 'NOT_FOUND');
    }
    const html = await getHtml(`${this.baseUrl}/chapters`, { headers: this._headers() });
    const $ = cheerio.load(html);
    const data = this._parseChapterGrid($);
    return { source: this.name, page: 1, maxPage: 1, hasNextPage: false, data };
  }

  async getNewest(page = 1) {
    // /mangas/new — recently added manga
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = pageNum === 1 ? `${this.baseUrl}/mangas/new` : `${this.baseUrl}/mangas/new?page=${pageNum}`;
    const html = await getHtml(url, { headers: this._headers() });
    const $ = cheerio.load(html);
    const data = this._parseMangaGrid($, url);
    const hasNextPage = data.length >= PAGE_SIZE;
    return { source: this.name, page: pageNum, maxPage: hasNextPage ? pageNum + 1 : pageNum, hasNextPage, data };
  }

  async search(query, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const q = encodeURIComponent(String(query || '').trim());
    const pageParam = pageNum > 1 ? `&page=${pageNum}` : '';
    const url = `${this.baseUrl}/search?q=${q}${pageParam}`;
    const html = await getHtml(url, { headers: this._headers() });
    const $ = cheerio.load(html);
    const data = this._parseMangaGrid($, url);
    const hasNextPage = data.length >= PAGE_SIZE;
    return { source: this.name, query: String(query || '').trim(), page: pageNum, hasNextPage, data };
  }

  async getGenres() {
    if (this._cachedGenres && Date.now() < this._cachedGenresExpiresAt) return this._cachedGenres;
    const html = await getHtml(`${this.baseUrl}/search`, { headers: this._headers() });
    const $ = cheerio.load(html);
    const genres = [];
    const seen = new Set();
    $('input[name="genre"][type="checkbox"]').each((_, el) => {
      const val = $(el).val()?.trim();
      if (!val || seen.has(val)) return;
      seen.add(val);
      genres.push({ name: val, slug: val });
    });
    genres.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    this._cachedGenres = genres;
    this._cachedGenresExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
    return genres;
  }

  async getTypes() {
    return ['manga', 'novel', 'one-shot', 'doujinshi', 'manhua', 'oel'];
  }

  async getByType(type, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanType = String(type || '').trim().toLowerCase();
    if (!cleanType) throw createBadRequest("Parameter 'type' wajib diisi", 'INVALID_PARAMETER');
    const pageParam = pageNum > 1 ? `&page=${pageNum}` : '';
    const url = `${this.baseUrl}/search?type=${encodeURIComponent(cleanType)}${pageParam}`;
    const html = await getHtml(url, { headers: this._headers() });
    const $ = cheerio.load(html);
    const data = this._parseMangaGrid($, url);
    const hasNextPage = data.length >= PAGE_SIZE;
    return { source: this.name, type: cleanType, page: pageNum, hasNextPage, data };
  }
  async getByGenre(genre, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    if (!cleanGenre) throw createBadRequest("Parameter 'genre' wajib diisi", 'INVALID_PARAMETER');
    // Support comma-separated multi-genre
    const genreList = cleanGenre.split(',').map(g => g.trim()).filter(Boolean);
    const genreParams = genreList.map(g => `genre=${encodeURIComponent(g)}`).join('&');
    const pageParam = pageNum > 1 ? `&page=${pageNum}` : '';
    const url = `${this.baseUrl}/search?${genreParams}${pageParam}`;
    const html = await getHtml(url, { headers: this._headers() });
    const $ = cheerio.load(html);
    const data = this._parseMangaGrid($, url);
    const hasNextPage = data.length >= PAGE_SIZE;
    return { source: this.name, genre: cleanGenre, page: pageNum, hasNextPage, data };
  }

  async getDetails(slug) {
    // Support ~ as / separator (used in detailUrl to avoid slug validation issues)
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '').replace(/~/g, '/');
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    const url = `${this.baseUrl}/manga/${cleanSlug}`;
    let html;
    try {
      html = await getHtml(url, { headers: this._headers() });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di MangaPill`, 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    const title = $('h1').first().text().trim() || cleanSlug;

    // Alt title — div after h1 in mb-3
    const altTitle = $('h1').first().next('div').text().trim() || null;
    const cover = $('img.lazy').first().attr('data-src') ||
                  $('img[src*="mangapill/i/"]').first().attr('src') || null;

    // Synopsis — the second p (first is the manhwa notice)
    const synopsis = $('p.text-sm').first().text().trim() ||
                     $('p').filter((_, el) => $(el).text().trim().length > 80 && !$(el).text().includes('discontinue')).first().text().trim() || null;

    // Type / Status / Year from div.mb-3
    let type = null, status = null, year = null;
    $('div.mb-3').each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (!text.includes('Type') && !text.includes('Status')) return;
      $(el).find('div').each((__, d) => {
        const t = $(d).text().replace(/\s+/g, ' ').trim();
        if (t.startsWith('Type ') && !type) type = t.replace('Type ', '').trim().toLowerCase();
        else if (t.startsWith('Status ') && !status) status = t.replace('Status ', '').trim().toLowerCase();
        else if (t.startsWith('Year ') && !year) year = t.replace('Year ', '').trim();
        else if (/^\d{4}$/.test(t) && !year) year = t;
      });
    });

    // Genres
    const genres = [];
    const seenG = new Set();
    $('a[href*="?genre="]').each((_, el) => {
      const name = $(el).text().trim();
      const href = $(el).attr('href') || '';
      const m = href.match(/\?genre=([^&]+)/);
      const slug = m ? decodeURIComponent(m[1]).toLowerCase() : name.toLowerCase();
      if (!name || seenG.has(name)) return;
      seenG.add(name);
      genres.push({ name, slug });
    });

    // Chapters — links to /chapters/
    const chapters = [];
    const seenCh = new Set();
    $('a[href*="/chapters/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!href || seenCh.has(href)) return;
      seenCh.add(href);
      const chTitle = $(el).text().trim() || href.split('/').pop();
      chapters.push({
        title: chTitle,
        slug: href,
        endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(this.baseUrl + href)}`,
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
      year: year || null,
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
      chapterUrl = rawSlug;
    } else {
      // Build from manga slug + chapter number
      // Need to find chapter from detail page
      const chNum = String(chapter || '').replace(/^chapter-?/i, '').trim();
      try {
        const details = await this.getDetails(rawSlug);
        const target = details.chapters.find((ch) => {
          const m = ch.title.match(/Chapter\s+([0-9.]+)/i) || ch.slug.match(/chapter-([0-9.]+)/i);
          return m && parseFloat(m[1]) === parseFloat(chNum);
        });
        chapterUrl = target ? `${this.baseUrl}${target.slug}` : null;
      } catch (_) {}
      if (!chapterUrl) throw createNotFound(`Chapter '${chapter}' tidak ditemukan untuk '${rawSlug}'`, 'NOT_FOUND');
    }

    let html;
    try {
      html = await getHtml(chapterUrl, { headers: this._headers() });
    } catch (err) {
      if (err.statusCode === 404) throw createNotFound('Chapter tidak ditemukan di MangaPill', 'NOT_FOUND');
      throw err;
    }

    const $ = cheerio.load(html);

    // Images are loaded statically in the HTML
    const images = [];
    const seenUrls = new Set();
    $('img[src*="cdn.readdetectiveconan.com/file/mangap"]').each((_, el) => {
      const src = $(el).attr('src') || '';
      if (!src || seenUrls.has(src)) return;
      seenUrls.add(src);
      images.push(src);
    });

    // Fallback: data-src
    if (!images.length) {
      $('img[data-src*="cdn"], img[src*="cdn"]').each((_, el) => {
        const src = $(el).attr('data-src') || $(el).attr('src') || '';
        if (!src || seenUrls.has(src) || src.includes('/i/')) return; // skip cover thumbnails
        seenUrls.add(src);
        images.push(src);
      });
    }

    if (!images.length) throw createBadGateway('Tidak ada gambar untuk chapter ini di MangaPill', 'UPSTREAM_ERROR');

    const pageTitle = $('title').text()
      .replace(/\s*[-–|]\s*MangaPill.*$/i, '')
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

module.exports = MangapillSource;
