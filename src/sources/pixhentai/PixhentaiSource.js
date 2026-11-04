const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');
 
class PixhentaiSource extends BaseSource {
  constructor() {
    super('pixhentai', 'PixHentai');
    this.baseUrl = 'https://pixhentai.com';
    this.icon = `https://pixhentai.com/wp-content/uploads/2019/12/favicon.ico`;
 
    // Genres cache
    this._cachedGenres = null;
    this._cachedGenresExpiresAt = 0;
  }
 
  getSupportedSorts() {
    return [
      { id: 'latest', name: 'Terbaru' },
    ];
  }
 
  // ─── Private helpers ────────────────────────────────────────────────────────
 
  _slugFromUrl(href) {
    if (!href) return null;
    return href.replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '') || null;
  }
 
  _parsePagination($, currentPage) {
    let maxPage = currentPage;
    $('a.page-numbers').each((_, el) => {
      const n = parseInt($(el).text().trim(), 10);
      if (!isNaN(n) && n > maxPage) maxPage = n;
    });
    const hasNextPage = $('a.next.page-numbers, a.page-numbers:contains("next"), a[href*="page/' + (currentPage + 1) + '/"]').length > 0 || maxPage > currentPage;
    return { maxPage: maxPage > currentPage ? maxPage : null, hasNextPage };
  }
 
  _parseCardList($) {
    const items = [];
    const seen = new Set();
 
    $('div#content article').each((_, el) => {
      const a = $(el).find('a').first();
      const href = a.attr('href') || '';
      const slug = this._slugFromUrl(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);
 
      const title = $(el).find('h2').first().text().trim() || a.attr('title') || '';
      if (!title) return;
 
      // Strip thumbnail dimensions (-200x285) to get full-size cover
      const rawCover = $(el).find('img').first().attr('src') || '';
      const cover = rawCover.replace(/-\d+x\d+(\.[a-zA-Z0-9]+)$/, '$1') || null;
 
      items.push({ title, slug, cover });
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
    const url = `${this.baseUrl}/page/${pageNum}/`;
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }
 
  async search(query, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = `${this.baseUrl}/page/${pageNum}/?s=${encodeURIComponent(String(query || '').trim())}`;
    const html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
    return {
      source: this.name,
      query: String(query || '').trim(),
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
 
    const html = await getHtml(`${this.baseUrl}/`, { headers: { Referer: `${this.baseUrl}/` } });
    const $ = cheerio.load(html);
    const genres = [];
    const seen = new Set();
 
    $('ul.megamenu li a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const match = href.match(/\/genre\/([^/]+)\/?$/);
      if (!match) return;
      const slug = match[1];
      if (seen.has(slug)) return;
      seen.add(slug);
      const name = $(el).text().trim();
      if (!name) return;
      genres.push({ name, slug });
    });
 
    genres.sort((a, b) => a.name.localeCompare(b.name, 'id'));
    this._cachedGenres = genres;
    this._cachedGenresExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
    return genres;
  }
 
  async getByGenre(genre, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanGenre = String(genre || '').trim().toLowerCase();
    if (!cleanGenre) throw createBadRequest("Parameter 'genre' wajib diisi", 'INVALID_PARAMETER');
 
    // Verify genre exists
    const genres = await this.getGenres();
    const found = genres.find((g) => g.slug === cleanGenre || g.name.toLowerCase() === cleanGenre);
    if (!found) throw createNotFound(`Genre '${genre}' tidak ditemukan di PixHentai`, 'NOT_FOUND');
 
    const url = `${this.baseUrl}/genre/${found.slug}/page/${pageNum}/`;
    const html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    const $ = cheerio.load(html);
    const data = this._parseCardList($);
    const { maxPage, hasNextPage } = this._parsePagination($, pageNum);
 
    return {
      source: this.name,
      genre: found.name,
      page: pageNum,
      maxPage,
      hasNextPage,
      data,
    };
  }
 
  async getDetails(slug) {
    const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '');
    if (!cleanSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');
 
    const url = `${this.baseUrl}/${cleanSlug}/`;
    let html;
    try {
      html = await getHtml(url, { headers: { Referer: `${this.baseUrl}/` } });
    } catch (err) {
      if (err.statusCode === 404) {
        throw createNotFound(`'${cleanSlug}' tidak ditemukan di PixHentai`, 'NOT_FOUND');
      }
      throw err;
    }
 
    const $ = cheerio.load(html);
 
    const title = $('h1.entry-title, h1').first().text().trim() || cleanSlug;
 
    // Cover — first image in entry-content, strip thumbnail dimensions
    const rawCover = $('div.entry-content img, div.thumbnail img').first().attr('src') || '';
    const cover = rawCover.replace(/-\d+x\d+(\.[a-zA-Z0-9]+)$/, '$1') || null;
 
    // Synopsis — ambil semua p sampai ketemu boilerplate outro
    const synParagraphs = [];
    $('div.entry-content p').each((i, el) => {
      const text = $(el).text().trim();
      if (!text) return;
      // Skip boilerplate intro (p pertama)
      if (i === 0 && /baca komik hentai|manga sex doujinshi/i.test(text)) return;
      // Stop ketemu boilerplate outro
      if (/cerita selengkapnya|kelanjutan ceritanya|chapter\s*:/i.test(text)) return;
      synParagraphs.push(text);
    });
    const synopsis = synParagraphs.join(' ').trim() || null;
 
    // Alt title & author from <li> in entry-content (kept for internal use only)
    $('div.entry-content ul li').each((_, el) => {
      // no-op, kept for future use
    });
 
    // Genres/tags specific to this manga — found in post footer tags section
    const genres = [];
    const seenGenres = new Set();
    // Collect from a[rel="tag"] (tags) and specific genre links in the post body
    $('a[rel="tag"], a[href*="/tag/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const match = href.match(/\/(?:genre|tag)\/([^/]+)\/?$/);
      const genreSlug = match ? match[1] : null;
      const name = $(el).text().trim();
      if (!name || !genreSlug || seenGenres.has(genreSlug)) return;
      seenGenres.add(genreSlug);
      genres.push({ name, slug: genreSlug });
    });
 
    // PixHentai: single chapter = the manga page itself
    const chapters = [{
      title,
      slug: url,
      endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(url)}`,
      date: null,
    }];
 
    // Series — other parts/chapters in the same series (from "Chapter :" list)
    const series = [];
    $('div.entry-content').find('li').filter((_, el) => {
      return $(el).find('strong').text().trim().toLowerCase().includes('chapter');
    }).first().find('ol li').each((_, el) => {
      const a = $(el).find('a').first();
      const href = a.attr('href') || '';
      const partTitle = a.text().trim() || $(el).text().trim();
      const partSlug = this._slugFromUrl(href);
      if (!partTitle) return;
      series.push({
        title: partTitle,
        slug: partSlug || null,
        endpoint: partSlug ? `/api/sources/${this.name}/manga/${partSlug}` : null,
      });
    });

    // Related posts dari #related-posts
    const related = [];
    $('#related-posts article.related-post').each((_, el) => {
      const a = $(el).find('.related-post-title a').first();
      const href = a.attr('href') || '';
      const relSlug = this._slugFromUrl(href);
      const relTitle = a.text().trim();
      if (!relSlug || !relTitle) return;
      const rawRelCover = $(el).find('.related-thumb img').first().attr('src') || '';
      const relCover = rawRelCover.replace(/-\d+x\d+(\.[a-zA-Z0-9]+)$/, '$1') || null;
      related.push({ title: relTitle, slug: relSlug, cover: relCover });
    });

    return {
      source: this.name,
      title,
      cover,
      synopsis,
      series,
      genres,
      totalChapters: 1,
      chapters,
      related,
    };
  }
 
  async getPages(slug, chapter) {
    const rawSlug = String(slug || '').trim();
    if (!rawSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');
 
    // slug can be full URL or bare slug
    const pageUrl = rawSlug.startsWith('http')
      ? rawSlug
      : `${this.baseUrl}/${rawSlug.replace(/^\/+|\/+$/g, '')}/`;
 
    let html;
    try {
      html = await getHtml(pageUrl, { headers: { Referer: `${this.baseUrl}/` } });
    } catch (err) {
      if (err.statusCode === 404) {
        throw createNotFound(`Halaman tidak ditemukan di PixHentai: ${pageUrl}`, 'NOT_FOUND');
      }
      throw err;
    }
 
    const $ = cheerio.load(html);
    const pages = [];
    const seenUrls = new Set();
 
    $('.thumbnail img, figure.gallery-item img').each((_, img) => {
      const src = $(img).attr('src')?.trim() || '';
      if (!src || seenUrls.has(src)) return;
      seenUrls.add(src);
      pages.push({
        page: pages.length + 1,
        url: src,
        directUrl: src,
        proxyUrl: `/api/proxy/image?url=${encodeURIComponent(src)}&referer=${encodeURIComponent(`${this.baseUrl}/`)}`,
      });
    });
 
    if (pages.length === 0) {
      throw createBadGateway('Gagal menemukan gambar dari PixHentai', 'UPSTREAM_ERROR');
    }
 
    const title = $('h1.entry-title, h1').first().text().trim();
 
    return {
      source: this.name,
      title,
      totalPages: pages.length,
      pages,
    };
  }
}
 
module.exports = PixhentaiSource;