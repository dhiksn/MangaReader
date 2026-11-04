const cheerio = require('cheerio');
const BaseSource = require('../BaseSource');
const { getHtml } = require('../../utils/httpClient');
const { createNotFound, createBadRequest, createBadGateway } = require('../../utils/errors');

class BacakomikSource extends BaseSource {
  constructor() {
    super('bacakomik', 'BacaKomik');
    this.baseUrl = 'https://bacakomik.my';
    this.icon = `https://i2.wp.com/bacakomik.my/wp-content/uploads/2023/11/Ikon-HD-Bacakomik-e1700846109308.png?w=140`;

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

  _slugFromKomikUrl(href) {
    if (!href) return null;
    const match = href.match(/\/komik\/([^/]+)\/?$/);
    return match ? match[1] : null;
  }

  _resolveOrder(raw) {
    const map = {
      update: 'update', latest_update: 'update', latest: 'latest',
      newest: 'latest', popular: 'popular', title: 'title',
      az: 'title', titlereverse: 'titlereverse', za: 'titlereverse',
    };
    return map[String(raw || '').toLowerCase()] || 'update';
  }

  /** Build listing URL with path-style paging. */
  _buildListUrl(order, page, extra = '') {
    const base = `${this.baseUrl}/daftar-komik/`;
    const pagePart = page > 1 ? `page/${page}/` : '';
    return `${base}${pagePart}?order=${order}${extra}`;
  }

  /** Parse manga cards from div.animepost elements. */
  _parseCardList($) {
    const items = [];
    const seen = new Set();

    $('div.animepost').each((_, el) => {
      const $el = $(el);
      const a = $el.find('a').first();
      const href = a.attr('href') || '';
      const slug = this._slugFromKomikUrl(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const title = $el.find('.animposx .tt h4').text().trim() ||
                    $el.find('.tt').text().trim() ||
                    a.attr('title') || '';
      const cover = $el.find('div.limit img').first().attr('src') || null;
      // type dari span.typeflag — kelas kedua adalah nama tipenya (e.g. "typeflag Manhua")
      const typeFlagClass = $el.find('span[class*="typeflag"]').attr('class') || '';
      const typeMatch = typeFlagClass.match(/typeflag\s+(\S+)/i);
      const type = typeMatch ? typeMatch[1].toLowerCase() : null;
      const statusRaw = $el.find('.limit span.status').text().trim().toLowerCase();
      const status = statusRaw || 'ongoing';
      // bacakomik card tidak punya latest chapter di listing
      const latestChapter = null;
      // rating ada di .rating i
      const ratingRaw = $el.find('.rating i').text().trim();
      const rating = ratingRaw && !isNaN(parseFloat(ratingRaw)) ? parseFloat(ratingRaw) : null;

      items.push({ title: title.trim(), slug, cover, type, status, latestChapter, rating });
    });

    return items;
  }

  /** Parse numbered pagination. */
  _parsePagination($, currentPage) {
    let maxPage = currentPage;
    $('div.pagination a.page-numbers:not(.next)').each((_, el) => {
      const n = parseInt($(el).text().trim(), 10);
      if (!isNaN(n) && n > maxPage) maxPage = n;
    });
    const hasNextPage = $('div.pagination a.next.page-numbers').length > 0;
    return { maxPage: maxPage > currentPage ? maxPage : null, hasNextPage };
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

  async getPopular(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = this._buildListUrl('popular', pageNum);
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async getNewest(page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const url = this._buildListUrl('latest', pageNum);
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
    const status = String(options.status || '').toLowerCase();
    const type = String(options.type || '').toLowerCase();

    let extra = '';
    if (status) extra += `&status=${encodeURIComponent(status)}`;
    if (type) extra += `&type=${encodeURIComponent(type)}`;

    const url = this._buildListUrl(order, pageNum, extra);
    const { data, maxPage, hasNextPage } = await this._fetchListing(url, pageNum);
    return { source: this.name, page: pageNum, maxPage, hasNextPage, data };
  }

  async search(query, page = 1) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const q = encodeURIComponent(String(query || '').trim());
    const url =
      pageNum === 1
        ? `${this.baseUrl}/?s=${q}`
        : `${this.baseUrl}/page/${pageNum}/?s=${q}`;
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

    const html = await getHtml(`${this.baseUrl}/daftar-komik/`, {
      headers: { Referer: `${this.baseUrl}/` },
    });
    const $ = cheerio.load(html);
    const genres = [];
    const seen = new Set();

    $('ul.dropdown-menu.c4 li input[name="genre[]"]').each((_, el) => {
      const id = $(el).val();
      if (!id || seen.has(id)) return;
      seen.add(id);
      const label =
        $(`label[for="${$(el).attr('id')}"]`).text().trim() ||
        $(el).next('label').text().trim() ||
        $(el).closest('li').text().trim();
      if (!label) return;
      const slug = label.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      genres.push({ name: label, slug, id });
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
      const match = genres.find(
        (g) => g.slug === key || g.name.toLowerCase() === key || g.id === key
      );
      if (!match) throw createNotFound(`Genre '${key}' tidak ditemukan di BacaKomik`, 'NOT_FOUND');
      return match;
    });

    const genreParams = found.map((g) => `genre%5B%5D=${g.id}`).join('&');
    const base = `${this.baseUrl}/daftar-komik/`;
    const pagePart = pageNum > 1 ? `page/${pageNum}/` : '';
    const url = `${base}${pagePart}?order=${order}&${genreParams}`;

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
    return ['manga', 'manhwa', 'manhua'];
  }

  async getByType(type, page = 1, options = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const cleanType = String(type || '').trim().toLowerCase();
    if (!cleanType) throw createBadRequest("Parameter 'type' wajib diisi", 'INVALID_PARAMETER');

    const order = this._resolveOrder(options.order || options.sort || 'update');
    // bacakomik type param expects capitalized first letter
    const typeParam = cleanType.charAt(0).toUpperCase() + cleanType.slice(1);
    const url = this._buildListUrl(order, pageNum, `&type=${encodeURIComponent(typeParam)}`);
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
      if (err.statusCode === 404) {
        throw createNotFound(`Manga '${cleanSlug}' tidak ditemukan di BacaKomik`, 'NOT_FOUND');
      }
      throw err;
    }

    const $ = cheerio.load(html);

    // Title — strip "Komik" prefix and extra whitespace
    const rawTitle = $('h1[itemprop="name"], h1.entry-title').first().text();
    const title = rawTitle
      .replace(/^Komik\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim() || cleanSlug;

    // Alt title
    let altTitle = null;
    $('.infox .spe span').each((_, el) => {
      if ($(el).text().toLowerCase().includes('judul alternatif')) {
        altTitle = $(el).clone().children('b').remove().end().text()
          .replace(/^[:\s]+/, '').trim() || null;
      }
    });

    // Cover — use data-lazy-src (real URL), fallback to src
    const coverEl = $('.thumb img').first();
    const cover =
      coverEl.attr('data-lazy-src') ||
      coverEl.attr('data-src') ||
      coverEl.attr('src') || null;

    // Synopsis — strip boilerplate "Manga/Manhwa X yang dibuat oleh ... bercerita tentang"
    const rawSynopsis = $('div.desc .entry-content-single').text().trim() ||
                        $('div.desc').text().trim();
    let synopsis = null;
    if (rawSynopsis) {
      // Strip everything up to and including "bercerita tentang"
      const marker = rawSynopsis.toLowerCase().indexOf('bercerita tentang');
      if (marker !== -1) {
        synopsis = rawSynopsis.slice(marker + 'bercerita tentang'.length).replace(/\s+/g, ' ').trim();
      } else {
        synopsis = rawSynopsis.replace(/\s+/g, ' ').trim();
      }
      if (!synopsis) synopsis = null;
    }

    // Status (Indonesian: Berjalan=ongoing, Tamat=completed, Hiatus=hiatus)
    let status = 'ongoing';
    let type = null;
    let author = null;
    let year = null;

    $('.infox .spe span').each((_, el) => {
      const text = $(el).text().trim();
      const lower = text.toLowerCase();

      if (lower.includes('status')) {
        if (lower.includes('tamat') || lower.includes('completed')) status = 'completed';
        else if (lower.includes('hiatus')) status = 'hiatus';
        else status = 'ongoing';
      } else if (lower.includes('jenis komik')) {
        type = $(el).find('a').text().trim().toLowerCase() || null;
      } else if (lower.startsWith('author')) {
        const authorLinks = $(el).find('a').map((_, a) => $(a).text().trim()).get().filter(Boolean);
        author = authorLinks.length ? authorLinks.join(', ') : null;
      } else if (lower.includes('rilis')) {
        const yearMatch = text.match(/\d{4}/);
        if (yearMatch) year = yearMatch[0];
      }
    });

    // Rating
    const ratingRaw =
      $('[itemprop="ratingValue"]').attr('content') ||
      $('[itemprop="ratingValue"]').text().trim() ||
      $('.numscore').first().text().trim();
    const rating = ratingRaw && !isNaN(parseFloat(ratingRaw)) ? parseFloat(ratingRaw) : null;

    // Genres from .genre-info > a with slug from href
    const genres = [];
    const seenGenres = new Set();
    $('.infox .genre-info a, .infox .spe .mgen a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const name = $(el).text().trim();
      if (!name) return;
      const slugMatch = href.match(/\/([^/]+)\/?(?:\?.*)?$/);
      const genreSlug = slugMatch ? slugMatch[1] : name.toLowerCase().replace(/\s+/g, '-');
      if (seenGenres.has(genreSlug)) return;
      seenGenres.add(genreSlug);
      genres.push({ name, slug: genreSlug });
    });

    // Chapter list from #chapter_list li (newest first)
    const chapters = [];
    $('#chapter_list li').each((_, el) => {
      const a = $(el).find('span.lchx > a, a').first();
      const href = a.attr('href') || '';
      if (!href) return;

      const chTitle = a.text().replace(/\s+/g, ' ').trim();
      const chDate = $(el).find('span.dt a, span.dt').first().text().trim() || null;
      const chNumMatch = chTitle.match(/Chapter\s+([0-9.]+)/i);
      const chNum = chNumMatch ? chNumMatch[1] : null;

      chapters.push({
        title: chTitle || `Chapter ${chNum}`,
        slug: href,
        endpoint: `/api/sources/${this.name}/chapter/${encodeURIComponent(href)}`,
        date: chDate,
      });
    });

    // Related series — div.widget_senction.relatedpost .serieslist ul li
    const related = [];
    $('.widget_senction.relatedpost .serieslist ul li, .relatedpost .serieslist ul li').each((_, el) => {
      const a = $(el).find('a.series').first();
      const href = a.attr('href') || '';
      const relSlug = this._slugFromKomikUrl(href);
      if (!relSlug || relSlug === cleanSlug) return;
      const relTitle = $(el).find('h4 a').text().trim();
      const rawRelCover = $(el).find('img').first().attr('data-lazy-src') ||
                          $(el).find('noscript img').attr('src') || null;
      const typeFlagClass = $(el).find('span[class*="typeflag"]').attr('class') || '';
      const typeMatch = typeFlagClass.match(/typeflag\s+(\S+)/i);
      const relType = typeMatch ? typeMatch[1].toLowerCase() : null;
      if (relTitle) related.push({ title: relTitle, slug: relSlug, cover: rawRelCover, type: relType });
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
      year: year || null,
      rating,
      genres,
      totalChapters: chapters.length,
      chapters,
      related,
    };
  }

  async _resolveChapterUrl(mangaSlug, chapterNum) {
    const details = await this.getDetails(mangaSlug);
    const target = details.chapters.find((ch) => {
      const m = ch.title.match(/Chapter\s+([0-9.]+)/i);
      return m && parseFloat(m[1]) === parseFloat(chapterNum);
    });
    if (!target) {
      throw createNotFound(
        `Chapter '${chapterNum}' tidak ditemukan untuk manga '${mangaSlug}'`,
        'NOT_FOUND'
      );
    }
    return target.slug;
  }

  async getPages(slug, chapter, server = 1) {
    const rawSlug = String(slug || '').trim();
    const rawChapter = String(chapter || '').trim();
    if (!rawSlug) throw createBadRequest("Parameter 'slug' wajib diisi", 'INVALID_PARAMETER');

    let chapterUrl;
    if (rawSlug.startsWith('http')) {
      chapterUrl = rawSlug;
    } else {
      const chNum = rawChapter.replace(/^chapter-?/i, '');
      chapterUrl = await this._resolveChapterUrl(rawSlug, chNum);
    }

    let html;
    try {
      html = await getHtml(chapterUrl, { headers: { Referer: `${this.baseUrl}/` } });
    } catch (err) {
      if (err.statusCode === 404) {
        throw createNotFound(`Chapter tidak ditemukan di BacaKomik: ${chapterUrl}`, 'NOT_FOUND');
      }
      throw err;
    }

    const $ = cheerio.load(html);
    const pages = [];
    const seenUrls = new Set();

    // bacakomik images are static <img> tags inside divs, alt contains "Chapter"
    // Filter out noscript wrappers
    $('img[alt*="Chapter"], img[alt*="chapter"]').each((_, img) => {
      if ($(img).parent().is('noscript')) return;

      // Fallback URL from onerror attribute
      const onerror = $(img).attr('onError') || $(img).attr('onerror') || '';
      const fallbackMatch = onerror.match(/src='([^']+)'/);
      const imgUrl = (fallbackMatch?.[1] || $(img).attr('src') || '').trim();

      if (!imgUrl || seenUrls.has(imgUrl)) return;
      seenUrls.add(imgUrl);

      pages.push({
        page: pages.length + 1,
        url: imgUrl,
        directUrl: imgUrl,
        proxyUrl: `/api/proxy/image?url=${encodeURIComponent(imgUrl)}&referer=${encodeURIComponent(`${this.baseUrl}/`)}`,
      });
    });

    if (pages.length === 0) {
      throw createBadGateway(
        'Gagal menemukan gambar chapter dari BacaKomik',
        'UPSTREAM_ERROR'
      );
    }

    // Build title from page <title>
    const pageTitle = $('title').text()
      .replace(/\s*[-–|]\s*BacaKomik.*$/i, '')
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

module.exports = BacakomikSource;
